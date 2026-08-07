'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const {
  ISSUER,
  AUDIENCE,
  assertUsableSecret,
  createSessionManager,
  bearerFrom,
} = require('../lib/prequalify/session');

const SECRET = 'secreto-de-precualificacion-suficientemente-largo';
const APP_SECRET = 'secreto-del-app-que-no-debe-reutilizarse-aqui';

const manager = () => createSessionManager({ secret: SECRET, appJwtSecret: APP_SECRET });

// --- secreto --------------------------------------------------------------

test('exige un secreto de al menos 32 caracteres', () => {
  assert.throws(() => assertUsableSecret('corto'), TypeError);
  assert.throws(() => assertUsableSecret('a'.repeat(31)), TypeError);
  assert.doesNotThrow(() => assertUsableSecret('a'.repeat(32)));
});

test('prohibe reutilizar el secreto JWT del app', () => {
  // Es la defensa central de este modulo: verificarJWT en app.js no comprueba
  // `aud`, asi que compartir secreto convertiria una sesion anonima en un
  // token de usuario autenticado.
  assert.throws(
    () => createSessionManager({ secret: APP_SECRET, appJwtSecret: APP_SECRET }),
    /NO puede ser el mismo/
  );
});

// --- emision --------------------------------------------------------------

test('emite un token verificable con su TTL', () => {
  const { issue, verify, ttlSeconds } = manager();
  const { token, expiresInSeconds } = issue({ leadId: '00Q123' });

  assert.equal(expiresInSeconds, ttlSeconds);
  assert.deepEqual(verify(token).leadId, '00Q123');
});

test('issue exige leadId', () => {
  const { issue } = manager();
  for (const leadId of [undefined, null, '', '   ', 42]) {
    assert.throws(() => issue({ leadId }), TypeError, `leadId: ${String(leadId)}`);
  }
});

test('el payload no lleva NADA sensible', () => {
  const { issue } = manager();
  const { token } = issue({ leadId: '00Q123' });
  const payload = jwt.decode(token);

  // Un JWT va firmado, no cifrado: quien lo intercepte lee esto.
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['aud', 'exp', 'iat', 'iss', 'jti', 'leadId']
  );
  const serializado = JSON.stringify(payload).toLowerCase();
  for (const prohibido of ['ssn', 'social', 'score', 'email', 'phone', 'access_token']) {
    assert.ok(!serializado.includes(prohibido), `no debe incluir ${prohibido}`);
  }
});

test('cada sesion tiene su propio jti', () => {
  const { issue } = manager();
  const a = jwt.decode(issue({ leadId: '00Q1' }).token);
  const b = jwt.decode(issue({ leadId: '00Q1' }).token);
  assert.notEqual(a.jti, b.jti);
});

// --- verificacion ---------------------------------------------------------

test('rechaza basura sin reventar', () => {
  const { verify } = manager();
  for (const token of [undefined, null, '', 'no-es-jwt', 'a.b.c', 42, {}]) {
    assert.equal(verify(token), null, `token: ${String(token)}`);
  }
});

test('rechaza un token firmado con otro secreto', () => {
  const { verify } = manager();
  const ajeno = jwt.sign({ leadId: '00Q123' }, 'otro-secreto-cualquiera-largo-de-sobra', {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  assert.equal(verify(ajeno), null);
});

test('rechaza alg:none (confusion de algoritmo)', () => {
  const { verify } = manager();
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ leadId: '00Q123', iss: ISSUER, aud: AUDIENCE })
  ).toString('base64url');
  assert.equal(verify(`${header}.${payload}.`), null);
});

test('rechaza un token del app: la audiencia no cuadra', () => {
  // Aunque alguien consiguiera firmar con el secreto correcto, sin la
  // audiencia de precualificacion no entra.
  const { verify } = manager();
  const tokenDelApp = jwt.sign({ leadId: '00Q123', username: 'admin' }, SECRET, {
    issuer: ISSUER,
    audience: 'vig-app',
  });
  assert.equal(verify(tokenDelApp), null);
});

test('rechaza un emisor distinto', () => {
  const { verify } = manager();
  const otro = jwt.sign({ leadId: '00Q123' }, SECRET, {
    issuer: 'otro-servicio',
    audience: AUDIENCE,
  });
  assert.equal(verify(otro), null);
});

test('rechaza un token vencido', () => {
  const { verify } = createSessionManager({ secret: SECRET, ttlSeconds: 1 });
  const vencido = jwt.sign({ leadId: '00Q123' }, SECRET, {
    algorithm: 'HS256',
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: -10,
  });
  assert.equal(verify(vencido), null);
});

test('rechaza un token sin leadId', () => {
  const { verify } = manager();
  const sinLead = jwt.sign({ algo: 'otra cosa' }, SECRET, {
    algorithm: 'HS256',
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  assert.equal(verify(sinLead), null);
});

// --- cabecera -------------------------------------------------------------

test('bearerFrom extrae el token', () => {
  assert.equal(bearerFrom('Bearer abc.def.ghi'), 'abc.def.ghi');
  assert.equal(bearerFrom('bearer abc'), 'abc');
});

test('bearerFrom rechaza otros esquemas y basura', () => {
  for (const value of [undefined, null, '', 'abc', 'Basic abc', 'Bearer', 'Bearer   ', 42]) {
    assert.equal(bearerFrom(value), null, `valor: ${String(value)}`);
  }
});
