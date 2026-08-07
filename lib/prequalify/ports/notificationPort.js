'use strict';

const { notImplementedPort } = require('./portFactory');

/**
 * Puerto de notificaciones: avisar al solicitante del resultado.
 *
 * Sustituye a las plantillas de correo sueltas del legacy (`mail_corrobower.php`
 * y sus variantes `_es` / `_rejected` / `congra_*`, que hay que consolidar).
 *
 * Reglas que la implementacion debe cumplir:
 * - **`nodemailer` con TLS verificado.** Prohibido el SMTP casero en claro y
 *   `rejectUnauthorized:false`.
 * - **Sanitizar CRLF** en cualquier campo que termine en una cabecera SMTP
 *   (asunto, nombre) y escapar HTML en el cuerpo: son inyeccion de cabeceras y
 *   XSS en el correo.
 * - **Nada sensible en el mensaje.** Ni SSN, ni score, ni detalle del reporte:
 *   un correo viaja por sistemas que no controlamos.
 *
 * @typedef {object} NotificationPort
 * @property {(message: {
 *   channel: 'email'|'sms'|'whatsapp',
 *   to: string,
 *   template: string,
 *   data?: object,
 *   locale?: 'es'|'en'
 * }) => Promise<{messageId?: string}>} notify
 */

const METHODS = Object.freeze(['notify']);

/** @returns {NotificationPort} */
function createNotImplementedNotificationPort() {
  return notImplementedPort('notification', METHODS);
}

module.exports = { METHODS, createNotImplementedNotificationPort };
