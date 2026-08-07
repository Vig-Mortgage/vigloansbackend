'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  US_STATES,
  STATE_CODES,
  isValidStateCode,
  stateName,
  listStates,
} = require('../lib/geo/usStates');
const {
  normalizeZip,
  countryPathFor,
  createCache,
  createZipLookup,
} = require('../lib/geo/zipLookup');

// --- lista de estados -----------------------------------------------------

test('cubre los 50 estados + DC + 5 territorios + 3 codigos militares', () => {
  assert.equal(STATE_CODES.length, 59);
  assert.equal(Object.keys(US_STATES).length, 59);
});

test('acepta todo EEUU, no solo Puerto Rico', () => {
  for (const code of ['PR', 'FL', 'TX', 'NY', 'CA', 'HI', 'AK', 'DC', 'VI', 'GU', 'AE']) {
    assert.equal(isValidStateCode(code), true, `deberia aceptar ${code}`);
  }
});

test('rechaza codigos que no existen', () => {
  for (const code of ['ZZ', 'XX', 'QQ', '', 'P', 'PRR', 'Puerto Rico', null, undefined, 42]) {
    assert.equal(isValidStateCode(code), false, `deberia rechazar ${String(code)}`);
  }
});

test('isValidStateCode tolera minusculas y espacios', () => {
  assert.equal(isValidStateCode('pr'), true);
  assert.equal(isValidStateCode(' fl '), true);
});

test('stateName devuelve el nombre completo', () => {
  assert.equal(stateName('PR'), 'Puerto Rico');
  assert.equal(stateName('fl'), 'Florida');
  assert.equal(stateName('ZZ'), null);
});

test('listStates viene ordenada por nombre y sin huecos', () => {
  const list = listStates();
  assert.equal(list.length, STATE_CODES.length);
  const nombres = list.map((s) => s.name);
  assert.deepEqual(nombres, [...nombres].sort((a, b) => a.localeCompare(b, 'en')));
  assert.ok(list.every((s) => s.code && s.name));
});

// --- normalizacion de ZIP -------------------------------------------------

test('normalizeZip acepta 5 digitos y ZIP+4', () => {
  assert.equal(normalizeZip('00926'), '00926');
  assert.equal(normalizeZip('00926-1234'), '00926');
  assert.equal(normalizeZip(' 33101 '), '33101');
});

test('normalizeZip rechaza lo que no es ZIP', () => {
  for (const v of ['', '926', '123456', 'abcde', null, undefined, {}]) {
    assert.equal(normalizeZip(v), null, `valor: ${String(v)}`);
  }
});

// --- el detalle de Puerto Rico -------------------------------------------

test('los ZIP de PR van al pais `pr`: bajo `us` Zippopotam da 404', () => {
  for (const zip of ['00601', '00926', '00901', '00795', '00694']) {
    assert.equal(countryPathFor(zip), 'pr', `zip: ${zip}`);
  }
});

test('el resto de EEUU va al pais `us`', () => {
  for (const zip of ['33101', '10001', '90210', '00801' /* VI */]) {
    assert.equal(countryPathFor(zip), 'us', `zip: ${zip}`);
  }
});

// --- resolucion de ZIP ----------------------------------------------------

/** fetch falso que registra las URLs pedidas. */
function fakeFetch(rutas) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const entry = rutas[url];
    if (!entry) return { status: 404, json: async () => ({}) };
    if (entry instanceof Error) throw entry;
    return { status: entry.status ?? 200, json: async () => entry.body };
  };
  impl.calls = calls;
  return impl;
}

const RESPUESTA_SJ = {
  status: 200,
  body: {
    'post code': '00926',
    country: 'Puerto Rico',
    places: [{ 'place name': 'San Juan', state: 'Pr', 'state abbreviation': 'PR' }],
  },
};

test('resuelve un ZIP de PR contra el path correcto', async () => {
  const fetchImpl = fakeFetch({ 'https://api.zippopotam.us/pr/00926': RESPUESTA_SJ });
  const lookup = createZipLookup({ fetchImpl });

  assert.deepEqual(await lookup('00926'), {
    zipCode: '00926',
    city: 'San Juan',
    state: 'PR',
  });
  assert.deepEqual(fetchImpl.calls, ['https://api.zippopotam.us/pr/00926']);
});

test('resuelve un ZIP de estados', async () => {
  const fetchImpl = fakeFetch({
    'https://api.zippopotam.us/us/33101': {
      status: 200,
      body: { places: [{ 'place name': 'Miami', 'state abbreviation': 'FL' }] },
    },
  });
  const lookup = createZipLookup({ fetchImpl });
  assert.deepEqual(await lookup('33101'), {
    zipCode: '33101',
    city: 'Miami',
    state: 'FL',
  });
});

test('si Zippopotam manda un estado raro, cae al pais del path', async () => {
  // Su data de PR trae `state: "Pr"`; si faltara la abreviatura, PR igual sale.
  const fetchImpl = fakeFetch({
    'https://api.zippopotam.us/pr/00901': {
      status: 200,
      body: { places: [{ 'place name': 'San Juan', state: 'Pr' }] },
    },
  });
  const lookup = createZipLookup({ fetchImpl });
  assert.deepEqual(await lookup('00901'), {
    zipCode: '00901',
    city: 'San Juan',
    state: 'PR',
  });
});

test('un ZIP inexistente devuelve null y no revienta', async () => {
  const lookup = createZipLookup({ fetchImpl: fakeFetch({}) });
  assert.equal(await lookup('99999'), null);
});

test('un ZIP mal formado ni siquiera llama al servicio', async () => {
  const fetchImpl = fakeFetch({});
  const lookup = createZipLookup({ fetchImpl });
  assert.equal(await lookup('abc'), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('si el servicio se cae, degrada a null en vez de romper el wizard', async () => {
  const fetchImpl = fakeFetch({
    'https://api.zippopotam.us/us/33101': new Error('ECONNRESET'),
  });
  const lookup = createZipLookup({ fetchImpl });
  assert.equal(await lookup('33101'), null);
});

test('un 5xx no se cachea: se reintenta la proxima vez', async () => {
  let intentos = 0;
  const fetchImpl = async () => {
    intentos += 1;
    if (intentos === 1) return { status: 503, json: async () => ({}) };
    return {
      status: 200,
      json: async () => ({ places: [{ 'place name': 'Miami', 'state abbreviation': 'FL' }] }),
    };
  };
  const lookup = createZipLookup({ fetchImpl });
  assert.equal(await lookup('33101'), null);
  assert.deepEqual(await lookup('33101'), { zipCode: '33101', city: 'Miami', state: 'FL' });
  assert.equal(intentos, 2);
});

test('cachea los aciertos: no repite el request', async () => {
  const fetchImpl = fakeFetch({ 'https://api.zippopotam.us/pr/00926': RESPUESTA_SJ });
  const lookup = createZipLookup({ fetchImpl });
  await lookup('00926');
  await lookup('00926');
  await lookup('00926-4567'); // mismo ZIP con +4
  assert.equal(fetchImpl.calls.length, 1);
});

test('la cache expira segun el TTL', async () => {
  let ahora = 0;
  const fetchImpl = fakeFetch({ 'https://api.zippopotam.us/pr/00926': RESPUESTA_SJ });
  const lookup = createZipLookup({
    fetchImpl,
    now: () => ahora,
    cache: createCache({ ttlMs: 1000 }),
  });
  await lookup('00926');
  ahora = 999;
  await lookup('00926');
  assert.equal(fetchImpl.calls.length, 1, 'dentro del TTL no reconsulta');
  ahora = 1001;
  await lookup('00926');
  assert.equal(fetchImpl.calls.length, 2, 'vencido el TTL, reconsulta');
});

test('la cache no crece sin limite', async () => {
  const cache = createCache({ maxEntries: 2 });
  cache.set('a', 1, 0);
  cache.set('b', 2, 0);
  cache.set('c', 3, 0);
  assert.equal(cache.size, 2);
  assert.equal(cache.get('a', 0), undefined, 'se descarto la mas antigua');
  assert.equal(cache.get('c', 0), 3);
});
