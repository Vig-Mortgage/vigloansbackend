'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ALLOWED_MESSAGE_FIELDS, buildEnvelope } = require('../lib/mailer');
const {
  createOtpDeliveryAdapter,
  _aE164,
  _enmascarar,
  _minutosDe,
} = require('../lib/prequalify/adapters/otpDelivery');

const TWILIO = { sid: 'AC_test', token: 'tok_test', twilioPurchasedNumber: '+17875551000' };
const WHATSAPP = { accessToken: 'tok_wa', url: 'https://graph.facebook.com/v18.0/1234/messages' };
const MAIL = { host: 'smtp.example.com', user: 'u', password: 'p' };

/** Respuesta minima estilo `fetch`. */
function respuesta(ok, body, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body };
}

/** Adaptador con todo mockeado. Devuelve tambien lo que se llamo. */
function construir({ fetchRespuesta, mailInfo = { messageId: '<id@vig>' } } = {}) {
  const llamadas = [];
  const adaptador = createOtpDeliveryAdapter({
    getMailSecrets: async () => MAIL,
    getTwilioSecrets: async () => TWILIO,
    getWhatsappSecrets: async () => WHATSAPP,
    fetchImpl: async (url, opciones) => {
      llamadas.push({ url, opciones });
      return fetchRespuesta ?? respuesta(true, { sid: 'SM123', messages: [{ id: 'wamid.1' }] });
    },
    createMailerImpl: () => ({
      sendMail: async (mensaje) => {
        llamadas.push({ mail: mensaje });
        return mailInfo;
      },
    }),
  });
  return { adaptador, llamadas };
}

// ---------------------------------------------------------------------------
// Normalizacion del telefono
// ---------------------------------------------------------------------------

test('aE164 antepone +1 a los 10 digitos que entrega el esquema', () => {
  assert.equal(_aE164('7875551234'), '+17875551234');
});

test('aE164 acepta 11 digitos que ya traen el 1', () => {
  assert.equal(_aE164('17875551234'), '+17875551234');
});

test('aE164 no duplica el + como hacia el legacy', () => {
  // `otp_sms.php` producia `++1787...`: quitaba el +, lo reponia y concatenaba
  // otro. Cualquier entrada con + debe salir con uno solo.
  assert.equal(_aE164('+1 (787) 555-1234'), '+17875551234');
  assert.equal(_aE164('++17875551234'), '+17875551234');
});

test('aE164 rechaza lo que no es un numero NANP', () => {
  assert.throws(() => _aE164('123'), /E.164/);
  assert.throws(() => _aE164(''), /E.164/);
});

// ---------------------------------------------------------------------------
// Enmascarado para logs
// ---------------------------------------------------------------------------

test('enmascarar deja el correo irreconocible pero distinguible', () => {
  assert.equal(_enmascarar('roberto@vigpr.com'), 'ro***@vigpr.com');
});

test('enmascarar deja solo los ultimos 4 digitos del telefono', () => {
  assert.equal(_enmascarar('7875551234'), '***1234');
});

test('minutosDe deriva del TTL real y nunca baja de 1', () => {
  assert.equal(_minutosDe(600), 10);
  assert.equal(_minutosDe(300), 5);
  assert.equal(_minutosDe(10), 1);
});

// ---------------------------------------------------------------------------
// SMS
// ---------------------------------------------------------------------------

test('sms llama a Twilio con el numero comprado y el cuerpo con el codigo', async () => {
  const { adaptador, llamadas } = construir();
  const r = await adaptador.send({
    channel: 'sms',
    destination: '7875551234',
    code: '123456',
    ttlSeconds: 600,
    locale: 'es',
  });

  assert.equal(llamadas.length, 1);
  const { url, opciones } = llamadas[0];
  assert.match(url, /api\.twilio\.com.*Accounts\/AC_test\/Messages\.json/);
  assert.equal(opciones.method, 'POST');
  assert.match(opciones.headers.Authorization, /^Basic /);

  const cuerpo = new URLSearchParams(opciones.body);
  assert.equal(cuerpo.get('To'), '+17875551234');
  assert.equal(cuerpo.get('From'), TWILIO.twilioPurchasedNumber);
  assert.match(cuerpo.get('Body'), /123456/);
  assert.match(cuerpo.get('Body'), /10 minutos/);

  assert.deepEqual(r, { deliveryId: 'SM123' });
});

test('sms en ingles manda el cuerpo en ingles', async () => {
  const { adaptador, llamadas } = construir();
  await adaptador.send({
    channel: 'sms',
    destination: '7875551234',
    code: '123456',
    ttlSeconds: 600,
    locale: 'en',
  });
  const cuerpo = new URLSearchParams(llamadas[0].opciones.body);
  assert.match(cuerpo.get('Body'), /Do not share it/);
});

test('sms propaga el fallo de Twilio como ProviderError, sin exponer su texto', async () => {
  const { adaptador } = construir({
    fetchRespuesta: respuesta(false, { message: 'The From number is not valid' }, 400),
  });
  await assert.rejects(
    adaptador.send({ channel: 'sms', destination: '7875551234', code: '1', ttlSeconds: 600 }),
    (e) => {
      assert.equal(e.name, 'ProviderError');
      // El mensaje interno conserva el detalle...
      assert.match(e.message, /From number is not valid/);
      // ...pero lo que veria el cliente no.
      assert.doesNotMatch(e.publicMessage, /From number/);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------

test('whatsapp usa la plantilla aprobada con el codigo en cuerpo y boton', async () => {
  const { adaptador, llamadas } = construir();
  const r = await adaptador.send({
    channel: 'whatsapp',
    destination: '7875551234',
    code: '654321',
    ttlSeconds: 600,
    locale: 'es',
  });

  const { url, opciones } = llamadas[0];
  assert.equal(url, WHATSAPP.url);
  assert.equal(opciones.headers.Authorization, `Bearer ${WHATSAPP.accessToken}`);

  const enviado = JSON.parse(opciones.body);
  assert.equal(enviado.messaging_product, 'whatsapp');
  assert.equal(enviado.to, '+17875551234');
  assert.equal(enviado.template.name, 'otp_landing');
  assert.equal(enviado.template.language.code, 'es');

  // El codigo va DOS veces: cuerpo y parametro del boton de URL. Es la forma
  // que Meta tiene aprobada; quitar uno rompe el envio en produccion.
  const [cuerpo, boton] = enviado.template.components;
  assert.equal(cuerpo.parameters[0].text, '654321');
  assert.equal(boton.sub_type, 'url');
  assert.equal(boton.parameters[0].text, '654321');

  assert.deepEqual(r, { deliveryId: 'wamid.1' });
});

// ---------------------------------------------------------------------------
// Correo
// ---------------------------------------------------------------------------

test('email pasa a sendMail SOLO los campos que admite', async () => {
  // Este test existe por un fallo real: el mock de `sendMail` aceptaba
  // cualquier objeto, asi que no vio que se le estaba pasando el mensaje con
  // sus metadatos (`template`, `locale`, `containsSecret`). El mailer de
  // verdad los rechaza y el OTP moria con 400 en produccion.
  //
  // La comprobacion se hace contra `ALLOWED_MESSAGE_FIELDS` del propio mailer
  // y, ademas, pasando el resultado por su `buildEnvelope` real — que es
  // exactamente quien lanzaba.
  const { adaptador, llamadas } = construir();
  await adaptador.send({
    channel: 'email',
    destination: 'roberto@vigpr.com',
    code: '111222',
    ttlSeconds: 600,
    locale: 'es',
  });

  const { mail } = llamadas[0];
  const sobrantes = Object.keys(mail).filter((k) => !ALLOWED_MESSAGE_FIELDS.includes(k));
  assert.deepEqual(sobrantes, [], `campos que sendMail rechazaria: ${sobrantes.join(', ')}`);
  assert.doesNotThrow(() => buildEnvelope(mail));
});

test('email manda la plantilla otpCode y devuelve el messageId', async () => {
  const { adaptador, llamadas } = construir();
  const r = await adaptador.send({
    channel: 'email',
    destination: 'roberto@vigpr.com',
    code: '999888',
    ttlSeconds: 600,
    locale: 'es',
  });

  const { mail } = llamadas[0];
  assert.equal(mail.to, 'roberto@vigpr.com');
  assert.match(mail.subject, /verificaci/i);
  assert.match(mail.text, /999888/);
  assert.deepEqual(r, { deliveryId: '<id@vig>' });
});

// ---------------------------------------------------------------------------
// Reglas del contrato del puerto
// ---------------------------------------------------------------------------

test('send NUNCA devuelve el codigo', async () => {
  for (const channel of ['sms', 'whatsapp', 'email']) {
    const { adaptador } = construir();
    const destino = channel === 'email' ? 'a@b.com' : '7875551234';
    const r = await adaptador.send({
      channel,
      destination: destino,
      code: '777777',
      ttlSeconds: 600,
      locale: 'es',
    });
    assert.doesNotMatch(JSON.stringify(r), /777777/, `el canal ${channel} filtro el codigo`);
    assert.deepEqual(Object.keys(r), ['deliveryId']);
  }
});

test('un canal desconocido no se entrega en silencio', async () => {
  const { adaptador, llamadas } = construir();
  await assert.rejects(
    adaptador.send({ channel: 'telegram', destination: 'x', code: '1', ttlSeconds: 600 }),
    /Canal no soportado/
  );
  assert.equal(llamadas.length, 0);
});

test('un secreto incompleto dice QUE clave falta, y no llama al proveedor', async () => {
  const llamadas = [];
  const adaptador = createOtpDeliveryAdapter({
    getMailSecrets: async () => MAIL,
    getTwilioSecrets: async () => ({ sid: 'AC_test' }), // sin token ni numero
    getWhatsappSecrets: async () => WHATSAPP,
    fetchImpl: async (...args) => {
      llamadas.push(args);
      return respuesta(true, {});
    },
    createMailerImpl: () => ({ sendMail: async () => ({}) }),
  });

  await assert.rejects(
    adaptador.send({ channel: 'sms', destination: '7875551234', code: '1', ttlSeconds: 600 }),
    /token.*twilioPurchasedNumber|twilioPurchasedNumber/
  );
  assert.equal(llamadas.length, 0, 'no debe salir peticion con credenciales incompletas');
});
