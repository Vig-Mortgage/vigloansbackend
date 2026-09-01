'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { notFoundHandler, errorHandler } = require('../middleware/errorHandler');
const { createPorts } = require('../lib/prequalify/ports');
const { createOtpService } = require('../lib/prequalify/otp');
const { createInMemoryOtpStore } = require('../lib/prequalify/otpStore');
const { createSessionManager } = require('../lib/prequalify/session');
const { createPrequalifyRouter } = require('../routes/prequalify');
const mapper = require('../lib/prequalify/salesforceMapper');

const SESSION_SECRET = 'secreto-de-sesion-de-precualificacion-largo';
const OTP_SECRET = 'secreto-del-otp-suficientemente-largo-tambien';

/**
 * POR QUE EXISTE ESTE ARCHIVO
 *
 * El 2026-09-01 el wizard volvia al primer paso justo despues de validar los
 * dos codigos. Los 498 tests estaban en verde.
 *
 * Se colo porque el doble de Salesforce de los otros tests GUARDA
 * `completedSteps` tal cual, y el adaptador real NO PUEDE: la org no tiene
 * campo para esa lista. Lo unico que persiste del avance es `currentStep__c`,
 * un numero del 1 al 5, y `completedSteps` se DERIVA de el
 * (`completedSetFromLegacy` en el mapper). Ni `start` ni `otpVerify` tienen
 * numero, asi que en un lead nuevo la lista volvia vacia.
 *
 * El doble de abajo reproduce esa limitacion en vez de taparla:
 *
 *   - `updateLead` IGNORA `completedSteps`, como el adaptador real.
 *   - `completedSteps` se deriva de `currentStep__c` con la maquina de estados
 *     de verdad.
 *   - `setCurrentStep` solo acepta los numeros que la org acepta.
 *
 * Es la tercera vez en esta migracion que un doble mas permisivo que la pieza
 * real esconde un fallo. La regla que sale de aqui: cuando el sistema real NO
 * PUEDE hacer algo, el doble tampoco debe poder.
 */
function fakeSalesforceComoLaOrgReal() {
  const registros = new Map(); // id -> registro con FORMA DE SALESFORCE
  let seq = 0;

  return {
    registros,
    api: {
      findLeadByEmailOrPhone: async ({ email }) => {
        for (const [id, r] of registros) if (r.Email === email) return { id };
        return null;
      },
      createLead: async (lead) => {
        seq += 1;
        const id = `00Q${seq}`;
        registros.set(id, { Id: id, ...mapper.toLeadFields(lead) });
        return { id };
      },
      // La LECTURA pasa por el mapper de produccion. Cualquier regresion en la
      // derivacion de `completedSteps` rompe estos tests, que es el objetivo:
      // una version propia aqui volveria a esconder los fallos.
      getLead: async (id) => mapper.fromLeadRecord(registros.get(id) ?? null),
      updateLead: async (id, campos, { step } = {}) => {
        const r = registros.get(id);
        if (!r) return;
        // `completedSteps` se DESCARTA, igual que en el adaptador real: la org
        // no tiene campo donde escribirlo. Guardarlo seria mentir, y es
        // exactamente la mentira que dejo pasar tres fallos.
        const { completedSteps, ...resto } = campos ?? {};
        void completedSteps;
        // Misma traduccion que produccion, incluida la anidacion de la
        // direccion: se importa, no se copia.
        Object.assign(r, mapper.toLeadFields(mapper.toApiModelForStep(step, resto)));
      },
      setCurrentStep: async (id, legacy) => {
        const r = registros.get(id);
        if (!r) return;
        if (!Number.isInteger(legacy)) return; // la org solo guarda 1..5
        r.currentStep__c = String(legacy);
      },
    },
  };
}

function buildApp() {
  const sf = fakeSalesforceComoLaOrgReal();
  const entregas = [];
  const ports = createPorts({
    salesforce: sf.api,
    otp: {
      send: async (p) => {
        entregas.push(p);
        return {};
      },
    },
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
  app.use(notFoundHandler);
  app.use(errorHandler);
  return { app, sf, entregas };
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
    return { status: res.status, body: texto ? JSON.parse(texto) : null };
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

/** Recorre el flujo real del cliente: pedir codigos, verificar, mandar `start`. */
async function arrancarComoElCliente(app, entregas) {
  await call(app, 'POST', '/prequalify/otp', {
    body: { email: IDENTIDAD.email, phone: IDENTIDAD.phone },
  });
  const codigo = (canal) => [...entregas].reverse().find((e) => e.channel === canal)?.code;

  const v = await call(app, 'POST', '/prequalify/otp/verify', {
    body: {
      email: IDENTIDAD.email,
      phone: IDENTIDAD.phone,
      emailCode: codigo('email'),
      phoneCode: codigo('sms'),
      firstName: IDENTIDAD.firstName,
      lastName: IDENTIDAD.lastName,
    },
  });
  assert.equal(v.status, 200, 'la verificacion deberia emitir sesion');

  const start = await call(app, 'POST', '/prequalify/leads', {
    token: v.body.token,
    body: IDENTIDAD,
  });
  return { token: v.body.token, leadId: v.body.leadId, start };
}

// ---------------------------------------------------------------------------

test('tras validar los codigos el wizard NO vuelve al primer paso', async () => {
  const { app, entregas } = buildApp();
  const s = await arrancarComoElCliente(app, entregas);

  assert.equal(s.start.status, 200);

  // Esto es lo que fallaba: el backend contestaba `otpVerify` —un paso ya
  // hecho— y el cliente, al releer, volvia al principio.
  assert.notEqual(
    s.start.body.nextStep,
    'otpVerify',
    'no puede mandar de vuelta a un paso ya completado'
  );
  assert.equal(s.start.body.nextStep, 'personal');

  // Y la lectura que el cliente usa para decidir su pantalla.
  const estado = await call(app, 'GET', '/prequalify/leads', { token: s.token });
  assert.equal(estado.status, 200);
  assert.notEqual(estado.body.currentStep, 'start', 'volvio al primer paso');
  assert.equal(estado.body.currentStep, 'personal');
});

test('el avance sobrevive a releer el lead: `currentStep__c` queda escrito', async () => {
  const { app, entregas, sf } = buildApp();
  const s = await arrancarComoElCliente(app, entregas);

  // Sin esto el avance vive solo en la memoria del request y se pierde: es lo
  // que hacia que el wizard reanudara siempre en el mismo sitio.
  const registro = sf.registros.get(s.leadId);
  assert.equal(registro.currentStep__c, '1', 'la org debe quedar apuntando a `personal`');
});

test('el paso siguiente se puede entrar de verdad, no solo se anuncia', async () => {
  const { app, entregas } = buildApp();
  const s = await arrancarComoElCliente(app, entregas);

  // Un 409 aqui significaria que el backend anuncia un paso al que no deja
  // entrar, que es la otra forma de quedarse atascado.
  const personal = await call(app, 'PATCH', `/prequalify/leads/${s.leadId}/personal`, {
    token: s.token,
    body: {
      dob: IDENTIDAD.dob,
      // SSN con formato valido. NO se usa el de las personas de prueba de
      // Experian (area 666) porque el esquema lo rechaza a proposito: la SSA no
      // emite esa area. Este test mide el avance del wizard, no Experian.
      ssn: '123456789',
      citizenship: 'U.S. Citizen',
      maritalStatus: 'Single',
      dependents: 0,
      typeOfCredit: 'IndividualCredit',
    },
  });
  assert.equal(personal.status, 200, JSON.stringify(personal.body));
  assert.equal(personal.body.nextStep, 'currentAddress');
});

test('reanudar en otra sesion lleva al paso correcto, no al primero', async () => {
  const { app, entregas } = buildApp();
  const s = await arrancarComoElCliente(app, entregas);

  // Segundo login del mismo solicitante: el lead ya existe. Es el caso de
  // "cerre el navegador y volvi".
  entregas.length = 0;
  await call(app, 'POST', '/prequalify/otp', {
    body: { email: IDENTIDAD.email, phone: IDENTIDAD.phone },
  });
  const codigo = (canal) => [...entregas].reverse().find((e) => e.channel === canal)?.code;
  const v = await call(app, 'POST', '/prequalify/otp/verify', {
    body: {
      email: IDENTIDAD.email,
      phone: IDENTIDAD.phone,
      emailCode: codigo('email'),
      phoneCode: codigo('sms'),
      firstName: IDENTIDAD.firstName,
      lastName: IDENTIDAD.lastName,
    },
  });
  assert.equal(v.status, 200);
  assert.equal(v.body.leadId, s.leadId, 'deberia reutilizar el mismo lead');

  const estado = await call(app, 'GET', '/prequalify/leads', { token: v.body.token });
  assert.equal(estado.body.currentStep, 'personal');
});

test('completar la direccion NO devuelve al formulario vacio', async () => {
  // Regresion del sintoma: "despues de ingresar la direccion y aceptar
  // devuelve y borra la direccion / Faltaba completar un paso anterior".
  //
  // Causa: al completar `currentAddress` el siguiente paso es `creditCheck`,
  // que NO tiene numero legacy, asi que `currentStep__c` se quedaba en 2 y la
  // direccion no constaba como hecha. `credit-check` respondia 409 y el cliente
  // retrocedia.
  const { app, entregas } = buildApp();
  const s = await arrancarComoElCliente(app, entregas);

  await call(app, 'PATCH', `/prequalify/leads/${s.leadId}/personal`, {
    token: s.token,
    body: {
      dob: IDENTIDAD.dob,
      ssn: '123456789',
      citizenship: 'U.S. Citizen',
      maritalStatus: 'Single',
      dependents: 0,
      typeOfCredit: 'IndividualCredit',
    },
  });

  const direccion = await call(app, 'PUT', `/prequalify/leads/${s.leadId}/addresses`, {
    token: s.token,
    body: {
      line1: 'Calle Prueba 1',
      city: 'San Juan',
      state: 'PR',
      zipCode: '00901',
      housing: 'Own',
      years: 5,
      months: 0,
      mailingAddressDiffers: false,
    },
  });
  assert.equal(direccion.status, 200, JSON.stringify(direccion.body));
  assert.equal(direccion.body.nextStep, 'creditCheck');

  // Lo que fallaba: releer decia que tocaba la direccion OTRA VEZ.
  const estado = await call(app, 'GET', '/prequalify/leads', { token: s.token });
  assert.notEqual(
    estado.body.currentStep,
    'currentAddress',
    'pedia la direccion de nuevo, borrando lo escrito'
  );
  assert.equal(estado.body.currentStep, 'creditCheck');

  // Y el paso anunciado tiene que poder entrarse de verdad: un 409 aqui es el
  // "Faltaba completar un paso anterior" que veia el usuario.
  const credito = await call(app, 'POST', `/prequalify/leads/${s.leadId}/credit-check`, {
    token: s.token,
    body: { ssn: '123456789' },
  });
  assert.notEqual(credito.status, 409, JSON.stringify(credito.body));
});
