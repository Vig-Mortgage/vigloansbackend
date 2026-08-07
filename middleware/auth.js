'use strict';

const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const logger = require('./../lib/logger');

/**
 * Autenticacion y autorizacion del app movil.
 *
 * Extraido de `app.js` (Tarea D2). Salvo la correccion de seguridad que se
 * documenta abajo, el comportamiento es el mismo.
 *
 * CAMBIO DE SEGURIDAD — se fija `algorithms: ['HS256']` en el verify.
 *
 * `app.js` llamaba a `jwt.verify(token, secret, cb)` sin restringir el
 * algoritmo. Eso deja la puerta abierta a la confusion de algoritmo: un token
 * con `alg: none`, o firmado con un algoritmo que el verificador acepte por
 * defecto, puede pasar sin conocer el secreto. Es la regla que el CLAUDE.md ya
 * exigia y que estaba sin aplicar.
 *
 * El cambio es compatible con los tokens vivos: `jwt.sign` con un secreto de
 * texto usa HS256, asi que todo lo emitido hasta hoy sigue validando.
 *
 * LO QUE NO SE CAMBIA AQUI: no se valida `aud`. Los tokens que ya circulan no
 * la traen, asi que exigirla cerraria la sesion de todos los usuarios del app.
 * El riesgo que la audiencia cubriria —que un token de otro flujo pase por uno
 * del app— esta resuelto por el otro lado: la sesion de precalificacion usa un
 * secreto distinto (ver `lib/prequalify/session.js`).
 * TODO(Roberto): emitir con `aud` y empezar a exigirla cuando expire la ultima
 * tanda de tokens sin ella.
 */

const JWT_ALGORITHMS = Object.freeze(['HS256']);

/** Prefijo de dueno en las claves de S3. Origen: anti-IDOR de la Fase 0. */
const OWNED_KEY_REGEX = /^u([A-Za-z0-9]+)__/;

/** Identificador estable del dueno segun el JWT. */
function getOwnerId(req) {
  return req.usuario && req.usuario.sfUserId ? String(req.usuario.sfUserId) : null;
}

/**
 * ¿Puede este request tocar esta clave de S3?
 *
 * Un token valido NO basta: hay que comprobar que la clave le pertenece.
 *
 * @param {object} req
 * @param {string} key
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
function authorizeKeyOwnership(req, key) {
  const match = OWNED_KEY_REGEX.exec(String(key ?? ''));

  if (!match) {
    // Grandfathering: las claves anteriores a la Fase 0 no tienen prefijo y
    // se siguen permitiendo. Esto es un agujero conocido y sigue abierto —
    // mientras exista, un usuario autenticado puede leer un documento viejo
    // que no es suyo. Se cierra con la migracion de claves (Tarea F1).
    logger.warn('idor.clave_legacy', { key: String(key ?? '').slice(0, 64) });
    return { ok: true };
  }

  const owner = getOwnerId(req);
  if (!owner) {
    logger.warn('idor.token_sin_owner');
    return { ok: false, status: 403, error: 'No autorizado para este recurso.' };
  }
  if (match[1] !== owner) {
    logger.warn('idor.bloqueado', { owner, key: String(key).slice(0, 64) });
    return { ok: false, status: 403, error: 'No autorizado para este recurso.' };
  }
  return { ok: true };
}

/**
 * Middleware de verificacion del JWT del app.
 *
 * @param {object} deps
 * @param {() => Promise<{jwt_secret_key: string}>} deps.getBackendSecrets
 */
function createVerificarJWT({ getBackendSecrets }) {
  if (typeof getBackendSecrets !== 'function') {
    throw new TypeError('createVerificarJWT requiere getBackendSecrets');
  }

  return async function verificarJWT(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) {
      return res.status(403).send({ message: 'Token no proporcionado.' });
    }

    let secrets;
    try {
      secrets = await getBackendSecrets();
    } catch (error) {
      logger.error('auth.secretos_no_disponibles', { message: error.message });
      return res.status(500).send({ message: 'Error interno del servidor.' });
    }

    try {
      req.usuario = jwt.verify(token, secrets.jwt_secret_key, {
        algorithms: JWT_ALGORITHMS,
      });
      return next();
    } catch {
      // El motivo (expirado, firma mala, malformado) queda fuera: distinguirlos
      // le dice a un atacante cuan cerca esta.
      return res.status(401).send({ message: 'Token inválido.' });
    }
  };
}

/** Limitador de intentos de autenticacion. Mismos valores que `app.js`. */
function createAuthLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Demasiados intentos de autenticación. Intente de nuevo en 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
  });
}

/** Limitador del endpoint publico de soporte. */
function createSupportLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Demasiados mensajes de soporte. Intente de nuevo en 15 minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
  });
}

module.exports = {
  JWT_ALGORITHMS,
  OWNED_KEY_REGEX,
  getOwnerId,
  authorizeKeyOwnership,
  createVerificarJWT,
  createAuthLimiter,
  createSupportLimiter,
};
