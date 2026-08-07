'use strict';

const defaultLogger = require('./logger');
const {
  sanitizeHeaderValue,
  assertEmailAddress,
} = require('./prequalify/notifications');

/**
 * Transporte de correo del backend: `nodemailer` con TLS **verificado siempre**.
 *
 * Reemplaza al cliente SMTP casero de `app.js` (`sendSmtpEmail`, ~70 lineas
 * sobre `net`/`tls`), que era un problema de seguridad en tres frentes:
 *
 * 1. `tls.connect(..., { rejectUnauthorized: false })` en `app.js:1112`. Con esa
 *    linea la conexion se cifra pero **no se verifica a quien**: cualquiera en
 *    la ruta puede presentar un certificado propio, recibir el `AUTH LOGIN` y
 *    quedarse con el usuario y la contrasena de SMTP2GO en base64 (que no es
 *    cifrado, es codificacion). Es un MITM de manual.
 * 2. En el camino normal (puerto 2525) ni siquiera habia TLS: `net.connect` en
 *    claro y `AUTH LOGIN` con la contrasena en base64 por la red. Nunca se
 *    emitia `STARTTLS`.
 * 3. La maquina de estados por pasos (`step === 0..9` sobre eventos `data`)
 *    asumia una respuesta por evento y un solo `250`; con respuestas partidas o
 *    multilinea se desincroniza, y el `resolve(true)` ocurria antes de que el
 *    servidor confirmara la cola. "Correo enviado" podia ser mentira.
 *
 * Que hace este modulo y que no:
 * - **Transporta.** No redacta. El asunto y el cuerpo los construye
 *   `lib/prequalify/notifications.js`, que ya escapa HTML, sanea CRLF y prohibe
 *   datos sensibles. La salida de `buildEmailMessage()` encaja tal cual en
 *   [sendMail].
 * - **No lee el entorno para obtener credenciales.** Llegan inyectadas desde el
 *   secreto `Mail` de Secrets Manager. Lo unico que se consulta de `process.env`
 *   es `NODE_TLS_REJECT_UNAUTHORIZED`, y solo para **abortar** si alguien lo
 *   puso a `0` (esa variable desactiva la verificacion de certificados de todo
 *   el proceso, incluidas S3, Salesforce y Experian).
 * - **No expone detalle al llamador.** El error que sale de aqui lleva un
 *   `publicMessage` generico; el detalle va a `lib/logger.js`, que redacta
 *   claves sensibles.
 *
 * TODO(Roberto): `sanitizeHeaderValue`/`escapeHtml` viven hoy en
 * `lib/prequalify/notifications.js` y los importa este modulo, que es generico.
 * Cuando se extraiga `support` de `app.js` conviene moverlos a un `lib/text.js`
 * compartido; mientras tanto se importan de alli para no tener dos criterios de
 * saneado distintos en el mismo backend.
 */

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/**
 * Puerto por defecto: 587 (submission con STARTTLS obligatorio).
 *
 * El legacy usaba 2525 con el comentario "puerto SMTP alternativo de SMTP2GO
 * seguro" — 2525 es el puerto alternativo de SMTP2GO, pero no es seguro por si
 * mismo: es submission en claro salvo que se negocie STARTTLS, que es
 * exactamente lo que el cliente casero no hacia. Aqui cualquier puerto que no
 * sea 465 exige STARTTLS ([buildTransportOptions]).
 */
const DEFAULT_PORT = 587;

/** Puerto de SMTPS (TLS implicito desde el primer byte). */
const IMPLICIT_TLS_PORT = 465;

/**
 * Tope de destinatarios por envio.
 *
 * Este backend manda notificaciones transaccionales: uno, dos con copia al
 * co-deudor. Un envio con veinte destinatarios significa que alguien logro
 * empujar una lista desde fuera, y en ese caso preferimos fallar.
 */
const MAX_RECIPIENTS = 5;

/** Un asunto mas largo que esto no es un asunto. Limite de linea SMTP: 998. */
const MAX_SUBJECT_LENGTH = 255;

/** Campos aceptados en el mensaje. Todo lo demas se rechaza (ver [buildEnvelope]). */
const ALLOWED_MESSAGE_FIELDS = Object.freeze([
  'to',
  'from',
  'replyTo',
  'subject',
  'html',
  'text',
]);

/**
 * CR, LF, el resto de caracteres de control y los separadores de linea Unicode.
 * Mismo criterio que `sanitizeHeaderValue` de `notifications.js`, aqui en forma
 * de **deteccion** porque en una direccion no se limpia: se rechaza.
 */
// Se construye desde cadena para que no haya caracteres de control literales en el fuente.
const CONTROL_CHAR_RE = new RegExp('[\u0000-\u001f\u007f\u2028\u2029]');

/** Hostname razonable. El host viene del secreto, pero se valida igual. */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

/**
 * Sigue la convencion de `middleware/errorHandler.js`: `status` fija el codigo
 * HTTP y `publicMessage` es lo unico que ve el cliente. El detalle (host, codigo
 * SMTP, respuesta del servidor) queda en el `message` y en `cause`, para el log.
 */
class MailerError extends Error {
  /**
   * @param {string} message detalle interno; nunca se envia al cliente
   * @param {object} [options]
   * @param {string} [options.code] `MAILER_CONFIG` (mal cableado) | `MAILER_MESSAGE`
   *   (mensaje invalido) | `MAILER_TRANSPORT` (fallo el envio)
   * @param {number} [options.status]
   * @param {string} [options.publicMessage]
   * @param {unknown} [options.cause]
   */
  constructor(message, { code = 'MAILER_TRANSPORT', status = 502, publicMessage, cause } = {}) {
    super(message);
    this.name = 'MailerError';
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage || 'No pudimos enviar el correo en este momento.';
    if (cause !== undefined) this.cause = cause;
  }
}

/** Error de configuracion: el modulo esta mal cableado. Falla en claro y pronto. */
function configError(message) {
  return new MailerError(message, {
    code: 'MAILER_CONFIG',
    status: 500,
    publicMessage: 'El servicio de correo no está disponible.',
  });
}

/** Error del mensaje: lo que se pidio enviar no es valido (o es un ataque). */
function messageError(message, cause) {
  return new MailerError(message, {
    code: 'MAILER_MESSAGE',
    status: 400,
    publicMessage: 'No pudimos enviar el correo: datos inválidos.',
    cause,
  });
}

// ---------------------------------------------------------------------------
// Cabeceras
// ---------------------------------------------------------------------------

/**
 * Valida una direccion que va a una cabecera (`From`, `To`, `Reply-To`).
 *
 * Acepta `usuario@dominio` y `Nombre Visible <usuario@dominio>`.
 *
 * Criterio, el mismo que `notifications.assertEmailAddress`: en una direccion
 * **no se sanea, se rechaza**. Un `\r\n` dentro de un `Reply-To` no es un dato
 * mal escrito, es `Reply-To: x@y\r\nBcc: victima@ejemplo.com` — el ataque que el
 * SMTP casero permitia, porque escribia el valor directo en el socket
 * (`app.js:1091`). Limpiarlo y enviar igual seria mandar el correo a un destino
 * que nadie pidio.
 *
 * @param {unknown} value
 * @param {string} field nombre del campo, para el mensaje de error
 * @returns {string} la direccion normalizada
 * @throws {MailerError}
 */
function assertHeaderAddress(value, field) {
  const raw = String(value ?? '');

  if (CONTROL_CHAR_RE.test(raw)) {
    // El valor NO se incluye en el error: acabaria en el log con el payload.
    throw messageError(`Caracteres de control (CR/LF) en '${field}': posible inyección de cabeceras`);
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) throw messageError(`'${field}' vacío`);
  if (trimmed.length > 320) throw messageError(`'${field}' excede la longitud permitida`);

  // Varias direcciones en un solo campo se rechazan: cada destinatario entra
  // como elemento del array `to`, nunca separado por comas dentro de la cadena.
  const match = /^(.*?)\s*<([^<>]*)>$/.exec(trimmed);
  const address = match ? match[2].trim() : trimmed;
  const display = match ? match[1].replace(/^"|"$/g, '').trim() : '';

  let verified;
  try {
    // Reutiliza el criterio de notifications.js (formato + longitud + control).
    verified = assertEmailAddress(address);
  } catch (err) {
    throw messageError(`Dirección inválida en '${field}'`, err);
  }

  if (!display) return verified;
  return `${formatDisplayName(sanitizeHeaderValue(display))} <${verified}>`;
}

/**
 * Entrecomilla el nombre visible si lleva algo que un parser de cabeceras podria
 * interpretar (`<`, `>`, `,`, `:`, acentos…). `nodemailer` tambien codifica, pero
 * no se delega la seguridad en el: el valor sale ya inequivoco de aqui.
 */
function formatDisplayName(name) {
  if (/^[A-Za-z0-9 ._-]+$/.test(name)) return name;
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Deja un asunto apto para la cabecera `Subject`.
 *
 * Aqui si se **sanea** en vez de rechazar (criterio de
 * `notifications.sanitizeHeaderValue`): el asunto es texto libre y un salto de
 * linea puede venir de un formulario legitimo, mientras que en una direccion
 * nunca es legitimo.
 *
 * @throws {MailerError} si queda vacio o es absurdamente largo
 */
function assertSubject(value) {
  const subject = sanitizeHeaderValue(value);
  if (subject.length === 0) throw messageError("'subject' vacío");
  if (subject.length > MAX_SUBJECT_LENGTH) {
    throw messageError(`'subject' excede ${MAX_SUBJECT_LENGTH} caracteres`);
  }
  return subject;
}

// ---------------------------------------------------------------------------
// Credenciales y opciones de transporte
// ---------------------------------------------------------------------------

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

/**
 * Normaliza el secreto `Mail` a la forma que espera `nodemailer`.
 *
 * Acepta las dos formas para que el cableado no necesite un mapeo intermedio:
 * la del secreto tal cual (`MAIL_HOST`, `MAIL_PORT`, `MAIL_USERNAME`,
 * `MAIL_PASSWORD`, `MAIL_FROM`) y la corta (`host`, `port`, `user`, `pass`,
 * `from`).
 *
 * **No hay valores por defecto para host, usuario ni contrasena.** El `app.js`
 * viejo caia a `'mail.smtp2go.com'` y `'vigmortgage'` cuando el secreto no
 * cargaba (`app.js:995-997`): un fallo al leer Secrets Manager quedaba
 * disimulado y el envio fallaba mas tarde y peor. Aqui, si falta algo, se rompe
 * al construir el mailer.
 *
 * @throws {MailerError} codigo `MAILER_CONFIG`
 */
function normalizeCredentials(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw configError('createMailer requiere `credentials` (el objeto del secreto Mail)');
  }

  const host = firstDefined(raw.host, raw.MAIL_HOST);
  const port = firstDefined(raw.port, raw.MAIL_PORT, DEFAULT_PORT);
  const user = firstDefined(raw.user, raw.username, raw.MAIL_USERNAME);
  const pass = firstDefined(raw.pass, raw.password, raw.MAIL_PASSWORD);
  const from = firstDefined(raw.from, raw.MAIL_FROM);

  // El nombre del campo que falta si es util; el valor jamas.
  const faltan = [];
  if (!host) faltan.push('host/MAIL_HOST');
  if (!user) faltan.push('user/MAIL_USERNAME');
  if (!pass) faltan.push('pass/MAIL_PASSWORD');
  if (faltan.length > 0) {
    throw configError(`Credenciales de correo incompletas, faltan: ${faltan.join(', ')}`);
  }

  const hostname = String(host).trim().toLowerCase();
  if (!HOSTNAME_RE.test(hostname)) {
    throw configError(`Host SMTP inválido: ${JSON.stringify(hostname)}`);
  }

  const puerto = Number(port);
  if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) {
    throw configError(`Puerto SMTP inválido: ${JSON.stringify(String(port))}`);
  }

  if (typeof user !== 'string' || typeof pass !== 'string') {
    throw configError('Usuario y contraseña de SMTP deben ser cadenas');
  }

  return { host: hostname, port: puerto, user, pass, from };
}

/**
 * Rechaza cualquier opcion del secreto que debilite TLS.
 *
 * El objetivo es que **no exista una forma de configurar este modulo sin
 * verificacion de certificado**. Si manana alguien mete
 * `{"tls":{"rejectUnauthorized":false}}` en el secreto para "arreglar" un error
 * de certificado, el backend no arranca el envio: falla con un mensaje que dice
 * exactamente que hizo mal. Es el fallo que se esta corrigiendo, y la unica
 * manera de que no vuelva es que no se pueda expresar.
 *
 * @throws {MailerError} codigo `MAILER_CONFIG`
 */
function assertNoTlsDowngrade(raw, port) {
  const prohibido = (opcion) =>
    configError(
      `TLS no es opcional: ${opcion}. Prohibido por CLAUDE.md; si el certificado del ` +
        'servidor SMTP no valida, se arregla el certificado o el host, no la verificación.'
    );

  if (raw.tls && typeof raw.tls === 'object') {
    if (raw.tls.rejectUnauthorized === false) throw prohibido('tls.rejectUnauthorized:false');
    if (typeof raw.tls.checkServerIdentity === 'function') {
      // Un checkServerIdentity propio es la otra manera de apagar la
      // verificacion del nombre del host sin tocar rejectUnauthorized.
      throw prohibido('tls.checkServerIdentity personalizado');
    }
  }
  if (raw.rejectUnauthorized === false) throw prohibido('rejectUnauthorized:false');
  if (raw.ignoreTLS === true) throw prohibido('ignoreTLS:true');
  if (raw.requireTLS === false) throw prohibido('requireTLS:false');
  if (raw.secure === false && port === IMPLICIT_TLS_PORT) {
    throw prohibido(`secure:false en el puerto ${IMPLICIT_TLS_PORT}`);
  }

  const cifrado = firstDefined(raw.encryption, raw.MAIL_ENCRYPTION);
  if (cifrado !== undefined) {
    const valor = String(cifrado).trim().toLowerCase();
    if (['none', 'null', 'off', 'false', 'no', 'plain'].includes(valor)) {
      throw prohibido(`MAIL_ENCRYPTION=${JSON.stringify(valor)}`);
    }
  }
}

/**
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` desactiva la verificacion de certificados de
 * **todo el proceso**: S3, Secrets Manager, Salesforce, Experian y este correo.
 * Es un `rejectUnauthorized:false` global, asi que se comprueba aunque el
 * transporte venga inyectado.
 *
 * Es la unica lectura de `process.env` del modulo, y es para abortar, no para
 * configurar.
 */
function assertGlobalTlsVerification(env) {
  const flag = env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (flag !== undefined && String(flag).trim() === '0') {
    throw configError(
      'NODE_TLS_REJECT_UNAUTHORIZED=0 desactiva la verificación TLS de todo el proceso. ' +
        'Quítala del entorno antes de enviar correo.'
    );
  }
}

/**
 * Opciones de `nodemailer.createTransport`, con TLS cerrado.
 *
 * - Puerto 465 → `secure:true` (TLS implicito).
 * - Cualquier otro puerto → `requireTLS:true`: se emite `STARTTLS` y **si el
 *   servidor no lo ofrece, el envio falla**. Sin esta linea `nodemailer` haria
 *   STARTTLS "si se puede", y un atacante que borre la capacidad del `EHLO`
 *   consigue que el correo salga en claro (STARTTLS stripping).
 * - `rejectUnauthorized:true` y `minVersion:'TLSv1.2'` explicitos. Son el valor
 *   por defecto de Node, pero se escriben para que quede a la vista en la
 *   revision y para que un cambio de default no nos afecte.
 * - `servername` para que la verificacion del nombre use el host configurado.
 *
 * Exportada para poder auditarla en tests sin abrir un socket.
 *
 * @param {object} raw credenciales tal cual llegan del secreto
 * @returns {object} opciones de transporte (la contrasena va en `auth.pass`)
 */
function buildTransportOptions(raw) {
  const { host, port, user, pass } = normalizeCredentials(raw);
  assertNoTlsDowngrade(raw, port);

  const secure = port === IMPLICIT_TLS_PORT || raw.secure === true;

  return {
    host,
    port,
    secure,
    // En 465 el TLS ya es implicito; en el resto, STARTTLS obligatorio.
    requireTLS: !secure,
    auth: { user, pass },
    tls: {
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      servername: host,
    },
    // El cliente casero no tenia timeouts: un servidor que no respondia dejaba
    // la promesa colgada para siempre y con ella la peticion HTTP.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  };
}

// ---------------------------------------------------------------------------
// Mensaje
// ---------------------------------------------------------------------------

/**
 * Convierte el mensaje del llamador en un sobre con todas las cabeceras ya
 * verificadas.
 *
 * Rechaza campos que no esten en [ALLOWED_MESSAGE_FIELDS]. En particular no hay
 * `bcc` ni `headers`: si el llamador pudiera pasar cabeceras arbitrarias, todo
 * el saneado de arriba seria decorativo — la copia oculta es justo el premio de
 * una inyeccion de cabeceras. Cuando haga falta copia, se anade aqui con
 * validacion, no por la puerta de atras.
 *
 * @throws {MailerError} codigo `MAILER_MESSAGE`
 */
function buildEnvelope(message, defaults = {}) {
  if (message == null || typeof message !== 'object' || Array.isArray(message)) {
    throw messageError('sendMail espera un objeto mensaje');
  }

  const desconocidos = Object.keys(message).filter((k) => !ALLOWED_MESSAGE_FIELDS.includes(k));
  if (desconocidos.length > 0) {
    throw messageError(
      `Campos no permitidos en el mensaje: ${desconocidos.join(', ')}. ` +
        `Permitidos: ${ALLOWED_MESSAGE_FIELDS.join(', ')}`
    );
  }

  const destinatarios = Array.isArray(message.to) ? message.to : [message.to];
  if (destinatarios.length === 0) throw messageError("'to' vacío");
  if (destinatarios.length > MAX_RECIPIENTS) {
    throw messageError(`Demasiados destinatarios (${destinatarios.length} > ${MAX_RECIPIENTS})`);
  }
  const to = destinatarios.map((address) => assertHeaderAddress(address, 'to'));

  const from = assertHeaderAddress(firstDefined(message.from, defaults.from), 'from');

  const replyToRaw = firstDefined(message.replyTo, defaults.replyTo);
  const replyTo = replyToRaw === undefined ? undefined : assertHeaderAddress(replyToRaw, 'replyTo');

  const subject = assertSubject(message.subject);

  const html = typeof message.html === 'string' && message.html.length > 0 ? message.html : undefined;
  const text = typeof message.text === 'string' && message.text.length > 0 ? message.text : undefined;
  if (!html && !text) throw messageError('El mensaje no tiene cuerpo (html o text)');

  const envelope = { from, to, subject };
  if (replyTo) envelope.replyTo = replyTo;
  if (html) envelope.html = html;
  if (text) envelope.text = text;
  return envelope;
}

/**
 * Dominios de los destinatarios, para el log.
 *
 * La direccion completa es PII y no se registra; el dominio basta para
 * diagnosticar ("todos los fallos son a @gmail.com") sin guardar a quien se le
 * escribio.
 */
function recipientDomains(to) {
  const dominios = to.map((address) => {
    const limpio = address.replace(/^.*<|>$/g, '');
    const at = limpio.lastIndexOf('@');
    return at === -1 ? 'desconocido' : limpio.slice(at + 1).toLowerCase();
  });
  return [...new Set(dominios)];
}

// ---------------------------------------------------------------------------
// Fabrica
// ---------------------------------------------------------------------------

/**
 * Carga `nodemailer` de forma perezosa.
 *
 * Perezosa a proposito: mientras el cableado no este hecho, requerir el modulo
 * al arrancar tumbaria el backend entero por una dependencia que aun no se usa.
 * Cuando falta, el error dice que instalar.
 */
function loadNodemailerCreateTransport() {
  try {
    // eslint-disable-next-line global-require
    return require('nodemailer').createTransport;
  } catch (err) {
    throw new MailerError(
      "Falta la dependencia 'nodemailer'. Instálala con: pnpm add nodemailer",
      { code: 'MAILER_CONFIG', status: 500, publicMessage: 'El servicio de correo no está disponible.', cause: err }
    );
  }
}

/**
 * Construye el mailer.
 *
 * @param {object} options
 * @param {object} [options.credentials] secreto `Mail` (`MAIL_HOST`, `MAIL_PORT`,
 *   `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_FROM`) o su forma corta
 *   (`host`/`port`/`user`/`pass`/`from`). Obligatorio salvo que se inyecte
 *   `transport`. **Nunca se lee del entorno aquí.**
 * @param {{sendMail: Function, verify?: Function}} [options.transport] transporte
 *   ya construido. Es el punto de inyeccion para los tests: con el, el modulo se
 *   prueba entero sin red y sin `nodemailer` instalado.
 * @param {(opts: object) => object} [options.createTransport] fabrica alternativa
 *   (por defecto `nodemailer.createTransport`). Util para auditar las opciones
 *   de TLS que se pasan.
 * @param {{from?: string, replyTo?: string}} [options.defaults] cabeceras por
 *   defecto. `from` cae al `MAIL_FROM` del secreto si no se indica.
 * @param {object} [options.logger] por defecto `lib/logger.js` (redacta claves
 *   sensibles).
 * @param {object} [options.env] solo para tests; por defecto `process.env`.
 * @returns {{sendMail: Function, verify: Function, describe: Function}}
 * @throws {MailerError} codigo `MAILER_CONFIG` si el cableado no es seguro
 *
 * @example
 *   const { buildEmailMessage } = require('./prequalify/notifications');
 *   const mailer = createMailer({ credentials: await getSecret('Mail') });
 *   await mailer.sendMail(buildEmailMessage({ to, template, locale, data }));
 */
function createMailer({
  credentials,
  transport,
  createTransport,
  defaults = {},
  logger = defaultLogger,
  env = process.env,
} = {}) {
  // Se comprueba siempre, incluso con transporte inyectado: la variable apaga la
  // verificacion de todo el proceso, no solo de este transporte.
  assertGlobalTlsVerification(env);

  let transportOptions = null;
  const credentialDefaults = {};

  // Se validan las credenciales siempre que se aporten, aunque el transporte
  // venga inyectado: un secreto incompleto o con TLS relajado tiene que
  // romperse al cablear, no en el primer correo de un usuario real.
  if (credentials !== undefined || !transport) {
    transportOptions = buildTransportOptions(credentials);
    const normalized = normalizeCredentials(credentials);
    if (normalized.from) credentialDefaults.from = normalized.from;
  }

  const cabecerasPorDefecto = { ...credentialDefaults, ...defaults };

  // Se valida ya, para no descubrir un `from` con CRLF en el primer envio.
  if (cabecerasPorDefecto.from) {
    cabecerasPorDefecto.from = assertHeaderAddress(cabecerasPorDefecto.from, 'defaults.from');
  }
  if (cabecerasPorDefecto.replyTo) {
    cabecerasPorDefecto.replyTo = assertHeaderAddress(cabecerasPorDefecto.replyTo, 'defaults.replyTo');
  }

  let instancia = transport || null;

  function resolveTransport() {
    if (instancia) return instancia;
    const factory = createTransport || loadNodemailerCreateTransport();
    instancia = factory(transportOptions);
    return instancia;
  }

  /**
   * Datos no sensibles del transporte, para logs y para un endpoint de salud.
   * Nunca incluye `auth`: la contrasena no sale de `transportOptions`.
   */
  function describe() {
    if (!transportOptions) return { injected: true };
    const info = {
      host: transportOptions.host,
      port: transportOptions.port,
      secure: transportOptions.secure,
      requireTLS: transportOptions.requireTLS,
      rejectUnauthorized: transportOptions.tls.rejectUnauthorized,
    };
    // Marca el caso de test: hay credenciales validadas pero el envio real lo
    // hace un transporte inyectado, no el que describen esas opciones.
    if (transport) info.injected = true;
    return info;
  }

  /**
   * Envia un mensaje ya redactado.
   *
   * Encaja con la salida de `notifications.buildEmailMessage()`.
   *
   * @param {object} message
   * @param {string|string[]} message.to
   * @param {string} [message.from] cae a `defaults.from` / `MAIL_FROM`
   * @param {string} [message.replyTo]
   * @param {string} message.subject se sanea (CRLF fuera)
   * @param {string} [message.html] cuerpo; ya escapado por quien lo redacto
   * @param {string} [message.text]
   * @returns {Promise<{messageId: string|null}>}
   * @throws {MailerError} el llamador solo ve `publicMessage`
   */
  async function sendMail(message) {
    const envelope = buildEnvelope(message, cabecerasPorDefecto);
    const contexto = {
      ...describe(),
      recipients: envelope.to.length,
      recipientDomains: recipientDomains(envelope.to),
    };

    let info;
    try {
      info = await resolveTransport().sendMail(envelope);
    } catch (err) {
      // El detalle va al log; al llamador, `publicMessage` generico. Nunca se
      // registran `subject`, `html` ni `text`: el cuerpo puede llevar un OTP, un
      // enlace de invitacion de un solo uso o datos del solicitante, y un log se
      // copia a sitios donde un correo no deberia estar.
      logger.error('mailer: falló el envío', {
        ...contexto,
        errorCode: err?.code,
        responseCode: err?.responseCode,
        errorMessage: err?.message,
      });
      throw new MailerError(`Fallo al enviar correo vía ${contexto.host ?? 'transporte inyectado'}`, {
        code: 'MAILER_TRANSPORT',
        status: 502,
        cause: err,
      });
    }

    const messageId = typeof info?.messageId === 'string' ? info.messageId : null;
    logger.info('mailer: correo enviado', { ...contexto, messageId });
    return { messageId };
  }

  /**
   * Comprueba la conexion y las credenciales sin enviar nada. Util en el
   * arranque o en un endpoint de salud.
   *
   * @returns {Promise<boolean>}
   */
  async function verify() {
    const t = resolveTransport();
    if (typeof t.verify !== 'function') return true;
    try {
      await t.verify();
      return true;
    } catch (err) {
      logger.error('mailer: verificación de transporte fallida', {
        ...describe(),
        errorCode: err?.code,
        errorMessage: err?.message,
      });
      throw new MailerError('Verificación del transporte SMTP fallida', {
        code: 'MAILER_TRANSPORT',
        status: 502,
        cause: err,
      });
    }
  }

  return { sendMail, verify, describe };
}

module.exports = {
  DEFAULT_PORT,
  IMPLICIT_TLS_PORT,
  MAX_RECIPIENTS,
  MAX_SUBJECT_LENGTH,
  ALLOWED_MESSAGE_FIELDS,
  MailerError,
  sanitizeHeaderValue,
  assertHeaderAddress,
  assertSubject,
  normalizeCredentials,
  buildTransportOptions,
  buildEnvelope,
  createMailer,
};
