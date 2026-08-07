'use strict';

/**
 * Construccion de los mensajes de la precualificacion (asunto y cuerpo).
 *
 * Todo aqui es puro: **no envia nada**. El envio real vive detras de
 * `ports/notificationPort.js` (nodemailer con TLS verificado, Twilio,
 * WhatsApp). Este modulo solo produce texto ya saneado.
 *
 * Por que existe: el legacy tenia una plantilla por caso, cada una con ~400
 * lineas de HTML copiado y el envio SMTP incrustado
 * (`mail_corrobower.php`, `_es`, `_rejected`, `congra_*`, `otp_email.php`).
 * Cinco copias del mismo maquetado, dos de ellas identicas entre si
 * (`mail_corrobower_rejected.php` y `congra_mail_corrobower.php` tienen el
 * mismo asunto y el mismo cuerpo), y `_es` era la misma plantilla con el texto
 * traducido a mano en vez de usar el diccionario de `locales/`. Aqui hay **una**
 * maqueta y un diccionario por locale.
 *
 * Las tres reglas que este modulo hace imposibles de olvidar:
 *
 * 1. **Inyeccion de cabeceras SMTP.** Todo lo que acaba en `Subject`, `From`,
 *    `To` o `Reply-To` pasa por [sanitizeHeaderValue]. Un `\r\n` sin filtrar en
 *    un nombre convierte el correo del solicitante en un relay de spam con
 *    nuestro dominio.
 * 2. **XSS en el cuerpo.** El texto no se concatena: se declara en bloques y el
 *    renderizador los escapa. Una plantilla no *puede* meter HTML sin escapar
 *    porque no toca el HTML.
 * 3. **Nada sensible viaja.** Ni SSN, ni score, ni detalle del reporte de
 *    credito: [assertNoSensitiveData] rompe el render si alguien lo intenta.
 *    Un correo atraviesa servidores que no controlamos.
 */

// ---------------------------------------------------------------------------
// Constantes de marca y canal
// ---------------------------------------------------------------------------

/**
 * Remitente y pie. Portado de `mail_corrobower.php:48` y del pie comun de todas
 * las plantillas legacy ("© ViG Mortgage | Lic. OCIF IH-148 | NMLS ID: 214767").
 * Las licencias son informacion regulatoria obligatoria en la comunicacion de un
 * originador hipotecario, no decoracion: no se quitan.
 */
const BRAND = Object.freeze({
  name: 'VIG Mortgage',
  fromAddress: 'info@vigmortgage.com',
  ocifLicence: 'Lic. OCIF IH-148',
  nmlsId: 'NMLS ID: 214767',
});

const LOCALES = Object.freeze(['es', 'en']);

/**
 * Locale por defecto: **espanol**.
 *
 * Diverge a proposito del legacy, que caia en ingles
 * (`config_language.php`: `$defaultLang = 'en'`). El mercado es Puerto Rico y la
 * mayoria de los solicitantes escribe y lee en espanol; el ingles como
 * predeterminado era un descuido heredado del tema del sitio.
 *
 * TODO(Roberto): confirmar el cambio. Si prefieres mantener 'en' por
 * consistencia con la web, es una linea.
 */
const DEFAULT_LOCALE = 'es';

/** Plantillas disponibles. El valor es el `template` del `notificationPort`. */
const Template = Object.freeze({
  /** Codigo de verificacion. Origen: `otp_email.php`. */
  OTP_CODE: 'otpCode',
  /** Invitacion al co-deudor. Origen: `mail_corrobower.php` (la activa). */
  COBORROWER_INVITE: 'coborrowerInvite',
  /** Resultado favorable. Origen: `mail_corrobower_congra.php` (borrador). */
  PREQUALIFIED: 'prequalified',
  /** Resultado desfavorable. Origen: `mail_corrobower_rejected.php` (borrador). */
  NOT_PREQUALIFIED: 'notPrequalified',
  /** Acuse de recibo de documentos. Nueva: el legacy no avisaba nada. */
  DOCUMENTS_RECEIVED: 'documentsReceived',
});

/**
 * Dominios a los que se permite enlazar desde un correo.
 *
 * El endpoint de notificaciones recibe datos; si el enlace saliera de esos
 * datos sin filtro, cualquiera podria hacer que VIG mande un correo con su
 * marca apuntando a un sitio de phishing. La lista blanca lo impide.
 *
 * TODO(Roberto): anadir el host definitivo del wizard en Next.js cuando se
 * decida (¿`vigpr.com/precualifica`?) y retirar `prequalify.vigpr.com` al
 * apagar el PHP.
 */
const ALLOWED_LINK_HOSTS = Object.freeze([
  'prequalify.vigpr.com',
  'vigpr.com',
  'www.vigpr.com',
  'vigmortgage.com',
  'www.vigmortgage.com',
]);

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

/** Sigue la convencion de `middleware/errorHandler.js`: `status` + `publicMessage`. */
class NotificationError extends Error {
  /**
   * @param {string} message detalle interno (log)
   * @param {string} [publicMessage] lo unico que ve el cliente
   */
  constructor(message, publicMessage = 'No pudimos preparar la notificación.') {
    super(message);
    this.name = 'NotificationError';
    this.status = 400;
    this.publicMessage = publicMessage;
  }
}

// ---------------------------------------------------------------------------
// Saneamiento
// ---------------------------------------------------------------------------

/**
 * Deja un valor apto para una cabecera SMTP.
 *
 * Quita CR y LF (que es como se inyectan cabeceras: `Asunto\r\nBcc: victima@…`)
 * y de paso el resto de caracteres de control y los separadores de linea
 * Unicode `U+2028`/`U+2029`, que algunos clientes tratan como salto.
 *
 * Mismo comportamiento que `sanitizeHeaderValue` de `app.js` (Fase 0), ampliado.
 *
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeHeaderValue(value) {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Escapa HTML. Identico al `escapeHtml` de `app.js` para que no haya dos
 * criterios distintos de escape en el mismo backend.
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Valida una direccion de correo destino.
 *
 * A diferencia del asunto, aqui **no se sanea, se rechaza**: una direccion con
 * un salto de linea no es una direccion mal escrita, es un intento de inyeccion.
 * Limpiarla y seguir enviando seria mandar el correo a un destino que nadie
 * pidio.
 *
 * @param {unknown} address
 * @returns {string} la direccion, verificada
 * @throws {NotificationError}
 */
function assertEmailAddress(address) {
  const value = String(address ?? '').trim();
  if (value !== sanitizeHeaderValue(value) || value.length === 0 || value.length > 254) {
    throw new NotificationError(
      'Direccion de correo con caracteres de control o longitud invalida',
      'Correo inválido.'
    );
  }
  if (!/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]{2,}$/.test(value)) {
    throw new NotificationError(
      `Direccion de correo invalida: ${JSON.stringify(value)}`,
      'Correo inválido.'
    );
  }
  return value;
}

/**
 * Valida un enlace que va a ir dentro de un correo con nuestra marca.
 *
 * Exige `https` (nunca `http`, ni `javascript:`, ni `data:`) y un host de
 * [ALLOWED_LINK_HOSTS].
 *
 * @param {unknown} url
 * @returns {string} el enlace verificado
 * @throws {NotificationError}
 */
function assertSafeLink(url) {
  const raw = String(url ?? '').trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new NotificationError(`Enlace invalido: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new NotificationError(`Enlace no https: ${JSON.stringify(raw)}`);
  }
  if (!ALLOWED_LINK_HOSTS.includes(parsed.hostname.toLowerCase())) {
    throw new NotificationError(`Host no permitido en enlace: ${parsed.hostname}`);
  }
  return parsed.toString();
}

/**
 * Claves que jamas pueden llegar a un mensaje.
 *
 * El correo del legacy ya arrastraba el nombre completo y el id del lead en la
 * URL; el paso siguiente natural era meter el score y el monto ("[insert amount
 * here]" en `mail_corrobower_congra.php:271`). Se corta aqui.
 */
const FORBIDDEN_DATA_KEYS = Object.freeze([
  'ssn',
  'socialsecurity',
  'socialsecuritynumber',
  'score',
  'creditscore',
  'fico',
  'creditreport',
  'experian',
  'bureau',
  'password',
  'dateofbirth',
  'dob',
  'accountnumber',
  'routingnumber',
]);

/** Un SSN escrito en cualquier variante habitual. */
const SSN_LIKE_RE = /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/;

/**
 * Rompe el render si los datos traen algo que no puede viajar por correo.
 *
 * Recorre el objeto en profundidad: mira los nombres de las claves y el
 * contenido de los valores de texto.
 *
 * @param {unknown} data
 * @throws {NotificationError}
 */
function assertNoSensitiveData(data, path = 'data') {
  if (data == null) return;

  if (typeof data === 'string') {
    if (SSN_LIKE_RE.test(data)) {
      // El valor NO se incluye en el mensaje del error: acabaria en el log.
      throw new NotificationError(`Dato con forma de SSN en ${path}`);
    }
    return;
  }

  if (Array.isArray(data)) {
    data.forEach((item, i) => assertNoSensitiveData(item, `${path}[${i}]`));
    return;
  }

  if (typeof data === 'object') {
    for (const [key, value] of Object.entries(data)) {
      const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
      if (FORBIDDEN_DATA_KEYS.includes(normalized)) {
        throw new NotificationError(`Campo prohibido en notificacion: ${path}.${key}`);
      }
      assertNoSensitiveData(value, `${path}.${key}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Bloques
// ---------------------------------------------------------------------------

/**
 * El cuerpo de una plantilla es una lista de bloques, no una cadena de HTML.
 *
 * Es la parte importante del diseno: quien escribe una plantilla declara
 * *contenido*, nunca markup, asi que no tiene manera de olvidarse de escapar.
 * El unico sitio del modulo que produce HTML es [renderHtml].
 */
const Block = Object.freeze({
  /** Parrafo de texto. */
  text: (value) => ({ type: 'text', value }),
  /** Saludo ("Hola X,"). Va aparte para poder omitirlo si no hay nombre. */
  greeting: (value) => ({ type: 'greeting', value }),
  /** Codigo destacado (OTP). */
  code: (value) => ({ type: 'code', value }),
  /** Boton de accion. `url` debe venir ya validada por [assertSafeLink]. */
  button: (label, url) => ({ type: 'button', label, url }),
  /** El mismo enlace en texto, para clientes que no muestran el boton. */
  link: (url) => ({ type: 'link', url }),
  /** Nota fina al pie del contenido. */
  note: (value) => ({ type: 'note', value }),
});

// ---------------------------------------------------------------------------
// Plantillas
// ---------------------------------------------------------------------------

/**
 * Catalogo de plantillas.
 *
 * Cada entrada declara: asunto por locale, campos requeridos y los bloques del
 * cuerpo. Los textos estan reescritos a partir del legacy — se conserva **lo que
 * dicen**, no su HTML: las plantillas viejas eran tablas de maquetado de 2015
 * con SVGs de redes sociales incrustados.
 *
 * Fuente de cada texto en espanol: `locales/es.php` del legacy cuando existia la
 * clave; redaccion nueva cuando el legacy solo tenia ingles (los borradores de
 * resultado nunca se tradujeron).
 */
const TEMPLATES = Object.freeze({
  /**
   * Origen: `otp_email.php` (asunto `VIG Mortgage - {Verification_code}`,
   * cuerpo con la clave `Use_the_following_verification_code_…`).
   *
   * El codigo va en el cuerpo, nunca en el asunto: los asuntos aparecen en
   * notificaciones de pantalla de bloqueo y en logs de servidores de correo.
   * Por eso el resultado sale marcado con `containsSecret`.
   */
  [Template.OTP_CODE]: {
    requires: ['code'],
    containsSecret: true,
    subject: {
      es: `${BRAND.name} - Código de verificación`,
      en: `${BRAND.name} - Verification code`,
    },
    blocks: (data, locale) => {
      const minutos = Number(data.expiresInMinutes ?? 10);
      const bloques = [];
      if (data.name) bloques.push(Block.greeting(data.name));
      bloques.push(
        Block.text(
          locale === 'es'
            ? `Usa el siguiente código de verificación para tu solicitud en ${BRAND.name}. No lo compartas con nadie. Vence en ${minutos} minutos.`
            : `Use the following verification code for your application at ${BRAND.name}. Do not share it with anyone. It expires in ${minutos} minutes.`
        ),
        Block.code(data.code),
        Block.note(
          locale === 'es'
            ? 'Si no solicitaste este código, ignora este mensaje.'
            : 'If you did not request this code, please ignore this message.'
        )
      );
      return bloques;
    },
  },

  /**
   * Origen: `mail_corrobower.php`, la unica plantilla de invitacion que el
   * legacy usa de verdad.
   *
   * Diferencia importante con el legacy: alli el enlace era
   * `co-borrower.php?i={lead_id}&n={nombre}&t={tipo}` — el id del lead viajaba
   * en la URL y quien lo tuviera entraba a la solicitud. Aqui el enlace lo
   * construye el servicio con un token de invitacion de un solo uso, y esta
   * plantilla solo lo coloca despues de validarlo.
   */
  [Template.COBORROWER_INVITE]: {
    requires: ['inviteUrl'],
    links: ['inviteUrl'],
    subject: {
      es: `${BRAND.name} - Invitación para unirse a la solicitud de precalificación`,
      en: `${BRAND.name} - Invitation to join the pre-qualification application`,
    },
    blocks: (data, locale) => {
      const porQuien = data.applicantName ? String(data.applicantName) : null;
      const es = locale === 'es';
      return [
        Block.greeting(es ? 'Estimado(a) co-deudor(a)' : 'Dear Co-Borrower'),
        Block.text(
          es
            ? porQuien
              ? `Has sido incluido(a) como co-deudor en una solicitud de precalificación en ${BRAND.name} por ${porQuien}.`
              : `Has sido incluido(a) como co-deudor en una solicitud de precalificación en ${BRAND.name}.`
            : porQuien
              ? `You have been listed as a co-borrower in a prequalification request at ${BRAND.name} by ${porQuien}.`
              : `You have been listed as a co-borrower in a prequalification request at ${BRAND.name}.`
        ),
        Block.text(
          es
            ? 'Necesitamos que nos proporciones información adicional y que aceptes los términos y condiciones de la solicitud.'
            : 'We need you to provide additional information and to accept the terms and conditions of the request.'
        ),
        Block.button(es ? 'Comenzar ahora' : 'Start now', data.inviteUrl),
        Block.text(
          es
            ? 'Si el botón no funciona, copia y pega este enlace en tu navegador:'
            : 'If the button does not work, copy and paste this link into your browser:'
        ),
        Block.link(data.inviteUrl),
        Block.note(
          es
            ? 'El enlace te lleva a una página segura de nuestro sitio y caduca pasado un tiempo. Si no esperabas esta invitación, ignora este mensaje.'
            : 'The link takes you to a secure page on our site and expires after a while. If you were not expecting this invitation, please ignore this message.'
        ),
      ];
    },
  },

  /**
   * Origen: `mail_corrobower_congra.php`, que en el repo esta a medio hacer
   * (literalmente dice "[Customer Name]", "[insert amount here]", "[Your
   * name]"). Nunca se completo, asi que el texto de abajo es redaccion nueva
   * que respeta lo que el borrador pretendia decir.
   *
   * **No lleva monto ni score.** El score esta prohibido por CLAUDE.md; el monto
   * queda fuera porque un correo sin cifrar no es sitio para una cifra que el
   * solicitante puede tomar por un compromiso.
   *
   * TODO(Roberto): ¿el monto precalificado debe ir en el correo, o solo cuando
   * el oficial hipotecario contacte? El borrador legacy lo contemplaba.
   * TODO(Roberto): firma. Los borradores terminan en "[Your name] / [Your
   * position] / [Your e-mail]": decidir si firma un oficial concreto o el
   * equipo.
   */
  [Template.PREQUALIFIED]: {
    requires: [],
    subject: {
      es: `Resultado de tu solicitud de precalificación - ${BRAND.name}`,
      en: `Result of your prequalification request - ${BRAND.name}`,
    },
    blocks: (data, locale) => {
      const es = locale === 'es';
      const bloques = [];
      if (data.name) bloques.push(Block.greeting(data.name));
      bloques.push(
        Block.text(
          es
            ? 'Revisamos la información que nos proporcionaste y tu solicitud cumple con nuestros criterios de precalificación.'
            : 'We have reviewed the information you provided and your request meets our prequalification criteria.'
        ),
        Block.text(
          es
            ? 'Recuerda que una precalificación no es una aprobación de crédito ni una garantía de financiamiento: el resultado final depende de la verificación de documentos y de una solicitud formal.'
            : 'Please keep in mind that a prequalification is not a credit approval or a financing guarantee: the final result depends on document verification and a formal application.'
        ),
        Block.text(
          es
            ? 'En los próximos días un oficial hipotecario te contactará para explicarte los siguientes pasos.'
            : 'In the next few days a mortgage officer will contact you to explain the next steps.'
        )
      );
      // El pie con OCIF/NMLS lo pone [renderHtml] en todos los mensajes; no se
      // repite aqui.
      return bloques;
    },
  },

  /**
   * Origen: `mail_corrobower_rejected.php` (y su duplicado exacto
   * `congra_mail_corrobower.php`, que pese al nombre contiene el texto de
   * rechazo). Tambien es un borrador con marcadores sin rellenar.
   *
   * No se dan motivos ni cifras a proposito.
   *
   * TODO(Roberto): consultar con cumplimiento. Si esta precalificacion cuenta
   * como "adverse action" bajo ECOA / Regulation B (12 CFR 1002.9), el aviso
   * tiene contenido obligatorio (motivos concretos, aviso de la FCRA, datos del
   * bureau) y plazos, y no puede resolverse con un correo generico como este.
   * El legacy nunca lo trato; hay que confirmarlo antes de activar esta
   * plantilla en produccion.
   */
  [Template.NOT_PREQUALIFIED]: {
    requires: [],
    subject: {
      es: `Resultado de tu solicitud de precalificación - ${BRAND.name}`,
      en: `Result of your prequalification request - ${BRAND.name}`,
    },
    blocks: (data, locale) => {
      const es = locale === 'es';
      const bloques = [];
      if (data.name) bloques.push(Block.greeting(data.name));
      bloques.push(
        Block.text(
          es
            ? 'Gracias por el tiempo que dedicaste a completar tu solicitud de precalificación.'
            : 'Thank you for the time you spent completing your prequalification request.'
        ),
        Block.text(
          es
            ? 'Después de revisarla, no podemos precalificarte en este momento con la información que nos proporcionaste.'
            : 'After reviewing it, we are not able to prequalify you at this time with the information you provided.'
        ),
        Block.text(
          es
            ? 'Cada situación financiera es distinta y cambia con el tiempo. Puedes volver a solicitarlo más adelante.'
            : 'Every financial situation is different and changes over time. You are welcome to apply again later.'
        ),
        Block.text(
          es
            ? 'Si tienes preguntas sobre esta decisión, comunícate con nosotros y con gusto te orientamos.'
            : 'If you have questions about this decision, please contact us and we will gladly help you.'
        )
      );
      // El pie con OCIF/NMLS lo pone [renderHtml]; no se repite aqui.
      return bloques;
    },
  },

  /**
   * Sin equivalente legacy: el wizard viejo subia los documentos y no avisaba
   * nada. Se anade porque el solicitante sube una foto desde el movil y no
   * tiene otra forma de saber que llego.
   *
   * No lista los nombres de los archivos: son datos del solicitante y no
   * aportan nada en el correo.
   */
  [Template.DOCUMENTS_RECEIVED]: {
    requires: ['count'],
    subject: {
      es: `${BRAND.name} - Recibimos tus documentos`,
      en: `${BRAND.name} - We received your documents`,
    },
    blocks: (data, locale) => {
      const es = locale === 'es';
      const count = Number(data.count);
      if (!Number.isInteger(count) || count < 1) {
        throw new NotificationError(`count invalido: ${String(data.count)}`);
      }
      const bloques = [];
      if (data.name) bloques.push(Block.greeting(data.name));
      bloques.push(
        Block.text(
          es
            ? count === 1
              ? 'Recibimos 1 documento de tu solicitud de precalificación.'
              : `Recibimos ${count} documentos de tu solicitud de precalificación.`
            : count === 1
              ? 'We received 1 document for your prequalification request.'
              : `We received ${count} documents for your prequalification request.`
        ),
        Block.text(
          es
            ? 'No necesitas hacer nada más por ahora. Si falta algo, te lo pediremos.'
            : 'You do not need to do anything else for now. If anything is missing, we will let you know.'
        ),
        Block.note(
          es
            ? 'Nunca te pediremos tu número de seguro social ni contraseñas por correo.'
            : 'We will never ask for your social security number or passwords by email.'
        )
      );
      return bloques;
    },
  },
});

const TEMPLATE_NAMES = Object.freeze(Object.keys(TEMPLATES));

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function normalizeLocale(locale) {
  const value = String(locale ?? '').slice(0, 2).toLowerCase();
  return LOCALES.includes(value) ? value : DEFAULT_LOCALE;
}

/**
 * Unico punto del modulo que genera HTML.
 *
 * Cada valor pasa por [escapeHtml]. Los `url` ya vienen validados por
 * [assertSafeLink], pero se escapan igual: si manana se relaja la lista blanca,
 * el escape sigue impidiendo cerrar el atributo.
 *
 * HTML deliberadamente minimo y con estilos en linea: los clientes de correo no
 * aplican hojas externas y muchos ignoran `<style>`.
 */
function renderHtml(blocks, { locale, year }) {
  const partes = blocks.map((block) => {
    switch (block.type) {
      case 'greeting':
        return `<p>${escapeHtml(block.value)},</p>`;
      case 'text':
        return `<p>${escapeHtml(block.value)}</p>`;
      case 'code':
        return `<p style="font-size:28px;letter-spacing:4px;font-weight:bold">${escapeHtml(block.value)}</p>`;
      case 'button':
        return (
          `<p><a href="${escapeHtml(block.url)}" ` +
          'style="display:inline-block;padding:12px 24px;background:#166bab;color:#ffffff;text-decoration:none;border-radius:4px">' +
          `${escapeHtml(block.label)}</a></p>`
        );
      case 'link':
        return `<p><a href="${escapeHtml(block.url)}">${escapeHtml(block.url)}</a></p>`;
      case 'note':
        return `<p style="font-size:12px;color:#666666">${escapeHtml(block.value)}</p>`;
      default:
        throw new NotificationError(`Bloque desconocido: ${String(block.type)}`);
    }
  });

  const pie =
    `&copy; ${escapeHtml(year)} ${escapeHtml(BRAND.name)} | ` +
    `${escapeHtml(BRAND.ocifLicence)} | ${escapeHtml(BRAND.nmlsId)}`;

  return (
    `<div lang="${escapeHtml(locale)}" style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222222">` +
    partes.join('\n') +
    `\n<hr style="border:none;border-top:1px solid #dddddd">\n` +
    `<p style="font-size:12px;color:#666666">${pie}</p>` +
    '</div>'
  );
}

/**
 * Version en texto plano. No necesita escape (no hay markup que interpretar),
 * pero se manda siempre: un correo solo-HTML puntua peor en los filtros de spam
 * y hay clientes que no renderizan HTML.
 */
function renderText(blocks, { year }) {
  const partes = blocks.map((block) => {
    switch (block.type) {
      case 'greeting':
        return `${block.value},`;
      case 'button':
        return `${block.label}: ${block.url}`;
      case 'link':
        return block.url;
      default:
        return String(block.value ?? '');
    }
  });
  partes.push('---');
  partes.push(`(c) ${year} ${BRAND.name} | ${BRAND.ocifLicence} | ${BRAND.nmlsId}`);
  return partes.join('\n\n');
}

/**
 * Renderiza una plantilla.
 *
 * @param {object} input
 * @param {string} input.template una de [Template]
 * @param {'es'|'en'} [input.locale] por defecto [DEFAULT_LOCALE]
 * @param {object} [input.data] datos de la plantilla
 * @param {number} [input.year] ano del pie; por defecto el actual (inyectable
 *   para que los tests sean deterministas — el resto del modulo es puro)
 * @returns {{template: string, locale: string, subject: string, html: string,
 *            text: string, containsSecret: boolean}}
 *   `subject` sale ya libre de CR/LF; `html` con todo escapado.
 * @throws {NotificationError}
 */
function renderTemplate({ template, locale, data = {}, year } = {}) {
  const spec = Object.hasOwn(TEMPLATES, template) ? TEMPLATES[template] : null;
  if (!spec) {
    throw new NotificationError(
      `Plantilla desconocida: ${JSON.stringify(String(template))}`
    );
  }

  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    throw new NotificationError('data debe ser un objeto');
  }

  // Antes de nada: que no viaje nada que no deba.
  assertNoSensitiveData(data);

  for (const field of spec.requires ?? []) {
    if (data[field] === undefined || data[field] === null || data[field] === '') {
      throw new NotificationError(`Falta el campo requerido '${field}' para ${template}`);
    }
  }

  // Los enlaces se validan antes de construir bloques: si uno no pasa, no se
  // llega a renderizar nada.
  const safeData = { ...data };
  for (const field of spec.links ?? []) {
    safeData[field] = assertSafeLink(data[field]);
  }

  const loc = normalizeLocale(locale);
  const anio = Number.isInteger(year) ? year : new Date().getUTCFullYear();
  const blocks = spec.blocks(safeData, loc);

  // El asunto es constante por plantilla: nunca se interpola dato del cliente.
  // Aun asi pasa por el saneador, que es la garantia que piden las reglas y lo
  // que protege si manana alguien mete un nombre en el asunto.
  const subject = sanitizeHeaderValue(spec.subject[loc] ?? spec.subject[DEFAULT_LOCALE]);

  return {
    template,
    locale: loc,
    subject,
    html: renderHtml(blocks, { locale: loc, year: anio }),
    text: renderText(blocks, { year: anio }),
    containsSecret: Boolean(spec.containsSecret),
  };
}

/**
 * Mensaje de correo completo, listo para `notificationPort.notify`.
 *
 * Todas las cabeceras salen saneadas: `to` validado, `subject` sin CR/LF,
 * `from`/`replyTo` de constantes.
 *
 * @param {object} input
 * @param {string} input.to destinatario
 * @param {string} input.template
 * @param {'es'|'en'} [input.locale]
 * @param {object} [input.data]
 * @param {number} [input.year]
 * @returns {{to: string, from: string, replyTo: string, subject: string,
 *            html: string, text: string, template: string, locale: string,
 *            containsSecret: boolean}}
 * @throws {NotificationError}
 */
function buildEmailMessage({ to, template, locale, data, year } = {}) {
  const rendered = renderTemplate({ template, locale, data, year });
  const destinatario = assertEmailAddress(to);
  const remitente = `${sanitizeHeaderValue(BRAND.name)} <${BRAND.fromAddress}>`;

  return {
    ...rendered,
    to: destinatario,
    from: remitente,
    replyTo: BRAND.fromAddress,
  };
}

/**
 * Version corta para SMS/WhatsApp: sin HTML y de una sola pieza.
 *
 * Un SMS no tiene cabeceras que inyectar, pero si se sanea igual: el texto
 * puede acabar en un log o en una plantilla de WhatsApp.
 *
 * @returns {{template: string, locale: string, body: string, containsSecret: boolean}}
 */
function buildShortMessage({ template, locale, data, year } = {}) {
  const rendered = renderTemplate({ template, locale, data, year });
  const cuerpo = rendered.text
    .split('\n\n')
    .slice(0, 2)
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return {
    template: rendered.template,
    locale: rendered.locale,
    body: cuerpo.slice(0, 320),
    containsSecret: rendered.containsSecret,
  };
}

module.exports = {
  BRAND,
  LOCALES,
  DEFAULT_LOCALE,
  Template,
  TEMPLATES,
  TEMPLATE_NAMES,
  ALLOWED_LINK_HOSTS,
  FORBIDDEN_DATA_KEYS,
  NotificationError,
  sanitizeHeaderValue,
  escapeHtml,
  assertEmailAddress,
  assertSafeLink,
  assertNoSensitiveData,
  normalizeLocale,
  renderTemplate,
  buildEmailMessage,
  buildShortMessage,
};
