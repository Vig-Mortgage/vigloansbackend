'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const mailer = require('../lib/mailer');

/**
 * Estos tests son casi todos de seguridad, porque el modulo que sustituyen lo
 * era: `sendSmtpEmail` en `app.js` conectaba con
 * `tls.connect(..., { rejectUnauthorized: false })` y escribia los valores
 * directamente en el socket sin filtrar CR/LF.
 *
 * Todo corre **sin red y sin `nodemailer` instalado**: el transporte se inyecta.
 * Si algun test abriera un socket, seria un fallo del diseno del modulo.
 */

/** Credenciales de mentira. Ningun valor real vive en el repo. */
const CREDENCIALES = Object.freeze({
  MAIL_HOST: 'smtp.ejemplo-test.invalid',
  MAIL_PORT: '587',
  MAIL_USERNAME: 'usuario-de-prueba',
  MAIL_PASSWORD: 'contrasena-de-prueba',
});

/** Payload clasico de inyeccion de cabeceras SMTP. */
const CRLF = '\r\nBcc: victima@ejemplo.com';

const MENSAJE_BASE = Object.freeze({
  to: 'solicitante@ejemplo.com',
  from: 'VIG Mortgage <info@vigmortgage.com>',
  subject: 'Asunto de prueba',
  html: '<p>Hola</p>',
  text: 'Hola',
});

/** Transporte espia: guarda el sobre y devuelve un messageId. */
function transporteFalso({ falla = null } = {}) {
  const enviados = [];
  return {
    enviados,
    sendMail: async (envelope) => {
      enviados.push(envelope);
      if (falla) throw falla;
      return { messageId: '<abc@ejemplo>' };
    },
  };
}

/** Logger espia: guarda nivel, mensaje y meta de cada llamada. */
function loggerFalso() {
  const registros = [];
  const push = (level) => (msg, meta) => registros.push({ level, msg, meta });
  return {
    registros,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    /** Todo lo registrado como texto plano, para buscar filtraciones. */
    dump: () => JSON.stringify(registros),
  };
}

function crear(overrides = {}) {
  const transport = overrides.transport ?? transporteFalso();
  const logger = overrides.logger ?? loggerFalso();
  return {
    transport,
    logger,
    mailer: mailer.createMailer({ transport, logger, env: {}, ...overrides.options }),
  };
}

// ---------------------------------------------------------------------------
// TLS: no se puede apagar
// ---------------------------------------------------------------------------

test('las opciones de transporte llevan TLS verificado y STARTTLS obligatorio', () => {
  const opciones = mailer.buildTransportOptions(CREDENCIALES);

  assert.equal(opciones.tls.rejectUnauthorized, true);
  assert.equal(opciones.tls.minVersion, 'TLSv1.2');
  assert.equal(opciones.tls.servername, 'smtp.ejemplo-test.invalid');
  // Puerto 587: TLS explicito, y exigido (si el servidor no ofrece STARTTLS,
  // se falla en vez de mandar en claro).
  assert.equal(opciones.secure, false);
  assert.equal(opciones.requireTLS, true);
  assert.equal(opciones.port, 587);
  assert.equal(opciones.auth.user, CREDENCIALES.MAIL_USERNAME);
});

test('el puerto 465 usa TLS implicito', () => {
  const opciones = mailer.buildTransportOptions({ ...CREDENCIALES, MAIL_PORT: 465 });
  assert.equal(opciones.secure, true);
  // Con TLS implicito, STARTTLS no aplica.
  assert.equal(opciones.requireTLS, false);
  assert.equal(opciones.tls.rejectUnauthorized, true);
});

test('el puerto 2525 del legacy tambien exige STARTTLS', () => {
  // El SMTP casero usaba 2525 con `net.connect`: texto en claro y la
  // contrasena en base64 por la red. Ahora ese mismo puerto va cifrado.
  const opciones = mailer.buildTransportOptions({ ...CREDENCIALES, MAIL_PORT: '2525' });
  assert.equal(opciones.port, 2525);
  assert.equal(opciones.requireTLS, true);
  assert.equal(opciones.tls.rejectUnauthorized, true);
});

test('no hay forma de configurar rejectUnauthorized:false', () => {
  const intentos = [
    { tls: { rejectUnauthorized: false } },
    { rejectUnauthorized: false },
    { ignoreTLS: true },
    { requireTLS: false },
    { MAIL_PORT: 465, secure: false },
    { MAIL_ENCRYPTION: 'none' },
    { MAIL_ENCRYPTION: 'off' },
    { tls: { checkServerIdentity: () => undefined } },
  ];

  for (const extra of intentos) {
    const credenciales = { ...CREDENCIALES, ...extra };
    assert.throws(
      () => mailer.buildTransportOptions(credenciales),
      (err) => {
        assert.ok(err instanceof mailer.MailerError, `${JSON.stringify(Object.keys(extra))}: tipo`);
        assert.equal(err.code, 'MAILER_CONFIG');
        assert.match(err.message, /TLS no es opcional/);
        return true;
      },
      `deberia rechazar ${JSON.stringify(Object.keys(extra))}`
    );
    // Y tampoco por la puerta de createMailer.
    assert.throws(
      () => mailer.createMailer({ credentials: credenciales, env: {}, logger: loggerFalso() }),
      mailer.MailerError
    );
  }
});

test('NODE_TLS_REJECT_UNAUTHORIZED=0 aborta la creacion del mailer', () => {
  // Esa variable apaga la verificacion de certificados de TODO el proceso, asi
  // que se comprueba incluso con transporte inyectado.
  assert.throws(
    () =>
      mailer.createMailer({
        transport: transporteFalso(),
        logger: loggerFalso(),
        env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
      }),
    (err) => {
      assert.equal(err.code, 'MAILER_CONFIG');
      assert.match(err.message, /NODE_TLS_REJECT_UNAUTHORIZED/);
      return true;
    }
  );

  // Con la variable a '1' (o ausente) no molesta.
  assert.doesNotThrow(() =>
    mailer.createMailer({
      transport: transporteFalso(),
      logger: loggerFalso(),
      env: { NODE_TLS_REJECT_UNAUTHORIZED: '1' },
    })
  );
});

test('las opciones de TLS que llegan al createTransport real son las verificadas', () => {
  let capturadas = null;
  const m = mailer.createMailer({
    credentials: CREDENCIALES,
    logger: loggerFalso(),
    env: {},
    createTransport: (opciones) => {
      capturadas = opciones;
      return transporteFalso();
    },
  });

  return m.sendMail({ ...MENSAJE_BASE }).then(() => {
    assert.equal(capturadas.tls.rejectUnauthorized, true);
    assert.equal(capturadas.requireTLS, true);
    assert.equal(capturadas.host, 'smtp.ejemplo-test.invalid');
  });
});

// ---------------------------------------------------------------------------
// Inyeccion CRLF en cabeceras
// ---------------------------------------------------------------------------

test('CRLF en `to` se rechaza, no se limpia', async () => {
  const { mailer: m, transport } = crear();
  await assert.rejects(
    () => m.sendMail({ ...MENSAJE_BASE, to: `victima@ejemplo.com${CRLF}` }),
    (err) => {
      assert.equal(err.code, 'MAILER_MESSAGE');
      // El payload no viaja en el mensaje del error (acabaria en el log).
      assert.ok(!err.message.includes('victima@'));
      return true;
    }
  );
  assert.equal(transport.enviados.length, 0, 'no debe llegar nada al transporte');
});

test('CRLF en `from` y `replyTo` se rechaza', async () => {
  for (const campo of ['from', 'replyTo']) {
    const { mailer: m, transport } = crear();
    await assert.rejects(
      () => m.sendMail({ ...MENSAJE_BASE, [campo]: `info@vigmortgage.com${CRLF}` }),
      (err) => {
        assert.equal(err.code, 'MAILER_MESSAGE');
        assert.match(err.message, new RegExp(campo));
        return true;
      },
      `${campo} deberia rechazarse`
    );
    assert.equal(transport.enviados.length, 0);
  }
});

test('CRLF en el nombre visible de una direccion se rechaza', async () => {
  // `Reply-To: ${safeName} <${safeEmail}>` era como el legacy montaba la
  // cabecera; si el nombre trae un salto, se cuela una cabecera entera.
  const { mailer: m } = crear();
  await assert.rejects(
    () => m.sendMail({ ...MENSAJE_BASE, replyTo: `Ana${CRLF} <ana@ejemplo.com>` }),
    mailer.MailerError
  );
});

test('CRLF en el asunto se sanea y el sobre sale limpio', async () => {
  const { mailer: m, transport } = crear();
  await m.sendMail({
    ...MENSAJE_BASE,
    subject: `Soporte\r\nBcc: victima@ejemplo.com\r\nX-Cabecera: si`,
  });

  const [sobre] = transport.enviados;
  // El asunto es texto libre: se limpia (a diferencia de una direccion, donde
  // un salto nunca es legitimo y se rechaza).
  assert.ok(!new RegExp('[\u0000-\u001f\u007f\u2028\u2029]').test(sobre.subject));
  assert.equal(sobre.subject, 'Soporte Bcc: victima@ejemplo.com X-Cabecera: si');
  assert.equal(sobre.to.length, 1);
});

test('separadores de linea Unicode y otros controles tambien se filtran', async () => {
  const { mailer: m, transport } = crear();
  const RAROS = [0x2028, 0x2029, 0x0000, 0x007f].map((c) => String.fromCharCode(c)).join('');
  await m.sendMail({ ...MENSAJE_BASE, subject: `Antes${RAROS}Despues` });
  const [sobre] = transport.enviados;
  assert.ok(!new RegExp('[\u0000-\u001f\u007f\u2028\u2029]').test(sobre.subject));
  assert.equal(sobre.subject, 'Antes Despues');
});

test('no se aceptan cabeceras arbitrarias ni bcc', async () => {
  const { mailer: m } = crear();
  for (const extra of [
    { bcc: 'oculto@ejemplo.com' },
    { headers: { 'X-Cualquiera': 'valor' } },
    { attachments: [] },
  ]) {
    await assert.rejects(
      () => m.sendMail({ ...MENSAJE_BASE, ...extra }),
      (err) => {
        assert.equal(err.code, 'MAILER_MESSAGE');
        assert.match(err.message, /no permitidos/);
        return true;
      },
      `deberia rechazar ${Object.keys(extra)[0]}`
    );
  }
});

test('el numero de destinatarios esta acotado', async () => {
  const { mailer: m } = crear();
  const muchos = Array.from(
    { length: mailer.MAX_RECIPIENTS + 1 },
    (_, i) => `persona${i}@ejemplo.com`
  );
  await assert.rejects(() => m.sendMail({ ...MENSAJE_BASE, to: muchos }), /Demasiados destinatarios/);

  // Dentro del limite si pasa (solicitante + co-deudor es el caso real).
  const { mailer: m2, transport } = crear();
  await m2.sendMail({ ...MENSAJE_BASE, to: ['a@ejemplo.com', 'b@ejemplo.com'] });
  assert.deepEqual(transport.enviados[0].to, ['a@ejemplo.com', 'b@ejemplo.com']);
});

test('el nombre visible con caracteres especiales sale entrecomillado', () => {
  assert.equal(
    mailer.assertHeaderAddress('VIG Mortgage <info@vigmortgage.com>', 'from'),
    'VIG Mortgage <info@vigmortgage.com>'
  );
  assert.equal(
    mailer.assertHeaderAddress('Rivera, Ana <ana@ejemplo.com>', 'from'),
    '"Rivera, Ana" <ana@ejemplo.com>'
  );
  assert.equal(mailer.assertHeaderAddress('ana@ejemplo.com', 'to'), 'ana@ejemplo.com');
});

test('una direccion con dos destinatarios en la misma cadena se rechaza', () => {
  assert.throws(
    () => mailer.assertHeaderAddress('a@ejemplo.com, b@ejemplo.com', 'to'),
    mailer.MailerError
  );
});

// ---------------------------------------------------------------------------
// Credenciales
// ---------------------------------------------------------------------------

test('sin credenciales el mailer no se construye', () => {
  for (const credenciales of [undefined, null, {}, 'texto', []]) {
    assert.throws(
      () => mailer.createMailer({ credentials: credenciales, env: {}, logger: loggerFalso() }),
      (err) => {
        assert.ok(err instanceof mailer.MailerError);
        assert.equal(err.code, 'MAILER_CONFIG');
        assert.equal(err.status, 500);
        return true;
      },
      `deberia fallar con ${JSON.stringify(credenciales)}`
    );
  }
});

test('faltar la contrasena se dice en claro, sin valores', () => {
  assert.throws(
    () =>
      mailer.createMailer({
        credentials: { MAIL_HOST: 'smtp.ejemplo-test.invalid', MAIL_USERNAME: 'u' },
        env: {},
        logger: loggerFalso(),
      }),
    (err) => {
      assert.match(err.message, /pass\/MAIL_PASSWORD/);
      assert.ok(!err.message.includes('contrasena-de-prueba'));
      // Al cliente, nunca el detalle.
      assert.equal(err.publicMessage, 'El servicio de correo no está disponible.');
      return true;
    }
  );
});

test('las credenciales NO se leen del entorno', () => {
  // Aunque el proceso tenga las variables puestas, el modulo no las mira: las
  // credenciales llegan del secreto `Mail` inyectado por el llamador.
  const previo = { ...process.env };
  process.env.MAIL_HOST = 'smtp.ejemplo-test.invalid';
  process.env.MAIL_USERNAME = 'colado';
  process.env.MAIL_PASSWORD = 'colada';
  try {
    assert.throws(
      () => mailer.createMailer({ credentials: {}, logger: loggerFalso() }),
      /Credenciales de correo incompletas/
    );
  } finally {
    for (const k of ['MAIL_HOST', 'MAIL_USERNAME', 'MAIL_PASSWORD']) {
      if (previo[k] === undefined) delete process.env[k];
      else process.env[k] = previo[k];
    }
  }
});

test('host o puerto invalidos se rechazan', () => {
  assert.throws(
    () => mailer.buildTransportOptions({ ...CREDENCIALES, MAIL_HOST: 'smtp .malo\r\n' }),
    /Host SMTP inválido/
  );
  for (const puerto of ['0', '70000', 'abc', '-1']) {
    assert.throws(
      () => mailer.buildTransportOptions({ ...CREDENCIALES, MAIL_PORT: puerto }),
      /Puerto SMTP inválido/,
      `puerto ${puerto}`
    );
  }
});

test('normalizeCredentials acepta la forma corta y la del secreto', () => {
  const corta = mailer.normalizeCredentials({
    host: 'smtp.ejemplo-test.invalid',
    port: 587,
    user: 'u',
    pass: 'p',
    from: 'info@vigmortgage.com',
  });
  assert.equal(corta.host, 'smtp.ejemplo-test.invalid');
  assert.equal(corta.from, 'info@vigmortgage.com');

  // Sin puerto: submission con STARTTLS por defecto.
  const sinPuerto = mailer.normalizeCredentials({
    MAIL_HOST: 'smtp.ejemplo-test.invalid',
    MAIL_USERNAME: 'u',
    MAIL_PASSWORD: 'p',
  });
  assert.equal(sinPuerto.port, mailer.DEFAULT_PORT);
});

test('MAIL_FROM del secreto sirve de remitente por defecto', async () => {
  const transport = transporteFalso();
  const m = mailer.createMailer({
    credentials: { ...CREDENCIALES, MAIL_FROM: 'VIG Mortgage <info@vigmortgage.com>' },
    transport,
    logger: loggerFalso(),
    env: {},
  });
  await m.sendMail({ to: 'a@ejemplo.com', subject: 'Hola', text: 'Hola' });
  assert.equal(transport.enviados[0].from, 'VIG Mortgage <info@vigmortgage.com>');
});

test('sin remitente no se envia', async () => {
  const { mailer: m } = crear();
  await assert.rejects(
    () => m.sendMail({ to: 'a@ejemplo.com', subject: 'Hola', text: 'Hola' }),
    /'from' vacío/
  );
});

// ---------------------------------------------------------------------------
// Fallo del transporte
// ---------------------------------------------------------------------------

test('un fallo del transporte se envuelve: detalle al log, generico al llamador', async () => {
  const fallo = Object.assign(new Error('535 Authentication failed: usuario/clave'), {
    code: 'EAUTH',
    responseCode: 535,
  });
  const transport = transporteFalso({ falla: fallo });
  const logger = loggerFalso();
  const m = mailer.createMailer({ transport, logger, env: {} });

  await assert.rejects(
    () => m.sendMail({ ...MENSAJE_BASE }),
    (err) => {
      assert.ok(err instanceof mailer.MailerError);
      assert.equal(err.code, 'MAILER_TRANSPORT');
      assert.equal(err.status, 502);
      // Lo unico que ve el cliente: sin codigos SMTP ni respuesta del servidor.
      assert.equal(err.publicMessage, 'No pudimos enviar el correo en este momento.');
      assert.ok(!err.publicMessage.includes('535'));
      assert.ok(!err.publicMessage.includes('Authentication'));
      // El detalle sigue disponible para el log, en `cause`.
      assert.equal(err.cause, fallo);
      return true;
    }
  );

  const errores = logger.registros.filter((r) => r.level === 'error');
  assert.equal(errores.length, 1);
  assert.equal(errores[0].meta.errorCode, 'EAUTH');
  assert.equal(errores[0].meta.responseCode, 535);
});

test('verify() envuelve el fallo igual que sendMail', async () => {
  const logger = loggerFalso();
  const m = mailer.createMailer({
    transport: {
      sendMail: async () => ({}),
      verify: async () => {
        throw new Error('ECONNREFUSED interno');
      },
    },
    logger,
    env: {},
  });

  await assert.rejects(() => m.verify(), (err) => {
    assert.equal(err.code, 'MAILER_TRANSPORT');
    assert.ok(!err.publicMessage.includes('ECONNREFUSED'));
    return true;
  });
});

test('un envio correcto devuelve messageId', async () => {
  const { mailer: m } = crear();
  const resultado = await m.sendMail({ ...MENSAJE_BASE });
  assert.deepEqual(resultado, { messageId: '<abc@ejemplo>' });
});

// ---------------------------------------------------------------------------
// Logging: el cuerpo nunca se registra
// ---------------------------------------------------------------------------

test('ni el cuerpo ni el asunto llegan al log (ni en exito ni en fallo)', async () => {
  const SECRETO_EN_CUERPO = 'CODIGO-OTP-987654';
  const ASUNTO = 'Código de verificación de Ana Rivera';
  const mensaje = {
    to: 'ana@ejemplo.com',
    from: 'VIG Mortgage <info@vigmortgage.com>',
    subject: ASUNTO,
    html: `<p>Tu código es ${SECRETO_EN_CUERPO}</p>`,
    text: `Tu código es ${SECRETO_EN_CUERPO}`,
  };

  // Exito
  const loggerOk = loggerFalso();
  const mOk = mailer.createMailer({ transport: transporteFalso(), logger: loggerOk, env: {} });
  await mOk.sendMail(mensaje);
  const volcadoOk = loggerOk.dump();
  assert.ok(!volcadoOk.includes(SECRETO_EN_CUERPO), 'el cuerpo no puede aparecer en el log');
  assert.ok(!volcadoOk.includes(ASUNTO), 'el asunto no puede aparecer en el log');
  assert.ok(!volcadoOk.includes('<p>'), 'el html no puede aparecer en el log');
  // La direccion completa es PII: solo el dominio.
  assert.ok(!volcadoOk.includes('ana@ejemplo.com'), 'la dirección no puede aparecer en el log');
  assert.ok(volcadoOk.includes('ejemplo.com'), 'el dominio si es util para diagnosticar');
  assert.ok(loggerOk.registros.some((r) => r.level === 'info'));

  // Fallo
  const loggerErr = loggerFalso();
  const mErr = mailer.createMailer({
    transport: transporteFalso({ falla: new Error('boom') }),
    logger: loggerErr,
    env: {},
  });
  await assert.rejects(() => mErr.sendMail(mensaje));
  const volcadoErr = loggerErr.dump();
  assert.ok(!volcadoErr.includes(SECRETO_EN_CUERPO));
  assert.ok(!volcadoErr.includes(ASUNTO));
  assert.ok(!volcadoErr.includes('ana@ejemplo.com'));
});

test('la contrasena no aparece en describe() ni en el log', async () => {
  const logger = loggerFalso();
  const m = mailer.createMailer({
    credentials: CREDENCIALES,
    logger,
    env: {},
    createTransport: () => transporteFalso(),
  });
  await m.sendMail({ ...MENSAJE_BASE });

  const descripcion = m.describe();
  assert.deepEqual(descripcion, {
    host: 'smtp.ejemplo-test.invalid',
    port: 587,
    secure: false,
    requireTLS: true,
    rejectUnauthorized: true,
  });
  assert.ok(!logger.dump().includes(CREDENCIALES.MAIL_PASSWORD));
  assert.ok(!JSON.stringify(descripcion).includes(CREDENCIALES.MAIL_PASSWORD));
});

// ---------------------------------------------------------------------------
// Encaje con notifications.js
// ---------------------------------------------------------------------------

test('lo que produce notifications.buildEmailMessage se envia tal cual', async () => {
  const { buildEmailMessage, Template } = require('../lib/prequalify/notifications');
  const mensaje = buildEmailMessage({
    to: 'ana@ejemplo.com',
    template: Template.OTP_CODE,
    locale: 'es',
    data: { code: '123456', name: 'Ana Rivera' },
    year: 2026,
  });

  const { mailer: m, transport } = crear();
  // `buildEmailMessage` devuelve ademas metadatos (template, locale,
  // containsSecret) que no son cabeceras: el mailer solo acepta el sobre.
  const { template, locale, containsSecret, ...sobre } = mensaje;
  const resultado = await m.sendMail(sobre);

  assert.equal(resultado.messageId, '<abc@ejemplo>');
  assert.equal(transport.enviados[0].to[0], 'ana@ejemplo.com');
  assert.equal(transport.enviados[0].from, 'VIG Mortgage <info@vigmortgage.com>');
  assert.ok(transport.enviados[0].html.includes('123456'));
  assert.ok(!/[\r\n]/.test(transport.enviados[0].subject));
});

test('el mensaje necesita cuerpo', async () => {
  const { mailer: m } = crear();
  await assert.rejects(
    () => m.sendMail({ to: 'a@ejemplo.com', from: 'info@vigmortgage.com', subject: 'Hola' }),
    /no tiene cuerpo/
  );
});

test('el asunto vacio o desmedido se rechaza', () => {
  assert.throws(() => mailer.assertSubject('   '), /vacío/);
  assert.throws(
    () => mailer.assertSubject('x'.repeat(mailer.MAX_SUBJECT_LENGTH + 1)),
    /excede/
  );
  assert.equal(mailer.assertSubject('  Hola   mundo  '), 'Hola mundo');
});
