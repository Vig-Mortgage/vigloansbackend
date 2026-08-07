'use strict';

const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const logger = require('./logger');

/**
 * Acceso a AWS Secrets Manager con cache.
 *
 * Extraido de `app.js` sin cambiar comportamiento (Tarea D1). El cliente y la
 * cache eran globales del monolito; aqui quedan encapsulados y, sobre todo,
 * testeables: `createSecretsProvider` acepta un cliente inyectado, asi que se
 * puede probar el TTL y el fallback sin hablar con AWS.
 *
 * LA CLAVE DE CACHE ES EL NOMBRE DEL SECRETO. Antes se derivaba con un
 * if/else que mandaba cualquier nombre no reconocido al bucket 'appConfig', asi
 * que pedir un secreto nuevo devolvia en silencio el contenido de
 * 'vigloans/app-config'. Se corrigio al montar la precalificacion; el comentario
 * queda para que nadie lo "simplifique" de vuelta.
 *
 * TODO(Roberto): las credenciales salen de SM_AWS_ACCESS_KEY_ID /
 * SM_AWS_SECRET_ACCESS_KEY, que son llaves de larga vida en el `.env` del
 * servidor. El CLAUDE.md pide rol IAM de instancia. Mientras sigan siendo
 * llaves, cualquier filtracion del `.env` entrega todos los secretos de la
 * cuenta.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Nombres de los secretos que usa el backend. */
const SecretName = Object.freeze({
  BACKEND: 'vigloans/backend',
  APP_CONFIG: 'vigloans/app-config',
  MAIL: 'Mail',
  PREQUALIFY: 'vigloans/prequalify',
});

/** Cliente por defecto, con la misma configuracion que tenia `app.js`. */
function createDefaultClient() {
  return new SecretsManagerClient({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.SM_AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey:
        process.env.SM_AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

/**
 * @param {object} [deps]
 * @param {object} [deps.client] cliente de Secrets Manager (inyectable)
 * @param {number} [deps.ttlMs]
 * @param {() => number} [deps.now]
 */
function createSecretsProvider({
  client = null,
  ttlMs = DEFAULT_TTL_MS,
  now = () => Date.now(),
} = {}) {
  // Perezoso: construir el cliente en el require obligaria a tener credenciales
  // para importar el modulo, y rompe los tests.
  let smClient = client;
  const cache = new Map();

  async function getSecret(secretName) {
    const current = now();
    const cached = cache.get(secretName);
    if (cached && cached.expiry > current) return cached.data;

    try {
      smClient = smClient ?? createDefaultClient();
      const response = await smClient.send(
        new GetSecretValueCommand({ SecretId: secretName })
      );
      const parsed = JSON.parse(response.SecretString);
      cache.set(secretName, { data: parsed, expiry: current + ttlMs });
      logger.info('secrets.cargado', { name: secretName });
      return parsed;
    } catch (error) {
      // El nombre del secreto no es sensible; su contenido si, y nunca se
      // loguea. Si hay copia vencida se usa: preferimos servir con datos de
      // hace unos minutos antes que caernos porque AWS parpadeo.
      // La clave se llama `name` y no `secretName` a proposito: `lib/logger.js`
      // redacta cualquier clave que contenga "secret", y un error sin saber QUE
      // secreto fallo no sirve de nada. El nombre no es sensible; su contenido
      // si, y nunca se loguea.
      logger.error('secrets.error', { name: secretName, message: error.message });
      if (cached) {
        logger.warn('secrets.cache_vencido_usado', { name: secretName });
        return cached.data;
      }
      throw error;
    }
  }

  return {
    getSecret,
    getBackendSecrets: () => getSecret(SecretName.BACKEND),
    getAppConfig: () => getSecret(SecretName.APP_CONFIG),
    getMailSecrets: () => getSecret(SecretName.MAIL),
    getPrequalifySecrets: () => getSecret(SecretName.PREQUALIFY),
    /** Solo para tests. */
    _clearCache: () => cache.clear(),
    get _cacheSize() {
      return cache.size;
    },
  };
}

module.exports = { SecretName, DEFAULT_TTL_MS, createSecretsProvider };
