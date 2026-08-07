'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createExperianAdapter,
  _dobParaExperian,
  _ssnParaExperian,
} = require('../lib/prequalify/adapters/experianReport');

const SECRETO = {
  EXPERIAN_URL: 'https://us-api.experian.com/oauth2/v1/token',
  EXPERIAN_URL_REPORT: 'https://us-api.experian.com/consumerservices/prequal/v1/credit-report',
  EXPERIAN_CLIENT_ID: 'cid-prod',
  EXPERIAN_CLIENT_SECRET: 'csec-prod',
  EXPERIAN_USERNAME: 'user-prod',
  EXPERIAN_PASSWORD: 'pass-prod',
  EXPERIAN_SUBSCRIBER_CODE: '1234567',
  EXPERIAN_URL_DEV: 'https://uat-us-api.experian.com/oauth2/v1/token',
  EXPERIAN_URL_REPORT_DEV: 'https://uat-us-api.experian.com/consumerservices/prequal/v1/credit-report',
  EXPERIAN_CLIENT_ID_DEV: 'cid-uat',
  EXPERIAN_CLIENT_SECRET_DEV: 'csec-uat',
  EXPERIAN_USERNAME_DEV: 'user-uat',
  EXPERIAN_PASSWORD_DEV: 'pass-uat',
  EXPERIAN_SUBSCRIBER_CODE_DEV: '7654321',
};

const SOLICITANTE = {
  firstName: 'ANA',
  lastName: 'DIAZ',
  dob: '1980-03-15',
  ssn: '666-12-3456',
  address: { line1: 'CALLE LUNA 12', city: 'Ponce', state: 'PR', zipCode: '00731' },
};

function respuesta(ok, body, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body };
}

/** Adaptador con fetch mockeado. Devuelve tambien lo que se llamo. */
function construir({ usarUat = false, tokenResp, reporteResp } = {}) {
  const llamadas = [];
  const adaptador = createExperianAdapter({
    getExperianSecrets: async () => SECRETO,
    usarUat,
    fetchImpl: async (url, opciones) => {
      llamadas.push({ url, opciones, body: JSON.parse(opciones.body) });
      const esToken = url.includes('/oauth2/');
      if (esToken) return tokenResp ?? respuesta(true, { access_token: 'tok-123', expires_in: 1800 });
      return reporteResp ?? respuesta(true, { creditProfile: [{ riskModel: [] }] });
    },
  });
  return { adaptador, llamadas };
}

// --- normalizacion de entrada ---------------------------------------------

test('la fecha se convierte a MMDDYYYY, como espera Experian', () => {
  assert.equal(_dobParaExperian('1980-03-15'), '03151980');
  assert.equal(_dobParaExperian('2000-12-01'), '12012000');
});

test('una fecha con formato raro no llega al proveedor', () => {
  assert.throws(() => _dobParaExperian('15/03/1980'), /Fecha de nacimiento no valida/);
  assert.throws(() => _dobParaExperian(''), /Fecha de nacimiento no valida/);
});

test('el SSN va sin guiones y con nueve digitos', () => {
  assert.equal(_ssnParaExperian('666-12-3456'), '666123456');
  assert.equal(_ssnParaExperian('666 12 3456'), '666123456');
});

test('un SSN incompleto no llega al proveedor', () => {
  assert.throws(() => _ssnParaExperian('123'), /SSN no valido/);
});

// --- eleccion de entorno --------------------------------------------------

test('por defecto usa produccion', async () => {
  const { adaptador, llamadas } = construir({ usarUat: false });
  await adaptador.fetchCreditReport(SOLICITANTE);
  assert.match(llamadas[0].url, /^https:\/\/us-api\.experian\.com/);
  assert.equal(llamadas[0].opciones.headers.client_id, 'cid-prod');
  assert.equal(llamadas[1].body.requestor.subscriberCode, '1234567');
});

test('con usarUat apunta a UAT en las dos llamadas y con las claves _DEV', async () => {
  const { adaptador, llamadas } = construir({ usarUat: true });
  await adaptador.fetchCreditReport(SOLICITANTE);
  for (const l of llamadas) assert.match(l.url, /^https:\/\/uat-us-api\.experian\.com/);
  assert.equal(llamadas[0].opciones.headers.client_id, 'cid-uat');
  assert.equal(llamadas[1].body.requestor.subscriberCode, '7654321');
});

test('no se mezclan entornos: contra UAT no sale ninguna credencial de prod', async () => {
  const { adaptador, llamadas } = construir({ usarUat: true });
  await adaptador.fetchCreditReport(SOLICITANTE);

  const enviado = JSON.stringify(llamadas);
  for (const deProd of ['cid-prod', 'csec-prod', 'user-prod', 'pass-prod', '1234567']) {
    assert.ok(!enviado.includes(deProd), `se filtro una credencial de produccion: ${deProd}`);
  }
  assert.equal(llamadas[0].body.username, 'user-uat');
  assert.equal(llamadas[0].body.password, 'pass-uat');
});

// --- forma de la peticion -------------------------------------------------

test('el cuerpo del reporte replica el del legacy', async () => {
  const { adaptador, llamadas } = construir();
  await adaptador.fetchCreditReport(SOLICITANTE);

  const reporte = llamadas[1];
  assert.equal(reporte.opciones.headers.Authorization, 'Bearer tok-123');

  const pii = reporte.body.consumerPii.primaryApplicant;
  assert.deepEqual(pii.name, { firstName: 'ANA', lastName: 'DIAZ' });
  assert.deepEqual(pii.dob, { dob: '03151980' });
  assert.deepEqual(pii.ssn, { ssn: '666123456' });
  assert.deepEqual(pii.currentAddress, {
    line1: 'CALLE LUNA 12',
    city: 'Ponce',
    state: 'PR',
    zipCode: '00731',
  });

  // Estos tres no son cosmeticos: "3F" es lo que legitima la consulta bajo la
  // FCRA, y "AF" selecciona el modelo cuyo score lee la decision.
  assert.equal(reporte.body.permissiblePurpose.type, '3F');
  assert.deepEqual(reporte.body.addOns.riskModels.modelIndicator, ['AF']);
  assert.deepEqual(reporte.body.vendorData, { vendorNumber: 'FMV', vendorVersion: 'V1.00' });
});

test('primero pide token y luego el reporte, en ese orden', async () => {
  const { adaptador, llamadas } = construir();
  await adaptador.fetchCreditReport(SOLICITANTE);
  assert.equal(llamadas.length, 2);
  assert.match(llamadas[0].url, /oauth2/);
  assert.match(llamadas[1].url, /credit-report/);
});

// --- errores --------------------------------------------------------------

test('un fallo de token no llega a pedir el reporte', async () => {
  const { adaptador, llamadas } = construir({
    tokenResp: respuesta(false, { errors: [{ message: 'Your account is in invalid state' }] }, 401),
  });
  await assert.rejects(adaptador.fetchCreditReport(SOLICITANTE), (e) => {
    assert.equal(e.name, 'ProviderError');
    assert.match(e.message, /invalid state/);
    return true;
  });
  assert.equal(llamadas.length, 1, 'no debe intentar el reporte sin token');
});

test('el texto de Experian queda dentro y al cliente le llega generico', async () => {
  const { adaptador } = construir({
    reporteResp: respuesta(false, { errors: [{ message: 'Subscriber code not authorized' }] }, 403),
  });
  await assert.rejects(adaptador.fetchCreditReport(SOLICITANTE), (e) => {
    assert.match(e.message, /Subscriber code not authorized/);
    assert.doesNotMatch(e.publicMessage, /Subscriber/);
    return true;
  });
});

test('un secreto incompleto falla antes de salir a la red', async () => {
  const llamadas = [];
  const adaptador = createExperianAdapter({
    getExperianSecrets: async () => ({ EXPERIAN_URL: 'https://x' }),
    usarUat: false,
    fetchImpl: async (...a) => {
      llamadas.push(a);
      return respuesta(true, {});
    },
  });
  await assert.rejects(adaptador.fetchCreditReport(SOLICITANTE), /le faltan claves/);
  assert.equal(llamadas.length, 0);
});

test('una entrada invalida no gasta una consulta de credito', async () => {
  // Cada reporte cuesta dinero y deja rastro en el buro. Validar antes de
  // llamar no es solo higiene.
  const { adaptador, llamadas } = construir();
  await assert.rejects(
    adaptador.fetchCreditReport({ ...SOLICITANTE, ssn: '12' }),
    /SSN no valido/
  );
  assert.equal(llamadas.length, 0);
});

// --- el reporte no se filtra ----------------------------------------------

test('el puerto expone SOLO fetchCreditReport', () => {
  // `createPorts` rechaza cualquier clave fuera del contrato. Un `_entorno` de
  // conveniencia en el objeto devuelto tumbo el montaje entero en produccion
  // el 2026-08-07: los tests de este fichero pasaban porque probaban el
  // adaptador suelto, nunca a traves de `createPorts`.
  const { adaptador } = construir();
  assert.deepEqual(Object.keys(adaptador), ['fetchCreditReport']);
});

test('el adaptador es aceptado por createPorts', () => {
  const { createPorts } = require('../lib/prequalify/ports');
  const { adaptador } = construir();
  const ports = createPorts({ experian: adaptador });
  assert.equal(typeof ports.experian.fetchCreditReport, 'function');
});

test('devuelve el reporte crudo para que lo parsee la capa de dominio', async () => {
  const crudo = { creditProfile: [{ riskModel: [{ modelIndicator: 'AF', score: '712' }] }] };
  const { adaptador } = construir({ reporteResp: respuesta(true, crudo) });
  const r = await adaptador.fetchCreditReport(SOLICITANTE);
  assert.deepEqual(r, crudo);
});
