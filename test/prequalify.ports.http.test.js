'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const asyncHandler = require('../middleware/asyncHandler');
const { errorHandler, notFoundHandler } = require('../middleware/errorHandler');
const { createPorts } = require('../lib/prequalify/ports');

/**
 * Cierra el circuito de la Tarea B2: un puerto sin implementar tiene que llegar
 * al cliente como un 501 limpio a traves del errorHandler real, sin filtrar
 * quien es el proveedor.
 */
function buildApp(ports) {
  const app = express();
  app.use(express.json());

  app.post(
    '/prequalify/leads',
    asyncHandler(async (req, res) => {
      const lead = await ports.salesforce.createLead(req.body);
      res.status(201).json(lead);
    })
  );

  app.post(
    '/prequalify/otp',
    asyncHandler(async (req, res) => {
      await ports.otp.send({ channel: 'sms', destination: '7871234567', code: '123456' });
      // Aunque el puerto respondiera, el codigo nunca vuelve al cliente.
      res.status(202).json({ sent: true });
    })
  );

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

async function call(app, method, path, body) {
  const srv = app.listen(0);
  const { port } = srv.address();
  try {
    const opts = { method };
    if (body !== undefined) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`http://127.0.0.1:${port}${path}`, opts);
    return { status: res.status, body: await res.json() };
  } finally {
    srv.close();
  }
}

test('sin proveedores configurados, el endpoint responde 501 limpio', async () => {
  const app = buildApp(createPorts());
  const res = await call(app, 'POST', '/prequalify/leads', { email: 'a@b.com' });

  assert.equal(res.status, 501);
  assert.equal(res.body.error, 'Este servicio no esta disponible en este momento.');
});

test('el 501 no filtra proveedor, metodo, stack ni rutas internas', async () => {
  const app = buildApp(createPorts());
  const res = await call(app, 'POST', '/prequalify/leads', {});

  const serializado = JSON.stringify(res.body).toLowerCase();
  for (const filtracion of ['salesforce', 'createlead', 'stack', 'lib/prequalify', 'node_modules']) {
    assert.ok(!serializado.includes(filtracion), `no debe filtrar: ${filtracion}`);
  }
  assert.deepEqual(Object.keys(res.body), ['error']);
});

test('con el puerto inyectado, el mismo endpoint funciona', async () => {
  const app = buildApp(
    createPorts({
      salesforce: { createLead: async ({ email }) => ({ id: `00Q-${email}` }) },
    })
  );
  const res = await call(app, 'POST', '/prequalify/leads', { email: 'a@b.com' });

  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { id: '00Q-a@b.com' });
});

test('el OTP nunca vuelve en la respuesta, ni con el puerto implementado', async () => {
  const app = buildApp(
    createPorts({ otp: { send: async () => ({ deliveryId: 'SM123' }) } })
  );
  const res = await call(app, 'POST', '/prequalify/otp', {});

  assert.equal(res.status, 202);
  assert.ok(!JSON.stringify(res.body).includes('123456'));
  assert.deepEqual(res.body, { sent: true });
});
