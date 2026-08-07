'use strict';

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

/**
 * Token de sesion del flujo anonimo de precualificacion.
 *
 * Es una auth **distinta** de la del app: el solicitante no tiene cuenta. Se
 * emite tras verificar el OTP y solo sirve para tocar SU lead.
 *
 * POR QUE SECRETO PROPIO, y no el `jwt_secret_key` del backend:
 * `verificarJWT` en `app.js` verifica la firma pero no fija `algorithms` ni
 * comprueba `aud`. Si esta sesion se firmara con el mismo secreto, el token de
 * un lead anonimo pasaria como token de usuario autenticado del app: escalada
 * de privilegio directa. Con secreto separado eso es imposible aunque el otro
 * verificador siga sin mirar la audiencia.
 *
 * QUE NO VA EN EL PAYLOAD: ni SSN, ni score, ni email, ni telefono, ni el
 * access token de Salesforce. Un JWT va firmado, no cifrado: cualquiera que lo
 * intercepte lee su contenido. Solo el id del lead y un identificador de sesion.
 */

const ISSUER = 'vigloansbackend';
const AUDIENCE = 'vig-prequalify';
const ALGORITHM = 'HS256';

/** TTL corto: el wizard se completa de una sentada. */
const DEFAULT_TTL_SECONDS = 30 * 60;

/**
 * Valida el secreto de firma.
 *
 * Rechaza que coincida con el del app: seria volver a abrir justo el agujero
 * que este modulo evita.
 *
 * @param {string} secret
 * @param {string} [appJwtSecret] secreto del app, para comprobar que difieren
 */
function assertUsableSecret(secret, appJwtSecret) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new TypeError(
      'El secreto de sesion de precualificacion debe tener al menos 32 caracteres'
    );
  }
  if (appJwtSecret && secret === appJwtSecret) {
    throw new Error(
      'El secreto de precualificacion NO puede ser el mismo que el JWT del app: ' +
        'permitiria usar una sesion anonima como token de usuario autenticado'
    );
  }
}

/**
 * Crea el emisor/verificador de sesiones.
 *
 * @param {object} deps
 * @param {string} deps.secret secreto propio (Secrets Manager)
 * @param {string} [deps.appJwtSecret] para la comprobacion de no-reuso
 * @param {number} [deps.ttlSeconds]
 */
function createSessionManager({
  secret,
  appJwtSecret,
  ttlSeconds = DEFAULT_TTL_SECONDS,
} = {}) {
  assertUsableSecret(secret, appJwtSecret);

  /**
   * Emite la sesion tras verificar el OTP.
   *
   * @param {object} params
   * @param {string} params.leadId
   * @returns {{token: string, expiresInSeconds: number}}
   */
  function issue({ leadId }) {
    if (typeof leadId !== 'string' || leadId.trim() === '') {
      throw new TypeError('issue() requiere un leadId');
    }
    const token = jwt.sign(
      { leadId, jti: crypto.randomUUID() },
      secret,
      {
        algorithm: ALGORITHM,
        issuer: ISSUER,
        audience: AUDIENCE,
        expiresIn: ttlSeconds,
      }
    );
    return { token, expiresInSeconds: ttlSeconds };
  }

  /**
   * Verifica y decodifica. Devuelve null si el token no sirve; el motivo
   * concreto no se le dice al cliente.
   *
   * `algorithms` fijo evita el ataque de confusion de algoritmo (un token con
   * `alg: none` o firmado con RS256 usando la clave publica como secreto).
   *
   * @param {string} token
   * @returns {{leadId: string, jti: string}|null}
   */
  function verify(token) {
    if (typeof token !== 'string' || token === '') return null;
    try {
      const payload = jwt.verify(token, secret, {
        algorithms: [ALGORITHM],
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      if (!payload || typeof payload.leadId !== 'string') return null;
      return { leadId: payload.leadId, jti: payload.jti };
    } catch {
      return null;
    }
  }

  return { issue, verify, ttlSeconds };
}

/** Extrae el token de `Authorization: Bearer <token>`. */
function bearerFrom(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const [scheme, token] = headerValue.split(' ');
  if (!token || scheme.toLowerCase() !== 'bearer') return null;
  return token.trim() || null;
}

module.exports = {
  ISSUER,
  AUDIENCE,
  ALGORITHM,
  DEFAULT_TTL_SECONDS,
  assertUsableSecret,
  createSessionManager,
  bearerFrom,
};
