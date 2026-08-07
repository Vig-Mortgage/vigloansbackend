'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CONFIG,
  VerifyResult,
  RequestResult,
  generateCode,
  hashCode,
  safeEqual,
  challengeKey,
  createOtpService,
} = require('../lib/prequalify/otp');
const { createInMemoryOtpStore } = require('../lib/prequalify/otpStore');

const SECRET = 'un-secreto-de-prueba-suficientemente-largo';
const DESTINO = { channel: 'sms', destination: '7871234567' };

/** Puerto que captura el codigo entregado, para poder verificarlo en el test. */
function spyOtpPort() {
  const entregas = [];
  return {
    port: { send: async (payload) => { entregas.push(payload); return { deliveryId: 'X' }; } },
    entregas,
    get ultimoCodigo() {
      return entregas.at(-1)?.code;
    },
  };
}

function buildService({ now, config } = {}) {
  const spy = spyOtpPort();
  let reloj = 0;
  const clock = now ?? (() => reloj);
  const service = createOtpService({
    otpPort: spy.port,
    secret: SECRET,
    store: createInMemoryOtpStore({ now: clock }),
    now: clock,
    config,
  });
  return {
    service,
    spy,
    avanzar: (segundos) => { reloj += segundos * 1000; },
    get reloj() { return reloj; },
  };
}

// --- generacion del codigo ------------------------------------------------

test('genera codigos del largo pedido, con ceros a la izquierda incluidos', () => {
  for (let i = 0; i < 200; i += 1) {
    const code = generateCode(6);
    assert.match(code, /^\d{6}$/);
  }
});

test('los codigos no se repiten en serie (no es un contador ni una constante)', () => {
  const vistos = new Set(Array.from({ length: 300 }, () => generateCode(6)));
  assert.ok(vistos.size > 250, `demasiadas repeticiones: ${vistos.size}/300`);
});

test('generateCode rechaza largos absurdos', () => {
  for (const n of [0, 3, 11, 1.5, '6', null]) {
    assert.throws(() => generateCode(n), RangeError, `largo: ${String(n)}`);
  }
});

// --- hashing y comparacion ------------------------------------------------

test('el hash liga el codigo al destino: el mismo codigo en otro numero no vale', () => {
  const a = hashCode('123456', '7871234567', SECRET);
  const b = hashCode('123456', '7879999999', SECRET);
  assert.notEqual(a, b);
});

test('el hash no deja ver el codigo', () => {
  const hash = hashCode('123456', '7871234567', SECRET);
  assert.ok(!hash.includes('123456'));
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test('hashCode exige secreto', () => {
  assert.throws(() => hashCode('123456', '7871234567', ''), TypeError);
});

test('safeEqual compara bien y tolera largos distintos', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcdef'), false);
  assert.equal(safeEqual('', ''), true);
});

test('la clave del almacen no guarda el telefono en claro', () => {
  const key = challengeKey('sms', '7871234567', SECRET);
  assert.ok(!key.includes('7871234567'));
  // Y el mismo destino escrito distinto da la misma clave.
  assert.equal(challengeKey('sms', ' 7871234567 ', SECRET), key);
});

// --- construccion ---------------------------------------------------------

test('exige un otpPort y un secreto decente', () => {
  assert.throws(() => createOtpService({ secret: SECRET }), TypeError);
  assert.throws(
    () => createOtpService({ otpPort: { send: async () => {} }, secret: 'corto' }),
    TypeError
  );
});

// --- request --------------------------------------------------------------

test('requestCode NUNCA devuelve el codigo', async () => {
  const { service, spy } = buildService();
  const res = await service.requestCode(DESTINO);

  assert.equal(res.result, RequestResult.SENT);
  assert.equal(res.expiresInSeconds, DEFAULT_CONFIG.ttlSeconds);
  // El codigo si llego al puerto de entrega...
  assert.match(spy.ultimoCodigo, /^\d{6}$/);
  // ...pero no aparece por ningun lado en la respuesta.
  assert.ok(!JSON.stringify(res).includes(spy.ultimoCodigo));
  assert.deepEqual(Object.keys(res).sort(), ['expiresInSeconds', 'result']);
});

test('el almacen guarda el hash, no el codigo', async () => {
  const store = createInMemoryOtpStore();
  const spy = spyOtpPort();
  const service = createOtpService({ otpPort: spy.port, secret: SECRET, store });
  await service.requestCode(DESTINO);

  const key = challengeKey('sms', DESTINO.destination, SECRET);
  const record = await store.get(key);
  assert.ok(!JSON.stringify(record).includes(spy.ultimoCodigo));
  assert.match(record.codeHash, /^[0-9a-f]{64}$/);
});

test('reenviar antes del cooldown no manda otro SMS', async () => {
  const { service, spy, avanzar } = buildService();
  await service.requestCode(DESTINO);

  const res = await service.requestCode(DESTINO);
  assert.equal(res.result, RequestResult.COOLDOWN);
  assert.ok(res.retryAfterSeconds > 0);
  assert.equal(spy.entregas.length, 1, 'no debe entregar de nuevo');

  avanzar(DEFAULT_CONFIG.resendCooldownSeconds);
  assert.equal((await service.requestCode(DESTINO)).result, RequestResult.SENT);
  assert.equal(spy.entregas.length, 2);
});

test('tope de envios por reto: no se puede usar como ametralladora de SMS', async () => {
  const { service, spy, avanzar } = buildService();
  for (let i = 0; i < DEFAULT_CONFIG.maxSendsPerChallenge; i += 1) {
    assert.equal((await service.requestCode(DESTINO)).result, RequestResult.SENT);
    avanzar(DEFAULT_CONFIG.resendCooldownSeconds);
  }
  const res = await service.requestCode(DESTINO);
  assert.equal(res.result, RequestResult.TOO_MANY_SENDS);
  assert.equal(spy.entregas.length, DEFAULT_CONFIG.maxSendsPerChallenge);
});

// --- verify ---------------------------------------------------------------

test('el codigo correcto verifica', async () => {
  const { service, spy } = buildService();
  await service.requestCode(DESTINO);
  const res = await service.verifyCode({ ...DESTINO, code: spy.ultimoCodigo });
  assert.equal(res.result, VerifyResult.OK);
});

test('el codigo se consume: no sirve dos veces', async () => {
  const { service, spy } = buildService();
  await service.requestCode(DESTINO);
  const code = spy.ultimoCodigo;

  assert.equal((await service.verifyCode({ ...DESTINO, code })).result, VerifyResult.OK);
  assert.equal(
    (await service.verifyCode({ ...DESTINO, code })).result,
    VerifyResult.NOT_FOUND
  );
});

test('un codigo de otro destino no vale', async () => {
  const { service, spy } = buildService();
  await service.requestCode(DESTINO);
  const res = await service.verifyCode({
    channel: 'sms',
    destination: '7879999999',
    code: spy.ultimoCodigo,
  });
  assert.equal(res.result, VerifyResult.NOT_FOUND);
});

test('el codigo expira con el TTL', async () => {
  const { service, spy, avanzar } = buildService();
  await service.requestCode(DESTINO);
  const code = spy.ultimoCodigo;

  avanzar(DEFAULT_CONFIG.ttlSeconds - 1);
  // Todavia vive: se comprueba sin gastarlo mediante un codigo malo.
  assert.equal(
    (await service.verifyCode({ ...DESTINO, code: '000000' })).result,
    VerifyResult.INVALID
  );

  avanzar(2);
  // Vencido, el codigo bueno ya no sirve. El motivo exacto depende del
  // almacen: con TTL nativo (Redis, o el de memoria) el registro simplemente
  // ya no esta y sale NOT_FOUND; con un almacen sin expiracion automatica
  // (una tabla SQL sin job de limpieza) la comprobacion de `expiresAt` dentro
  // de verifyCode devuelve EXPIRED. Para el cliente los dos significan lo
  // mismo: pide un codigo nuevo.
  const res = await service.verifyCode({ ...DESTINO, code });
  assert.ok(
    [VerifyResult.EXPIRED, VerifyResult.NOT_FOUND].includes(res.result),
    `esperaba expirado o inexistente, salio: ${res.result}`
  );
  assert.notEqual(res.result, VerifyResult.OK);
});

test('verifyCode expira por su cuenta si el almacen no lo hace', async () => {
  // Defensa en profundidad: un almacen sin TTL (tabla SQL) devolveria el
  // registro vencido. verifyCode no debe aceptarlo.
  let reloj = 0;
  const vencidos = new Map();
  const storeSinTtl = {
    async get(key) { return vencidos.get(key) ?? null; },
    async set(key, record) { vencidos.set(key, record); },
    async delete(key) { vencidos.delete(key); },
  };
  const spy = spyOtpPort();
  const service = createOtpService({
    otpPort: spy.port,
    secret: SECRET,
    store: storeSinTtl,
    now: () => reloj,
  });

  await service.requestCode(DESTINO);
  reloj += (DEFAULT_CONFIG.ttlSeconds + 1) * 1000;

  const res = await service.verifyCode({ ...DESTINO, code: spy.ultimoCodigo });
  assert.equal(res.result, VerifyResult.EXPIRED);
  assert.equal(vencidos.size, 0, 'y lo borra al detectarlo');
});

test('verificar sin haber pedido codigo no revela nada', async () => {
  const { service } = buildService();
  const res = await service.verifyCode({ ...DESTINO, code: '123456' });
  assert.equal(res.result, VerifyResult.NOT_FOUND);
  assert.equal(res.remainingAttempts, undefined);
});

test('cada fallo descuenta intentos y al agotarlos bloquea', async () => {
  const { service } = buildService();
  await service.requestCode(DESTINO);

  for (let i = 1; i < DEFAULT_CONFIG.maxAttempts; i += 1) {
    const res = await service.verifyCode({ ...DESTINO, code: '000000' });
    assert.equal(res.result, VerifyResult.INVALID);
    assert.equal(res.remainingAttempts, DEFAULT_CONFIG.maxAttempts - i);
  }

  const bloqueo = await service.verifyCode({ ...DESTINO, code: '000000' });
  assert.equal(bloqueo.result, VerifyResult.LOCKED);
  assert.equal(bloqueo.retryAfterSeconds, DEFAULT_CONFIG.lockoutSeconds);
});

test('bloqueado, ni el codigo bueno pasa', async () => {
  const { service, spy } = buildService();
  await service.requestCode(DESTINO);
  const code = spy.ultimoCodigo;

  for (let i = 0; i < DEFAULT_CONFIG.maxAttempts; i += 1) {
    await service.verifyCode({ ...DESTINO, code: '000000' });
  }
  assert.equal((await service.verifyCode({ ...DESTINO, code })).result, VerifyResult.LOCKED);
});

test('el bloqueo se levanta al vencer, no antes', async () => {
  const { service, avanzar } = buildService();
  await service.requestCode(DESTINO);
  for (let i = 0; i < DEFAULT_CONFIG.maxAttempts; i += 1) {
    await service.verifyCode({ ...DESTINO, code: '000000' });
  }

  avanzar(DEFAULT_CONFIG.lockoutSeconds - 1);
  assert.equal(
    (await service.verifyCode({ ...DESTINO, code: '000000' })).result,
    VerifyResult.LOCKED
  );

  avanzar(2);
  const res = await service.verifyCode({ ...DESTINO, code: '000000' });
  assert.equal(res.result, VerifyResult.NOT_FOUND, 'vencido el bloqueo, el reto ya no existe');
});

test('bloqueado, tampoco se puede pedir codigo nuevo', async () => {
  const { service, spy, avanzar } = buildService();
  await service.requestCode(DESTINO);
  for (let i = 0; i < DEFAULT_CONFIG.maxAttempts; i += 1) {
    await service.verifyCode({ ...DESTINO, code: '000000' });
  }
  avanzar(DEFAULT_CONFIG.resendCooldownSeconds + 1);

  const res = await service.requestCode(DESTINO);
  assert.equal(res.result, RequestResult.LOCKED);
  assert.equal(spy.entregas.length, 1, 'no debe entregar estando bloqueado');
});

test('reenviar NO regala intentos', async () => {
  // Si al pedir codigo nuevo se reiniciara el contador, el lockout no serviria:
  // bastaria con pedir otro cada cuatro fallos.
  const { service, avanzar } = buildService();
  await service.requestCode(DESTINO);
  for (let i = 0; i < DEFAULT_CONFIG.maxAttempts - 1; i += 1) {
    await service.verifyCode({ ...DESTINO, code: '000000' });
  }

  avanzar(DEFAULT_CONFIG.resendCooldownSeconds);
  assert.equal((await service.requestCode(DESTINO)).result, RequestResult.SENT);

  const res = await service.verifyCode({ ...DESTINO, code: '000000' });
  assert.equal(res.result, VerifyResult.LOCKED, 'el intento numero 5 debe bloquear igual');
});

test('el codigo nuevo invalida el anterior', async () => {
  const { service, spy, avanzar } = buildService();
  await service.requestCode(DESTINO);
  const viejo = spy.ultimoCodigo;

  avanzar(DEFAULT_CONFIG.resendCooldownSeconds);
  await service.requestCode(DESTINO);
  const nuevo = spy.ultimoCodigo;
  assert.notEqual(viejo, nuevo);

  assert.equal(
    (await service.verifyCode({ ...DESTINO, code: viejo })).result,
    VerifyResult.INVALID
  );
  assert.equal((await service.verifyCode({ ...DESTINO, code: nuevo })).result, VerifyResult.OK);
});

test('verifyCode tolera codigos ausentes o de tipo raro', async () => {
  const { service } = buildService();
  await service.requestCode(DESTINO);
  for (const code of [undefined, null, '', 123456, {}]) {
    const res = await service.verifyCode({ ...DESTINO, code });
    assert.ok(
      [VerifyResult.INVALID, VerifyResult.LOCKED].includes(res.result),
      `code: ${String(code)} -> ${res.result}`
    );
  }
});

// --- almacen --------------------------------------------------------------

test('el almacen olvida los retos vencidos', async () => {
  let reloj = 0;
  const store = createInMemoryOtpStore({ now: () => reloj });
  await store.set('k', { codeHash: 'x', expiresAt: 1000, attempts: 0, sends: 1, lastSentAt: 0 });

  reloj = 999;
  assert.ok(await store.get('k'));
  reloj = 1001;
  assert.equal(await store.get('k'), null);
});

test('un reto bloqueado sobrevive al vencimiento del codigo', async () => {
  // Si no, esperar el TTL limpiaria el lockout y el atacante seguiria probando.
  let reloj = 0;
  const store = createInMemoryOtpStore({ now: () => reloj });
  await store.set('k', {
    codeHash: 'x',
    expiresAt: 1000,
    attempts: 5,
    sends: 1,
    lastSentAt: 0,
    lockedUntil: 5000,
  });

  reloj = 2000;
  const record = await store.get('k');
  assert.ok(record, 'el bloqueo debe seguir vivo');
  assert.equal(record.lockedUntil, 5000);

  reloj = 5001;
  assert.equal(await store.get('k'), null);
});

test('el almacen no crece sin limite: hay tope duro de entradas', async () => {
  // Sin tope, rotar destinos dentro de la ventana de TTL agota la memoria.
  const store = createInMemoryOtpStore({ now: () => 0, maxEntries: 10 });
  for (let i = 0; i < 50; i += 1) {
    await store.set(`k${i}`, {
      codeHash: 'x', expiresAt: 1_000_000, attempts: 0, sends: 1, lastSentAt: 0,
    });
  }
  assert.ok(store.size <= 10, `tamano: ${store.size}`);
});

test('el secreto del HMAC no puede ser mas corto que su salida', () => {
  const otpPort = { send: async () => ({}) };
  assert.throws(() => createOtpService({ otpPort, secret: 'a'.repeat(31) }), TypeError);
  assert.doesNotThrow(() => createOtpService({ otpPort, secret: 'a'.repeat(32) }));
});
