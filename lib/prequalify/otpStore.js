'use strict';

/**
 * Almacen de retos OTP.
 *
 * Contrato que debe cumplir cualquier implementacion (Redis, DynamoDB, tabla):
 *
 *   get(key)          -> Promise<OtpRecord|null>
 *   set(key, record)  -> Promise<void>
 *   delete(key)       -> Promise<void>
 *
 * @typedef {object} OtpRecord
 * @property {string} codeHash HMAC del codigo. NUNCA el codigo en claro.
 * @property {number} expiresAt epoch ms
 * @property {number} attempts intentos fallidos acumulados
 * @property {number} sends envios acumulados en la ventana
 * @property {number} lastSentAt epoch ms
 * @property {number} [lockedUntil] epoch ms mientras dure el bloqueo
 *
 * IMPORTANTE — el almacen debe ser **compartido y persistente** en produccion.
 * Con el de memoria, un reinicio de pm2 o una segunda instancia detras del
 * balanceador borran el contador de intentos: el atacante recupera sus 5
 * intentos con solo esperar (o con suerte de balanceo). Para 6 digitos eso
 * degrada el lockout hasta volverlo inutil.
 *
 * TODO(Roberto): decidir el backend real. Con una sola instancia de pm2 el de
 * memoria aguanta, pero deja de servir en cuanto se escale horizontalmente.
 * Redis con TTL nativo es lo natural aqui.
 */

/**
 * Almacen en memoria. Sirve para tests y para un despliegue de una sola
 * instancia; no para varias.
 *
 * @param {object} [options]
 * @param {() => number} [options.now]
 */
function createInMemoryOtpStore({ now = () => Date.now(), maxEntries = 50_000 } = {}) {
  const store = new Map();

  /**
   * Descarta lo vencido. Con un tope duro por encima: purgar solo lo vencido no
   * basta, porque dentro de la ventana de TTL un atacante que rote destinos
   * puede crear registros sin limite y agotar la memoria del proceso.
   *
   * Al llegar al tope se descartan los mas antiguos (Map preserva el orden de
   * insercion). Nota: eso puede tirar un bloqueo vigente, asi que el tope debe
   * quedar muy por encima del trafico legitimo — y es otra razon para mover
   * esto a Redis, donde el desalojo lo maneja el servidor.
   */
  function purge(current) {
    for (const [key, record] of store) {
      const vigente = Math.max(record.expiresAt, record.lockedUntil ?? 0);
      if (vigente <= current) store.delete(key);
    }
    while (store.size >= maxEntries) {
      store.delete(store.keys().next().value);
    }
  }

  return {
    async get(key) {
      const current = now();
      const record = store.get(key);
      if (!record) return null;
      // Un registro bloqueado sigue vivo aunque el codigo haya expirado: si no,
      // esperar el TTL limpiaria el lockout.
      const vigente = Math.max(record.expiresAt, record.lockedUntil ?? 0);
      if (vigente <= current) {
        store.delete(key);
        return null;
      }
      return { ...record };
    },

    async set(key, record) {
      purge(now());
      store.set(key, { ...record });
    },

    async delete(key) {
      store.delete(key);
    },

    get size() {
      return store.size;
    },
  };
}

module.exports = { createInMemoryOtpStore };
