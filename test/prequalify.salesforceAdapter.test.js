'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSalesforceLeadAdapter } = require('../lib/prequalify/adapters/salesforceLead');
const { createPorts } = require('../lib/prequalify/ports');

const LEAD_ID = '00Q5f000004ABCDEAA';

const SECRETO = {
  SF_URL: 'https://vig.my.salesforce.com/services/oauth2/token',
  SF_CLIENT_ID: 'cid-prod',
  SF_CLIENT_SECRET: 'csec-prod',
  SF_USERNAME: 'user-prod',
  SF_PASSWORD: 'pass',
  SF_SECURITY_TOKEN: 'tok',
  SF_URL_DEV: 'https://vig--sb.sandbox.my.salesforce.com/services/oauth2/token',
  SF_CLIENT_ID_DEV: 'cid-sb',
  SF_CLIENT_SECRET_DEV: 'csec-sb',
  SF_USERNAME_DEV: 'user-sb',
  SF_PASSWORD_DEV: 'pass-sb',
  SF_SECURITY_TOKEN_DEV: 'tok-sb',
};

const INSTANCIA = 'https://vig.my.salesforce.com';

function texto(status, cuerpo) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)),
    json: async () => (typeof cuerpo === 'string' ? JSON.parse(cuerpo) : cuerpo),
  };
}

/**
 * Adaptador con `fetch` mockeado.
 *
 * `respuestas` es una funcion (url, opciones) -> respuesta; si no se pasa,
 * autentica bien y devuelve una query vacia.
 */
function construir({
  respuestas,
  permitirEscrituras = false,
  usarSandbox = false,
  ahora,
  // Por defecto la org NO tiene Client Credentials activo: es el caso de
  // produccion hoy, y deja que los tests del flujo de contrasena sigan
  // ejercitando el camino que de verdad se usa.
  clientCredentials = false,
} = {}) {
  const llamadas = [];
  const adaptador = createSalesforceLeadAdapter({
    getSalesforceSecrets: async () => SECRETO,
    permitirEscrituras,
    usarSandbox,
    ...(ahora ? { ahora } : {}),
    fetchImpl: async (url, opciones) => {
      llamadas.push({ url, opciones });
      if (respuestas) {
        const r = respuestas(url, opciones, llamadas.length);
        if (r) return r;
      }
      if (url.includes('/oauth2/token')) {
        const grant = new URLSearchParams(opciones.body).get('grant_type');
        if (grant === 'client_credentials' && !clientCredentials) {
          // Lo que devuelve Salesforce cuando el flujo no esta habilitado.
          return texto(400, { error: 'invalid_grant', error_description: 'authentication failure' });
        }
        return texto(200, { access_token: 'tok-abc', instance_url: INSTANCIA });
      }
      return texto(200, { records: [] });
    },
  });
  return { adaptador, llamadas };
}

/** Las llamadas SOQL, para no depender de indices que cambian con los flujos. */
const queries = (llamadas) => llamadas.filter((l) => l.url.includes('/query'));

/**
 * Cuantas AUTENTICACIONES hubo, no cuantos POST de token.
 *
 * Cada autenticacion puede gastar dos peticiones —el flujo preferido y el
 * respaldo—, asi que contar peticiones de token ya no mide lo mismo.
 */
const autenticaciones = (llamadas) =>
  llamadas.filter(
    (l) =>
      l.url.includes('/oauth2/token') &&
      new URLSearchParams(l.opciones.body).get('grant_type') === 'client_credentials'
  ).length;

/** Los POST al endpoint de token, con su grant_type ya extraido. */
const tokens = (llamadas) =>
  llamadas
    .filter((l) => l.url.includes('/oauth2/token'))
    .map((l) => ({ ...l, grant: new URLSearchParams(l.opciones.body).get('grant_type') }));

// --- contrato del puerto ---------------------------------------------------

test('el adaptador expone exactamente los metodos del puerto', () => {
  const { adaptador } = construir();
  assert.deepEqual(Object.keys(adaptador).sort(), [
    'createLead', 'findLeadByEmailOrPhone', 'getLead', 'setCurrentStep', 'updateLead',
  ]);
});

test('createPorts lo acepta', () => {
  const { adaptador } = construir();
  const ports = createPorts({ salesforce: adaptador });
  assert.equal(typeof ports.salesforce.getLead, 'function');
});

// --- autenticacion ---------------------------------------------------------

test('el respaldo de contrasena concatena password + security token', async () => {
  const { adaptador, llamadas } = construir();
  await adaptador.findLeadByEmailOrPhone({ email: 'a@b.com' });

  const intentos = tokens(llamadas);
  assert.deepEqual(
    intentos.map((t) => t.grant),
    ['client_credentials', 'password'],
    'primero el flujo preferido, luego el respaldo'
  );

  const cuerpo = new URLSearchParams(intentos[1].opciones.body);
  assert.equal(intentos[1].url, SECRETO.SF_URL);
  assert.equal(cuerpo.get('password'), 'passtok', 'password + security token');
  assert.equal(cuerpo.get('username'), 'user-prod');
});

test('con Client Credentials NO se intenta el flujo de contrasena', async () => {
  const { adaptador, llamadas } = construir({ clientCredentials: true });
  await adaptador.findLeadByEmailOrPhone({ email: 'a@b.com' });

  const intentos = tokens(llamadas);
  assert.deepEqual(intentos.map((t) => t.grant), ['client_credentials']);

  // Client Credentials no manda identidad de usuario: es su razon de ser.
  const cuerpo = new URLSearchParams(intentos[0].opciones.body);
  assert.equal(cuerpo.get('username'), null, 'no debe viajar el usuario');
  assert.equal(cuerpo.get('password'), null, 'no debe viajar la contrasena');
  assert.equal(cuerpo.get('client_id'), 'cid-prod');
  assert.equal(cuerpo.get('client_secret'), 'csec-prod');
});

test('si los dos flujos fallan, el error trae LOS DOS motivos', async () => {
  // El `invalid_grant: authentication failure` de Salesforce es identico para
  // contrasena mala, token caducado, flujo deshabilitado y politica de la app.
  // Reportar los dos intentos es lo que permite distinguir "hay que activar el
  // flujo en la org" de "la credencial esta mal".
  const { adaptador } = construir({
    respuestas: (url, o) => {
      if (!url.includes('/oauth2/token')) return null;
      const grant = new URLSearchParams(o.body).get('grant_type');
      return grant === 'client_credentials'
        ? texto(400, { error: 'invalid_grant', error_description: 'flow not enabled' })
        : texto(400, { error: 'invalid_grant', error_description: 'authentication failure' });
    },
  });

  await assert.rejects(adaptador.getLead(LEAD_ID), (e) => {
    assert.equal(e.name, 'ProviderError');
    assert.match(e.message, /client_credentials -> .*flow not enabled/);
    assert.match(e.message, /password -> .*authentication failure/);
    return true;
  });
});

test('sin usuario ni token, Client Credentials basta', async () => {
  // Una org que solo tenga el flujo moderno no deberia necesitar guardar
  // contrasena ni security token en el secreto.
  const llamadas = [];
  const adaptador = createSalesforceLeadAdapter({
    getSalesforceSecrets: async () => ({
      SF_URL: SECRETO.SF_URL,
      SF_CLIENT_ID: 'cid-prod',
      SF_CLIENT_SECRET: 'csec-prod',
    }),
    fetchImpl: async (url, opciones) => {
      llamadas.push({ url, opciones });
      if (url.includes('/oauth2/token')) {
        return texto(200, { access_token: 'tok-abc', instance_url: INSTANCIA });
      }
      return texto(200, { records: [] });
    },
  });

  assert.equal(await adaptador.findLeadByEmailOrPhone({ email: 'a@b.com' }), null);
  assert.deepEqual(tokens(llamadas).map((t) => t.grant), ['client_credentials']);
});

test('sin Client Credentials y sin credenciales de usuario, dice que faltan', async () => {
  const adaptador = createSalesforceLeadAdapter({
    getSalesforceSecrets: async () => ({
      SF_URL: SECRETO.SF_URL,
      SF_CLIENT_ID: 'cid-prod',
      SF_CLIENT_SECRET: 'csec-prod',
    }),
    fetchImpl: async () => texto(400, { error: 'invalid_grant', error_description: 'nope' }),
  });
  await assert.rejects(adaptador.getLead(LEAD_ID), /le faltan claves: SF_USERNAME/);
});

test('el token se cachea entre llamadas', async () => {
  const { adaptador, llamadas } = construir();
  await adaptador.findLeadByEmailOrPhone({ email: 'a@b.com' });
  await adaptador.findLeadByEmailOrPhone({ email: 'c@d.com' });

  assert.equal(autenticaciones(llamadas), 1, 'no debe reautenticar en cada peticion');
});

test('el token se renueva cuando caduca', async () => {
  let reloj = 1_000_000;
  const { adaptador, llamadas } = construir({ ahora: () => reloj });
  await adaptador.findLeadByEmailOrPhone({ email: 'a@b.com' });
  reloj += 61 * 60 * 1000; // mas de una hora
  await adaptador.findLeadByEmailOrPhone({ email: 'c@d.com' });

  assert.equal(autenticaciones(llamadas), 2);
});

test('un 401 con token cacheado reautentica y reintenta UNA vez', async () => {
  let consultas = 0;
  const { adaptador, llamadas } = construir({
    respuestas: (url) => {
      if (url.includes('/query')) {
        consultas += 1;
        // El primer query falla como si el token hubiera caducado antes de hora.
        if (consultas === 1) return texto(401, [{ errorCode: 'INVALID_SESSION_ID' }]);
      }
      return null;
    },
  });

  const r = await adaptador.findLeadByEmailOrPhone({ email: 'a@b.com' });
  assert.equal(r, null);
  assert.equal(autenticaciones(llamadas), 2);
  assert.equal(consultas, 2, 'reintenta una vez');
});

test('un sandbox caducado devuelve HTML y se reporta como tal', async () => {
  // Sintoma real del sandbox `landingpg` el 2026-08-07: pagina HTML de error en
  // vez de JSON. Sin este caso el fallo salia como "token undefined" mucho
  // despues y costaba relacionarlo con la causa.
  const { adaptador } = construir({
    usarSandbox: true,
    respuestas: (url) =>
      url.includes('/oauth2/token') ? texto(420, '<head><title>Error Page</title>') : null,
  });
  await assert.rejects(adaptador.getLead(LEAD_ID), (e) => {
    assert.equal(e.name, 'ProviderError');
    assert.match(e.message, /no es JSON/);
    return true;
  });
});

test('con usarSandbox usa las claves _DEV', async () => {
  const { adaptador, llamadas } = construir({ usarSandbox: true });
  await adaptador.findLeadByEmailOrPhone({ email: 'a@b.com' });
  assert.equal(llamadas[0].url, SECRETO.SF_URL_DEV);
  const enviado = JSON.stringify(llamadas);
  for (const deProd of ['cid-prod', 'csec-prod', 'user-prod']) {
    assert.ok(!enviado.includes(deProd), `se filtro credencial de produccion: ${deProd}`);
  }
});

// --- lecturas --------------------------------------------------------------

test('findLeadByEmailOrPhone escapa el SOQL en vez de concatenarlo', async () => {
  // El legacy concatenaba el email crudo en el WHERE
  // (`accionCrearLead.php:12`). Una comilla simple bastaba para romper la query.
  const { adaptador, llamadas } = construir();
  await adaptador.findLeadByEmailOrPhone({ email: "ana' OR Id != null OR '" });

  const query = decodeURIComponent(queries(llamadas)[0].url.split('q=')[1]);
  assert.ok(!/OR Id != null OR/.test(query.replace(/\\'/g, '')), 'inyeccion SOQL');
  assert.match(query, /\\'/, 'la comilla debe ir escapada');
});

test('findLeadByEmailOrPhone devuelve el id o null', async () => {
  const conLead = construir({
    respuestas: (url) => (url.includes('/query') ? texto(200, { records: [{ Id: LEAD_ID }] }) : null),
  });
  assert.deepEqual(await conLead.adaptador.findLeadByEmailOrPhone({ email: 'a@b.com' }), {
    id: LEAD_ID,
  });

  const sinLead = construir();
  assert.equal(await sinLead.adaptador.findLeadByEmailOrPhone({ email: 'a@b.com' }), null);
});

test('getLead devuelve el modelo de la API y NUNCA el SSN', async () => {
  const { adaptador } = construir({
    respuestas: (url) =>
      url.includes('/query')
        ? texto(200, {
            records: [{
              Id: LEAD_ID, Email: 'ana@vigpr.com', FirstName: 'ANA', LastName: 'DIAZ',
              Birthdate__c: '1980-03-15', currentStep__c: '2',
              Street: 'CALLE LUNA 12', City: 'Ponce', State: 'PR', PostalCode: '00731',
              // Si la org lo devolviera por error, no debe salir de aqui.
              LASERCA__SSN__c: '123456789',
            }],
          })
        : null,
  });

  const lead = await adaptador.getLead(LEAD_ID);
  assert.equal(lead.firstName, 'ANA');
  assert.equal(lead.currentAddress.city, 'Ponce');
  assert.equal(lead.currentStep, 'currentAddress');
  assert.ok(!JSON.stringify(lead).includes('123456789'), 'el SSN no puede salir de getLead');
});

test('getLead con un id que no es de Salesforce no consulta', async () => {
  const { adaptador, llamadas } = construir();
  assert.equal(await adaptador.getLead('no-es-un-id'), null);
  assert.equal(llamadas.length, 0, 'ni siquiera autentica');
});

// --- escrituras: el flag ---------------------------------------------------

test('con las escrituras apagadas, createLead NO llama a Salesforce', async () => {
  const { adaptador, llamadas } = construir({ permitirEscrituras: false });
  const r = await adaptador.createLead({ email: 'a@b.com', firstName: 'ANA', lastName: 'DIAZ' });

  assert.equal(llamadas.length, 0, 'no debe salir ninguna peticion');
  assert.match(r.id, /^SIN_ESCRIBIR_/, 'el id sintetico debe ser reconocible');
});

test('con las escrituras apagadas, updateLead y setCurrentStep tampoco', async () => {
  const { adaptador, llamadas } = construir({ permitirEscrituras: false });
  await adaptador.updateLead(LEAD_ID, { firstName: 'ANA' });
  await adaptador.setCurrentStep(LEAD_ID, 3);
  assert.equal(llamadas.length, 0);
});

test('con las escrituras encendidas, createLead manda los campos mapeados', async () => {
  const { adaptador, llamadas } = construir({
    permitirEscrituras: true,
    respuestas: (url, o) =>
      o.method === 'POST' && url.includes('/sobjects/Lead')
        ? texto(201, { id: LEAD_ID, success: true })
        : null,
  });

  const r = await adaptador.createLead({
    email: 'ana@vigpr.com', phone: '7871234567', firstName: 'ana', lastName: 'diaz',
    dob: '1980-03-15', loanPurpose: 'Compra',
  });

  assert.deepEqual(r, { id: LEAD_ID });
  const post = llamadas.find((l) => l.opciones.method === 'POST' && l.url.includes('/sobjects/Lead'));
  const enviado = JSON.parse(post.opciones.body);
  // El mapeo lo hace el mapper: aqui solo se comprueba que llego mapeado.
  assert.equal(enviado.Email, 'ana@vigpr.com');
  assert.equal(enviado.FirstName, 'ANA', 'el mapper pasa a mayusculas');
  assert.equal(enviado.Birthdate__c, '1980-03-15');
});

test('setCurrentStep escribe el numero legacy como string', async () => {
  // El puerto recibe el NUMERO ya traducido por el router. Pasarlo a
  // `mapper.toCurrentStepFields` —que espera el NOMBRE del paso— devolvia `{}`
  // y convertia esto en un no-op silencioso: el lead nunca avanzaba en
  // Salesforce y nada lo delataba.
  const { adaptador, llamadas } = construir({
    permitirEscrituras: true,
    respuestas: (url, o) => (o.method === 'PATCH' ? texto(204, '') : null),
  });

  await adaptador.setCurrentStep(LEAD_ID, 3);
  const patch = llamadas.find((l) => l.opciones.method === 'PATCH');
  assert.ok(patch, 'setCurrentStep debe emitir un PATCH');
  assert.deepEqual(JSON.parse(patch.opciones.body), { currentStep__c: '3' });
});

test('updateLead descarta completedSteps, que no tiene campo en la org', async () => {
  const { adaptador, llamadas } = construir({
    permitirEscrituras: true,
    respuestas: (url, o) => (o.method === 'PATCH' ? texto(204, '') : null),
  });

  await adaptador.updateLead(LEAD_ID, { firstName: 'ANA', completedSteps: ['start', 'personal'] });
  const patch = llamadas.find((l) => l.opciones.method === 'PATCH');
  const enviado = JSON.parse(patch.opciones.body);
  assert.equal(enviado.FirstName, 'ANA');
  assert.ok(!('completedSteps' in enviado));
});

test('updateLead sin campos mapeables no llama a Salesforce', async () => {
  const { adaptador, llamadas } = construir({ permitirEscrituras: true });
  await adaptador.updateLead(LEAD_ID, { completedSteps: ['start'] });
  assert.equal(llamadas.length, 0, 'un PATCH vacio es una llamada desperdiciada');
});

// --- errores ---------------------------------------------------------------

test('el error de Salesforce queda dentro; al cliente le llega generico', async () => {
  const { adaptador } = construir({
    permitirEscrituras: true,
    respuestas: (url, o) =>
      o.method === 'POST' && url.includes('/sobjects/Lead')
        ? texto(400, [{ errorCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields: [LastName]' }])
        : null,
  });

  await assert.rejects(adaptador.createLead({ email: 'a@b.com' }), (e) => {
    assert.equal(e.name, 'ProviderError');
    assert.match(e.message, /REQUIRED_FIELD_MISSING/);
    assert.doesNotMatch(e.publicMessage, /REQUIRED_FIELD|LastName/);
    return true;
  });
});

test('un secreto incompleto falla antes de salir a la red', async () => {
  const llamadas = [];
  const adaptador = createSalesforceLeadAdapter({
    getSalesforceSecrets: async () => ({ SF_URL: 'https://x' }),
    fetchImpl: async (...a) => {
      llamadas.push(a);
      return texto(200, {});
    },
  });
  await assert.rejects(adaptador.getLead(LEAD_ID), /le faltan claves/);
  assert.equal(llamadas.length, 0);
});

// --- objetos hijos ---------------------------------------------------------

/** Recoge los POST a objetos hijos. */
function conEscrituras() {
  return construir({
    permitirEscrituras: true,
    respuestas: (url, o) => {
      if (o.method === 'POST' && url.includes('/sobjects/')) return texto(201, { id: 'a0X1', success: true });
      if (o.method === 'PATCH') return texto(204, '');
      return null;
    },
  });
}

const posts = (llamadas, sobject) =>
  llamadas.filter((l) => l.opciones.method === 'POST' && l.url.includes(`/sobjects/${sobject}`));

test('el paso de empleo crea Employment_SelfEmployment__c', async () => {
  const { adaptador, llamadas } = conEscrituras();
  await adaptador.updateLead(LEAD_ID, {
    employerBusinessName: 'Acme Corp', positionTitle: 'Ingeniero',
    startDate: '2020-01-15', employerPhone: '7871234567',
    line1: 'Ave 1', city: 'Ponce', state: 'PR', zipCode: '00731',
    yearsEmployment: 5, monthsEmployment: 2,
  }, { step: 'employment' });

  const [post] = posts(llamadas, 'Employment_SelfEmployment__c');
  assert.ok(post, 'debe crear el registro de empleo');
  const r = JSON.parse(post.opciones.body);
  assert.equal(r.Lead__c, LEAD_ID);
  assert.equal(r.EmployerBusinessName__c, 'ACME CORP');
  assert.equal(r.PositionTitle__c, 'INGENIERO');
});

test('el paso de ingresos crea Income__c con el mensual ya derivado', async () => {
  const { adaptador, llamadas } = conEscrituras();
  await adaptador.updateLead(LEAD_ID, {
    grossPayPerPeriod: 3000, incomeFrequency: 'Biweekly',
    // Lo deriva el router con `income.js`; el adaptador solo lo persiste.
    monthlyIncome: 6500,
    businessOwnerOrSelfEmployed: false, retiredOrPensioner: false, paysChildSupport: false,
  }, { step: 'income' });

  const [post] = posts(llamadas, 'Income__c');
  assert.ok(post, 'debe crear el registro de ingresos');
  const r = JSON.parse(post.opciones.body);
  // Los nombres estan invertidos EN LA ORG: `MonthlyIncome__c` guarda el pago
  // por periodo y `TotalIncome__c` el mensual. Se respeta el legacy.
  assert.equal(r.MonthlyIncome__c, 3000);
  assert.equal(r.TotalIncome__c, 6500);
  assert.equal(r.IncomeFrequency__c, 'Biweekly');
});

test('la direccion POSTAL crea MailingAddress__c y NO toca el Lead', async () => {
  // Este test es el motivo de que el paso viaje explicito: `currentAddress` y
  // `mailingAddress` mandan los mismos nombres de campo. Sin el paso, la
  // postal se escribiria encima de la fisica del Lead.
  const { adaptador, llamadas } = conEscrituras();
  await adaptador.updateLead(LEAD_ID, {
    line1: 'PO Box 99', city: 'Cabo Rojo', state: 'PR', zipCode: '00623',
    housing: 'Own', years: 3, months: 0,
  }, { step: 'mailingAddress' });

  const [post] = posts(llamadas, 'MailingAddress__c');
  assert.ok(post, 'debe crear el registro de direccion postal');
  const r = JSON.parse(post.opciones.body);
  assert.equal(r.StreetMailAddress__c, 'PO Box 99');
  assert.equal(r.cbocityMailAddress__c, 'Cabo Rojo');

  const patch = llamadas.find((l) => l.opciones.method === 'PATCH');
  if (patch) {
    const enLead = JSON.parse(patch.opciones.body);
    assert.ok(!('Street' in enLead), 'la postal no puede sobrescribir Street del Lead');
    assert.ok(!('City' in enLead), 'la postal no puede sobrescribir City del Lead');
  }
});

test('la direccion FISICA va al Lead y no crea ningun hijo', async () => {
  const { adaptador, llamadas } = conEscrituras();
  await adaptador.updateLead(LEAD_ID, {
    line1: 'CALLE LUNA 12', city: 'Ponce', state: 'PR', zipCode: '00731',
    housing: 'Own', years: 5, months: 0,
  }, { step: 'currentAddress' });

  assert.equal(posts(llamadas, 'MailingAddress__c').length, 0);
  const patch = llamadas.find((l) => l.opciones.method === 'PATCH');
  const enLead = JSON.parse(patch.opciones.body);
  assert.equal(enLead.Street, 'CALLE LUNA 12');
  assert.equal(enLead.City, 'Ponce');
});

test('un paso sin objeto hijo no crea ninguno', async () => {
  const { adaptador, llamadas } = conEscrituras();
  await adaptador.updateLead(LEAD_ID, { citizenship: 'U.S. Citizen' }, { step: 'personal' });
  // Filtrando por `/sobjects/`: el POST de autenticacion tambien es POST.
  const hijos = llamadas.filter(
    (l) => l.opciones.method === 'POST' && l.url.includes('/sobjects/')
  );
  assert.equal(hijos.length, 0);
});

test('con las escrituras apagadas tampoco se crean hijos', async () => {
  const { adaptador, llamadas } = construir({ permitirEscrituras: false });
  await adaptador.updateLead(LEAD_ID, {
    grossPayPerPeriod: 3000, incomeFrequency: 'Biweekly', monthlyIncome: 6500,
  }, { step: 'income' });
  assert.equal(llamadas.length, 0);
});

test('el hijo se crea ANTES de marcar el Lead', async () => {
  // Si el hijo falla, el Lead no debe quedar como si el paso hubiera cuajado.
  const { adaptador, llamadas } = construir({
    permitirEscrituras: true,
    respuestas: (url, o) =>
      o.method === 'POST' && url.includes('/sobjects/Income__c')
        ? texto(400, [{ errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'nope' }])
        : o.method === 'PATCH'
          ? texto(204, '')
          : null,
  });

  await assert.rejects(
    adaptador.updateLead(LEAD_ID, {
      grossPayPerPeriod: 3000, incomeFrequency: 'Biweekly', monthlyIncome: 6500,
    }, { step: 'income' }),
    /FIELD_CUSTOM_VALIDATION_EXCEPTION/
  );
  assert.equal(llamadas.filter((l) => l.opciones.method === 'PATCH').length, 0,
    'no debe tocar el Lead si el hijo fallo');
});
