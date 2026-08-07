'use strict';

const crypto = require('node:crypto');

const { createInMemoryOtpStore } = require('./otpStore');

/**
 * Servicio de OTP de la precualificacion.
 *
 * Regla numero uno: **el codigo nunca vuelve al cliente**. Ni en la respuesta
 * de `request()`, ni en un log, ni en un mensaje de error. Es el fallo
 * historico del `prequalify` legacy y por eso [requestCode] devuelve solo
 * metadatos.
 *
 * Decisiones de seguridad, todas comprobadas por tests:
 *
 * - **`crypto.randomInt`, no `Math.random`.** `Math.random` es predecible: quien
 *   observe unas cuantas salidas puede reconstruir el estado del generador y
 *   anticipar codigos.
 * - **Se guarda un HMAC del codigo, no el codigo.** Si alguien lee el almacen
 *   (dump de Redis, backup, log de la base) no obtiene OTPs vivos.
 * - **Comparacion en tiempo constante.** Un `===` sobre el hash filtra por
 *   tiempo cuantos bytes coinciden.
 * - **El codigo se consume al primer acierto.** Sin esto un codigo interceptado
 *   sirve hasta que expire.
 * - **Lockout tras N fallos** y **cooldown entre envios**, este ultimo tambien
 *   para que nadie use el endpoint como ametralladora de SMS a costa nuestra.
 * CONTRATO CON EL ROUTER (Tarea B4) — los valores de [VerifyResult] y
 * [RequestResult] son **internos, para el log**. El router NO debe mapearlos
 * uno a uno a respuestas distintas:
 *
 * - `INVALID`, `NOT_FOUND` y `EXPIRED` van al cliente con el MISMO mensaje.
 *   Distinguirlos permite enumerar que telefonos y correos tienen un reto
 *   activo.
 * - `LOCKED`, `COOLDOWN` y `TOO_MANY_SENDS` si pueden traducirse a 429 con
 *   `Retry-After`, porque el usuario legitimo necesita saber cuanto esperar.
 * - Este servicio limita **por destino**. Hace falta ademas un rate-limit
 *   **por IP** en el router: sin el, alguien puede rotar destinos y usar el
 *   endpoint como ametralladora de SMS a nuestra costa.
 */

const DEFAULT_CONFIG = Object.freeze({
  codeLength: 6,
  ttlSeconds: 600, // 10 min
  maxAttempts: 5,
  lockoutSeconds: 900, // 15 min tras agotar intentos
  resendCooldownSeconds: 60,
  maxSendsPerChallenge: 5,
});

/**
 * Motivos internos. Para el log y los tests; nunca para el cliente.
 *
 * `EXPIRED` y `NOT_FOUND` significan lo mismo de cara al usuario ("pide un
 * codigo nuevo") y cual de los dos sale depende del almacen: con TTL nativo
 * (Redis) el registro vencido ya no existe y sale `NOT_FOUND`; sin TTL (una
 * tabla SQL) lo atrapa la comprobacion de `expiresAt` y sale `EXPIRED`. El
 * router debe tratarlos igual.
 */
const VerifyResult = Object.freeze({
  OK: 'ok',
  INVALID: 'invalid',
  EXPIRED: 'expired',
  LOCKED: 'locked',
  NOT_FOUND: 'not_found',
});

const RequestResult = Object.freeze({
  SENT: 'sent',
  COOLDOWN: 'cooldown',
  LOCKED: 'locked',
  TOO_MANY_SENDS: 'too_many_sends',
});

/**
 * Codigo numerico aleatorio criptograficamente seguro.
 *
 * Se permiten ceros a la izquierda (`padStart`): recortarlos reduciria el
 * espacio de codigos y sesgaria la distribucion.
 */
function generateCode(length = DEFAULT_CONFIG.codeLength) {
  if (!Number.isInteger(length) || length < 4 || length > 10) {
    throw new RangeError('codeLength debe ser un entero entre 4 y 10');
  }
  const max = 10 ** length;
  return String(crypto.randomInt(0, max)).padStart(length, '0');
}

/** HMAC-SHA256 del codigo, ligado al destino para que no sea reusable. */
function hashCode(code, destination, secret) {
  if (!secret) throw new TypeError('Falta el secreto para el HMAC del OTP');
  return crypto
    .createHmac('sha256', secret)
    .update(`${normalizeDestination(destination)}:${code}`)
    .digest('hex');
}

/** Comparacion en tiempo constante de dos hashes hex. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** El mismo telefono escrito distinto no debe crear dos retos. */
function normalizeDestination(destination) {
  return String(destination ?? '').trim().toLowerCase();
}

/** Clave del almacen: canal + destino, hasheados para no guardar PII en claro. */
function challengeKey(channel, destination, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${channel}:${normalizeDestination(destination)}`)
    .digest('hex');
}

/**
 * Crea el servicio.
 *
 * @param {object} deps
 * @param {object} deps.otpPort puerto de entrega (ver `ports/otpPort.js`)
 * @param {string} deps.secret secreto del HMAC (Secrets Manager, no en codigo)
 * @param {object} [deps.store] almacen; por defecto en memoria
 * @param {() => number} [deps.now]
 * @param {object} [deps.config]
 */
function createOtpService({
  otpPort,
  secret,
  store = createInMemoryOtpStore(),
  now = () => Date.now(),
  config: overrides = {},
} = {}) {
  if (!otpPort || typeof otpPort.send !== 'function') {
    throw new TypeError('createOtpService requiere un otpPort con send()');
  }
  // 32 caracteres: la clave de un HMAC-SHA256 no deberia ser mas corta que su
  // salida. Sale de Secrets Manager, generarla larga no cuesta nada.
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new TypeError('createOtpService requiere un secreto de al menos 32 caracteres');
  }
  const config = { ...DEFAULT_CONFIG, ...overrides };

  /**
   * Genera y envia un codigo.
   *
   * @returns {Promise<{result: string, retryAfterSeconds?: number, expiresInSeconds?: number}>}
   *   **Nunca** incluye el codigo.
   */
  async function requestCode({ channel, destination, locale }) {
    const key = challengeKey(channel, destination, secret);
    const current = now();
    const existing = await store.get(key);

    if (existing?.lockedUntil && existing.lockedUntil > current) {
      return {
        result: RequestResult.LOCKED,
        retryAfterSeconds: Math.ceil((existing.lockedUntil - current) / 1000),
      };
    }

    if (existing) {
      const desde = current - existing.lastSentAt;
      if (desde < config.resendCooldownSeconds * 1000) {
        return {
          result: RequestResult.COOLDOWN,
          retryAfterSeconds: Math.ceil(
            (config.resendCooldownSeconds * 1000 - desde) / 1000
          ),
        };
      }
      if (existing.sends >= config.maxSendsPerChallenge) {
        return {
          result: RequestResult.TOO_MANY_SENDS,
          retryAfterSeconds: Math.ceil((existing.expiresAt - current) / 1000),
        };
      }
    }

    const code = generateCode(config.codeLength);
    const record = {
      codeHash: hashCode(code, destination, secret),
      expiresAt: current + config.ttlSeconds * 1000,
      // Reenviar da un codigo nuevo pero NO regala intentos: si no, bastaria
      // con pedir otro codigo cada vez que se agotan.
      attempts: existing?.attempts ?? 0,
      sends: (existing?.sends ?? 0) + 1,
      lastSentAt: current,
    };
    await store.set(key, record);

    // El puerto recibe el codigo para entregarlo; su retorno no lo incluye y
    // nosotros no lo propagamos.
    await otpPort.send({
      channel,
      destination,
      code,
      ttlSeconds: config.ttlSeconds,
      locale,
    });

    return { result: RequestResult.SENT, expiresInSeconds: config.ttlSeconds };
  }

  /**
   * Verifica un codigo. Al acertar, lo consume.
   *
   * @returns {Promise<{result: string, remainingAttempts?: number, retryAfterSeconds?: number}>}
   */
  async function verifyCode({ channel, destination, code }) {
    const key = challengeKey(channel, destination, secret);
    const current = now();
    const record = await store.get(key);

    if (!record) return { result: VerifyResult.NOT_FOUND };

    if (record.lockedUntil && record.lockedUntil > current) {
      return {
        result: VerifyResult.LOCKED,
        retryAfterSeconds: Math.ceil((record.lockedUntil - current) / 1000),
      };
    }

    if (record.expiresAt <= current) {
      await store.delete(key);
      return { result: VerifyResult.EXPIRED };
    }

    const candidato = hashCode(String(code ?? ''), destination, secret);
    if (safeEqual(candidato, record.codeHash)) {
      // Un solo uso.
      await store.delete(key);
      return { result: VerifyResult.OK };
    }

    const attempts = record.attempts + 1;
    if (attempts >= config.maxAttempts) {
      await store.set(key, {
        ...record,
        attempts,
        lockedUntil: current + config.lockoutSeconds * 1000,
      });
      return {
        result: VerifyResult.LOCKED,
        retryAfterSeconds: config.lockoutSeconds,
      };
    }

    await store.set(key, { ...record, attempts });
    return {
      result: VerifyResult.INVALID,
      remainingAttempts: config.maxAttempts - attempts,
    };
  }

  return { requestCode, verifyCode, config };
}

module.exports = {
  DEFAULT_CONFIG,
  VerifyResult,
  RequestResult,
  generateCode,
  hashCode,
  safeEqual,
  normalizeDestination,
  challengeKey,
  createOtpService,
};
