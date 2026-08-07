'use strict';

const { notImplementedPort } = require('./portFactory');

/**
 * Puerto de entrega del OTP (SMS, WhatsApp o correo).
 *
 * Division de responsabilidades: la generacion del codigo, el TTL, los intentos
 * y el lockout son de `lib/prequalify/otp.js` (Tarea B3). Este puerto **solo
 * entrega** el codigo por el canal pedido.
 *
 * Reglas que la implementacion debe cumplir:
 * - **[send] no devuelve el codigo.** Su valor de retorno no lo incluye, y el
 *   router jamas lo pone en la respuesta. Este fue un error real del legacy y
 *   es la regla numero uno de la skill.
 * - **El codigo no se escribe en logs.** Loguear el canal y un identificador
 *   del envio, nunca el destino completo ni el codigo.
 * - Las credenciales (Twilio, SMTP) salen de Secrets Manager en el backend.
 *   El cliente no las ve ni las manda.
 *
 * @typedef {object} OtpPort
 * @property {(delivery: {
 *   channel: 'sms'|'whatsapp'|'email',
 *   destination: string,
 *   code: string,
 *   ttlSeconds: number,
 *   locale?: 'es'|'en'
 * }) => Promise<{deliveryId?: string}>} send
 *   Entrega el codigo. El retorno NO puede contener el codigo.
 */

const METHODS = Object.freeze(['send']);

/** @returns {OtpPort} */
function createNotImplementedOtpPort() {
  return notImplementedPort('otp', METHODS);
}

module.exports = { METHODS, createNotImplementedOtpPort };
