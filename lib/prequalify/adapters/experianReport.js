'use strict';

const { ProviderError } = require('../ports/errors');
const logger = require('../../logger');

/**
 * Consulta del reporte de credito a Experian.
 *
 * Implementa `ports/experianPort.js`. Portado de `accionExperian.php`
 * (`getToken` :288 y `getApiResponse` :331), separando lo que alli estaba
 * mezclado: aqui solo esta la llamada HTTP. El parseo y el scoring viven en
 * `lib/prequalify/experian.js`, que recibe el reporte crudo.
 *
 * QUE NO SE PORTA DEL LEGACY
 *
 * - El `print_r($api_response)` de `accionExperian.php:1924`, que volcaba el
 *   reporte ENTERO —con SSN, tradelines y direcciones— en la respuesta HTTP al
 *   navegador. Aqui el reporte no sale nunca del backend.
 * - Los `echo` de depuracion repartidos por el archivo.
 *
 * ENTORNO
 *
 * El secreto `prod/experian` trae dos juegos de claves: las de produccion y las
 * `_DEV` (UAT). `usarUat` elige cual, y por defecto se mira
 * `EXPERIAN_USE_UAT === 'true'`. Es una decision de despliegue, no de codigo:
 * la misma imagen sirve para los dos entornos.
 *
 * QUE NO SE LOGUEA
 *
 * Ni el SSN, ni el reporte, ni el token. Al log va el subscriberCode, el
 * entorno, si hubo score y cuanto tardo — lo justo para saber si el proveedor
 * responde y a que ritmo.
 */

/** El legacy manda la fecha como MMDDYYYY (`accionExperian.php:43`). */
function dobParaExperian(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!m) throw new ProviderError('experian', 'Fecha de nacimiento no valida');
  const [, anio, mes, dia] = m;
  return `${mes}${dia}${anio}`;
}

/** Nueve digitos sin guiones, como espera la API. */
function ssnParaExperian(valor) {
  const digitos = String(valor ?? '').replace(/\D/g, '');
  if (digitos.length !== 9) throw new ProviderError('experian', 'SSN no valido');
  return digitos;
}

function exigirClaves(secreto, claves) {
  const faltan = claves.filter((k) => !secreto?.[k]);
  if (faltan.length) {
    throw new ProviderError(
      'experian',
      `Al secreto 'prod/experian' le faltan claves: ${faltan.join(', ')}`
    );
  }
}

/**
 * @param {object} deps
 * @param {() => Promise<object>} deps.getExperianSecrets secreto `prod/experian`
 * @param {boolean} [deps.usarUat] por defecto, `EXPERIAN_USE_UAT === 'true'`
 * @param {Function} [deps.fetchImpl] inyectable para tests
 * @param {number} [deps.timeoutMs] el legacy usaba 30 s
 * @returns {{fetchCreditReport: Function}}
 */
function createExperianAdapter({
  getExperianSecrets,
  usarUat = process.env.EXPERIAN_USE_UAT === 'true',
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('createExperianAdapter necesita fetch (Node >=18) o fetchImpl');
  }

  const suf = usarUat ? '_DEV' : '';
  const entorno = usarUat ? 'uat' : 'produccion';

  /** Token OAuth. Experian lo da con 1800 s de vida. */
  async function pedirToken(secreto) {
    const respuesta = await fetchImpl(secreto[`EXPERIAN_URL${suf}`], {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Experian espera el cliente en CABECERAS, no en el cuerpo ni en Basic.
        client_id: secreto[`EXPERIAN_CLIENT_ID${suf}`],
        client_secret: secreto[`EXPERIAN_CLIENT_SECRET${suf}`],
      },
      body: JSON.stringify({
        username: secreto[`EXPERIAN_USERNAME${suf}`],
        password: secreto[`EXPERIAN_PASSWORD${suf}`],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const datos = await respuesta.json().catch(() => ({}));
    if (!respuesta.ok || !datos.access_token) {
      // El texto de Experian distingue credenciales de cliente malas, cuenta
      // bloqueada y contrasena mala. Se conserva en el mensaje interno porque
      // sin el, diagnosticar un 401 es adivinar; al cliente le llega generico.
      throw new ProviderError(
        'experian',
        `token ${respuesta.status}: ${
          datos?.errors?.[0]?.message ?? datos?.error_description ?? 'sin detalle'
        }`
      );
    }
    return datos.access_token;
  }

  /**
   * @param {{firstName, lastName, dob, ssn, address:{line1,city,state,zipCode}}} applicant
   * @returns {Promise<object>} reporte crudo, para `experian.parseCreditReport`
   */
  async function fetchCreditReport(applicant) {
    const secreto = await getExperianSecrets();
    exigirClaves(secreto, [
      `EXPERIAN_URL${suf}`,
      `EXPERIAN_URL_REPORT${suf}`,
      `EXPERIAN_CLIENT_ID${suf}`,
      `EXPERIAN_CLIENT_SECRET${suf}`,
      `EXPERIAN_USERNAME${suf}`,
      `EXPERIAN_PASSWORD${suf}`,
      `EXPERIAN_SUBSCRIBER_CODE${suf}`,
    ]);

    const direccion = applicant?.address ?? {};
    const cuerpo = {
      consumerPii: {
        primaryApplicant: {
          name: { firstName: applicant?.firstName, lastName: applicant?.lastName },
          dob: { dob: dobParaExperian(applicant?.dob) },
          ssn: { ssn: ssnParaExperian(applicant?.ssn) },
          currentAddress: {
            line1: direccion.line1,
            city: direccion.city,
            state: direccion.state,
            zipCode: direccion.zipCode,
          },
        },
      },
      requestor: { subscriberCode: secreto[`EXPERIAN_SUBSCRIBER_CODE${suf}`] },
      // "3F" = solicitud de credito iniciada por el consumidor. Es lo que
      // legitima la consulta bajo la FCRA; cambiarlo no es cosmetico.
      permissiblePurpose: { type: '3F' },
      vendorData: { vendorNumber: 'FMV', vendorVersion: 'V1.00' },
      // "AF" selecciona el modelo de riesgo cuyo score usa la decision. El
      // parser solo lee ese (`experian.js` parseScore).
      addOns: { riskModels: { modelIndicator: ['AF'] } },
    };

    const token = await pedirToken(secreto);
    const inicio = process.hrtime.bigint();

    const respuesta = await fetchImpl(secreto[`EXPERIAN_URL_REPORT${suf}`], {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const ms = Number((process.hrtime.bigint() - inicio) / 1000000n);
    const datos = await respuesta.json().catch(() => ({}));

    if (!respuesta.ok) {
      throw new ProviderError(
        'experian',
        `reporte ${respuesta.status}: ${
          datos?.errors?.[0]?.message ?? datos?.error?.message ?? 'sin detalle'
        }`
      );
    }

    // Nada del reporte al log: solo si vino y cuanto tardo.
    logger.info('prequalify.experian_reporte', {
      entorno,
      ms,
      // `creditProfile` es la raiz que el parser espera; si no viene, el
      // reporte llego vacio y conviene verlo en el log antes que en el parseo.
      perfiles: Array.isArray(datos?.creditProfile) ? datos.creditProfile.length : 0,
    });

    return datos;
  }

  return { fetchCreditReport, _entorno: entorno };
}

module.exports = {
  createExperianAdapter,
  // Para tests; no forman parte del contrato del puerto.
  _dobParaExperian: dobParaExperian,
  _ssnParaExperian: ssnParaExperian,
};
