'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const {
  JWT_ALGORITHMS,
  authorizeKeyOwnership,
  getOwnerId,
  createVerificarJWT,
} = require('../middleware/auth');

const SECRET = 'secreto-de-prueba-del-backend-suficientemente-largo';
const getBackendSecrets = async () => ({ jwt_secret_key: SECRET });

/** req/res falsos, suficientes para el middleware. */
function fakeCtx(authorization) {
  const res = {
    statusCode: null,
    payload: null,
    status(c) { this.statusCode = c; return this; },
    send(p) { this.payload = p; return this; },
  };
  return { req: { headers: authorization ? { authorization } : {} }, res };
}

async function run(middleware, authorization) {
  const { req, res } = fakeCtx(authorization);
  let siguiente = false;
  await middleware(req, res, () => { siguiente = true; });
  return { req, res, siguiente };
}

// --- verificacion del JWT -------------------------------------------------

test('acepta un token HS256 valido y deja el usuario en req', async () => {
  const mw = createVerificarJWT({ getBackendSecrets });
  const token = jwt.sign({ username: 'ana', sfUserId: '005AAA' }, SECRET);
  const { req, siguiente } = await run(mw, `Bearer ${token}`);

  assert.equal(siguiente, true);
  assert.equal(req.usuario.username, 'ana');
});

test('sin token responde 403', async () => {
  const mw = createVerificarJWT({ getBackendSecrets });
  const { res, siguiente } = await run(mw);
  assert.equal(res.statusCode, 403);
  assert.equal(siguiente, false);
});

test('rechaza alg:none — la confusion de algoritmo que faltaba cerrar', async () => {
  // Antes de fijar `algorithms`, este es el ataque que quedaba abierto.
  const mw = createVerificarJWT({ getBackendSecrets });
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ username: 'admin' })).toString('base64url');

  const { res, siguiente } = await run(mw, `Bearer ${header}.${payload}.`);
  assert.equal(res.statusCode, 401);
  assert.equal(siguiente, false);
});

test('solo se admite HS256', () => {
  assert.deepEqual(JWT_ALGORITHMS, ['HS256']);
});

test('rechaza firma con otro secreto y token vencido', async () => {
  const mw = createVerificarJWT({ getBackendSecrets });

  const ajeno = jwt.sign({ username: 'x' }, 'otro-secreto-distinto-y-largo-de-sobra');
  assert.equal((await run(mw, `Bearer ${ajeno}`)).res.statusCode, 401);

  const vencido = jwt.sign({ username: 'x' }, SECRET, { expiresIn: -10 });
  assert.equal((await run(mw, `Bearer ${vencido}`)).res.statusCode, 401);
});

test('el 401 no dice POR QUE fallo', async () => {
  // Distinguir "expirado" de "firma invalida" le dice al atacante cuan cerca esta.
  const mw = createVerificarJWT({ getBackendSecrets });
  const vencido = jwt.sign({ username: 'x' }, SECRET, { expiresIn: -10 });
  const malo = jwt.sign({ username: 'x' }, 'otro-secreto-distinto-y-largo-de-sobra');

  const a = await run(mw, `Bearer ${vencido}`);
  const b = await run(mw, `Bearer ${malo}`);
  assert.deepEqual(a.res.payload, b.res.payload);
});

test('si Secrets Manager falla responde 500, no deja pasar', async () => {
  const mw = createVerificarJWT({
    getBackendSecrets: async () => { throw new Error('AccessDenied'); },
  });
  const token = jwt.sign({ username: 'ana' }, SECRET);
  const { res, siguiente } = await run(mw, `Bearer ${token}`);

  assert.equal(res.statusCode, 500);
  assert.equal(siguiente, false);
  assert.ok(!JSON.stringify(res.payload).includes('AccessDenied'));
});

test('createVerificarJWT exige su dependencia', () => {
  assert.throws(() => createVerificarJWT({}), TypeError);
});

// --- autorizacion por recurso (anti-IDOR) ---------------------------------

const reqDe = (sfUserId) => ({ usuario: sfUserId ? { sfUserId } : undefined });

test('getOwnerId saca el dueno del token', () => {
  assert.equal(getOwnerId(reqDe('005AAA')), '005AAA');
  assert.equal(getOwnerId(reqDe()), null);
  assert.equal(getOwnerId({}), null);
});

test('el dueno accede a su propia clave', () => {
  const r = authorizeKeyOwnership(reqDe('005AAA'), 'u005AAA__documento.pdf');
  assert.equal(r.ok, true);
});

test('IDOR: no se accede a la clave de otro dueno', () => {
  const r = authorizeKeyOwnership(reqDe('005BBB'), 'u005AAA__documento.pdf');
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('IDOR por prefijo parcial tambien se bloquea', () => {
  // u005A__ no debe pasar por u005AAA__
  assert.equal(authorizeKeyOwnership(reqDe('005A'), 'u005AAA__doc.pdf').ok, false);
  assert.equal(authorizeKeyOwnership(reqDe('005AAA'), 'u005A__doc.pdf').ok, false);
});

test('un token sin sfUserId no toca claves con dueno', () => {
  const r = authorizeKeyOwnership(reqDe(), 'u005AAA__documento.pdf');
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('las claves legacy siguen permitidas: el agujero conocido de la Fase 0', () => {
  // No es un descuido: es grandfathering documentado, pendiente de la Tarea F1.
  // El test existe para que el dia que se cierre, falle y haya que actualizarlo.
  assert.equal(authorizeKeyOwnership(reqDe('005AAA'), 'documento-viejo.pdf').ok, true);
  assert.equal(authorizeKeyOwnership(reqDe(), 'documento-viejo.pdf').ok, true);
});

test('authorizeKeyOwnership tolera claves ausentes o raras', () => {
  for (const k of [undefined, null, '', 42, {}]) {
    assert.doesNotThrow(() => authorizeKeyOwnership(reqDe('005AAA'), k));
  }
});
