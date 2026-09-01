'use strict';

const stateMachine = require('./stateMachine');

/**
 * Traduccion entre el modelo de la API de precualificacion (camelCase, definido
 * en `schemas.js`) y los campos de Salesforce.
 *
 * Todo aqui son **funciones puras**: sin red, sin credenciales, sin fecha/hora,
 * sin estado global. La implementacion del puerto (`ports/salesforcePort.js`)
 * usa este modulo para armar los cuerpos que manda y para limpiar lo que lee.
 *
 * El mapeo NO se inventa: sale de los `accion*.php` del Joomla legacy y cada
 * grupo de campos cita `archivo:linea`. Donde el legacy es ambiguo o
 * simplemente no tenia campo, hay un `TODO(Roberto)` en vez de una invencion.
 *
 * Tres cosas que el legacy hacia y aqui cambian a proposito, todas comentadas
 * en su sitio:
 *
 * 1. **El dedupe se reactiva.** `find_lead_by_email_or_phone` existia en
 *    `accionCrearLead.php:9` pero la llamada estaba comentada
 *    (`accionCrearLead.php:279-295`), asi que cada intento creaba un Lead nuevo.
 * 2. **El SOQL se escapa.** El legacy concatenaba el email y el telefono en el
 *    `WHERE` (`accionCrearLead.php:12-13`, `accionQuerySalesforce.php:14-20`,
 *    `accionQueryAllData.php:9`).
 * 3. **La lectura nunca devuelve el SSN.** `accionQueryAllData.php:9` lo
 *    seleccionaba y `:131-146` lo copiaba tal cual a la respuesta HTTP.
 */

// ---------------------------------------------------------------------------
// Objetos de Salesforce que toca el flujo
// ---------------------------------------------------------------------------

/**
 * El wizard legacy no guarda todo en el Lead: cuelga tres objetos hijos por
 * lookup `Lead__c`. Se conservan tal cual para no romper los reportes y
 * automatizaciones que la org ya tenga sobre ellos.
 */
const SObject = Object.freeze({
  LEAD: 'Lead',
  // accionMailingAddress.php:237
  MAILING_ADDRESS: 'MailingAddress__c',
  // accionEmployment_SelfEmployment.php:310
  EMPLOYMENT: 'Employment_SelfEmployment__c',
  // accionIncome.php:183
  INCOME: 'Income__c',
});

// ---------------------------------------------------------------------------
// SOQL: escapado y constructores
// ---------------------------------------------------------------------------

/**
 * Caracteres que Salesforce exige escapar dentro de un literal de cadena SOQL.
 * Fuente: SOQL and SOSL Reference, "Quoted String Escape Sequences".
 */
const SOQL_ESCAPES = Object.freeze({
  '\\': '\\\\',
  "'": "\\'",
  '"': '\\"',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
});

/** Tope defensivo: un literal de 4 KB en un `WHERE` no es un caso legitimo. */
const MAX_SOQL_LITERAL_LENGTH = 4096;

/**
 * Escapa el contenido de un literal de cadena SOQL.
 *
 * El `addslashes()` de `accionCrearLead.php:11-12` no vale: escapa `'`, `"` y
 * `\` al estilo de PHP pero deja pasar los saltos de linea y tabuladores, que
 * en SOQL tambien son secuencias reservadas. Y en `accionQuerySalesforce.php` y
 * `accionQueryAllData.php` no habia ni siquiera `addslashes()`.
 *
 * El `replace` de un solo paso es deliberado: sustituye cada caracter una sola
 * vez, asi que la barra invertida que introduce el escape no se vuelve a
 * escapar (el bug clasico de encadenar reemplazos).
 *
 * @param {string} value
 * @returns {string} el valor listo para ir entre comillas simples
 * @throws {TypeError} si no es cadena
 * @throws {RangeError} si trae NUL/control no escapable o excede el tope
 */
function escapeSoqlString(value) {
  if (typeof value !== 'string') {
    throw new TypeError('escapeSoqlString espera una cadena');
  }
  if (value.length > MAX_SOQL_LITERAL_LENGTH) {
    throw new RangeError('Literal SOQL demasiado largo');
  }
  // NUL y demas controles no tienen secuencia de escape definida en SOQL. Los
  // que si la tienen (backspace, tab, salto de linea, form feed, retorno de
  // carro) quedan fuera del rango de abajo a proposito.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0007\u000b\u000e-\u001f\u007f]/.test(value)) {
    throw new RangeError('Literal SOQL con caracteres de control no permitidos');
  }
  return value.replace(/[\\'"\n\r\t\b\f]/g, (char) => SOQL_ESCAPES[char]);
}

/** El literal completo, con sus comillas simples. */
function soqlLiteral(value) {
  return `'${escapeSoqlString(value)}'`;
}

/**
 * ¿Parece un Id de Salesforce? 15 caracteres (case-sensitive) o 18 (con sufijo
 * de checksum). Se valida antes de meterlo en un `WHERE Id = ...` aunque
 * ademas vaya escapado: defensa en profundidad.
 */
function isSalesforceId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(value);
}

// ---------------------------------------------------------------------------
// Dedupe por email / telefono
// ---------------------------------------------------------------------------

/**
 * Formatos en los que un mismo telefono puede estar guardado en la org.
 *
 * No es una invencion: el formulario legacy usa intl-tel-input
 * (`index.php:59`) y manda `iti.getNumber()` (`js/scripts.js:2441-2442`), que
 * devuelve **E.164** (`+17875551234`). La API nueva normaliza a 10 digitos
 * (`schemas.js`, primitiva `phone`). Si el dedupe busca solo los 10 digitos, no
 * encuentra ni uno de los leads que ya existen — que es justo lo que hay que
 * evitar.
 *
 * @param {string} digits 10 digitos ya normalizados por el esquema
 * @returns {string[]} variantes sin repetir, en orden de probabilidad
 */
function phoneVariants(digits) {
  if (typeof digits !== 'string' || !/^\d{10}$/.test(digits)) {
    throw new RangeError('phoneVariants espera 10 digitos');
  }
  return [`+1${digits}`, digits, `1${digits}`];
}

/**
 * Criterio de dedupe normalizado, tal como lo consume
 * `SalesforcePort.findLeadByEmailOrPhone`.
 *
 * El email se pasa a minusculas solo para comparar: Salesforce compara cadenas
 * sin distinguir mayusculas en `=`, pero normalizar deja el criterio estable y
 * facil de loguear (el email no es dato sensible bajo la politica del repo; el
 * SSN si, y aqui no aparece).
 *
 * @param {{email?: string, phone?: string}} input
 * @returns {{email?: string, phone?: string, phoneVariants?: string[]}}
 * @throws {RangeError} si no viene ni email ni telefono
 */
function buildDedupeCriteria({ email, phone } = {}) {
  const criteria = {};

  if (typeof email === 'string' && email.trim() !== '') {
    criteria.email = email.trim().toLowerCase();
  }
  if (typeof phone === 'string' && phone.trim() !== '') {
    const digits = phone.replace(/\D/g, '');
    const normalized = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
    if (!/^\d{10}$/.test(normalized)) {
      throw new RangeError('Telefono invalido para el criterio de dedupe');
    }
    criteria.phone = normalized;
    criteria.phoneVariants = phoneVariants(normalized);
  }

  if (!criteria.email && !criteria.phone) {
    // `accionQuerySalesforce.php:10-12` ya se negaba a consultar sin ninguno de
    // los dos; sin esa guarda el `WHERE` queda con literales vacios y hace
    // match con cualquier lead que tenga el campo en blanco.
    throw new RangeError('Se requiere email o telefono para el dedupe');
  }
  return criteria;
}

/**
 * SOQL del dedupe. Sustituye a `accionCrearLead.php:13`, que era
 * `"... WHERE Email = '$email' OR Phone = '$phone' LIMIT 1"` con interpolacion
 * directa.
 *
 * Se pide `Tipo_Prestamo__c` ademas del `Id` porque
 * `accionCrearLeadCoBorrower.php:30` ya lo leia del registro encontrado.
 *
 * @param {{email?: string, phone?: string}} input
 * @returns {string}
 */
function buildFindLeadByEmailOrPhoneQuery(input) {
  const criteria = buildDedupeCriteria(input);
  const conditions = [];

  if (criteria.email) {
    conditions.push(`Email = ${soqlLiteral(criteria.email)}`);
  }
  if (criteria.phoneVariants) {
    const list = criteria.phoneVariants.map(soqlLiteral).join(', ');
    conditions.push(`Phone IN (${list})`);
  }

  return `SELECT Id, Tipo_Prestamo__c FROM Lead WHERE ${conditions.join(' OR ')} LIMIT 1`;
}

/**
 * Campos que se leen de un Lead. Es la lista de `accionQueryAllData.php:9`
 * **menos `LASERCA__SSN__c`**: el SSN se escribe y no se vuelve a leer nunca.
 * Se anade `Id`, que el legacy no pedia porque lo traia del POST.
 */
const LEAD_READ_FIELDS = Object.freeze([
  'Id',
  'Email',
  'Phone',
  'FirstName',
  'LastName',
  'Birthdate__c',
  'currentStep__c',
  'Email_Coborrower__c',
  'Phone_Coborrower__c',
  'Street',
  'City',
  'State',
  'PostalCode',
  'Citizenship__c',
  'Type_of_Credit__c',
  'Marital_Status__c',
  'Dependents__c',
  'yearsCurrentAddress__c',
  'monthsCurrentAddress__c',
  'Housing1__c',
  'rentMonth__c',
  // Se lee para saber si `creditCheck` ya corrio (ver `EVIDENCIA_EN_EL_LEAD`).
  // NO sale al cliente: `CAMPOS_PUBLICOS` del router es una lista blanca y el
  // score no esta en ella.
  'Score__c',
]);

/**
 * Campos que jamas deben salir de una lectura hacia el cliente. `fromLeadRecord`
 * ya funciona por lista blanca, asi que esto es el cinturon ademas de los
 * tirantes — y sirve de asercion en los tests.
 */
const SENSITIVE_LEAD_FIELDS = Object.freeze(['LASERCA__SSN__c']);

/** SOQL de lectura de un lead por Id. Reemplaza `accionQueryAllData.php:9`. */
function buildGetLeadQuery(leadId) {
  if (!isSalesforceId(leadId)) {
    throw new RangeError('Id de Salesforce invalido');
  }
  return `SELECT ${LEAD_READ_FIELDS.join(', ')} FROM Lead WHERE Id = ${soqlLiteral(leadId)} LIMIT 1`;
}

// ---------------------------------------------------------------------------
// Normalizadores
// ---------------------------------------------------------------------------

/**
 * El legacy pasaba a mayusculas un subconjunto concreto de campos con
 * `strtoupper()`. No es cosmetica: los registros que ya estan en la org tienen
 * esos valores en mayuscula, y cualquier picklist/regla de la org se escribio
 * contra ellos. Se replica exactamente donde el legacy lo hacia y en ningun
 * sitio mas.
 */
function upper(value) {
  return typeof value === 'string' ? value.toUpperCase() : value;
}

function trimOrUndefined(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Telefono en E.164, que es como el legacy lo guardaba
 * (`js/scripts.js:2441-2442`). La API trabaja con 10 digitos; convertir al
 * escribir mantiene un solo formato en la org.
 */
function toE164(digits) {
  if (typeof digits !== 'string') return undefined;
  const only = digits.replace(/\D/g, '');
  if (/^\d{10}$/.test(only)) return `+1${only}`;
  if (/^1\d{10}$/.test(only)) return `+${only}`;
  return undefined;
}

/** Lee una ruta con puntos (`currentAddress.line1`) sin explotar en el camino. */
function getPath(source, path) {
  return path.split('.').reduce(
    (acc, key) => (acc == null ? undefined : acc[key]),
    source
  );
}

/** Numero o `undefined`. Evita que un `''` se convierta en 0 al escribir. */
function toNumberOrUndefined(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

// ---------------------------------------------------------------------------
// Valores literales del formulario legacy
// ---------------------------------------------------------------------------

/**
 * El checkbox `employerFamily` no manda un booleano: manda esta frase completa
 * como `value` (`index.php:1321`) y `accionEmployment_SelfEmployment.php:297`
 * la guarda tal cual en `Employer_Family__c`, sin `strtoupper()`.
 */
const EMPLOYER_FAMILY_LEGACY_VALUE =
  'family member, property seller, real estate agent, or other party to the transaction.';

/**
 * Valores del radio `businessOwnerOrSelfEmployed` (`index.php:1382-1391`),
 * en mayusculas porque `accionIncome.php:126` les aplica `strtoupper()` y
 * `:131-163` ramifica comparando contra esas mismas mayusculas.
 */
const EmploymentKind = Object.freeze({
  SELF_EMPLOYED: 'SELF-EMPLOYED',
  EMPLOYED: 'EMPLOYED',
  RETIRED_OR_PENSIONER: 'RETIRED OR PENSIONER',
});

/** `DoyoupayforChildSupport` es 'Yes'/'No' y va en mayusculas (`accionIncome.php:128`). */
const YES = 'YES';
const NO = 'NO';

// ---------------------------------------------------------------------------
// API -> campos del objeto Lead
// ---------------------------------------------------------------------------

/**
 * Tabla declarativa del mapeo a nivel Lead. Un solo sitio donde mirar que campo
 * de la API cae en que campo de Salesforce y de donde salio.
 *
 * `path` es la ruta en el modelo de la API, `sf` el campo de Salesforce,
 * `to` la conversion (por defecto, identidad) y `cite` la linea del legacy.
 */
const LEAD_FIELD_MAP = Object.freeze([
  // --- start: `accionCrearLead.php:248-261` -------------------------------
  { path: 'email', sf: 'Email', cite: 'accionCrearLead.php:249' },
  // El legacy guardaba lo que devolvia intl-tel-input, o sea E.164.
  { path: 'phone', sf: 'Phone', to: toE164, cite: 'accionCrearLead.php:250' },
  { path: 'firstName', sf: 'FirstName', to: upper, cite: 'accionCrearLead.php:56,251' },
  { path: 'lastName', sf: 'LastName', to: upper, cite: 'accionCrearLead.php:57,252' },
  { path: 'dob', sf: 'Birthdate__c', cite: 'accionCrearLead.php:80,253' },
  { path: 'loanPurpose', sf: 'Tipo_Prestamo__c', cite: 'accionCrearLead.php:70,255' },
  { path: 'leadSource', sf: 'LeadSource', cite: 'accionCrearLead.php:72,256' },
  { path: 'referredBy', sf: 'Referred_By__c', to: upper, cite: 'accionCrearLead.php:66,257' },
  { path: 'originator', sf: 'Originador__c', cite: 'accionCrearLead.php:71,260' },

  // --- personal: `accionSalesforce.php:311-328` ---------------------------
  // Dato sensible: se escribe, nunca se lee de vuelta (ver `fromLeadRecord`).
  { path: 'ssn', sf: 'LASERCA__SSN__c', cite: 'accionSalesforce.php:31,312' },
  { path: 'coborrowerEmail', sf: 'Email_Coborrower__c', cite: 'accionSalesforce.php:313' },
  {
    path: 'coborrowerPhone',
    sf: 'Phone_Coborrower__c',
    to: toE164,
    cite: 'accionSalesforce.php:314',
  },
  { path: 'citizenship', sf: 'Citizenship__c', to: upper, cite: 'accionSalesforce.php:69,319' },
  { path: 'typeOfCredit', sf: 'Type_of_Credit__c', to: upper, cite: 'accionSalesforce.php:71,320' },
  { path: 'maritalStatus', sf: 'Marital_Status__c', to: upper, cite: 'accionSalesforce.php:73,321' },
  {
    path: 'dependents',
    sf: 'Dependents__c',
    to: toNumberOrUndefined,
    cite: 'accionSalesforce.php:74,322',
  },

  // --- currentAddress: tambien `accionSalesforce.php:311-328` -------------
  // En el legacy la direccion actual viajaba en el mismo POST que los datos
  // personales; en la API son dos pasos, pero caen en los mismos campos.
  { path: 'currentAddress.line1', sf: 'Street', to: upper, cite: 'accionSalesforce.php:64,315' },
  { path: 'currentAddress.city', sf: 'City', cite: 'accionSalesforce.php:316' },
  { path: 'currentAddress.state', sf: 'State', cite: 'accionSalesforce.php:317' },
  { path: 'currentAddress.zipCode', sf: 'PostalCode', cite: 'accionSalesforce.php:318' },
  {
    path: 'currentAddress.years',
    sf: 'yearsCurrentAddress__c',
    to: toNumberOrUndefined,
    cite: 'accionSalesforce.php:323',
  },
  {
    path: 'currentAddress.months',
    sf: 'monthsCurrentAddress__c',
    to: toNumberOrUndefined,
    cite: 'accionSalesforce.php:324',
  },
  { path: 'currentAddress.housing', sf: 'Housing1__c', to: upper, cite: 'accionSalesforce.php:98,325' },
  {
    path: 'currentAddress.rentMonth',
    sf: 'rentMonth__c',
    to: toNumberOrUndefined,
    cite: 'accionSalesforce.php:326',
  },
  // TODO(Roberto): `currentAddress.unit` no tiene campo en el Lead. El legacy
  // ni siquiera lee `$_POST['unit']` en `accionSalesforce.php` — solo la
  // direccion anterior (`unit2__c`) y la del patrono (`UnitEmployer__c`) tienen
  // donde guardarlo. ¿Existe un campo de apartamento/unidad en el Lead que el
  // legacy nunca uso, o hay que crearlo? Mientras no se confirme, el dato se
  // valida y se descarta al escribir.

  // --- previousAddress: ELIMINADO -----------------------------------------
  //
  // La direccion anterior no se persiste porque en Salesforce NO EXISTE donde
  // guardarla. Verificado contra la org de produccion el 2026-08-07: el Lead
  // tiene `yearsCurrentAddress2__c`, `monthsCurrentAddress2__c`, `Housing2__c`
  // y `rentMonth2__c`, pero NO `street2__c`, `unit2__c`, `cbocity2__c`,
  // `cbostate2__c` ni `zip2__c`.
  //
  // Estos campos se habian portado de `accionDireccionAnterior.php`, que es
  // codigo muerto: su POST esta comentado en el legacy (`scripts.js:1122-1137`)
  // y su fieldset era inalcanzable, asi que nunca llego a escribir en
  // Salesforce y nadie descubrio que los campos no estaban. Escribirlos habria
  // fallado con INVALID_FIELD en la primera solicitud real.
  //
  // Guardar solo el tiempo y el gasto de vivienda sin la direccion no sirve de
  // nada ("cuantos anos en QUE direccion"), y pedirle a alguien una direccion
  // para tirarla es peor que no pedirla. Por eso se elimina el paso entero, no
  // solo los cinco campos.
  //
  // Para reactivarlo hacen falta los cinco campos en el Lead. Requiere acceso
  // de administrador a Salesforce, que hoy no tenemos.

  // --- co-deudor: `accionCrearLeadCoBorrower.php:254-266` -----------------
  { path: 'isCoborrower', sf: 'Coborrower__c', cite: 'accionCrearLeadCoBorrower.php:261' },
  { path: 'borrowerLeadId', sf: 'Borrower__c', cite: 'accionCrearLeadCoBorrower.php:260' },
  // Enlace inverso, que se escribe sobre el lead del DEUDOR, no sobre el suyo.
  { path: 'coborrowerLeadId', sf: 'Coborrower_Lead__c', cite: 'accionCrearLeadCoBorrower.php:296' },

  // --- creditCheck: `accionExperian.php:993-1003` ---------------------------
  // El score que devuelve el modelo "AF" y la suma de pagos mensuales de los
  // tradelines. El legacy guardaba el score en `Score__c` pero la deuda solo en
  // `$_SESSION['MonthlyPayment']`, que se perdia al cerrar la sesion; aqui va a
  // `All_Monthly_Obligations__c`, que ya existe en la org.
  //
  // Persistirla importa: la decision se toma DESPUES, en el paso de ingresos, y
  // sin este dato habria que volver a pedir el reporte — otra consulta al buro
  // por la misma persona.
  { path: 'creditScore', sf: 'Score__c', to: toNumberOrUndefined, cite: 'accionExperian.php:993' },
  {
    path: 'monthlyDebtPayments',
    sf: 'All_Monthly_Obligations__c',
    to: toNumberOrUndefined,
    cite: 'accionExperian.php:588',
  },

  // --- resultado de calificacion: `accionIncome.php:257-263` --------------
  { path: 'qualification.dti', sf: 'DTI__c', to: toNumberOrUndefined, cite: 'accionIncome.php:260' },
  {
    path: 'qualification.housingRatio',
    sf: 'Housing__c',
    to: toNumberOrUndefined,
    cite: 'accionIncome.php:261',
  },
  {
    path: 'qualification.maxHomePrice',
    sf: 'Cantidad__c',
    to: toNumberOrUndefined,
    cite: 'accionIncome.php:262',
  },
]);

/** Indice `campo de la API -> campo de Salesforce`, util para tests y logs. */
const LEAD_FIELD_BY_API_PATH = Object.freeze(
  Object.fromEntries(LEAD_FIELD_MAP.map(({ path, sf }) => [path, sf]))
);

/**
 * Traduce un modelo (posiblemente parcial) de la API a un patch de campos del
 * Lead.
 *
 * Solo salen los campos **presentes** en la entrada. El legacy mandaba `''`
 * para todo lo ausente (`accionCrearLead.php:256-260`,
 * `accionDireccionAnterior.php:13-74`), lo que en un PATCH **borra** el valor
 * que ya estuviera guardado: reanudar el wizard vaciaba campos completados
 * antes. Aqui, ausente significa "no tocar".
 *
 * @param {object} apiData modelo de la API, plano o anidado
 *   (`{ email, phone, ..., currentAddress: {...}, mailingAddress: {...} }`)
 * @returns {object} objeto listo para `createLead`/`updateLead`
 */
function toLeadFields(apiData = {}) {
  const fields = {};

  for (const { path, sf, to } of LEAD_FIELD_MAP) {
    const raw = getPath(apiData, path);
    if (raw === undefined || raw === null) continue;

    const value = to ? to(raw) : raw;
    if (value === undefined) continue;
    fields[sf] = value;
  }

  // El paso llega como nombre de la maquina de estados; a Salesforce va el
  // numero legacy '1'..'5' (`stateMachine.js`, LEGACY_STEP_TO_STEP).
  const stepFields = toCurrentStepFields(apiData.currentStep);
  Object.assign(fields, stepFields);

  return fields;
}

/**
 * `currentStep__c` a partir de un paso del wizard.
 *
 * Devuelve `{}` (no toca el campo) para los pasos que el legacy no numera:
 * `mailingAddress`, `coborrower`, `otpVerify`.
 * `stateMachine.toLegacyStep()` es quien decide.
 *
 * @param {string} [step]
 * @returns {{currentStep__c?: string}}
 */
function toCurrentStepFields(step) {
  if (step === undefined || step === null) return {};
  const legacy = stateMachine.toLegacyStep(step);
  if (legacy === null) return {};
  // Es string en la org: `'1'` en `accionCrearLead.php:254`, `'2'` en
  // `accionSalesforce.php:327`, `'4'` en
  // `accionEmployment_SelfEmployment.php:302`, `'5'` en `accionIncome.php:360`.
  return { currentStep__c: String(legacy) };
}

// ---------------------------------------------------------------------------
// API -> objetos hijos
// ---------------------------------------------------------------------------

/**
 * Registro de `MailingAddress__c`. Portado de
 * `accionMailingAddress.php:224-232`.
 *
 * TODO(Roberto): el objeto solo tiene calle, unidad, ciudad, estado y ZIP,
 * pero `mailingAddressSchema` (= `addressBase`) tambien pide `housing`,
 * `rentMonth`, `years` y `months`. En una direccion **postal** esos cuatro no
 * tienen sentido (no vives ahi), y el legacy no los guardaba. Confirmar si el
 * paso debe dejar de pedirlos en vez de recogerlos y tirarlos.
 *
 * @param {string} leadId
 * @param {object} address
 * @returns {object}
 */
function toMailingAddressRecord(leadId, address = {}) {
  if (!isSalesforceId(leadId)) {
    throw new RangeError('Id de Salesforce invalido');
  }
  const record = { Lead__c: leadId };

  const put = (sf, value) => {
    if (value !== undefined && value !== null && value !== '') record[sf] = value;
  };

  // accionMailingAddress.php:229
  put('StreetMailAddress__c', trimOrUndefined(address.line1));
  // accionMailingAddress.php:230
  put('UnitMailAddress__c', trimOrUndefined(address.unit));
  // accionMailingAddress.php:227
  put('cbocityMailAddress__c', trimOrUndefined(address.city));
  // accionMailingAddress.php:226
  put('cbostateMailAddress__c', trimOrUndefined(address.state));
  // accionMailingAddress.php:228
  put('ZIPMailAddress__c', trimOrUndefined(address.zipCode));

  return record;
}

/**
 * Registro de `Employment_SelfEmployment__c`. Portado de
 * `accionEmployment_SelfEmployment.php:284-299`.
 *
 * @param {string} leadId
 * @param {object} employment tal como lo valida `employmentSchema`
 * @returns {object}
 */
function toEmploymentRecord(leadId, employment = {}) {
  if (!isSalesforceId(leadId)) {
    throw new RangeError('Id de Salesforce invalido');
  }
  const record = { Lead__c: leadId };

  const put = (sf, value) => {
    if (value !== undefined && value !== null && value !== '') record[sf] = value;
  };

  // :191,286 — el legacy pasa a mayusculas nombre del patrono, calle y puesto.
  put('EmployerBusinessName__c', upper(trimOrUndefined(employment.employerBusinessName)));
  // :228,291
  put('StreetEmployer__c', upper(trimOrUndefined(employment.line1)));
  // :244,293
  put('PositionTitle__c', upper(trimOrUndefined(employment.positionTitle)));
  // :287 — el resto va tal cual.
  put('PhoneEmployer__c', toE164(employment.employerPhone));
  // :288
  put('cbostateEmployer__c', trimOrUndefined(employment.state));
  // :289
  put('cbocityEmployer__c', trimOrUndefined(employment.city));
  // :290
  put('ZIPEmployer__c', trimOrUndefined(employment.zipCode));
  // :292
  put('UnitEmployer__c', trimOrUndefined(employment.unit));
  // :251,294 — `formatDateSF()` deja la fecha en `Y-m-d`, que es lo que ya
  // entrega el esquema.
  put('StartDate__c', trimOrUndefined(employment.startDate));
  // :295
  put('yearsEmployment__c', toNumberOrUndefined(employment.yearsEmployment));
  // :296
  put('monthsEmployment__c', toNumberOrUndefined(employment.monthsEmployment));

  // :297 — `Employer_Family__c` no guarda un booleano sino el `value` literal
  // del checkbox (`index.php:1321`). Si no esta marcado, el legacy manda ''.
  if (employment.employedByFamily !== undefined && employment.employedByFamily !== null) {
    record.Employer_Family__c = employment.employedByFamily
      ? EMPLOYER_FAMILY_LEGACY_VALUE
      : '';
  }
  // TODO(Roberto): confirmar si `Employer_Family__c` es texto (y entonces esta
  // bien guardar la frase) o casilla de verificacion. Si fuera booleano, el
  // legacy lleva anos escribiendo una cadena en un campo checkbox y Salesforce
  // la esta interpretando como `true` para cualquier valor no vacio.

  return record;
}

/**
 * Registro de `Income__c`. Portado de `accionIncome.php:123-190`.
 *
 * El legacy tiene tres ramas segun el radio `businessOwnerOrSelfEmployed`
 * (`:131`, `:144`, `:163`): cada una guarda los adjuntos y los totales en un
 * juego de campos distinto. Se replica.
 *
 * @param {string} leadId
 * @param {object} income datos de `incomeSchema` + `monthlyIncome` derivado
 * @param {number} income.monthlyIncome mensual calculado por `income.js`
 *   (NO por el cliente: ver la nota de `lib/prequalify/income.js`)
 * @param {string[]} [documentIds] ids/URLs de los adjuntos, en orden 1..4.
 *   El legacy los sacaba de `$_SESSION['file1'..'file4']`
 *   (`accionIncome.php:30-33`); ahora los aporta el puerto de documentos.
 * @returns {object}
 */
function toIncomeRecord(leadId, income = {}, documentIds = []) {
  if (!isSalesforceId(leadId)) {
    throw new RangeError('Id de Salesforce invalido');
  }

  const kind = toEmploymentKind(income);
  const [file1, file2, file3, file4] = documentIds;

  const record = { Lead__c: leadId };
  const put = (sf, value) => {
    if (value !== undefined && value !== null && value !== '') record[sf] = value;
  };

  // Comun a las tres ramas (`accionIncome.php:133-140`).
  record.BussinessOwnerOrSelfEmployed__c = kind; // sic: doble 's' en la org
  // :135,149,168 — `MonthlyIncome__c` guarda el **pago por periodo**, no el
  // mensual: el input legacy `#MonthlyIncome` es el bruto del periodo y
  // `#TotalIncome` el derivado (`js/scripts.js:589-604`). Los nombres estan
  // invertidos en la org; se respetan para no romper reportes existentes.
  put('MonthlyIncome__c', toNumberOrUndefined(income.grossPayPerPeriod));
  // :140,153,172 — aqui si va el mensual.
  put('TotalIncome__c', toNumberOrUndefined(income.monthlyIncome));
  // :139
  put('IncomeFrequency__c', trimOrUndefined(income.incomeFrequency));
  // :137 — 'YES'/'NO' en mayusculas (`:128`).
  if (income.paysChildSupport !== undefined && income.paysChildSupport !== null) {
    record.DoYouPayforChildSupport__c = income.paysChildSupport ? YES : NO;
  }
  // :138
  put('HowMuchChildSupport__c', toNumberOrUndefined(income.childSupportAmount));

  // TODO(Roberto): `RetiredorPensioner__c` (`:134,147,166`) guarda el segundo
  // radio del formulario, con valores 'Social Security' y
  // 'Government, 401K, IRA, etc...' (`index.php:1397,1401`). `incomeSchema`
  // solo tiene el booleano `retiredOrPensioner`, que no distingue entre los
  // dos. Falta decidir si la API expone ese detalle (un enum
  // `pensionSource`) o si el campo se deja de poblar. Hasta entonces no se
  // escribe: escribir 'YES' ahi seria inventarse un valor de picklist.

  if (kind === EmploymentKind.RETIRED_OR_PENSIONER) {
    // :141-142 — un solo adjunto ('forma') y un solo total.
    put('formaFile__c', file1);
    put('formaTotal__c', toNumberOrUndefined(income.netPay1));
  } else if (kind === EmploymentKind.EMPLOYED) {
    // :154-161 — cuatro talonarios y cuatro netos.
    put('paystubFile1__c', file1);
    put('paystubFile2__c', file2);
    put('paystubFile3__c', file3);
    put('paystubFile4__c', file4);
    put('netincome1__c', toNumberOrUndefined(income.netPay1));
    put('netincome2__c', toNumberOrUndefined(income.netPay2));
    put('netincome3__c', toNumberOrUndefined(income.netPay3));
    put('netincome4__c', toNumberOrUndefined(income.netPay4));
  } else {
    // :173-179 — planillas. Cuatro archivos pero solo TRES totales.
    put('taxesFile1__c', file1);
    put('taxesFile2__c', file2);
    put('taxesFile3__c', file3);
    put('taxesFile4__c', file4);
    put('taxesTotal1__c', toNumberOrUndefined(income.netPay1));
    put('taxesTotal2__c', toNumberOrUndefined(income.netPay2));
    put('taxesTotal3__c', toNumberOrUndefined(income.netPay3));
    // TODO(Roberto): en la rama self-employed el legacy sube `taxesFile4__c`
    // pero nunca escribe un `taxesTotal4__c` (`accionIncome.php:173-179`).
    // ¿Es un olvido del legacy y el campo existe en la org, o de verdad son
    // solo tres totales? Si existe, hay que anadirlo aqui.
  }

  return record;
}

/**
 * Deriva el valor de `BussinessOwnerOrSelfEmployed__c` desde los dos booleanos
 * de la API.
 *
 * TODO(Roberto): en el legacy esto es **un radio de tres opciones**
 * (`index.php:1382-1391`: Self-Employed / Employed / Retired or Pensioner),
 * mientras que `incomeSchema` tiene dos booleanos independientes
 * (`businessOwnerOrSelfEmployed`, `retiredOrPensioner`). Los dos booleanos
 * pueden estar en `true` a la vez, cosa que el radio no permite. Aqui se
 * resuelve dando prioridad a "retirado" (que es lo que el legacy trata como
 * caso especial, `:131`), pero lo correcto seria que la API expusiera un enum
 * de tres valores igual que el formulario. Confirmar antes de cablearlo.
 */
function toEmploymentKind({ businessOwnerOrSelfEmployed, retiredOrPensioner } = {}) {
  if (retiredOrPensioner) return EmploymentKind.RETIRED_OR_PENSIONER;
  if (businessOwnerOrSelfEmployed) return EmploymentKind.SELF_EMPLOYED;
  return EmploymentKind.EMPLOYED;
}

/**
 * Enlace inverso deudor -> co-deudor. `accionCrearLeadCoBorrower.php:295-299`
 * lo escribe sobre el lead del deudor despues de crear el del co-deudor.
 */
function toCoborrowerBackLinkFields(coborrowerLeadId) {
  if (!isSalesforceId(coborrowerLeadId)) {
    throw new RangeError('Id de Salesforce invalido');
  }
  return { Coborrower_Lead__c: coborrowerLeadId };
}

// ---------------------------------------------------------------------------
// Salesforce -> API
// ---------------------------------------------------------------------------

/**
 * Deshace el `strtoupper()` del legacy devolviendo el valor canonico de la API.
 *
 * Si el valor guardado no corresponde a ninguno conocido se devuelve tal cual
 * (recortado): perder el dato seria peor que devolverlo sin normalizar, y la
 * validacion de entrada ya lo rechazara si el cliente intenta reenviarlo.
 */
function denormalizeEnum(value, allowed) {
  const raw = trimOrUndefined(value);
  if (raw === undefined) return undefined;
  const match = allowed.find((option) => option.toUpperCase() === raw.toUpperCase());
  return match ?? raw;
}

const HOUSING_VALUES = Object.freeze(['No primary housing expense', 'Own', 'Rent']);
const CITIZENSHIP_VALUES = Object.freeze([
  'U.S. Citizen',
  'Permanent Resident Alien',
  'Non-Permanent Resident Alien',
]);
const MARITAL_STATUS_VALUES = Object.freeze(['Married', 'Single', 'Unmarried']);
const TYPE_OF_CREDIT_VALUES = Object.freeze(['IndividualCredit', 'CoborrowerCredit']);

/** Telefono de Salesforce (E.164 o lo que sea) a los 10 digitos de la API. */
function fromSalesforcePhone(value) {
  if (typeof value !== 'string') return undefined;
  const digits = value.replace(/\D/g, '');
  if (/^\d{10}$/.test(digits)) return digits;
  if (/^1\d{10}$/.test(digits)) return digits.slice(1);
  // Numero internacional o basura heredada: se devuelve tal cual para no
  // inventarse una normalizacion que no aplica.
  return trimOrUndefined(value);
}

/**
 * Traduce un registro de Lead de Salesforce al modelo de la API.
 *
 * **Nunca devuelve el SSN ni ningun dato de credito.** Funciona por lista
 * blanca: si un campo no esta escrito abajo, no sale. Esto corrige
 * `accionQueryAllData.php`, que seleccionaba `LASERCA__SSN__c` (`:9`) y luego
 * volcaba **todos** los campos del registro en la respuesta HTTP (`:131-146`),
 * dejando el SSN al alcance de cualquiera que supiera un Id de lead.
 *
 * @param {object|null} sfRecord registro crudo de Salesforce
 * @returns {object|null} modelo de la API, o `null` si no hay registro
 */
/**
 * Reconstruye `completedSteps` a partir de `currentStep__c`.
 *
 * POR QUE ES UNA DERIVACION Y NO UNA LECTURA
 *
 * Salesforce no tiene ningun campo donde guardar la lista de pasos completados
 * (verificado contra la org de produccion el 2026-08-07: no existe nada tipo
 * `completedSteps__c`, y no tenemos acceso de administrador para crearlo). Lo
 * unico que persiste del avance es `currentStep__c`, un solo numero del 1 al 5.
 *
 * Asi que se deriva: si el lead va por el paso N, todos los pasos aplicables
 * anteriores estan hechos. Es exacto para un wizard lineal, que es lo que
 * queda tras eliminar la direccion anterior.
 *
 * LIMITE CONOCIDO
 *
 * Un paso opcional que no tenga numero legacy (`mailingAddress`, `coborrower`)
 * se da por hecho en cuanto el lead pasa de el. No se puede distinguir "lo hizo"
 * de "no le aplicaba", porque el numero no lo registra. En la practica da igual:
 * `canEnter` solo exige los pasos que APLICAN al lead, y si aplicaba y no lo
 * hizo, `currentStep__c` no habria avanzado.
 *
 * El dia que exista un campo propio, esto se sustituye por una lectura directa
 * y el limite desaparece.
 */
/**
 * Pasos que dejan RASTRO en el propio Lead, y como reconocerlo.
 *
 * Existe porque `currentStep__c` no basta. Solo cinco pasos tienen numero
 * (1..5) y los demas —`mailingAddress`, `creditCheck`, `coborrower`— son
 * invisibles para el. Eso rompia el flujo de forma concreta: al completar
 * `currentAddress`, el siguiente paso es `creditCheck`, que no tiene numero,
 * asi que `currentStep__c` se quedaba en 2. Al releer el lead la direccion no
 * constaba como hecha, `credit-check` respondia 409 "faltan pasos previos" y el
 * cliente retrocedia al formulario de direccion, vacio.
 *
 * La salida es no depender solo del numero: si los datos de un paso ESTAN
 * escritos en el Lead, el paso se hizo. Es una deduccion sobre hechos
 * persistidos, no una suposicion.
 *
 * Solo se listan pasos cuyos datos viven en el Lead. Los que van a objetos hijo
 * (`employment`, `income`) no dejan rastro legible aqui, pero SI tienen numero
 * legacy, asi que estan cubiertos por la otra via.
 */
const EVIDENCIA_EN_EL_LEAD = Object.freeze({
  // La identidad del paso `start`: nace en `/otp/verify` con nombre, pero la
  // fecha de nacimiento solo se escribe en `start`.
  [stateMachine.Step.START]: (r) => Boolean(r.Birthdate__c),
  // Los tres enums que solo se piden en `personal`.
  [stateMachine.Step.PERSONAL]: (r) =>
    Boolean(r.Citizenship__c && r.Marital_Status__c && r.Type_of_Credit__c),
  // La direccion fisica completa.
  [stateMachine.Step.CURRENT_ADDRESS]: (r) =>
    Boolean(r.Street && r.City && r.State && r.PostalCode),
  // El score. Se comprueba PRESENCIA, no que sea mayor que cero: un "sin
  // registro" en el buro devuelve 0 y el paso se hizo igual.
  [stateMachine.Step.CREDIT_CHECK]: (r) =>
    r.Score__c !== null && r.Score__c !== undefined && r.Score__c !== '',
});

/**
 * Lleva los datos de un paso a la forma que espera [toLeadFields].
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
function toApiModelForStep(step, datos) {
  if (step !== 'currentAddress') return datos;
  const { line1, unit, city, state, zipCode, housing, rentMonth, years, months, ...otros } = datos;
  return {
    ...otros,
    currentAddress: { line1, unit, city, state, zipCode, housing, rentMonth, years, months },
  };
}

function completedSetFromLegacy(currentStepRaw, sfRecord) {
  const contexto = {
    typeOfCredit: denormalizeEnum(sfRecord.Type_of_Credit__c, TYPE_OF_CREDIT_VALUES),
    // `mailingAddressDiffers` tampoco se persiste; se asume que no difiere. Si
    // difiriera, el lead no habria pasado de ese paso y no estariamos aqui.
    mailingAddressDiffers: false,
  };

  const hechos = new Set();

  // Via 1: el numero. Si va por el paso N, los aplicables anteriores estan
  // hechos. Exacto para un wizard lineal.
  const paso = stateMachine.fromLegacyStep(currentStepRaw);
  if (paso) {
    const hasta = stateMachine.stepIndex(paso);
    for (const [i, s] of stateMachine.STEP_ORDER.entries()) {
      if (i < hasta && stateMachine.appliesTo(s, contexto)) hechos.add(s);
    }
  }

  // Via 2: el rastro en los datos. Cubre los pasos sin numero.
  for (const [s, hayRastro] of Object.entries(EVIDENCIA_EN_EL_LEAD)) {
    if (hayRastro(sfRecord)) hechos.add(s);
  }

  // `undefined` y no `[]` cuando no se sabe nada: distingue "lead recien
  // creado" de "lead sin ningun paso hecho", y es lo que esperan los
  // llamadores.
  return hechos.size > 0 ? [...hechos] : undefined;
}

function fromLeadRecord(sfRecord) {
  if (sfRecord === null || sfRecord === undefined) return null;
  if (typeof sfRecord !== 'object' || Array.isArray(sfRecord)) {
    throw new TypeError('fromLeadRecord espera un registro de Salesforce');
  }

  const lead = {
    id: trimOrUndefined(sfRecord.Id),
    email: trimOrUndefined(sfRecord.Email),
    phone: fromSalesforcePhone(sfRecord.Phone),
    firstName: trimOrUndefined(sfRecord.FirstName),
    lastName: trimOrUndefined(sfRecord.LastName),
    dob: trimOrUndefined(sfRecord.Birthdate__c),
    coborrowerEmail: trimOrUndefined(sfRecord.Email_Coborrower__c),
    coborrowerPhone: fromSalesforcePhone(sfRecord.Phone_Coborrower__c),
    citizenship: denormalizeEnum(sfRecord.Citizenship__c, CITIZENSHIP_VALUES),
    maritalStatus: denormalizeEnum(sfRecord.Marital_Status__c, MARITAL_STATUS_VALUES),
    typeOfCredit: denormalizeEnum(sfRecord.Type_of_Credit__c, TYPE_OF_CREDIT_VALUES),
    dependents: toNumberOrUndefined(sfRecord.Dependents__c),
    currentAddress: compact({
      line1: trimOrUndefined(sfRecord.Street),
      city: trimOrUndefined(sfRecord.City),
      state: trimOrUndefined(sfRecord.State),
      zipCode: trimOrUndefined(sfRecord.PostalCode),
      housing: denormalizeEnum(sfRecord.Housing1__c, HOUSING_VALUES),
      rentMonth: toNumberOrUndefined(sfRecord.rentMonth__c),
      years: toNumberOrUndefined(sfRecord.yearsCurrentAddress__c),
      months: toNumberOrUndefined(sfRecord.monthsCurrentAddress__c),
    }),
    // El numero crudo se conserva aparte porque puede traer valores que la
    // maquina de estados no mapea; `currentStep` es la lectura util.
    legacyStep: toNumberOrUndefined(sfRecord.currentStep__c),
    currentStep: stateMachine.fromLegacyStep(sfRecord.currentStep__c) ?? undefined,
    completedSteps: completedSetFromLegacy(sfRecord.currentStep__c, sfRecord),
  };

  const result = compact(lead);
  if (result.currentAddress && Object.keys(result.currentAddress).length === 0) {
    delete result.currentAddress;
  }
  return result;
}

/** Quita las claves con valor `undefined`, para no devolver ruido. */
function compact(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined)
  );
}

module.exports = {
  // Traduccion y derivacion, expuestas para que los dobles de prueba usen
  // las MISMAS que produccion en vez de una copia que puede divergir.
  toApiModelForStep,
  completedSetFromLegacy,
  // objetos y catalogos
  SObject,
  EmploymentKind,
  EMPLOYER_FAMILY_LEGACY_VALUE,
  LEAD_READ_FIELDS,
  SENSITIVE_LEAD_FIELDS,
  LEAD_FIELD_MAP,
  LEAD_FIELD_BY_API_PATH,
  // SOQL
  escapeSoqlString,
  soqlLiteral,
  isSalesforceId,
  buildFindLeadByEmailOrPhoneQuery,
  buildGetLeadQuery,
  // dedupe
  phoneVariants,
  buildDedupeCriteria,
  // API -> Salesforce
  toLeadFields,
  toCurrentStepFields,
  toMailingAddressRecord,
  toEmploymentRecord,
  toIncomeRecord,
  toEmploymentKind,
  toCoborrowerBackLinkFields,
  // Salesforce -> API
  fromLeadRecord,
};
