'use strict';

/**
 * Montaje del router de precualificacion.
 *
 * Se construye **perezosamente**, en la primera peticion, porque necesita
 * secretos de Secrets Manager y `app.js` monta los routers de forma sincrona.
 * Si los secretos no estan configurados todavia, responde 503 y **no tumba el
 * arranque**: el resto del backend (que hoy sirve a la app en produccion) sigue
 * funcionando igual.
 *
 * SECRETOS QUE HAY QUE CREAR (accion de Roberto) — secreto `vigloans/prequalify`:
 *   session_secret : >=32 chars. Firma el token de sesion del flujo anonimo.
 *                    DEBE ser distinto de `jwt_secret_key`; ver la explicacion
 *                    en `lib/prequalify/session.js`.
 *   otp_secret     : >=32 chars. HMAC de los codigos OTP.
 * Genera cada uno con, por ejemplo, `openssl rand -hex 32`.
 */

const cors = require('cors');
const express = require('express');

const logger = require('../lib/logger');
const { createPorts } = require('../lib/prequalify/ports');
const { createOtpService } = require('../lib/prequalify/otp');
const { createInMemoryOtpStore } = require('../lib/prequalify/otpStore');
const { createSessionManager } = require('../lib/prequalify/session');
const { createPrequalifyRouter } = require('./prequalify');

/**
 * CORS propio del flujo anonimo.
 *
 * El CORS global de `app.js` usa `origin: '*'` con `credentials: true`, que es
 * una combinacion invalida y peligrosa. Aqui se restringe a los origenes
 * conocidos y **sin credentials**: la sesion viaja en `Authorization: Bearer`,
 * no en cookie, asi que no hacen falta.
 */
function buildCors() {
  const permitidos = (process.env.PREQUALIFY_CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  return cors({
    // El CORS global de `app.js` ya escribio `Access-Control-Allow-Origin: *`
    // antes de llegar aqui. Cuando este `cors()` decide NO permitir un origen
    // simplemente no escribe cabecera, asi que la permisiva del global
    // sobrevivia y esta restriccion era un no-op: cualquier sitio podia llamar
    // al flujo anonimo desde un navegador. Se detecto probando el wizard en
    // local contra el backend desplegado.
    //
    // Por eso se limpian primero las cabeceras de arriba: lo que decida este
    // router es lo que vale.
    preflightContinue: false,
    origin(origin, callback) {
      // Sin `Origin` = app movil o server-to-server: se permite.
      if (!origin) return callback(null, true);
      if (permitidos.includes(origin)) return callback(null, true);
      logger.warn('prequalify.cors_rechazado', { origin });
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
  });
}

/**
 * @param {object} deps
 * @param {() => Promise<object>} deps.getPrequalifySecrets
 * @param {() => Promise<object>} [deps.getBackendSecrets] para comprobar no-reuso
 * @param {object} [deps.portImplementations] puertos reales cuando existan
 */
function createLazyPrequalifyMount({
  getPrequalifySecrets,
  getBackendSecrets = null,
  portImplementations = {},
} = {}) {
  const mount = express.Router();

  // Borra lo que el CORS global de `app.js` haya escrito, para que la politica
  // de este router sea la que mande. Ver la nota en [buildCors].
  mount.use((req, res, next) => {
    res.removeHeader('Access-Control-Allow-Origin');
    res.removeHeader('Access-Control-Allow-Credentials');
    next();
  });
  mount.use(buildCors());

  let real = null;
  let intento = null;

  async function build() {
    const secrets = await getPrequalifySecrets();
    const appSecret = getBackendSecrets
      ? (await getBackendSecrets().catch(() => null))?.jwt_secret_key
      : undefined;

    const ports = createPorts(portImplementations);
    const sessions = createSessionManager({
      secret: secrets.session_secret,
      appJwtSecret: appSecret,
    });
    const otpService = createOtpService({
      otpPort: ports.otp,
      secret: secrets.otp_secret,
      store: createInMemoryOtpStore(),
    });
    return createPrequalifyRouter({ ports, otpService, sessions });
  }

  mount.use(async (req, res, next) => {
    if (real) return real(req, res, next);
    try {
      // Una sola construccion aunque lleguen peticiones concurrentes.
      intento = intento ?? build();
      real = await intento;
      return real(req, res, next);
    } catch (error) {
      intento = null; // permite reintentar cuando el secreto ya exista
      logger.error('prequalify.no_configurado', { message: error.message });
      return res.status(503).json({
        error: 'La precualificacion no esta disponible en este momento.',
      });
    }
  });

  return mount;
}

module.exports = { buildCors, createLazyPrequalifyMount };
