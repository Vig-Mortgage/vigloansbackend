'use strict';

const { isValidStateCode } = require('./usStates');

/**
 * Resolucion de ZIP a ciudad y estado contra Zippopotam.us (gratis, sin llave,
 * sin registro).
 *
 * Sustituye a `getCities.php` del legacy, que ademas de depender de una tabla
 * MySQL propia tenia inyeccion SQL: metia `$_POST['stateId']` crudo en el
 * `WHERE`.
 *
 * Cambia tambien el patron de UI: en vez de dos dropdowns encadenados
 * (estado -> ciudad, dos requests y una lista de miles de opciones), el usuario
 * escribe el ZIP y se autocompletan ciudad y estado. Menos pasos y menos
 * errores de tipeo.
 *
 * OJO CON PUERTO RICO: Zippopotam trata a PR como pais aparte. Los ZIP de PR
 * dan 404 bajo `/us/` y solo responden bajo `/pr/`. Verificado: `/us/00926`
 * -> 404, `/pr/00926` -> San Juan. Es la razon de [countryPathFor].
 *
 * Degradacion: si el servicio falla o tarda, se devuelve `null` y el wizard
 * deja escribir ciudad y estado a mano. Un tercero caido no puede bloquear una
 * solicitud.
 */

const DEFAULT_BASE_URL = 'https://api.zippopotam.us';
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // los ZIP no se mueven
const DEFAULT_CACHE_MAX_ENTRIES = 5000;

/**
 * Prefijos de ZIP que Zippopotam sirve bajo el pais `pr` en vez de `us`.
 * 006xx y 007xx: PR oeste/sur. 009xx: area metro de San Juan.
 */
const PR_ZIP_PREFIXES = Object.freeze(['006', '007', '009']);

/** Normaliza a 5 digitos. Devuelve null si no es un ZIP valido. */
function normalizeZip(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const match = String(value).trim().match(/^(\d{5})(?:-\d{4})?$/);
  return match ? match[1] : null;
}

/** `pr` para los ZIP de Puerto Rico, `us` para el resto. */
function countryPathFor(zip5) {
  return PR_ZIP_PREFIXES.includes(zip5.slice(0, 3)) ? 'pr' : 'us';
}

/**
 * Cache en memoria con TTL. Suficiente: el conjunto de ZIP consultados es
 * pequeno y estable, y el proceso se reinicia en cada deploy.
 */
function createCache({ ttlMs = DEFAULT_CACHE_TTL_MS, maxEntries = DEFAULT_CACHE_MAX_ENTRIES } = {}) {
  const store = new Map();
  return {
    get(key, now) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, now) {
      if (store.size >= maxEntries) {
        // Descarta la entrada mas antigua; Map preserva orden de insercion.
        store.delete(store.keys().next().value);
      }
      store.set(key, { value, expiresAt: now + ttlMs });
    },
    get size() {
      return store.size;
    },
  };
}

/**
 * Convierte la respuesta de Zippopotam al contrato de la API.
 *
 * Para PR, Zippopotam devuelve `state: "Pr"` (su modelo lo trata como pais), asi
 * que la abreviatura se corrige a partir del path consultado.
 */
function mapResponse(zip5, country, payload) {
  const place = Array.isArray(payload?.places) ? payload.places[0] : null;
  if (!place) return null;

  const fromPayload = place['state abbreviation'];
  const stateCode = isValidStateCode(fromPayload)
    ? String(fromPayload).toUpperCase()
    : country.toUpperCase();

  if (!isValidStateCode(stateCode)) return null;

  return {
    zipCode: zip5,
    city: place['place name'],
    state: stateCode,
  };
}

/**
 * Crea el resolvedor. `fetchImpl` y `now` son inyectables para poder testear
 * sin red ni reloj real.
 *
 * @returns {(zip: string) => Promise<{zipCode:string, city:string, state:string}|null>}
 */
function createZipLookup({
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  cache = createCache(),
  logger = null,
} = {}) {
  return async function lookupZip(zip) {
    const zip5 = normalizeZip(zip);
    if (!zip5) return null;

    const cached = cache.get(zip5, now());
    if (cached !== undefined) return cached;

    const country = countryPathFor(zip5);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let result = null;
    try {
      const response = await fetchImpl(`${baseUrl}/${country}/${zip5}`, {
        signal: controller.signal,
      });
      // 404 = ZIP inexistente: es una respuesta valida, se cachea como null.
      if (response.status === 200) {
        result = mapResponse(zip5, country, await response.json());
      } else if (response.status !== 404) {
        // 5xx u otro: no se cachea, para reintentar en la proxima.
        if (logger) logger.warn?.('zipLookup: respuesta inesperada', { status: response.status });
        return null;
      }
    } catch (error) {
      // Timeout o red caida: el wizard sigue, el usuario escribe a mano.
      if (logger) logger.warn?.('zipLookup: fallo la consulta', { message: error?.message });
      return null;
    } finally {
      clearTimeout(timer);
    }

    cache.set(zip5, result, now());
    return result;
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  PR_ZIP_PREFIXES,
  normalizeZip,
  countryPathFor,
  createCache,
  createZipLookup,
};
