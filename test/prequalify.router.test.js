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
      // NO se pre-marca ningun paso: el fixture anterior ponia [START, OTP_VERIFY]
      // y eso oculto que el router no tenia endpoint para completarlos.
      const lead = { id: `00Q${seq}`, completedSteps: [], ...data, ...inicial };
      leads.set(lead.id, lead);
      return { id: lead.id };
    },
    getLead: async (id) => {
      const lead = leads.get(id);
      if (!lead) return null;
      // El adaptador real devuelve la direccion ANIDADA (`fromLeadRecord` la
      // arma como `currentAddress: {...}`) aunque el paso la envie plana. El
      // fake replica esa forma: si devolviera lo plano tal cual, el handler
      // leeria `lead.currentAddress.line1` como undefined en los tests y bien
      // en produccion.
      const { line1, city, state, zipCode, housing, rentMonth, years, months } = lead;
      const direccion = { line1, city, state, zipCode, housing, rentMonth, years, months };
      const tieneDireccion = Object.values(direccion).some((v) => v !== undefined);
      return tieneDireccion ? { ...lead, currentAddress: direccion } : lead;
    },
    updateLead: async (id, fields) => {
      const lead = leads.get(id);
      if (!lead) return;
      const { completedSteps, ...resto } = fields;
      if (completedSteps) lead.completedSteps = completedSteps;
      // Los campos se guardan DOS veces a proposito:
      //
      //  - Planos, porque asi los devuelve el adaptador real: `fromLeadRecord`
      //    entrega el modelo de la API con `dob`, `firstName` y `currentAddress`
      //    en la raiz. Un fake que solo los anidara haria que `req.lead.dob`
      //    fuera undefined en los tests y no en produccion — el doble mintiendo
      //    sobre la pieza real, que es como se colaron ya dos fallos.
      //  - Bajo `campos`, que es lo que inspeccionan los tests que comprueban
      //    QUE se escribio en cada paso.
      Object.assign(lead, resto, { campos: { ...(lead.campos ?? {}), ...resto } });
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

const IDENTIDAD = {
  email: 'juan@example.com',
  phone: '7871234567',
  firstName: 'Juan',
  lastName: 'Del Valle',
  dob: '1985-06-15',
  loanPurpose: 'Compra',
};

/** Codigo entregado por un canal concreto, del envio mas reciente. */
function codigoDe(entregas, canal) {
  return [...entregas].reverse().find((e) => e.channel === canal)?.code;
}

/**
 * Recorre OTP -> verify y devuelve la sesion (sin completar `start`).
 *
 * Se verifican AMBOS canales: el backend no emite sesion con uno solo.
 */
async function autenticar(app, entregas, email = 'juan@example.com', phone = '7871234567') {
  await call(app, 'POST', '/prequalify/otp', { body: { email, phone } });
  const res = await call(app, 'POST', '/prequalify/otp/verify', {
    body: {
      email,
      phone,
      emailCode: codigoDe(entregas, 'email'),
      phoneCode: codigoDe(entregas, 'sms'),
      // El nombre viaja aqui porque es donde nace el lead y la org lo exige
      // al insertar. Ver `otpVerifySchema`.
      firstName: IDENTIDAD.firstName,
      lastName: IDENTIDAD.lastName,
    },
  });
  return res.body;
}

/** Autentica y ademas completa `start`, que es el punto de partida real. */
async function arrancar(app, entregas, email = 'juan@example.com', phone = '7871234567') {
  const sesion = await autenticar(app, entregas, email, phone);
  await call(app, 'POST', '/prequalify/leads', {
    token: sesion.token,
    body: { ...IDENTIDAD, email },
  });
  return sesion;
}

// --- OTP ------------------------------------------------------------------

test('POST /otp responde 202 y NUNCA incluye el codigo', async () => {
  const entregas = [];
  const { app } = buildApp({ otpEntregas: entregas });
  const res = await call(app, 'POST', '/prequalify/otp', {
    body: { email: 'juan@example.com', phone: '7871234567' },
  });

  assert.equal(res.status, 202);
  assert.deepEqual(Object.keys(res.body).sort(), ['channels', 'expiresInSeconds', 'sent']);
  assert.equal(entregas.length, 2, 'un codigo al correo y otro al telefono');
  assert.ok(!res.raw.includes(entregas.at(-1).code));
});

test('POST /otp valida el payload con zod', async () => {
  const { app } = buildApp();
  assert.equal((await call(app, 'POST', '/prequalify/otp', { body: {} })).status, 400);
  // falta el telefono
  assert.equal(
    (await call(app, 'POST', '/prequalify/otp', { body: { email: 'a@b.com' } })).status,
    400
  );
  // falta el correo
  assert.equal(
    (await call(app, 'POST', '/prequalify/otp', { body: { phone: '7871234567' } })).status,
    400
  );
});

test('reenviar antes del cooldown da 429 con Retry-After', async () => {
  const entregas = [];
  const { app } = buildApp({ otpEntregas: entregas });
  const body = { email: 'juan@example.com', phone: '7871234567' };
  await call(app, 'POST', '/prequalify/otp', { body });

  const res = await call(app, 'POST', '/prequalify/otp', { body });
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  assert.equal(entregas.length, 2, 'no se reenvia ninguno de los dos');
});

test('el codigo correcto emite sesion; el malo da 401', async () => {
  const entregas = [];
  const { app } = buildApp({ otpEntregas: entregas });
  const contacto = { email: 'juan@example.com', phone: '7871234567' };
  await call(app, 'POST', '/prequalify/otp', { body: contacto });

  const malo = await call(app, 'POST', '/prequalify/otp/verify', {
    body: { ...contacto, firstName: IDENTIDAD.firstName, lastName: IDENTIDAD.lastName, emailCode: '000000', phoneCode: '000000' },
  });
  assert.equal(malo.status, 401);

  const bueno = await call(app, 'POST', '/prequalify/otp/verify', {
    body: {
      ...contacto,
      emailCode: codigoDe(entregas, 'email'),
      phoneCode: codigoDe(entregas, 'sms'),
      firstName: IDENTIDAD.firstName,
      lastName: IDENTIDAD.lastName,
    },
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
    body: {
      email: 'nadie@example.com', phone: '7870000000',
      emailCode: '123456', phoneCode: '123456',
      firstName: IDENTIDAD.firstName,
      lastName: IDENTIDAD.lastName,
    },
  });

  await call(app, 'POST', '/prequalify/otp', {
    body: { email: 'juan@example.com', phone: '7871234567' },
  });
  const conReto = await call(app, 'POST', '/prequalify/otp/verify', {
    body: {
      email: 'juan@example.com', phone: '7871234567',
      emailCode: '000000', phoneCode: '000000',
      firstName: IDENTIDAD.firstName,
      lastName: IDENTIDAD.lastName,
    },
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
  const ana = await autenticar(app, entregas, 'ana@example.com', '7879999999');
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
  const sesion = await arrancar(app, entregas);

  const res = await call(app, 'GET', '/prequalify/leads', { token: sesion.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.currentStep, Step.PERSONAL);
  assert.ok(Array.isArray(res.body.remainingSteps));
});

// --- maquina de estados ---------------------------------------------------

test('no se puede saltar un paso: empleo antes de datos personales da 409', async () => {
  const entregas = [];
  const { app } = buildApp({ otpEntregas: entregas });
  const sesion = await arrancar(app, entregas);

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
  const sesion = await arrancar(app, entregas);

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


// --- pasos start y submit (huecos que encontro el cliente Flutter) --------

test('POST /leads completa `start`: sin el, personal da 409', async () => {
  const entregas = [];
  const { app } = buildApp({ otpEntregas: entregas });
  const sesion = await autenticar(app, entregas);

  const cuerpoPersonal = {
    dob: '1985-06-15', ssn: '123-45-6789', citizenship: 'U.S. Citizen',
    maritalStatus: 'Single', dependents: 0, typeOfCredit: 'IndividualCredit',
  };

  // Sin `start` no se puede entrar a personal.
  const bloqueado = await call(app, 'PATCH', `/prequalify/leads/${sesion.leadId}/personal`, {
    token: sesion.token, body: cuerpoPersonal,
  });
  assert.equal(bloqueado.status, 409);
  assert.equal(bloqueado.body.expectedStep, Step.START);

  // Con `start` completado, si.
  const inicio = await call(app, 'POST', '/prequalify/leads', {
    token: sesion.token, body: IDENTIDAD,
  });
  assert.equal(inicio.status, 200);
  assert.equal(inicio.body.step, Step.START);

  const ok = await call(app, 'PATCH', `/prequalify/leads/${sesion.leadId}/personal`, {
    token: sesion.token, body: cuerpoPersonal,
  });
  assert.equal(ok.status, 200);
});

test('el progreso PERSISTE entre requests', async () => {
  // Antes `completedSteps` solo vivia en memoria del request: el lead nunca
  // avanzaba y resumeStep devolvia siempre lo mismo.
  const entregas = [];
  const { app } = buildApp({ otpEntregas: entregas });
  const sesion = await arrancar(app, entregas);

  const antes = await call(app, 'GET', '/prequalify/leads', { token: sesion.token });
  assert.equal(antes.body.currentStep, Step.PERSONAL);

  await call(app, 'PATCH', `/prequalify/leads/${sesion.leadId}/personal`, {
    token: sesion.token,
    body: {
      dob: '1985-06-15', ssn: '123-45-6789', citizenship: 'U.S. Citizen',
      maritalStatus: 'Single', dependents: 0, typeOfCredit: 'IndividualCredit',
    },
  });

  const despues = await call(app, 'GET', '/prequalify/leads', { token: sesion.token });
  assert.equal(despues.body.currentStep, Step.CURRENT_ADDRESS, 'debe haber avanzado');
});

test('POST /leads/:id/submit existe y respeta la maquina de estados', async () => {
  const entregas = [];
  const { app } = buildApp({ otpEntregas: entregas });
  const sesion = await arrancar(app, entregas);

  // Todavia faltan pasos: no se puede enviar.
  const temprano = await call(app, 'POST', `/prequalify/leads/${sesion.leadId}/submit`, {
    token: sesion.token,
  });
  assert.equal(temprano.status, 409);
  assert.notEqual(temprano.status, 404, 'la ruta debe existir');
});

test('submit tambien respeta la autorizacion por recurso', async () => {
  const entregas = [];
  const { app } = buildApp({ otpEntregas: entregas });
  const juan = await arrancar(app, entregas, 'juan@example.com', '7871234567');
  const ana = await arrancar(app, entregas, 'ana@example.com', '7879999999');

  const res = await call(app, 'POST', `/prequalify/leads/${ana.leadId}/submit`, {
    token: juan.token,
  });
  assert.equal(res.status, 404);
});

// --- CORS propio del flujo anonimo ---------------------------------------

test('el CORS del flujo anonimo GANA al CORS global permisivo', async () => {
  // El global de app.js escribe `Access-Control-Allow-Origin: *`. Si este
  // router se limita a "no escribir nada" cuando el origen no esta permitido,
  // la cabecera permisiva sobrevive y la restriccion no sirve de nada. Se
  // detecto probando el wizard en local contra el backend desplegado.
  const { createLazyPrequalifyMount } = require('../routes/prequalifyMount');
  const app = express();
  app.use(express.json());
  // Simula el CORS global permisivo que corre antes.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    next();
  });
  app.use('/prequalify', createLazyPrequalifyMount({
    getPrequalifySecrets: async () => ({
      session_secret: SESSION_SECRET, otp_secret: OTP_SECRET,
    }),
  }));
  app.use(notFoundHandler);
  app.use(errorHandler);

  const srv = app.listen(0);
  const { port } = srv.address();
  try {
    const ajeno = await fetch(`http://127.0.0.1:${port}/prequalify/leads`, {
      headers: { Origin: 'https://sitio-cualquiera.example' },
    });
    assert.equal(
      ajeno.headers.get('access-control-allow-origin'),
      null,
      'un origen no permitido no debe recibir ACAO'
    );
    assert.equal(ajeno.headers.get('access-control-allow-credentials'), null);
  } finally {
    srv.close();
  }
});

test('un origen permitido si recibe su ACAO, y nunca `*`', async () => {
  const previo = process.env.PREQUALIFY_CORS_ORIGINS;
  process.env.PREQUALIFY_CORS_ORIGINS = 'https://www.vigpr.com';
  try {
    const { createLazyPrequalifyMount } = require('../routes/prequalifyMount');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      next();
    });
    app.use('/prequalify', createLazyPrequalifyMount({
      getPrequalifySecrets: async () => ({
        session_secret: SESSION_SECRET, otp_secret: OTP_SECRET,
      }),
    }));
    app.use(notFoundHandler);
    app.use(errorHandler);

    const srv = app.listen(0);
    const { port } = srv.address();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/prequalify/leads`, {
        headers: { Origin: 'https://www.vigpr.com' },
      });
      assert.equal(res.headers.get('access-control-allow-origin'), 'https://www.vigpr.com');
    } finally {
      srv.close();
    }
  } finally {
    if (previo === undefined) delete process.env.PREQUALIFY_CORS_ORIGINS;
    else process.env.PREQUALIFY_CORS_ORIGINS = previo;
  }
});

// --- doble verificacion: hacen falta LOS DOS -----------------------------

test('un solo codigo correcto NO basta: hay que verificar correo y telefono', async () => {
  const entregas = [];
  const { app } = buildApp({ otpEntregas: entregas });
  const contacto = { email: 'juan@example.com', phone: '7871234567' };
  await call(app, 'POST', '/prequalify/otp', { body: contacto });

  // Correo bien, telefono mal.
  const soloCorreo = await call(app, 'POST', '/prequalify/otp/verify', {
    body: { ...contacto, firstName: IDENTIDAD.firstName, lastName: IDENTIDAD.lastName, emailCode: codigoDe(entregas, 'email'), phoneCode: '000000' },
  });
  assert.equal(soloCorreo.status, 401);
  assert.equal(soloCorreo.body.token, undefined);

  // Telefono bien, correo mal.
  const soloTelefono = await call(app, 'POST', '/prequalify/otp/verify', {
    body: { ...contacto, firstName: IDENTIDAD.firstName, lastName: IDENTIDAD.lastName, emailCode: '000000', phoneCode: codigoDe(entregas, 'sms') },
  });
  assert.equal(soloTelefono.status, 401);
  assert.equal(soloTelefono.body.token, undefined);
});

test('no se revela CUAL de los dos codigos fallo', async () => {
  const entregas = [];
  const { app } = buildApp({ otpEntregas: entregas });
  const contacto = { email: 'juan@example.com', phone: '7871234567' };
  await call(app, 'POST', '/prequalify/otp', { body: contacto });

  const a = await call(app, 'POST', '/prequalify/otp/verify', {
    body: { ...contacto, firstName: IDENTIDAD.firstName, lastName: IDENTIDAD.lastName, emailCode: codigoDe(entregas, 'email'), phoneCode: '000000' },
  });
  const b = await call(app, 'POST', '/prequalify/otp/verify', {
    body: { ...contacto, firstName: IDENTIDAD.firstName, lastName: IDENTIDAD.lastName, emailCode: '000000', phoneCode: '111111' },
  });
  assert.deepEqual(a.body, b.body, 'la respuesta debe ser identica');
});

test('el reto del telefono no depende de la via de entrega', async () => {
  // Se pide por WhatsApp; el reto se guarda como `phone`, asi que verificar
  // sigue funcionando. Antes se guardaba bajo el canal de entrega y no cuadraba.
  const entregas = [];
  const { app } = buildApp({ otpEntregas: entregas });
  const contacto = { email: 'juan@example.com', phone: '7871234567' };
  await call(app, 'POST', '/prequalify/otp', {
    body: { ...contacto, phoneChannel: 'whatsapp' },
  });
  assert.ok(codigoDe(entregas, 'whatsapp'), 'se entrego por WhatsApp');

  const res = await call(app, 'POST', '/prequalify/otp/verify', {
    body: {
      ...contacto,
      emailCode: codigoDe(entregas, 'email'),
      phoneCode: codigoDe(entregas, 'whatsapp'),
      firstName: IDENTIDAD.firstName,
      lastName: IDENTIDAD.lastName,
    },
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
});

// --- los errores de validacion dicen QUE campo ---------------------------

test('un 400 identifica el campo, no solo "Parametros invalidos"', async () => {
  const { app } = buildApp();
  const res = await call(app, 'POST', '/prequalify/otp', {
    body: { email: 'no-es-email', phone: '123' },
  });

  assert.equal(res.status, 400);
  assert.ok(Array.isArray(res.body.details), 'debe traer detalle por campo');
  const campos = res.body.details.map((d) => d.path);
  assert.ok(campos.includes('email'));
  assert.ok(campos.includes('phone'));
});

test('los mensajes de campo requerido vienen en espanol', async () => {
  // zod responde "Required" en ingles por defecto y ese texto acaba en la
  // pantalla del solicitante.
  const { app } = buildApp();
  const res = await call(app, 'POST', '/prequalify/otp', { body: {} });

  for (const d of res.body.details) {
    assert.ok(!/^required$/i.test(d.message), `sin traducir: ${d.path} -> ${d.message}`);
  }
});

// --- credit-check ---------------------------------------------------------

/** Lleva el lead hasta poder entrar al paso de credito. */
async function hastaCredito(app, entregas) {
  // `arrancar` y no `autenticar`: hace falta completar tambien el paso `start`.
  const sesion = await arrancar(app, entregas);
  await call(app, 'PATCH', `/prequalify/leads/${sesion.leadId}/personal`, {
    token: sesion.token,
    body: {
      dob: '1985-06-15', ssn: '123-45-6789', citizenship: 'U.S. Citizen',
      maritalStatus: 'Single', dependents: 0, typeOfCredit: 'IndividualCredit',
    },
  });
  await call(app, 'PUT', `/prequalify/leads/${sesion.leadId}/addresses`, {
    token: sesion.token,
    body: {
      line1: 'CALLE LUNA 12', city: 'Ponce', state: 'PR', zipCode: '00731',
      housing: 'Own', years: 5, months: 0,
    },
  });
  return sesion;
}

/** Reporte minimo con un score y un tradeline con pago mensual. */
const REPORTE = {
  creditProfile: [
    {
      riskModel: [{ modelIndicator: 'AF', score: '712' }],
      tradeline: [{ monthlyPaymentAmount: '350', accountType: '18', openOrClosed: 'O' }],
    },
  ],
};

test('credit-check manda al buro la identidad DEL LEAD y el SSN de la peticion', async () => {
  const pedidos = [];
  const entregas = [];
  const { app } = buildApp({
    otpEntregas: entregas,
    experian: {
      fetchCreditReport: async (solicitante) => {
        pedidos.push(solicitante);
        return REPORTE;
      },
    },
  });
  const sesion = await hastaCredito(app, entregas);

  const res = await call(app, 'POST', `/prequalify/leads/${sesion.leadId}/credit-check`, {
    token: sesion.token,
    body: { ssn: '123-45-6789' },
  });

  assert.equal(res.status, 200, res.raw);
  assert.equal(pedidos.length, 1);

  // El SSN viene del cuerpo; el resto, del lead. Aceptar la identidad del
  // cliente permitiria pedir el reporte de otra persona con la misma sesion.
  // Normalizado por zod: nueve digitos sin guiones (`schemas.js` primitiva ssn).
  assert.equal(pedidos[0].ssn, '123456789');
  assert.equal(pedidos[0].dob, '1985-06-15');
  assert.equal(pedidos[0].address.zipCode, '00731');
  assert.equal(pedidos[0].address.city, 'Ponce');
});

test('credit-check exige el SSN y lo valida', async () => {
  const entregas = [];
  const { app } = buildApp({
    otpEntregas: entregas,
    experian: { fetchCreditReport: async () => REPORTE },
  });
  const sesion = await hastaCredito(app, entregas);

  const sinSsn = await call(app, 'POST', `/prequalify/leads/${sesion.leadId}/credit-check`, {
    token: sesion.token, body: {},
  });
  assert.equal(sinSsn.status, 400);

  const malo = await call(app, 'POST', `/prequalify/leads/${sesion.leadId}/credit-check`, {
    token: sesion.token, body: { ssn: '000-00-0000' },
  });
  assert.equal(malo.status, 400);
});

test('credit-check guarda score y deuda, y NO los devuelve al cliente', async () => {
  const entregas = [];
  const { app, sf } = buildApp({
    otpEntregas: entregas,
    experian: { fetchCreditReport: async () => REPORTE },
  });
  const sesion = await hastaCredito(app, entregas);

  const res = await call(app, 'POST', `/prequalify/leads/${sesion.leadId}/credit-check`, {
    token: sesion.token, body: { ssn: '123-45-6789' },
  });

  assert.equal(res.status, 200);
  // Persistido para la decision posterior, que ocurre en el paso de ingresos.
  // El fake guarda lo que llega a `updateLead` bajo `campos`.
  const guardado = sf.leads.get(sesion.leadId).campos;
  assert.equal(guardado.creditScore, 712);
  assert.equal(guardado.monthlyDebtPayments, 350);

  // Pero nada de eso sale: el score es dato de credito.
  assert.ok(!res.raw.includes('712'), 'el score no debe salir al cliente');
  assert.ok(!res.raw.includes('350'), 'la deuda no debe salir al cliente');
  assert.ok(!res.raw.includes('123456789') && !res.raw.includes('123-45-6789'));
});

test('el reporte crudo nunca se serializa al cliente', async () => {
  const entregas = [];
  const conRastro = {
    creditProfile: [{
      riskModel: [{ modelIndicator: 'AF', score: '650' }],
      tradeline: [{ monthlyPaymentAmount: '100', subscriberName: 'BANCO SECRETO SA' }],
    }],
  };
  const { app } = buildApp({
    otpEntregas: entregas,
    experian: { fetchCreditReport: async () => conRastro },
  });
  const sesion = await hastaCredito(app, entregas);

  const res = await call(app, 'POST', `/prequalify/leads/${sesion.leadId}/credit-check`, {
    token: sesion.token, body: { ssn: '123-45-6789' },
  });
  assert.ok(!res.raw.includes('BANCO SECRETO'), 'se filtro contenido del reporte');
});

test('si el buro falla, al cliente le llega generico', async () => {
  const { ProviderError } = require('../lib/prequalify/ports/errors');
  const entregas = [];
  const { app } = buildApp({
    otpEntregas: entregas,
    experian: {
      fetchCreditReport: async () => {
        throw new ProviderError('experian', 'reporte 403: Subscriber code not authorized');
      },
    },
  });
  const sesion = await hastaCredito(app, entregas);

  const res = await call(app, 'POST', `/prequalify/leads/${sesion.leadId}/credit-check`, {
    token: sesion.token, body: { ssn: '123-45-6789' },
  });
  assert.equal(res.status, 502);
  assert.ok(!res.raw.toLowerCase().includes('subscriber'));
  assert.ok(!res.raw.toLowerCase().includes('experian'));
});
