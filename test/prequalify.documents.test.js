'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const docs = require('../lib/prequalify/documents');

/**
 * Estos tests son, sobre todo, tests de seguridad. El modulo existe porque el
 * legacy guardaba en S3 con la clave `= $file_name` del cliente
 * (`upload_and_analyze.php:46`), que es el IDOR que encontro la auditoria.
 * Cada bloque de abajo reproduce un ataque concreto.
 */

// Dos leads reales de Salesforce (18 caracteres). Se usan siempre los mismos
// para que el "acceso cruzado" se lea de un vistazo.
const LEAD_A = '00Q1t000005AbCdEAK';
const LEAD_B = '00Q1t000009ZzYyXWV';

const PDF_BYTES = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'binary');
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

function keyFor(leadId, overrides = {}) {
  return docs.buildDocumentKey({
    leadId,
    kind: docs.DocumentKind.PAYSTUB,
    contentType: 'application/pdf',
    fileName: 'talonario.pdf',
    docId: 'aaaabbbbccccdddd',
    ...overrides,
  }).key;
}

// ---------------------------------------------------------------------------
// Esquema de claves
// ---------------------------------------------------------------------------

test('la clave lleva el prefijo de dueno derivado del lead', () => {
  const key = keyFor(LEAD_A);
  assert.ok(key.startsWith(`ulead${LEAD_A}__`), key);
  assert.equal(docs.ownerPrefix(LEAD_A), `ulead${LEAD_A}__`);
});

test('la clave se puede volver a leer entera', () => {
  const parsed = docs.parseDocumentKey(keyFor(LEAD_A));
  assert.deepEqual(parsed, {
    ownerId: `lead${LEAD_A}`,
    leadId: LEAD_A,
    kind: 'paystub',
    docId: 'aaaabbbbccccdddd',
    slug: 'talonario',
    extension: 'pdf',
  });
});

test('sin nombre de archivo la clave sigue siendo valida (el slug es opcional)', () => {
  const { key } = docs.buildDocumentKey({
    leadId: LEAD_A,
    kind: 'licence',
    contentType: 'image/jpeg',
    docId: 'aaaabbbbccccdddd',
  });
  assert.equal(key, `ulead${LEAD_A}__licence_aaaabbbbccccdddd.jpg`);
  assert.ok(docs.keyBelongsToLead(key, LEAD_A));
});

test('cada subida sin docId explicito recibe un id distinto e impredecible', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) ids.add(docs.generateDocumentId());
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[a-f0-9]{32}$/);
});

// ---------------------------------------------------------------------------
// ATAQUE: path traversal por el nombre de archivo
// ---------------------------------------------------------------------------

test('ATAQUE path traversal: el nombre del cliente nunca produce una ruta', () => {
  const payloads = [
    '../../etc/passwd',
    '..\\..\\windows\\win.ini',
    '/etc/shadow',
    'C:\\Windows\\System32\\config\\SAM',
    '....//....//secreto.pdf',
    './../../../../root/.ssh/id_rsa',
    'talonario/../../../otro-lead.pdf',
    '..%2f..%2fetc%2fpasswd',
    'a/b/c/d/e.pdf',
  ];

  for (const payload of payloads) {
    const { key } = docs.buildDocumentKey({
      leadId: LEAD_A,
      kind: 'other',
      contentType: 'application/pdf',
      fileName: payload,
      docId: 'aaaabbbbccccdddd',
    });

    assert.ok(!key.includes('/'), `separador / en la clave: ${key}`);
    assert.ok(!key.includes('\\'), `separador \\ en la clave: ${key}`);
    assert.ok(!key.includes('..'), `".." en la clave: ${key}`);
    assert.ok(key.startsWith(`ulead${LEAD_A}__`), `prefijo perdido: ${key}`);
    assert.ok(docs.keyBelongsToLead(key, LEAD_A), key);
  }
});

test('ATAQUE byte nulo: no sobrevive al saneado', () => {
  // "foto.pdf\0.php": una capa en C corta en el nulo y ve otra extension.
  const nombre = 'foto.pdf\u0000.php';
  assert.ok(!docs.sanitizeFileName(nombre).includes('\u0000'));

  const { key } = docs.buildDocumentKey({
    leadId: LEAD_A,
    kind: 'licence',
    contentType: 'application/pdf',
    fileName: nombre,
    docId: 'aaaabbbbccccdddd',
  });
  assert.ok(!key.includes('\u0000'));
  assert.ok(key.endsWith('.pdf'));
});

test('ATAQUE extension: la extension sale del MIME validado, no del nombre', () => {
  const { key, extension } = docs.buildDocumentKey({
    leadId: LEAD_A,
    kind: 'other',
    contentType: 'application/pdf',
    fileName: 'shell.php',
    docId: 'aaaabbbbccccdddd',
  });
  assert.equal(extension, 'pdf');
  assert.ok(key.endsWith('.pdf'), key);
  assert.ok(!key.includes('.php'), key);
});

test('sanitizeFileName: casos concretos', () => {
  assert.equal(docs.sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.equal(docs.sanitizeFileName('..\\..\\win.ini'), 'win.ini');
  assert.equal(docs.sanitizeFileName('C:\\ruta\\licencia.PDF'), 'licencia.PDF');
  assert.equal(docs.sanitizeFileName('.htaccess'), 'htaccess');
  assert.equal(docs.sanitizeFileName('talonario enero 2026.pdf'), 'talonario-enero-2026.pdf');
  assert.equal(docs.sanitizeFileName('../'), '');
  assert.equal(docs.sanitizeFileName(''), '');
  assert.equal(docs.sanitizeFileName(null), '');
  assert.equal(docs.sanitizeFileName(undefined), '');
  // Nada de comillas ni CR/LF: esto acaba en un Content-Disposition.
  assert.ok(!docs.sanitizeFileName('a";b\r\nX: y.pdf').includes('"'));
  assert.ok(!/[\r\n]/.test(docs.sanitizeFileName('a\r\nb.pdf')));
});

// ---------------------------------------------------------------------------
// ATAQUE: leadId manipulado
// ---------------------------------------------------------------------------

test('ATAQUE leadId: solo se acepta alfanumerico', () => {
  const malos = [
    '../otro',
    '00Q1/00Q2',
    '00Q1..',
    '00Q1__paystub',       // intentar inyectar el separador
    '00Q1-2',
    '00Q1.2',
    '00Q1 ',
    '',
    null,
    undefined,
    123,
    { toString: () => '00Q1' },
    'a'.repeat(65),
  ];
  for (const leadId of malos) {
    assert.throws(
      () => docs.assertLeadId(leadId),
      (err) => err instanceof docs.DocumentValidationError && err.status === 400,
      `deberia rechazar: ${String(leadId)}`
    );
  }
  assert.equal(docs.assertLeadId(LEAD_A), LEAD_A);
});

// ---------------------------------------------------------------------------
// ATAQUE: IDOR cruzado entre leads
// ---------------------------------------------------------------------------

test('ATAQUE IDOR: la clave de un lead no pertenece a otro', () => {
  const keyA = keyFor(LEAD_A);
  const keyB = keyFor(LEAD_B);

  assert.ok(docs.keyBelongsToLead(keyA, LEAD_A));
  assert.ok(docs.keyBelongsToLead(keyB, LEAD_B));

  assert.equal(docs.keyBelongsToLead(keyA, LEAD_B), false);
  assert.equal(docs.keyBelongsToLead(keyB, LEAD_A), false);
});

test('ATAQUE IDOR: assertKeyBelongsToLead lanza 403 con mensaje generico', () => {
  const keyA = keyFor(LEAD_A);
  assert.throws(
    () => docs.assertKeyBelongsToLead(keyA, LEAD_B),
    (err) => {
      assert.ok(err instanceof docs.DocumentAccessError);
      assert.equal(err.status, 403);
      // El cliente no debe poder distinguir "no es tuya" de "no existe": si no,
      // el 403 sirve para enumerar claves.
      assert.equal(err.publicMessage, 'No autorizado para este recurso.');
      assert.ok(!err.publicMessage.includes(LEAD_A));
      assert.ok(!err.publicMessage.includes(keyA));
      return true;
    }
  );
  // El camino feliz devuelve la clave.
  assert.equal(docs.assertKeyBelongsToLead(keyA, LEAD_A), keyA);
});

test('ATAQUE IDOR: un prefijo parcial no cuela (por eso el separador es "__")', () => {
  const corto = docs.buildDocumentKey({
    leadId: '00Q1',
    kind: 'paystub',
    contentType: 'application/pdf',
    docId: 'aaaabbbbccccdddd',
  }).key;
  const largo = docs.buildDocumentKey({
    leadId: '00Q12',
    kind: 'paystub',
    contentType: 'application/pdf',
    docId: 'aaaabbbbccccdddd',
  }).key;

  assert.equal(docs.keyBelongsToLead(corto, '00Q12'), false);
  assert.equal(docs.keyBelongsToLead(largo, '00Q1'), false);
  // Y el prefijo de listado tampoco solapa.
  assert.ok(!largo.startsWith(docs.ownerPrefix('00Q1')));
});

test('ATAQUE IDOR: la comparacion respeta mayusculas (los Id de SF de 15 son case-sensitive)', () => {
  const key = keyFor('00Q1t000005AbCdE');
  assert.ok(docs.keyBelongsToLead(key, '00Q1t000005AbCdE'));
  assert.equal(docs.keyBelongsToLead(key, '00q1t000005abcde'), false);
});

test('ATAQUE IDOR: claves con ruta, ".." o forma ajena no pertenecen a nadie', () => {
  const ajenas = [
    `otra-carpeta/ulead${LEAD_A}__paystub_aaaabbbbccccdddd.pdf`,
    `../ulead${LEAD_A}__paystub_aaaabbbbccccdddd.pdf`,
    `ulead${LEAD_A}__paystub_aaaabbbbccccdddd.pdf/../../secreto`,
    'talonario.pdf',                       // clave legacy suelta
    'u005XX0000012345__doc_aaaabbbbccccdddd.pdf', // clave de usuario del app
    `ulead${LEAD_A}_paystub_aaaabbbbccccdddd.pdf`, // un solo guion bajo
    `ulead${LEAD_A}__ejecutable_aaaabbbbccccdddd.pdf`, // kind inventado
    `ulead${LEAD_A}__paystub_ZZZZ.pdf`,    // docId no hexadecimal
    '',
    null,
    42,
  ];
  for (const key of ajenas) {
    assert.equal(docs.parseDocumentKey(key), null, `deberia no parsear: ${String(key)}`);
    assert.equal(docs.keyBelongsToLead(key, LEAD_A), false, `no deberia pertenecer: ${String(key)}`);
  }
});

test('filterKeysForLead descarta las claves ajenas aunque el listado venga sucio', () => {
  const mias = [keyFor(LEAD_A), keyFor(LEAD_A, { kind: 'licence', contentType: 'image/png' })];
  const ajenas = [keyFor(LEAD_B), 'talonario_de_otro.pdf', null];

  const resultado = docs.filterKeysForLead([...mias, ...ajenas], LEAD_A);
  assert.equal(resultado.length, 2);
  assert.deepEqual(resultado.map((d) => d.key).sort(), [...mias].sort());
  assert.deepEqual(resultado.map((d) => d.kind).sort(), ['licence', 'paystub']);

  // Tambien acepta la forma {key} que devuelve S3.
  assert.equal(docs.filterKeysForLead([{ key: keyFor(LEAD_B) }], LEAD_A).length, 0);
  assert.deepEqual(docs.filterKeysForLead('no es un array', LEAD_A), []);
});

// ---------------------------------------------------------------------------
// Compatibilidad con el patron anti-IDOR de la Fase 0 (app.js)
// ---------------------------------------------------------------------------

test('la clave casa con OWNED_KEY_REGEX de la Fase 0, y su dueno nunca es un sfUserId', () => {
  // Copia literal de app.js:425.
  const OWNED_KEY_REGEX = /^u([A-Za-z0-9]+)__/;

  const key = keyFor(LEAD_A);
  const match = OWNED_KEY_REGEX.exec(key);

  // Que case importa: si NO casara, `authorizeKeyOwnership` la trataria como
  // "clave legacy" y la dejaria pasar por grandfathering (app.js:439-442).
  assert.ok(match, 'la clave debe casar con el regex de la Fase 0');
  assert.equal(match[1], `lead${LEAD_A}`);

  // Un sfUserId de Salesforce empieza por '005' y nunca por 'lead', asi que
  // `/downloadFile` responde 403 a un documento de precualificacion.
  assert.notEqual(match[1], '005XX000001Sv6DYAS');
  assert.ok(match[1].startsWith('lead'));
});

test('la clave sobrevive intacta a sanitizeFilename de app.js (es idempotente)', () => {
  // Copia literal de app.js:413-420.
  const sanitizeFilename = (filename) =>
    filename
      .replace(/\.\./g, '')
      .replace(/[\/\\]/g, '_') // eslint-disable-line no-useless-escape
      .replace(/[^\w\s.\-()]/g, '_')
      .trim();

  for (const kind of docs.DOCUMENT_KINDS) {
    const key = keyFor(LEAD_A, { kind, fileName: 'talonario enero.pdf' });
    assert.equal(sanitizeFilename(key), key, `se corrompe al pasar por app.js: ${key}`);
  }
});

// ---------------------------------------------------------------------------
// Tipo MIME
// ---------------------------------------------------------------------------

test('lista blanca de tipos: PDF e imagenes, nada mas', () => {
  for (const tipo of Object.keys(docs.ALLOWED_CONTENT_TYPES)) {
    assert.ok(docs.isAllowedContentType(tipo), tipo);
  }
  const prohibidos = [
    'application/x-php',
    'text/html',
    'image/svg+xml',       // SVG es HTML disfrazado: XSS si el bucket lo sirve
    'application/zip',
    'application/octet-stream',
    'text/plain',
    'application/msword',
    '',
    null,
    undefined,
  ];
  for (const tipo of prohibidos) {
    assert.equal(docs.isAllowedContentType(tipo), false, String(tipo));
    assert.throws(() => docs.extensionFor(tipo), docs.DocumentValidationError);
  }
});

test('el MIME se normaliza: mayusculas y parametros', () => {
  assert.equal(docs.normalizeContentType('IMAGE/JPEG; charset=binary'), 'image/jpeg');
  assert.equal(docs.extensionFor('  Application/PDF  '), 'pdf');
  assert.equal(docs.extensionFor('image/jpeg;boundary=x'), 'jpg');
});

test('kind: solo los tres del contrato del puerto', () => {
  for (const kind of ['licence', 'paystub', 'other']) {
    assert.equal(docs.assertDocumentKind(kind), kind);
  }
  for (const kind of ['licencia', 'Paystub', '../other', '', null, undefined]) {
    assert.throws(() => docs.assertDocumentKind(kind), docs.DocumentValidationError);
  }
});

// ---------------------------------------------------------------------------
// Tamano
// ---------------------------------------------------------------------------

test('tamano: se rechaza el archivo vacio y el que pasa del tope', () => {
  const base = { kind: 'paystub', contentType: 'application/pdf', fileName: 'a.pdf' };

  assert.throws(() => docs.validateUpload({ ...base, size: 0 }), docs.DocumentValidationError);
  assert.throws(
    () => docs.validateUpload({ ...base, size: docs.MAX_FILE_BYTES + 1 }),
    docs.DocumentValidationError
  );
  assert.throws(() => docs.validateUpload({ ...base, size: -1 }), docs.DocumentValidationError);
  assert.throws(() => docs.validateUpload({ ...base, size: 1.5 }), docs.DocumentValidationError);
  assert.throws(() => docs.validateUpload({ ...base }), docs.DocumentValidationError);

  assert.equal(docs.validateUpload({ ...base, size: 1 }).size, 1);
  assert.equal(
    docs.validateUpload({ ...base, size: docs.MAX_FILE_BYTES }).size,
    docs.MAX_FILE_BYTES
  );
});

test('el tope es MUY inferior al del legacy (150 MB) y al del multer de app.js (200 MB)', () => {
  assert.ok(docs.MAX_FILE_BYTES < 150 * 1024 * 1024);
  assert.ok(docs.MAX_FILE_BYTES <= 25 * 1024 * 1024);
});

test('cuota por lead', () => {
  assert.doesNotThrow(() => docs.assertWithinLeadQuota(0));
  assert.doesNotThrow(() => docs.assertWithinLeadQuota(docs.MAX_DOCUMENTS_PER_LEAD - 1));
  assert.throws(
    () => docs.assertWithinLeadQuota(docs.MAX_DOCUMENTS_PER_LEAD),
    docs.DocumentValidationError
  );
  assert.throws(() => docs.assertWithinLeadQuota(-1), docs.DocumentValidationError);
  assert.throws(() => docs.assertWithinLeadQuota('muchos'), docs.DocumentValidationError);
});

// ---------------------------------------------------------------------------
// ATAQUE: contenido que no coincide con el tipo declarado
// ---------------------------------------------------------------------------

test('sniffContentType reconoce las firmas reales', () => {
  assert.equal(docs.sniffContentType(PDF_BYTES), 'application/pdf');
  assert.equal(docs.sniffContentType(PNG_BYTES), 'image/png');
  assert.equal(docs.sniffContentType(JPEG_BYTES), 'image/jpeg');
  assert.equal(docs.sniffContentType(Buffer.from('<?php system($_GET[0]); ?>')), null);
  assert.equal(docs.sniffContentType(Buffer.alloc(0)), null);
  assert.equal(docs.sniffContentType(null), null);
});

test('ATAQUE tipo falseado: un PHP declarado como PDF se rechaza', () => {
  assert.throws(
    () =>
      docs.validateUpload({
        kind: 'paystub',
        contentType: 'application/pdf',
        fileName: 'talonario.pdf',
        bytes: Buffer.from('<?php system($_GET["c"]); ?>'),
      }),
    (err) => err instanceof docs.DocumentValidationError && err.status === 400
  );
});

test('ATAQUE tipo falseado: un PNG declarado como PDF se rechaza', () => {
  assert.throws(
    () =>
      docs.validateUpload({
        kind: 'licence',
        contentType: 'application/pdf',
        bytes: PNG_BYTES,
      }),
    docs.DocumentValidationError
  );
});

test('la firma real y el tipo declarado deben coincidir (HEIC y HEIF son el mismo contenedor)', () => {
  const heic = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypheic'),
  ]);
  for (const declarado of ['image/heic', 'image/heif']) {
    const resultado = docs.validateUpload({
      kind: 'licence',
      contentType: declarado,
      bytes: heic,
    });
    assert.equal(resultado.contentType, declarado);
    assert.equal(resultado.needsConversionForOcr, true);
  }
  assert.equal(
    docs.validateUpload({ kind: 'paystub', contentType: 'application/pdf', bytes: PDF_BYTES })
      .needsConversionForOcr,
    false
  );
});

test('sin bytes no se comprueba la firma (subida en dos fases)', () => {
  const resultado = docs.validateUpload({
    kind: 'paystub',
    contentType: 'application/pdf',
    size: 1024,
  });
  assert.equal(resultado.extension, 'pdf');
});

// ---------------------------------------------------------------------------
// prepareUpload: el camino completo que usa el puerto
// ---------------------------------------------------------------------------

test('prepareUpload valida y devuelve la clave en un solo paso', () => {
  const resultado = docs.prepareUpload({
    leadId: LEAD_A,
    kind: 'paystub',
    contentType: 'image/jpeg',
    fileName: '../../talonario de enero.JPG',
    bytes: JPEG_BYTES,
    docId: 'aaaabbbbccccdddd',
  });

  assert.equal(resultado.key, `ulead${LEAD_A}__paystub_aaaabbbbccccdddd_talonario-de-enero.jpg`);
  assert.equal(resultado.extension, 'jpg');
  assert.equal(resultado.size, JPEG_BYTES.length);
  assert.equal(resultado.safeFileName, 'talonario-de-enero.JPG');
  assert.ok(docs.keyBelongsToLead(resultado.key, LEAD_A));
  assert.equal(docs.keyBelongsToLead(resultado.key, LEAD_B), false);
});

test('prepareUpload falla antes de construir clave si el lead es invalido', () => {
  assert.throws(
    () =>
      docs.prepareUpload({
        leadId: '../otro',
        kind: 'paystub',
        contentType: 'application/pdf',
        bytes: PDF_BYTES,
      }),
    docs.DocumentValidationError
  );
});

test('docId invalido se rechaza (no se puede inyectar estructura por ahi)', () => {
  for (const docId of ['aaaa', 'ZZZZaaaabbbbcccc', '../../x', 'aaaabbbbccccdddd_extra', '']) {
    assert.throws(
      () =>
        docs.buildDocumentKey({
          leadId: LEAD_A,
          kind: 'paystub',
          contentType: 'application/pdf',
          docId,
        }),
      docs.DocumentValidationError,
      `docId: ${docId}`
    );
  }
});
