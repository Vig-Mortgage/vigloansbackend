'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const notif = require('../lib/prequalify/notifications');

/**
 * Igual que en documentos, la mayoria de estos tests son de seguridad: el
 * legacy montaba el correo concatenando `$_POST` dentro de 400 lineas de HTML
 * (`mail_corrobower.php`), sin escapar nada y sin filtrar CR/LF.
 *
 * El ano se pasa siempre explicito para que el render sea determinista.
 */
const YEAR = 2026;

/** Payload clasico de inyeccion de cabeceras SMTP. */
const CRLF_PAYLOAD = 'Ana\r\nBcc: victima@ejemplo.com\r\nSubject: Regalo gratis';
/** Payload clasico de XSS. */
const XSS_PAYLOAD = '<script>alert("xss")</script>';

const INVITE_URL = 'https://prequalify.vigpr.com/invitacion?t=abc123';

/** Datos minimos validos por plantilla. */
const DATOS_VALIDOS = {
  [notif.Template.OTP_CODE]: { code: '123456', expiresInMinutes: 10 },
  [notif.Template.COBORROWER_INVITE]: { applicantName: 'Ana Rivera', inviteUrl: INVITE_URL },
  [notif.Template.PREQUALIFIED]: { name: 'Ana Rivera' },
  [notif.Template.NOT_PREQUALIFIED]: { name: 'Ana Rivera' },
  [notif.Template.DOCUMENTS_RECEIVED]: { name: 'Ana Rivera', count: 3 },
};

function render(template, extra = {}, locale = 'es') {
  return notif.renderTemplate({
    template,
    locale,
    data: { ...DATOS_VALIDOS[template], ...extra },
    year: YEAR,
  });
}

// ---------------------------------------------------------------------------
// Cobertura basica del catalogo
// ---------------------------------------------------------------------------

test('todas las plantillas renderizan en es y en en', () => {
  assert.deepEqual(
    [...notif.TEMPLATE_NAMES].sort(),
    [...Object.values(notif.Template)].sort()
  );

  for (const template of notif.TEMPLATE_NAMES) {
    for (const locale of notif.LOCALES) {
      const mensaje = notif.renderTemplate({
        template,
        locale,
        data: DATOS_VALIDOS[template],
        year: YEAR,
      });
      assert.equal(mensaje.template, template);
      assert.equal(mensaje.locale, locale);
      assert.ok(mensaje.subject.length > 0, `${template}/${locale}: asunto vacio`);
      assert.ok(mensaje.html.includes('<div lang='), `${template}/${locale}: html vacio`);
      assert.ok(mensaje.text.length > 0, `${template}/${locale}: texto vacio`);
      // Pie regulatorio obligatorio en toda comunicacion del originador.
      assert.ok(mensaje.html.includes(notif.BRAND.nmlsId), `${template}/${locale}: falta NMLS`);
      assert.ok(mensaje.html.includes(notif.BRAND.ocifLicence), `${template}/${locale}: falta OCIF`);
      assert.ok(mensaje.html.includes(String(YEAR)));
    }
  }
});

test('el asunto cambia con el locale (no se manda ingles a quien pidio espanol)', () => {
  for (const template of notif.TEMPLATE_NAMES) {
    const es = notif.renderTemplate({ template, locale: 'es', data: DATOS_VALIDOS[template], year: YEAR });
    const en = notif.renderTemplate({ template, locale: 'en', data: DATOS_VALIDOS[template], year: YEAR });
    assert.notEqual(es.subject, en.subject, template);
    assert.notEqual(es.text, en.text, template);
  }
});

test('locale: se normaliza y cae al predeterminado si no se soporta', () => {
  assert.equal(notif.normalizeLocale('es-PR'), 'es');
  assert.equal(notif.normalizeLocale('EN'), 'en');
  assert.equal(notif.normalizeLocale('fr'), notif.DEFAULT_LOCALE);
  assert.equal(notif.normalizeLocale(undefined), notif.DEFAULT_LOCALE);
  assert.equal(notif.normalizeLocale(null), notif.DEFAULT_LOCALE);
  assert.equal(notif.normalizeLocale(42), notif.DEFAULT_LOCALE);
  // Puerto Rico: el predeterminado es espanol (el legacy caia en ingles).
  assert.equal(notif.DEFAULT_LOCALE, 'es');
});

// ---------------------------------------------------------------------------
// ATAQUE: inyeccion de cabeceras SMTP (CRLF)
// ---------------------------------------------------------------------------

test('ATAQUE CRLF: sanitizeHeaderValue elimina CR, LF y controles', () => {
  assert.equal(
    notif.sanitizeHeaderValue(CRLF_PAYLOAD),
    'Ana Bcc: victima@ejemplo.com Subject: Regalo gratis'
  );
  assert.ok(!notif.sanitizeHeaderValue(CRLF_PAYLOAD).includes('\r'));
  assert.ok(!notif.sanitizeHeaderValue(CRLF_PAYLOAD).includes('\n'));

  assert.equal(notif.sanitizeHeaderValue('a\u0000b'), 'a b');
  assert.equal(notif.sanitizeHeaderValue('a\tb'), 'a b');
  // U+2028/U+2029: algunos clientes los tratan como salto de linea.
  assert.equal(notif.sanitizeHeaderValue('a\u2028b'), 'a b');
  assert.equal(notif.sanitizeHeaderValue('  hola  '), 'hola');
  assert.equal(notif.sanitizeHeaderValue(null), '');
  assert.equal(notif.sanitizeHeaderValue(undefined), '');
});

test('ATAQUE CRLF: ningun asunto contiene CR/LF, aunque los datos vengan envenenados', () => {
  const veneno = {
    name: CRLF_PAYLOAD,
    applicantName: CRLF_PAYLOAD,
    code: '123456\r\nBcc: victima@ejemplo.com',
    count: 3,
    inviteUrl: INVITE_URL,
  };

  for (const template of notif.TEMPLATE_NAMES) {
    for (const locale of notif.LOCALES) {
      const mensaje = notif.renderTemplate({
        template,
        locale,
        data: { ...DATOS_VALIDOS[template], ...veneno },
        year: YEAR,
      });
      assert.ok(!/[\r\n]/.test(mensaje.subject), `${template}/${locale}: CRLF en el asunto`);
      assert.ok(
        !mensaje.subject.toLowerCase().includes('bcc:'),
        `${template}/${locale}: cabecera inyectada en el asunto`
      );
    }
  }
});

test('ATAQUE CRLF: una direccion destino con salto de linea se RECHAZA, no se limpia', () => {
  // Limpiarla y seguir seria enviar a un destino que nadie pidio.
  for (const destino of [
    'ana@ejemplo.com\r\nBcc: victima@ejemplo.com',
    'ana@ejemplo.com\nCc: otro@ejemplo.com',
    'ana@ejemplo.com\u0000',
    'ana@ejemplo.com, otro@ejemplo.com',
    'Ana <ana@ejemplo.com>',
    'ana@ejemplo',
    'ana ejemplo.com',
    '',
    null,
    `${'a'.repeat(250)}@ejemplo.com`,
  ]) {
    assert.throws(
      () => notif.assertEmailAddress(destino),
      (err) => err instanceof notif.NotificationError && err.status === 400,
      `deberia rechazar: ${JSON.stringify(String(destino))}`
    );
  }
  assert.equal(notif.assertEmailAddress('  ana@ejemplo.com '), 'ana@ejemplo.com');
});

test('ATAQUE CRLF: buildEmailMessage entrega cabeceras limpias', () => {
  const mensaje = notif.buildEmailMessage({
    to: 'ana@ejemplo.com',
    template: notif.Template.COBORROWER_INVITE,
    locale: 'es',
    data: { applicantName: CRLF_PAYLOAD, inviteUrl: INVITE_URL },
    year: YEAR,
  });

  for (const cabecera of [mensaje.to, mensaje.from, mensaje.replyTo, mensaje.subject]) {
    assert.ok(!/[\r\n]/.test(cabecera), `CRLF en cabecera: ${JSON.stringify(cabecera)}`);
  }
  assert.equal(mensaje.to, 'ana@ejemplo.com');
  assert.equal(mensaje.replyTo, notif.BRAND.fromAddress);
  assert.ok(mensaje.from.includes(notif.BRAND.fromAddress));

  assert.throws(
    () =>
      notif.buildEmailMessage({
        to: 'ana@ejemplo.com\r\nBcc: victima@ejemplo.com',
        template: notif.Template.PREQUALIFIED,
        data: {},
        year: YEAR,
      }),
    notif.NotificationError
  );
});

// ---------------------------------------------------------------------------
// ATAQUE: XSS / inyeccion de markup en el cuerpo
// ---------------------------------------------------------------------------

test('ATAQUE XSS: escapeHtml cubre los cinco caracteres', () => {
  assert.equal(
    notif.escapeHtml('<a href="x" onclick=\'y\'>&</a>'),
    '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;'
  );
  assert.equal(notif.escapeHtml(null), '');
});

test('ATAQUE XSS: el nombre del solicitante se escapa en el cuerpo HTML', () => {
  const mensaje = render(notif.Template.PREQUALIFIED, { name: XSS_PAYLOAD });

  assert.ok(!mensaje.html.includes('<script>'), mensaje.html);
  assert.ok(mensaje.html.includes('&lt;script&gt;'), mensaje.html);
  // La comilla doble tambien, o se puede cerrar un atributo.
  assert.ok(!mensaje.html.includes('alert("xss")'));
  assert.ok(mensaje.html.includes('alert(&quot;xss&quot;)'));
});

test('ATAQUE XSS: ningun dato del cliente puede introducir una etiqueta', () => {
  const veneno = {
    name: '"><img src=x onerror=alert(1)>',
    applicantName: '</p><iframe src="javascript:alert(1)"></iframe>',
    code: '<b>000000</b>',
    count: 2,
    inviteUrl: INVITE_URL,
  };

  for (const template of notif.TEMPLATE_NAMES) {
    const mensaje = notif.renderTemplate({
      template,
      locale: 'es',
      data: { ...DATOS_VALIDOS[template], ...veneno },
      year: YEAR,
    });
    // Criterio fuerte: las UNICAS etiquetas del correo son las que emite
    // [renderHtml]. Si un dato del cliente hubiera abierto una etiqueta, aqui
    // apareceria. Comprobar cadenas sueltas ('<img', 'onerror=') no valdria:
    // un `onerror=` ya escapado es texto inerte y daria un falso positivo.
    const etiquetas = new Set(
      [...mensaje.html.matchAll(/<\/?([a-zA-Z0-9]+)/g)].map((m) => m[1].toLowerCase())
    );
    for (const etiqueta of etiquetas) {
      assert.ok(
        ['div', 'p', 'a', 'hr'].includes(etiqueta),
        `${template}: etiqueta inesperada <${etiqueta}> en el HTML`
      );
    }
    // Y ningun atributo de evento ni esquema peligroso dentro de una etiqueta.
    assert.ok(!/<[^>]*\son\w+\s*=/i.test(mensaje.html), `${template}: atributo on* en una etiqueta`);
    assert.ok(!/href\s*=\s*"(?!https:)/i.test(mensaje.html), `${template}: href que no es https`);
  }
});

test('ATAQUE XSS: un bloque desconocido no llega a renderizarse como HTML crudo', () => {
  // El renderizador es el unico sitio que produce markup; cualquier bloque que
  // no reconozca es un fallo de programacion, no algo que se emita a ciegas.
  assert.throws(
    () => notif.renderTemplate({ template: 'noExiste', data: {}, year: YEAR }),
    notif.NotificationError
  );
});

// ---------------------------------------------------------------------------
// ATAQUE: enlaces (phishing con nuestra marca)
// ---------------------------------------------------------------------------

test('ATAQUE enlace: solo https y solo hosts nuestros', () => {
  assert.equal(notif.assertSafeLink(INVITE_URL), INVITE_URL);

  const malos = [
    'http://prequalify.vigpr.com/x',            // sin TLS
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'https://evil.com/phishing',
    'https://prequalify.vigpr.com.evil.com/x',  // sufijo enganoso
    'https://evil.com/?next=prequalify.vigpr.com',
    '//prequalify.vigpr.com/x',
    'no es una url',
    '',
    null,
    undefined,
  ];
  for (const url of malos) {
    assert.throws(
      () => notif.assertSafeLink(url),
      notif.NotificationError,
      `deberia rechazar: ${String(url)}`
    );
  }
});

test('ATAQUE enlace: la plantilla de co-deudor rechaza un enlace ajeno', () => {
  assert.throws(
    () =>
      notif.renderTemplate({
        template: notif.Template.COBORROWER_INVITE,
        data: { applicantName: 'Ana', inviteUrl: 'https://evil.com/robar' },
        year: YEAR,
      }),
    notif.NotificationError
  );
});

test('el enlace de invitacion aparece en el HTML y en el texto plano', () => {
  const mensaje = render(notif.Template.COBORROWER_INVITE);
  assert.ok(mensaje.html.includes(`href="${INVITE_URL}"`), mensaje.html);
  assert.ok(mensaje.text.includes(INVITE_URL));
});

// ---------------------------------------------------------------------------
// Nada sensible viaja por correo
// ---------------------------------------------------------------------------

test('assertNoSensitiveData rechaza campos prohibidos, aunque esten anidados', () => {
  const casos = [
    { ssn: '123456789' },
    { SSN: 'x' },
    { social_security_number: 'x' },
    { score: 720 },
    { creditScore: 720 },
    { fico: 700 },
    { creditReport: {} },
    { experian: { raw: 'x' } },
    { dateOfBirth: '1990-01-01' },
    { accountNumber: '000123' },
    { lead: { applicant: { ssn: '1' } } },
    { docs: [{ creditScore: 1 }] },
  ];
  for (const data of casos) {
    assert.throws(
      () => notif.assertNoSensitiveData(data),
      notif.NotificationError,
      JSON.stringify(data)
    );
  }
  assert.doesNotThrow(() => notif.assertNoSensitiveData({ name: 'Ana', count: 2 }));
  assert.doesNotThrow(() => notif.assertNoSensitiveData(null));
});

test('un valor con forma de SSN rompe el render, y el SSN no aparece en el error', () => {
  for (const valor of ['123-45-6789', '123456789', '123 45 6789']) {
    assert.throws(
      () => render(notif.Template.PREQUALIFIED, { name: `Ana ${valor}` }),
      (err) => {
        assert.ok(err instanceof notif.NotificationError);
        // El mensaje del error va al log: no puede llevar el dato.
        assert.ok(!err.message.includes(valor), err.message);
        return true;
      },
      valor
    );
  }
});

test('ninguna plantilla menciona score, monto ni el reporte de credito', () => {
  const prohibidos = [
    'score',
    'puntuacion',
    'experian',
    'fico',
    'seguro social',
    'social security number',
    'aprobado por $',
  ];
  for (const template of notif.TEMPLATE_NAMES) {
    for (const locale of notif.LOCALES) {
      const mensaje = notif.renderTemplate({
        template,
        locale,
        data: DATOS_VALIDOS[template],
        year: YEAR,
      });
      const cuerpo = `${mensaje.subject}\n${mensaje.text}`.toLowerCase();
      for (const palabra of prohibidos) {
        // La unica mencion admitida es la advertencia "nunca te pediremos tu
        // numero de seguro social", que es lo contrario de filtrarlo.
        if (palabra === 'seguro social' || palabra === 'social security number') {
          if (cuerpo.includes(palabra)) {
            assert.ok(
              /nunca te pediremos|we will never ask/.test(cuerpo),
              `${template}/${locale}: menciona el SSN fuera de la advertencia`
            );
          }
          continue;
        }
        assert.ok(
          !cuerpo.includes(palabra),
          `${template}/${locale}: menciona "${palabra}"`
        );
      }
      // Tampoco cifras de dinero.
      assert.ok(!/\$\s?\d/.test(cuerpo), `${template}/${locale}: hay un monto en el mensaje`);
    }
  }
});

// ---------------------------------------------------------------------------
// OTP
// ---------------------------------------------------------------------------

test('el codigo OTP va en el cuerpo, nunca en el asunto', () => {
  for (const locale of notif.LOCALES) {
    const mensaje = notif.renderTemplate({
      template: notif.Template.OTP_CODE,
      locale,
      data: { code: '907431', expiresInMinutes: 10 },
      year: YEAR,
    });
    // Los asuntos se ven en la pantalla de bloqueo y quedan en logs de MTA.
    assert.ok(!mensaje.subject.includes('907431'), mensaje.subject);
    assert.ok(mensaje.html.includes('907431'));
    assert.ok(mensaje.text.includes('907431'));
    // Bandera para que el puerto y el logger sepan que este cuerpo no se loguea.
    assert.equal(mensaje.containsSecret, true);
  }
});

test('solo la plantilla de OTP se marca como secreta', () => {
  for (const template of notif.TEMPLATE_NAMES) {
    const mensaje = notif.renderTemplate({
      template,
      data: DATOS_VALIDOS[template],
      year: YEAR,
    });
    assert.equal(
      mensaje.containsSecret,
      template === notif.Template.OTP_CODE,
      template
    );
  }
});

test('el OTP avisa de la caducidad con los minutos que le pasen', () => {
  const mensaje = render(notif.Template.OTP_CODE, { expiresInMinutes: 5 });
  assert.ok(mensaje.text.includes('5'));
});

// ---------------------------------------------------------------------------
// Campos requeridos y forma de la entrada
// ---------------------------------------------------------------------------

test('faltan campos requeridos: falla en claro', () => {
  assert.throws(
    () => notif.renderTemplate({ template: notif.Template.OTP_CODE, data: {}, year: YEAR }),
    notif.NotificationError
  );
  assert.throws(
    () =>
      notif.renderTemplate({
        template: notif.Template.COBORROWER_INVITE,
        data: { applicantName: 'Ana' },
        year: YEAR,
      }),
    notif.NotificationError
  );
  assert.throws(
    () =>
      notif.renderTemplate({
        template: notif.Template.DOCUMENTS_RECEIVED,
        data: { count: 0 },
        year: YEAR,
      }),
    notif.NotificationError
  );
});

test('data debe ser un objeto', () => {
  for (const data of ['texto', 42, ['a'], true]) {
    assert.throws(
      () => notif.renderTemplate({ template: notif.Template.PREQUALIFIED, data, year: YEAR }),
      notif.NotificationError,
      String(data)
    );
  }
  // Sin data, las plantillas que no requieren nada siguen funcionando.
  assert.doesNotThrow(() =>
    notif.renderTemplate({ template: notif.Template.PREQUALIFIED, year: YEAR })
  );
});

test('el saludo se omite si no hay nombre (nada de "Hola undefined,")', () => {
  const conNombre = render(notif.Template.PREQUALIFIED, { name: 'Ana' });
  const sinNombre = notif.renderTemplate({
    template: notif.Template.PREQUALIFIED,
    locale: 'es',
    data: {},
    year: YEAR,
  });
  assert.ok(conNombre.text.startsWith('Ana,'));
  assert.ok(!sinNombre.text.toLowerCase().includes('undefined'));
  assert.ok(!sinNombre.text.toLowerCase().includes('null'));
});

test('singular y plural en el acuse de documentos', () => {
  assert.ok(render(notif.Template.DOCUMENTS_RECEIVED, { count: 1 }).text.includes('1 documento '));
  assert.ok(render(notif.Template.DOCUMENTS_RECEIVED, { count: 3 }).text.includes('3 documentos'));
});

// ---------------------------------------------------------------------------
// Determinismo y version corta
// ---------------------------------------------------------------------------

test('con el mismo ano el render es identico (funcion pura)', () => {
  const a = render(notif.Template.COBORROWER_INVITE);
  const b = render(notif.Template.COBORROWER_INVITE);
  assert.deepEqual(a, b);
});

test('buildShortMessage: sin HTML y acotado para SMS/WhatsApp', () => {
  const corto = notif.buildShortMessage({
    template: notif.Template.OTP_CODE,
    locale: 'es',
    data: { code: '123456' },
    year: YEAR,
  });
  assert.ok(!corto.body.includes('<'));
  assert.ok(corto.body.length <= 320);
  assert.equal(corto.containsSecret, true);
  assert.ok(!/[\r\n]/.test(corto.body));
});
