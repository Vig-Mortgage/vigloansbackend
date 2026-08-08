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
function construir({ respuestas, permitirEscrituras = false, usarSandbox = false, ahora } = {}) {
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
        return texto(200, { access_token: 'tok-abc', instance_url: INSTANCIA });
      }
      return texto(200, { records: [] });
    },
  });
  return { adaptador, llamadas };
}

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

test('autentica con password + security token concatenados', async () => {
  const { adaptador, llamadas } = construir();
  await adaptador.findLeadByEmailOrPhone({ email: 'a@b.com' });

  const auth = llamadas[0];
  assert.equal(auth.url, SECRETO.SF_URL);
  const cuerpo = new URLSearchParams(auth.opciones.body);
  assert.equal(cuerpo.get('grant_type'), 'password');
  assert.equal(cuerpo.get('password'), 'passtok', 'password + security token');
});

test('el token se cachea entre llamadas', async () => {
  const { adaptador, llamadas } = construir();
  await adaptador.findLeadByEmailOrPhone({ email: 'a@b.com' });
  await adaptador.findLeadByEmailOrPhone({ email: 'c@d.com' });

  const auths = llamadas.filter((l) => l.url.includes('/oauth2/token'));
  assert.equal(auths.length, 1, 'no debe reautenticar en cada peticion');
});

test('el token se renueva cuando caduca', async () => {
  let reloj = 1_000_000;
  const { adaptador, llamadas } = construir({ ahora: () => reloj });
  await adaptador.findLeadByEmailOrPhone({ email: 'a@b.com' });
  reloj += 61 * 60 * 1000; // mas de una hora
  await adaptador.findLeadByEmailOrPhone({ email: 'c@d.com' });

  assert.equal(llamadas.filter((l) => l.url.includes('/oauth2/token')).length, 2);
});

test('un 401 con token cacheado reautentica y reintenta UNA vez', async () => {
  let queries = 0;
  const { adaptador, llamadas } = construir({
    respuestas: (url) => {
      if (url.includes('/query')) {
        queries += 1;
        // El primer query falla como si el token hubiera caducado antes de hora.
        if (queries === 1) return texto(401, [{ errorCode: 'INVALID_SESSION_ID' }]);
      }
      return null;
    },
  });

  const r = await adaptador.findLeadByEmailOrPhone({ email: 'a@b.com' });
  assert.equal(r, null);
  assert.equal(llamadas.filter((l) => l.url.includes('/oauth2/token')).length, 2);
  assert.equal(queries, 2, 'reintenta una vez');
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

  const query = decodeURIComponent(llamadas[1].url.split('q=')[1]);
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
