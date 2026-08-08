'use strict';

const { ProviderError } = require('../ports/errors');
const logger = require('../../logger');
const mapper = require('../salesforceMapper');

/**
 * Persistencia del lead de precualificacion en Salesforce.
 *
 * Implementa `ports/salesforcePort.js`. Reemplaza a `accionCrearLead.php`,
 * `accionSalesforce.php` y `accionQuerySalesforce.php`.
 *
 * Este modulo es SOLO transporte: autenticacion, HTTP y traduccion de errores.
 * Que campo va donde lo decide `salesforceMapper.js`, que ya esta portado y
 * probado. Aqui no hay ni un nombre de campo `__c` a mano.
 *
 * ESCRITURAS APAGADAS POR DEFECTO
 *
 * `permitirEscrituras` (por defecto `SALESFORCE_WRITES_ENABLED === 'true'`)
 * decide si `createLead`/`updateLead`/`setCurrentStep` llegan a la org o se
 * quedan en un no-op registrado. Existe porque hoy no hay sandbox: la unica org
 * disponible es la de produccion, con ~20.900 leads reales. Poder cablear el
 * adaptador y ejercitar las LECTURAS sin ensuciar esa org es la diferencia
 * entre avanzar y no avanzar.
 *
 * Con el flag apagado, una escritura devuelve un id sintetico y avisa en el
 * log. El flujo sigue, pero nada persiste — util para probar de punta a punta
 * sin dejar rastro, y peligroso si alguien lo confunde con "funciona": por eso
 * el log es `warn` y dice explicitamente que no se escribio.
 *
 * QUE NO SE PORTA DEL LEGACY
 *
 * - La concatenacion de email y telefono en el `WHERE` del SOQL
 *   (`accionCrearLead.php:12`, `accionDeleteLead.php:77`). El escapado vive en
 *   `mapper.escapeSoqlString` y las queries las arma el mapper.
 * - El dedupe comentado (`accionCrearLead.php:279-295`), que hacia que cada
 *   solicitud creara un lead nuevo. Aqui se busca antes de crear.
 * - `customError()`, que devolvia rutas de servidor y numeros de linea al
 *   cliente.
 */

/** Version de la API REST. Fijada a proposito: subirla es una decision. */
const API_VERSION = 'v60.0';

/** Margen para renovar el token antes de que caduque de verdad. */
const MARGEN_TOKEN_MS = 60 * 1000;

function exigirClaves(secreto, claves) {
  const faltan = claves.filter((k) => !secreto?.[k]);
  if (faltan.length) {
    throw new ProviderError(
      'salesforce',
      `Al secreto 'Salesforce' le faltan claves: ${faltan.join(', ')}`
    );
  }
}

/**
 * @param {object} deps
 * @param {() => Promise<object>} deps.getSalesforceSecrets secreto `Salesforce`
 * @param {boolean} [deps.usarSandbox] por defecto, `SALESFORCE_USE_SANDBOX === 'true'`
 * @param {boolean} [deps.permitirEscrituras] por defecto, `SALESFORCE_WRITES_ENABLED === 'true'`
 * @param {Function} [deps.fetchImpl] inyectable para tests
 * @param {number} [deps.timeoutMs]
 * @param {() => number} [deps.ahora] inyectable para probar la caducidad del token
 * @returns {{findLeadByEmailOrPhone, createLead, updateLead, getLead, setCurrentStep}}
 */
function createSalesforceLeadAdapter({
  getSalesforceSecrets,
  usarSandbox = process.env.SALESFORCE_USE_SANDBOX === 'true',
  permitirEscrituras = process.env.SALESFORCE_WRITES_ENABLED === 'true',
  fetchImpl = globalThis.fetch,
  timeoutMs = 30000,
  ahora = () => Date.now(),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('createSalesforceLeadAdapter necesita fetch (Node >=18) o fetchImpl');
  }

  const suf = usarSandbox ? '_DEV' : '';
  const entorno = usarSandbox ? 'sandbox' : 'produccion';

  /**
   * Token cacheado.
   *
   * Salesforce no dice cuanto dura el suyo en la respuesta del flujo password,
   * asi que se asume una hora y se renueva con margen. Sin cache, cada paso del
   * wizard abriria una sesion nueva y la org las cuenta.
   */
  let sesion = null;

  async function autenticar() {
    if (sesion && sesion.expira > ahora() + MARGEN_TOKEN_MS) return sesion;

    const secreto = await getSalesforceSecrets();
    exigirClaves(secreto, [
      `SF_URL${suf}`,
      `SF_CLIENT_ID${suf}`,
      `SF_CLIENT_SECRET${suf}`,
      `SF_USERNAME${suf}`,
      `SF_PASSWORD${suf}`,
      `SF_SECURITY_TOKEN${suf}`,
    ]);

    // El secreto guarda el ENDPOINT COMPLETO del token, no solo el host.
    const url = secreto[`SF_URL${suf}`];
    const cuerpo = new URLSearchParams({
      grant_type: 'password',
      client_id: secreto[`SF_CLIENT_ID${suf}`],
      client_secret: secreto[`SF_CLIENT_SECRET${suf}`],
      username: secreto[`SF_USERNAME${suf}`],
      // Salesforce exige contrasena + security token concatenados.
      password: String(secreto[`SF_PASSWORD${suf}`]) + String(secreto[`SF_SECURITY_TOKEN${suf}`]),
    });

    const respuesta = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: cuerpo.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const crudo = await respuesta.text();
    let datos;
    try {
      datos = JSON.parse(crudo);
    } catch {
      // Un sandbox caducado devuelve una pagina HTML de error, no JSON. Sin
      // este caso el fallo aparecia como "token undefined" mas adelante.
      throw new ProviderError(
        'salesforce',
        `token ${respuesta.status}: respuesta no es JSON (${crudo.slice(0, 80)})`
      );
    }

    if (!respuesta.ok || !datos.access_token) {
      throw new ProviderError(
        'salesforce',
        `token ${respuesta.status}: ${datos.error ?? ''} ${datos.error_description ?? ''}`.trim()
      );
    }

    sesion = {
      token: datos.access_token,
      instancia: datos.instance_url,
      expira: ahora() + 60 * 60 * 1000,
    };
    logger.info('salesforce.autenticado', { entorno });
    return sesion;
  }

  /** Llamada REST con reintento unico si el token caduco antes de tiempo. */
  async function llamar(metodo, ruta, cuerpo, { reintentado = false } = {}) {
    const { token, instancia } = await autenticar();
    const respuesta = await fetchImpl(`${instancia}/services/data/${API_VERSION}${ruta}`, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });

    // 401 con token cacheado: pudo caducar antes de lo asumido. Se reintenta
    // UNA vez con sesion nueva; si vuelve a fallar, es un problema real.
    if (respuesta.status === 401 && !reintentado) {
      sesion = null;
      return llamar(metodo, ruta, cuerpo, { reintentado: true });
    }

    if (respuesta.status === 204) return null;

    const datos = await respuesta.json().catch(() => null);
    if (!respuesta.ok) {
      const detalle = Array.isArray(datos)
        ? `${datos[0]?.errorCode ?? ''} ${datos[0]?.message ?? ''}`.trim()
        : JSON.stringify(datos ?? {}).slice(0, 200);
      throw new ProviderError('salesforce', `${metodo} ${ruta} -> ${respuesta.status}: ${detalle}`);
    }
    return datos;
  }

  /** Escritura bloqueada por el flag: se registra y NO se envia. */
  function escrituraBloqueada(operacion, extra = {}) {
    logger.warn('salesforce.escritura_omitida', {
      operacion,
      entorno,
      motivo: 'SALESFORCE_WRITES_ENABLED no esta activo — NADA se persistio',
      ...extra,
    });
  }

  // -------------------------------------------------------------------------
  // Puerto
  // -------------------------------------------------------------------------

  /**
   * Dedupe antes de crear. El legacy tenia esta funcion pero la llamada estaba
   * comentada (`accionCrearLead.php:279-295`), asi que cada solicitud generaba
   * un lead nuevo.
   */
  async function findLeadByEmailOrPhone(criteria) {
    const consulta = mapper.buildFindLeadByEmailOrPhoneQuery(criteria);
    if (!consulta) return null;
    const r = await llamar('GET', `/query?q=${encodeURIComponent(consulta)}`);
    const registro = r?.records?.[0];
    return registro ? { id: registro.Id } : null;
  }

  async function createLead(lead) {
    const campos = mapper.toLeadFields(lead);
    if (!permitirEscrituras) {
      escrituraBloqueada('createLead', { campos: Object.keys(campos).length });
      // Id sintetico reconocible: si aparece en Salesforce, algo va muy mal.
      return { id: `SIN_ESCRIBIR_${ahora()}` };
    }
    const r = await llamar('POST', '/sobjects/Lead', campos);
    logger.info('salesforce.lead_creado', { entorno });
    return { id: r.id };
  }

  /**
   * Pasos cuyos datos NO viven en el Lead sino en un objeto hijo.
   *
   * El paso llega explicito desde el router porque no se puede deducir del
   * contenido: `currentAddress` y `mailingAddress` mandan exactamente los mismos
   * nombres de campo, y sin el paso la direccion postal se escribiria encima de
   * la fisica.
   */
  const HIJOS = {
    mailingAddress: { sobject: mapper.SObject.MAILING_ADDRESS, construir: mapper.toMailingAddressRecord },
    employment: { sobject: mapper.SObject.EMPLOYMENT, construir: mapper.toEmploymentRecord },
    income: { sobject: mapper.SObject.INCOME, construir: mapper.toIncomeRecord },
  };

  /**
   * Crea el registro hijo de un paso.
   *
   * Se CREA, no se actualiza: el legacy tambien insertaba uno nuevo en cada
   * envio (`accionIncome.php` crea `Income__c`, `accionEmployment...` crea
   * `Employment_SelfEmployment__c`). Rehacer un paso deja dos registros, que es
   * el comportamiento que la org ya tiene y del que dependen sus informes.
   */
  async function crearHijo(leadId, step, datos) {
    const hijo = HIJOS[step];
    if (!hijo) return;

    const registro = hijo.construir(leadId, datos);
    // Los constructores siempre incluyen `Lead__c` (y el income, ademas, su
    // enum). Si no hay nada mas, el paso no traia datos y no hay que escribir.
    const utiles = Object.keys(registro).filter((k) => k !== 'Lead__c');
    if (utiles.length === 0) return;

    if (!permitirEscrituras) {
      escrituraBloqueada('crear ' + hijo.sobject, { leadId, campos: utiles.length });
      return;
    }
    await llamar('POST', `/sobjects/${hijo.sobject}`, registro);
    logger.info('salesforce.hijo_creado', { sobject: hijo.sobject });
  }

  /**
   * Lleva los datos del paso a la forma que espera el mapper.
   *
   * Los esquemas entregan la direccion PLANA (`line1`, `city`, ...) porque asi
   * la manda el formulario, pero `LEAD_FIELD_MAP` la busca anidada bajo
   * `currentAddress` — es lo que distingue la fisica de la postal, que tiene
   * exactamente los mismos nombres de campo.
   *
   * Sin esta traduccion `toLeadFields` devolvia `{}` para el paso de direccion:
   * el PATCH no salia y la direccion del solicitante NUNCA se guardaba. No se
   * veia porque las escrituras estaban apagadas y porque el doble de Salesforce
   * de los tests guarda los campos crudos, sin pasar por el mapper.
   */
  function aModeloApi(step, datos) {
    if (step !== 'currentAddress') return datos;
    const { line1, unit, city, state, zipCode, housing, rentMonth, years, months, ...otros } = datos;
    return {
      ...otros,
      currentAddress: { line1, unit, city, state, zipCode, housing, rentMonth, years, months },
    };
  }

  /**
   * @param {string} leadId
   * @param {object} fields datos del paso, ya validados
   * @param {{step?: string}} [opciones] paso del wizard; decide si ademas del
   *   Lead hay que crear un objeto hijo
   */
  async function updateLead(leadId, fields, { step } = {}) {
    // `completedSteps` no tiene campo en la org: se deriva de `currentStep__c`
    // al leer (ver `completedSetFromLegacy` en el mapper). Se descarta aqui en
    // vez de dejar que el mapper lo ignore en silencio.
    const { completedSteps, ...resto } = fields ?? {};
    void completedSteps;

    // El objeto hijo primero: si falla, el Lead no queda marcado como si el
    // paso hubiera cuajado.
    await crearHijo(leadId, step, resto);

    const campos = mapper.toLeadFields(aModeloApi(step, resto));
    if (Object.keys(campos).length === 0) return;

    if (!permitirEscrituras) {
      escrituraBloqueada('updateLead', { leadId, campos: Object.keys(campos).length });
      return;
    }
    await llamar('PATCH', `/sobjects/Lead/${encodeURIComponent(leadId)}`, campos);
  }

  /** Devuelve el modelo de la API. Nunca el SSN — ver `LEAD_READ_FIELDS`. */
  async function getLead(leadId) {
    if (!mapper.isSalesforceId(leadId)) return null;
    const consulta = mapper.buildGetLeadQuery(leadId);
    const r = await llamar('GET', `/query?q=${encodeURIComponent(consulta)}`);
    const registro = r?.records?.[0];
    return registro ? mapper.fromLeadRecord(registro) : null;
  }

  /**
   * El puerto recibe el NUMERO legacy (1..5), ya traducido por el router con
   * `stateMachine.toLegacyStep()`.
   *
   * Ojo con `mapper.toCurrentStepFields`: esa toma el NOMBRE del paso
   * (`'employment'`) y traduce ella misma. Pasarle el numero devuelve `{}` sin
   * quejarse, y `setCurrentStep` se convertia en un no-op silencioso — el lead
   * nunca avanzaba de paso en Salesforce y nada lo delataba.
   *
   * Va como string: asi esta en la org (`'1'` en `accionCrearLead.php:254`).
   */
  async function setCurrentStep(leadId, legacyStep) {
    if (!Number.isInteger(legacyStep)) return;
    const campos = { currentStep__c: String(legacyStep) };
    if (!permitirEscrituras) {
      escrituraBloqueada('setCurrentStep', { leadId, legacyStep });
      return;
    }
    await llamar('PATCH', `/sobjects/Lead/${encodeURIComponent(leadId)}`, campos);
  }

  logger.info('salesforce.adaptador', { entorno, escrituras: permitirEscrituras });

  return { findLeadByEmailOrPhone, createLead, updateLead, getLead, setCurrentStep };
}

module.exports = { createSalesforceLeadAdapter, API_VERSION };
