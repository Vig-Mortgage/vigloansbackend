'use strict';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { z } = require('zod');
const validate = require('../middleware/validate');
const asyncHandler = require('../middleware/asyncHandler');
const { errorHandler, notFoundHandler } = require('../middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());

  const Schema = z.object({ n: z.number().int().positive() });
  app.post('/echo', validate(Schema), (req, res) => res.json({ n: req.validated.body.n }));

  app.get('/boom', asyncHandler(async () => {
    throw new Error('kaboom interno con detalle sensible');
  }));

  app.get('/business', asyncHandler(async () => {
    const e = new Error('log-only');
    e.status = 422;
    e.publicMessage = 'Regla de negocio no cumplida';
    throw e;
  }));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

async function req(app, method, path, body) {
  const srv = app.listen(0);
  const port = srv.address().port;
  try {
    const opts = { method };
    if (body !== undefined) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); }
    const r = await fetch(`http://127.0.0.1:${port}${path}`, opts);
    const json = await r.json().catch(() => ({}));
    return { status: r.status, json };
  } finally {
    srv.close();
  }
}

test('validate: acepta entrada válida', async () => {
  const app = buildApp();
  const r = await req(app, 'POST', '/echo', { n: 5 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.n, 5);
});

test('validate: rechaza entrada inválida con 400 + details', async () => {
  const app = buildApp();
  const r = await req(app, 'POST', '/echo', { n: -1 });
  assert.strictEqual(r.status, 400);
  assert.ok(Array.isArray(r.json.details));
  assert.ok(r.json.details.length >= 1);
});

test('asyncHandler + errorHandler: 500 genérico sin filtrar el mensaje interno', async () => {
  const app = buildApp();
  const r = await req(app, 'GET', '/boom');
  assert.strictEqual(r.status, 500);
  assert.strictEqual(r.json.error, 'Error interno del servidor.');
  assert.ok(!JSON.stringify(r.json).includes('sensible'));
});

test('errorHandler: respeta status y publicMessage de errores de negocio', async () => {
  const app = buildApp();
  const r = await req(app, 'GET', '/business');
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.json.error, 'Regla de negocio no cumplida');
});

test('notFoundHandler: 404 JSON en ruta desconocida', async () => {
  const app = buildApp();
  const r = await req(app, 'GET', '/no-existe');
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.json.error, 'Recurso no encontrado.');
});
