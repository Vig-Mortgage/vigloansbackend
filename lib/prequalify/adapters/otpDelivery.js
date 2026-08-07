'use strict';

const { createMailer } = require('../../mailer');
const {
  Template,
  buildEmailMessage,
  buildShortMessage,
  normalizeLocale,
} = require('../notifications');
const { ProviderError } = require('../ports/errors');
const logger = require('../../logger');

/**
 * Entrega del codigo OTP por correo, SMS y WhatsApp.
 *
 * Implementa el contrato de `ports/otpPort.js`. Portado de los tres envios del
 * legacy (`otp_sms.php`, `otp_whatsapp.php` y el correo de `accionEnviarOtp`),
 * pero SIN sus fallos: alli el codigo llegaba en `$_POST['otp']`, o sea que lo
 * elegia quien llamaba. Aqui lo genera `lib/prequalify/otp.js` y este modulo
 * solo lo entrega.
 *
 * REGLAS QUE CUMPLE (del contrato del puerto)
 *
 * - [send] no devuelve el codigo. Devuelve `{deliveryId}`, que es el
 *   identificador del proveedor y sirve para rastrear el envio.
 * - El codigo no se escribe en logs. Tampoco el destino completo: se registra
 *   el canal y el destino enmascarado, que es lo que hace falta para depurar.
 *
 * PROVEEDORES
 *
 * - Correo: `lib/mailer.js` (nodemailer + SMTP2GO, TLS verificado). Ya en
 *   produccion.
 * - SMS: API REST de Twilio. Secreto `twillio` — el nombre lleva la errata de
 *   dos eles con la que se creo, y se respeta porque cambiarlo obligaria a
 *   recrear el secreto y a tocar el PHP que sigue vivo.
 * - WhatsApp: Cloud API de Meta. Secreto `whatsapp`. Manda la plantilla
 *   aprobada `otp_landing`, con el codigo en el cuerpo y en el boton de URL,
 *   igual que el legacy: una plantilla de WhatsApp no se puede improvisar, hay
 *   que usar una que Meta haya aprobado.
 */

/** Minutos que se le dicen al usuario. Se deriva del TTL real, no se inventa. */
function minutosDe(ttlSeconds) {
  return Math.max(1, Math.round((ttlSeconds ?? 600) / 60));
}

/**
 * Destino enmascarado para los logs.
 *
 * Un numero o un correo completos en un log son datos personales, y estos logs
 * los lee cualquiera con acceso a la instancia. Se deja lo justo para
 * distinguir dos envios entre si.
 */
function enmascarar(destino) {
  const valor = String(destino ?? '');
  if (valor.includes('@')) {
    const [usuario, dominio] = valor.split('@');
    return `${usuario.slice(0, 2)}***@${dominio}`;
  }
  return `***${valor.slice(-4)}`;
}

/**
 * Telefono en E.164 para los proveedores.
 *
 * Entra en 10 digitos (asi lo normaliza el esquema) y sale como `+1XXXXXXXXXX`.
 * PR y EEUU comparten el codigo +1.
 *
 * El legacy hacia esto mismo mal: quitaba el `+`, lo volvia a poner y luego
 * concatenaba otro, dejando `++1787...` (`otp_sms.php:10-31`).
 */
function aE164(destino) {
  const digitos = String(destino ?? '').replace(/\D/g, '');
  if (digitos.length === 10) return `+1${digitos}`;
  if (digitos.length === 11 && digitos.startsWith('1')) return `+${digitos}`;
  throw new ProviderError('otp', 'Telefono no convertible a E.164');
}

/** Lanza si al secreto le faltan claves, con el nombre de las que faltan. */
function exigirClaves(secreto, claves, nombreSecreto) {
  const faltan = claves.filter((k) => !secreto?.[k]);
  if (faltan.length) {
    throw new ProviderError(
      'otp',
      `Al secreto '${nombreSecreto}' le faltan claves: ${faltan.join(', ')}`
    );
  }
}

async function enviarSms({ destino, cuerpo, secreto, fetchImpl }) {
  exigirClaves(secreto, ['sid', 'token', 'twilioPurchasedNumber'], 'twillio');

  const cuerpoForm = new URLSearchParams({
    To: aE164(destino),
    From: secreto.twilioPurchasedNumber,
    Body: cuerpo,
  });

  const respuesta = await fetchImpl(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(secreto.sid)}/Messages.json`,
    {
      method: 'POST',
      headers: {
        // Basic con SID:token, que es como autentica Twilio.
        Authorization: `Basic ${Buffer.from(`${secreto.sid}:${secreto.token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: cuerpoForm.toString(),
    }
  );

  const datos = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) {
    // El mensaje de Twilio se registra pero NO se propaga al cliente: el
    // manejador de errores devuelve un texto generico.
    throw new ProviderError(
      'otp',
      `Twilio respondio ${respuesta.status}: ${datos?.message ?? 'sin detalle'}`
    );
  }
  return { deliveryId: datos.sid };
}

async function enviarWhatsapp({ destino, code, locale, secreto, fetchImpl }) {
  exigirClaves(secreto, ['accessToken', 'url'], 'whatsapp');

  // Plantilla aprobada en Meta. El codigo va dos veces: en el cuerpo y como
  // parametro del boton de URL. Es la forma de la plantilla `otp_landing` que
  // ya usa el legacy (`otp_whatsapp.php:20-50`); cambiarla exige volver a
  // pasar por aprobacion de Meta.
  const mensaje = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: aE164(destino),
    type: 'template',
    template: {
      name: 'otp_landing',
      language: { code: locale },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: code }],
        },
      ],
    },
  };

  const respuesta = await fetchImpl(secreto.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secreto.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(mensaje),
  });

  const datos = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok) {
    throw new ProviderError(
      'otp',
      `WhatsApp Cloud API respondio ${respuesta.status}: ${
        datos?.error?.message ?? 'sin detalle'
      }`
    );
  }
  return { deliveryId: datos?.messages?.[0]?.id };
}

/**
 * @param {object} deps
 * @param {() => Promise<object>} deps.getMailSecrets   secreto `Mail`
 * @param {() => Promise<object>} deps.getTwilioSecrets secreto `twillio`
 * @param {() => Promise<object>} deps.getWhatsappSecrets secreto `whatsapp`
 * @param {Function} [deps.fetchImpl] inyectable para tests
 * @param {Function} [deps.createMailerImpl] inyectable para tests
 * @returns {{send: Function}}
 */
function createOtpDeliveryAdapter({
  getMailSecrets,
  getTwilioSecrets,
  getWhatsappSecrets,
  fetchImpl = globalThis.fetch,
  createMailerImpl = createMailer,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('createOtpDeliveryAdapter necesita fetch (Node >=18) o fetchImpl');
  }

  async function send({ channel, destination, code, ttlSeconds, locale }) {
    const idioma = normalizeLocale(locale);
    const data = { code, minutes: minutosDe(ttlSeconds) };
    let resultado;

    if (channel === 'email') {
      const mensaje = buildEmailMessage({
        to: destination,
        template: Template.OTP_CODE,
        locale: idioma,
        data,
      });
      const mailer = createMailerImpl({ credentials: await getMailSecrets() });
      const info = await mailer.sendMail(mensaje);
      resultado = { deliveryId: info?.messageId };
    } else if (channel === 'sms' || channel === 'whatsapp') {
      const { body } = buildShortMessage({
        template: Template.OTP_CODE,
        locale: idioma,
        data,
      });
      resultado =
        channel === 'sms'
          ? await enviarSms({
              destino: destination,
              cuerpo: body,
              secreto: await getTwilioSecrets(),
              fetchImpl,
            })
          : await enviarWhatsapp({
              destino: destination,
              code,
              locale: idioma,
              secreto: await getWhatsappSecrets(),
              fetchImpl,
            });
    } else {
      throw new ProviderError('otp', `Canal no soportado: ${channel}`);
    }

    // Ni el codigo ni el destino completo. Ver la nota de [enmascarar].
    logger.info('prequalify.otp_entregado', {
      channel,
      destination: enmascarar(destination),
      deliveryId: resultado.deliveryId ?? null,
    });

    // Solo `deliveryId`: devolver el objeto del proveedor arrastraria el cuerpo
    // del mensaje, que contiene el codigo.
    return { deliveryId: resultado.deliveryId };
  }

  return { send };
}

module.exports = {
  createOtpDeliveryAdapter,
  // Exportados para los tests; no forman parte del contrato del puerto.
  _aE164: aE164,
  _enmascarar: enmascarar,
  _minutosDe: minutosDe,
};
