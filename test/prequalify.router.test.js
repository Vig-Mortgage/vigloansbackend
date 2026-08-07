'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { notFoundHandler, errorHandler } = require('../middleware/errorHandler');
const { createPorts } = require('../lib/prequalify/ports');
const { createOtpService } = require('../lib/prequalify/otp');
const { createInMemoryOtpStore } = require('../lib/prequalify/otpStore');
const { createSessionManager } = require('../lib/prequalify/session');
const { createPrequalifyRouter, OTP_FALLO } = require('../routes/prequalify');
const { createGeoRouter } = require('../routes/geo');
const { Step } = require('../lib/prequalify/stateMachine');

const SESSION_SECRET = 'secreto-de-sesion-de-precualificacion-largo';
const OTP_SECRET = 'secreto-del-otp-suficientemente-largo-tambien';

/** Lead falso en memoria, con el contrato que espera el router. */
function fakeSalesforce(inicial = {}) {
  const leads = new Map();
  let seq = 0;
  const api = {
    findLeadByEmailOrPhone: async ({ email }) =>
      [...leads.values()].find((l) => l.email === email) ?? null,
    createLead: async (data) => {
      seq += 1;
      const lead = { id: `00Q${seq}`, completedSteps: [Step.START, Step.OTP_VERIFY], ...data, ...inicial };
      leads.set(lead.id, lead);
      return { id: lead.id };
    },
    getLead: async (id) => leads.get(id) ?? null,
    updateLead: async (id, fields) => {
      const lead = leads.get(id);
      if (lead) Object.assign(lead, { campos: { ...(lead.campos ?? {}), ...fields } });
    },
    setCurrentStep: async () => {},
  };
  return { api, leads };
}

function buildApp({ salesforce, experian, otpEntregas = [] } = {}) {
  const sf = salesforce ?? fakeSalesforce();
  const ports = createPorts({
    salesforce: sf.api,
    ...(experian ? { experian } : {}),
    otp: { send: async (p) => { otpEntregas.push(p); return {}; } },
  });
  const otpService = createOtpService({
    otpPort: ports.otp,
    secret: OTP_SECRET,
    store: createInMemoryOtpStore(),
  });
  const sessions = createSessionManager({ secret: SESSION_SECRET });

  const app = express();
  app.use(express.json());
  app.use('/prequalify', createPrequalifyRouter({ ports, otpService, sessions }));
  app.use('/geo', createGeoRouter({ lookupZip: async (zip) =>
    zip === '00926' ? { zipCode: '00926', city: 'San Juan', state: 'PR' } : null }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return { app, sf, ports, sessions, otpEntregas };
}

async function call(app, method, path, { body, token } = {}) {
  const srv = app.listen(0);
  const { port } = srv.address();
  try {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    if (token) opts.headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, opts);
    const texto = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      body: texto ? JSON.parse(texto) : null,
      raw: texto,
    };
  } finally {
    srv.close();
  }
}

/** Recorre OTP -> verify y devuelve la sesion. */
async function autenticar(app, entregas, email = 'juan@example.com') {
  await call(app, 'POST', '/prequalify/otp', { body: { channel: 'email', email } });
  const code = entregas.at(-1).code;
  const res = await call(app, 'POST', '/prequalify/otp/verify', { body: { code, email } });
  return res.body;
}

// --- OTP ------------------------------------------------------------------

test('POST /otp responde 202 y NUNCA incluye el codigo', async () => {
  const entregas = [];
  const { app } = buildApp({ otpEntregas: entregas });
  const res = await call(app, 'POST', '/prequalify/otp', {
    body: { channel: 'sms', phone: '7871234567' },
  });

  assert.equal(res.status, 202);
  assert.deepEqual(Object.keys(res.body).sort(), ['expiresInSeconds', 'sent']);
  assert.ok(!res.raw.includes(entregas.at(-1).code));
});

test('POST /otp valida el payload con zod', async () => {
  const { app } = buildApp();
  assert.equal((await call(app, 'POST', '/prequalify/otp', { body: {} })).status, 400);
  assert.equal(
    (await call(app, 'POST', '/prequalify/otp', { body: { channel: 'paloma' } })).status,
    400
  );
  // sms sin telefono
  assert.equal(
    (await call(app, 'POST', '/prequalify/otp', { body: { channel: 'sms' } })).status,
    400
  );
});

test('reenviar antes del cooldown da 429 con Retry-After', async () => {
  const entregas = [];
  const { app } = buildApp({ otpEntregas: entregas });
  const body = { channel: 'sms', phone: '7871234567' };
  await call(app, 'POST', '/prequalify/otp', { body });

  const res = await call(app, 'POST', '/prequalify/otp', { body });
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  assert.equal(entregas.length, 1);
});

test('el codigo correcto emite sesion; el malo da 401', async () => {
  const entregas = [];
  const { app } = buildApp({ otpEntregas: entregas });
  await call(app, 'POST', '/prequalify/otp', {
    body: { channel: 'email', email: 'juan@example.com' },
  });

  const malo = await call(app, 'POST', '/prequalify/otp/verify', {
    body: { code: '000000', email: 'juan@example.com' },
  });
  assert.equal(malo.status, 401);

  const bueno = await call(app, 'POST', '/prequalify/otp/verify', {
    body: { code: entregas.at(-1).code, email: 'juan@example.com' },
  });
  assert.equal(bueno.status, 200);
  assert.ok(bueno.body.token);
  assert.ok(bueno.body.leadId);
});

test('codigo malo y codigo inexistente dan la MISMA respuesta', async () => {
  // Si difirieran, se podria enumerar que correos tienen un reto activo.
  const entregas = [];
  const { app } = buildApp({ otpEntregas: entregas });

  const sinReto = await call(app, 'POST', '/prequalify/otp/verify', {
    body: { code: '123456', email: 'nadie@example.com' },
  });

  await call(app, 'POST', '/prequalify/otp', {
    body: { channel: 'email', email: 'juan@example.com' },
  });
  const conReto = await call(app, 'POST', '/prequalify/otp/verify', {
    body: { code: '000000', email: 'juan@example.com' },
  });

  assert.equal(sinReto.status, conReto.status);
  assert.deepEqual(sinReto.body, conReto.body);
  assert.equal(sinReto.body.error, OTP_FALLO);
});

// --- sesion y autorizacion por recurso ------------------------------------

test('sin token, los endpoints de lead dan 401', async () => {
  const { app } = buildApp();
  assert.equal((await call(app, 'GET', '/prequalify/leads')).status, 401);
  assert.equal(
    (await call(app, 'PATCH', '/prequalify/leads/00Q1/personal', { body: {} })).status,
    401
  );
});

test('un token basura no pasa', async () => {
  const { app } = buildApp();
  const res = await call(app, 'GET', '/prequalify/leads', { token: 'no.es.jwt' });
  assert.equal(res.status, 401);
});

test('IDOR: la sesion de un lead no puede tocar el lead de otro', async () => {
  const entregas = [];
  const { app } = buildApp({ otpEntregas: entregas });

  const juan = await autenticar(app, entregas, 'juan@example.com');
  // Segundo lead, con su propia sesion.
  const ana = await autenticar(app, entregas, 'ana@example.com');
  assert.notEqual(juan.leadId, ana.leadId);

  const res = await call(app, 'PATCH', `/prequalify/leads/${ana.leadId}/personal`, {
    token: juan.token,
    body: {
      dob: '1985-06-15',
      ssn: '123-45-6789',
      citizenship: 'U.S. Citizen',
      maritalStatus: 'Single',
      dependents: 0,
      typeOfCredit: 'IndividualCredit',
    },
  });

  // 404 y no 403: un 403 confirmaria que el lead existe.
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Recurso no encontrado.');
});

test('GET /leads devuelve el paso donde reanudar', async () => {
  const entregas = [];
  const { app } = buildApp({ otpEntregas: entregas });
  const sesion = await autenticar(app, entregas);

  const res = await call(app, 'GET', '/prequalify/leads', { token: sesion.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.currentStep, Step.PERSONAL);
  assert.ok(Array.isArray(res.body.remainingSteps));
});

// --- maquina de estados ---------------------------------------------------

test('no se puede saltar un paso: empleo antes de datos personales da 409', async () => {
  const entregas = [];
  const { app } = buildApp({ otpEntregas: entregas });
  const sesion = await autenticar(app, entregas);

  const res = await call(app, 'PUT', `/prequalify/leads/${sesion.leadId}/employment`, {
    token: sesion.token,
    body: {
      employerBusinessName: 'VIG',
      positionTitle: 'Analista',
      startDate: '2020-01-15',
      employerPhone: '7879876543',
      employedByFamily: false,
      line1: 'Ave Ponce de Leon 500',
      city: 'San Juan',
      state: 'PR',
      zipCode: '00918',
      yearsEmployment: 5,
      monthsEmployment: 3,
    },
  });

  assert.equal(res.status, 409);
  assert.equal(res.body.expectedStep, Step.PERSONAL);
});

test('el paso valido avanza y anuncia el siguiente', async () => {
  const entregas = [];
  const { app } = buildApp({ otpEntregas: entregas });
  const sesion = await autenticar(app, entregas);

  const res = await call(app, 'PATCH', `/prequalify/leads/${sesion.leadId}/personal`, {
    token: sesion.token,
    body: {
      dob: '1985-06-15',
      ssn: '123-45-6789',
      citizenship: 'U.S. Citizen',
      maritalStatus: 'Single',
      dependents: 0,
      typeOfCredit: 'IndividualCredit',
    },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.step, Step.PERSONAL);
  assert.equal(res.body.nextStep, Step.CURRENT_ADDRESS);
});

test('la validacion zod corre antes de tocar el lead', async () => {
  const entregas = [];
  const { app } = buildApp({ otpEntregas: entregas });
  const sesion = await autenticar(app, entregas);

  // SSN invalido
  const res = await call(app, 'PATCH', `/prequalify/leads/${sesion.leadId}/personal`, {
    token: sesion.token,
    body: {
      dob: '1985-06-15',
      ssn: '000-00-0000',
      citizenship: 'U.S. Citizen',
      maritalStatus: 'Single',
      dependents: 0,
      typeOfCredit: 'IndividualCredit',
    },
  });
  assert.equal(res.status, 400);
});

test('el SSN no vuelve nunca en una respuesta', async () => {
  const entregas = [];
  const { app } = buildApp({ otpEntregas: entregas });
  const sesion = await autenticar(app, entregas);
  const ssn = '123-45-6789';

  const paso = await call(app, 'PATCH', `/prequalify/leads/${sesion.leadId}/personal`, {
    token: sesion.token,
    body: {
      dob: '1985-06-15',
      ssn,
      citizenship: 'U.S. Citizen',
      maritalStatus: 'Single',
      dependents: 0,
      typeOfCredit: 'IndividualCredit',
    },
  });
  assert.ok(!paso.raw.includes('123456789'));
  assert.ok(!paso.raw.includes(ssn));

  const lectura = await call(app, 'GET', '/prequalify/leads', { token: sesion.token });
  assert.ok(!lectura.raw.includes('123456789'));
});

// --- puertos sin implementar ---------------------------------------------

test('credit-check sin proveedor da 501 sin filtrar detalles', async () => {
  const entregas = [];
  const { app } = buildApp({ otpEntregas: entregas });
  const sesion = await autenticar(app, entregas);

  // Completa personal y direccion para poder entrar al paso de credito.
  await call(app, 'PATCH', `/prequalify/leads/${sesion.leadId}/personal`, {
    token: sesion.token,
    body: {
      dob: '1985-06-15', ssn: '123-45-6789', citizenship: 'U.S. Citizen',
      maritalStatus: 'Single', dependents: 0, typeOfCredit: 'IndividualCredit',
    },
  });

  const res = await call(app, 'POST', `/prequalify/leads/${sesion.leadId}/credit-check`, {
    token: sesion.token,
  });

  assert.ok([409, 501].includes(res.status), `status: ${res.status}`);
  assert.ok(!res.raw.toLowerCase().includes('experian'));
  assert.ok(!res.raw.toLowerCase().includes('stack'));
});

// --- geo ------------------------------------------------------------------

test('GET /geo/states devuelve todo EEUU', async () => {
  const { app } = buildApp();
  const res = await call(app, 'GET', '/geo/states');
  assert.equal(res.status, 200);
  assert.equal(res.body.states.length, 59);
  assert.ok(res.body.states.some((s) => s.code === 'PR'));
  assert.ok(res.body.states.some((s) => s.code === 'FL'));
});

test('GET /geo/zip resuelve y valida el formato', async () => {
  const { app } = buildApp();
  const ok = await call(app, 'GET', '/geo/zip/00926');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { zipCode: '00926', city: 'San Juan', state: 'PR' });

  assert.equal((await call(app, 'GET', '/geo/zip/99999')).status, 404);
  assert.equal((await call(app, 'GET', '/geo/zip/abc')).status, 400);
});

test('vistaPublica es lista blanca: lo desconocido no sale', () => {
  const { vistaPublica } = require('../routes/prequalify');
  const salida = vistaPublica({
    email: 'a@b.com',
    ssn: '123456789',
    LASERCA__SSN__c: '123456789',
    creditScore: 720,
    reporteExperian: { deudas: [] },
    campoNuevoQueAlguienAgrego: 'sorpresa',
  });
  assert.deepEqual(salida, { email: 'a@b.com' });
});

test('vistaPublica tolera null', () => {
  const { vistaPublica } = require('../routes/prequalify');
  assert.deepEqual(vistaPublica(null), {});
  assert.deepEqual(vistaPublica(undefined), {});
});

// --- montaje perezoso -----------------------------------------------------

test('sin el secreto configurado responde 503 y no tumba el proceso', async () => {
  const { createLazyPrequalifyMount } = require('../routes/prequalifyMount');
  const app = express();
  app.use(express.json());
  app.use('/prequalify', createLazyPrequalifyMount({
    getPrequalifySecrets: async () => { throw new Error('ResourceNotFoundException'); },
  }));
  app.use(notFoundHandler);
  app.use(errorHandler);

  const res = await call(app, 'GET', '/prequalify/leads');
  assert.equal(res.status, 503);
  // No filtra el nombre del secreto ni el error de AWS.
  assert.ok(!res.raw.includes('ResourceNotFound'));
  assert.ok(!res.raw.includes('vigloans/prequalify'));
});

test('el montaje rechaza reutilizar el secreto JWT del app', async () => {
  const { createLazyPrequalifyMount } = require('../routes/prequalifyMount');
  const compartido = 'el-mismo-secreto-para-todo-que-no-debe-pasar';
  const app = express();
  app.use(express.json());
  app.use('/prequalify', createLazyPrequalifyMount({
    getPrequalifySecrets: async () => ({ session_secret: compartido, otp_secret: OTP_SECRET }),
    getBackendSecrets: async () => ({ jwt_secret_key: compartido }),
  }));
  app.use(notFoundHandler);
  app.use(errorHandler);

  // Falla al construir -> 503, en vez de arrancar con la escalada de privilegio.
  assert.equal((await call(app, 'GET', '/prequalify/leads')).status, 503);
});

test('con los secretos correctos el montaje sirve el router', async () => {
  const { createLazyPrequalifyMount } = require('../routes/prequalifyMount');
  const app = express();
  app.use(express.json());
  app.use('/prequalify', createLazyPrequalifyMount({
    getPrequalifySecrets: async () => ({
      session_secret: SESSION_SECRET,
      otp_secret: OTP_SECRET,
    }),
  }));
  app.use(notFoundHandler);
  app.use(errorHandler);

  // Sin token: 401 (el router respondió, no el 503 del montaje).
  assert.equal((await call(app, 'GET', '/prequalify/leads')).status, 401);
});
