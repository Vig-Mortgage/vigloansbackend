'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PORT_SPECS,
  PORT_NAMES,
  createPorts,
  portAvailability,
  NotImplementedError,
  ProviderError,
} = require('../lib/prequalify/ports');
const { buildPort } = require('../lib/prequalify/ports/portFactory');

// --- valores por defecto: fallar en claro --------------------------------

test('sin implementacion, todo metodo lanza NotImplementedError con 501', async () => {
  const ports = createPorts();
  for (const [name, methods] of Object.entries(PORT_SPECS)) {
    for (const method of methods) {
      await assert.rejects(
        () => ports[name][method]({}),
        (error) => {
          assert.ok(error instanceof NotImplementedError, `${name}.${method}`);
          assert.equal(error.status, 501);
          assert.equal(error.port, name);
          assert.equal(error.method, method);
          return true;
        },
        `${name}.${method} deberia lanzar`
      );
    }
  }
});

test('el 501 no filtra que proveedor es: el nombre solo va en el log', async () => {
  const ports = createPorts();
  await assert.rejects(
    () => ports.experian.fetchCreditReport({}),
    (error) => {
      assert.equal(error.publicMessage, 'Este servicio no esta disponible en este momento.');
      assert.ok(!error.publicMessage.toLowerCase().includes('experian'));
      // El detalle si esta disponible del lado servidor.
      assert.ok(error.message.includes('experian'));
      return true;
    }
  );
});

test('estan los cinco puertos del contrato', () => {
  assert.deepEqual(
    [...PORT_NAMES].sort(),
    ['document', 'experian', 'notification', 'otp', 'salesforce']
  );
});

// --- inyeccion ------------------------------------------------------------

test('se puede construir el servicio con puertos mock', async () => {
  const ports = createPorts({
    salesforce: {
      createLead: async (lead) => ({ id: `00Q-${lead.email}` }),
      findLeadByEmailOrPhone: async () => null,
    },
  });

  assert.deepEqual(await ports.salesforce.createLead({ email: 'a@b.com' }), {
    id: '00Q-a@b.com',
  });
  assert.equal(await ports.salesforce.findLeadByEmailOrPhone({}), null);
});

test('los metodos no inyectados del mismo puerto siguen en 501', async () => {
  const ports = createPorts({ salesforce: { createLead: async () => ({ id: 'x' }) } });
  await assert.rejects(() => ports.salesforce.getLead('x'), NotImplementedError);
});

test('los demas puertos no se ven afectados', async () => {
  const ports = createPorts({ salesforce: { createLead: async () => ({ id: 'x' }) } });
  await assert.rejects(() => ports.experian.fetchCreditReport({}), NotImplementedError);
  await assert.rejects(() => ports.otp.send({}), NotImplementedError);
});

// --- proteccion contra errores de tipeo ----------------------------------

test('un puerto mal escrito falla al construir, no en produccion', () => {
  assert.throws(
    () => createPorts({ salesForce: {} }),
    (error) => {
      assert.ok(error instanceof TypeError);
      assert.ok(error.message.includes('salesForce'));
      assert.ok(error.message.includes('salesforce'), 'sugiere los validos');
      return true;
    }
  );
  assert.throws(() => createPorts({ experia: {} }), TypeError);
});

test('un metodo fuera del contrato falla al construir', () => {
  // `sendOtp` en vez de `send`: sin esta guarda se instalaria en silencio y
  // el puerto seguiria lanzando 501 sin que nadie entienda por que.
  assert.throws(
    () => createPorts({ otp: { sendOtp: async () => {} } }),
    (error) => {
      assert.ok(error.message.includes('sendOtp'));
      assert.ok(error.message.includes('send'));
      return true;
    }
  );
});

test('un metodo que no es funcion falla al construir', () => {
  assert.throws(() => createPorts({ otp: { send: 'no soy funcion' } }), TypeError);
  assert.throws(() => buildPort('x', ['a'], 'no soy objeto'), TypeError);
});

test('createPorts rechaza argumentos que no son objeto', () => {
  assert.throws(() => createPorts('nope'), TypeError);
  assert.throws(() => createPorts(null), TypeError);
});

test('createPorts sin argumentos funciona', () => {
  assert.doesNotThrow(() => createPorts());
});

// --- inmutabilidad --------------------------------------------------------

test('los puertos quedan congelados: nadie los parchea en caliente', () => {
  const ports = createPorts();
  assert.ok(Object.isFrozen(ports));
  assert.ok(Object.isFrozen(ports.salesforce));
  const original = ports.salesforce.createLead;
  try {
    ports.salesforce.createLead = async () => ({ id: 'inyectado' });
  } catch {
    // en modo estricto lanza; en ambos casos no debe cambiar
  }
  assert.equal(ports.salesforce.createLead, original);
});

// --- disponibilidad -------------------------------------------------------

test('portAvailability distingue implementado de stub', () => {
  const vacio = portAvailability(createPorts());
  assert.deepEqual(vacio, {
    salesforce: false,
    experian: false,
    otp: false,
    notification: false,
    document: false,
  });

  const parcial = portAvailability(
    createPorts({
      salesforce: { createLead: async () => ({ id: 'x' }) },
      otp: { send: async () => ({}) },
    })
  );
  assert.equal(parcial.salesforce, true);
  assert.equal(parcial.otp, true);
  assert.equal(parcial.experian, false);
});

test('portAvailability tolera un contenedor invalido', () => {
  assert.equal(portAvailability(undefined).salesforce, false);
  assert.equal(portAvailability({}).experian, false);
});

// --- ProviderError --------------------------------------------------------

test('ProviderError no filtra el mensaje del tercero al cliente', () => {
  const error = new ProviderError(
    'salesforce',
    "MALFORMED_QUERY: SELECT Id FROM Lead WHERE Email='a@b.com'",
    { cause: new Error('raw') }
  );
  assert.equal(error.status, 502);
  assert.equal(
    error.publicMessage,
    'No pudimos completar la operacion. Intenta de nuevo mas tarde.'
  );
  assert.ok(!error.publicMessage.includes('SELECT'));
  assert.ok(!error.publicMessage.includes('a@b.com'));
  // El detalle si queda para el logger.
  assert.ok(error.message.includes('MALFORMED_QUERY'));
  assert.equal(error.provider, 'salesforce');
});

test('ProviderError acepta un status propio', () => {
  assert.equal(new ProviderError('experian', 'timeout', { status: 504 }).status, 504);
});
