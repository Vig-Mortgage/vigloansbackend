'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Readable } = require('node:stream');

const { notFoundHandler, errorHandler } = require('../middleware/errorHandler');
const { createPorts } = require('../lib/prequalify/ports');
const { createOtpService } = require('../lib/prequalify/otp');
const { createInMemoryOtpStore } = require('../lib/prequalify/otpStore');
const { createSessionManager } = require('../lib/prequalify/session');
const { createPrequalifyRouter } = require('../routes/prequalify');
const {
  prepareUpload,
  assertKeyBelongsToLead,
  assertWithinLeadQuota,
  listPrefixForLead,
  parseDocumentKey,
  generateDocumentId,
  MAX_DOCUMENTS_PER_LEAD,
} = require('../lib/prequalify/documents');

const SESSION_SECRET = 'secreto-de-sesion-de-precualificacion-largo';
const OTP_SECRET = 'secreto-del-otp-suficientemente-largo-tambien';

/** PDF minimo: la firma real, que es lo que `sniffContentType` mira. */
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0),
]);

/**
 * Puerto de documentos falso que NO se inventa las reglas.
 *
 * Usa los mismos helpers de `lib/prequalify/documents.js` que usa el adaptador
 * real: el esquema de claves, la cuota y la comprobacion de dueno son
 * identicas. Lo unico simulado es S3, que aqui es un Map.
 *
 * Es a proposito. En esta misma migracion, cuatro fallos distintos se colaron
 * porque el doble era mas permisivo que la pieza real. Un fake que aceptara
 * cualquier clave dejaria pasar precisamente el IDOR que estas pruebas existen
 * para vigilar.
 */
function fakeDocumentPort() {
  const objetos = new Map(); // clave -> {bytes, contentType}
  const clavesDe = (leadId) =>
    [...objetos.keys()].filter((k) => k.startsWith(listPrefixForLead(leadId)));

  return {
    _objetos: objetos,
    api: {
      async upload({ leadId, kind, fileName, contentType, bytes }) {
        assertWithinLeadQuota(clavesDe(leadId).length);
        const p = prepareUpload({
          leadId,
          kind,
          fileName,
          contentType,
          bytes,
          docId: generateDocumentId(),
        });
        objetos.set(p.key, { bytes, contentType: p.contentType });
        return { key: p.key };
      },
      async getDocument({ leadId, key }) {
        const clave = assertKeyBelongsToLead(key, leadId);
        const o = objetos.get(clave);
        if (!o) throw Object.assign(new Error('no existe'), { status: 404 });
        return {
          body: Readable.from([o.bytes]),
          contentType: o.contentType,
          contentLength: o.bytes.length,
        };
      },
      async listDocuments({ leadId }) {
        return clavesDe(leadId)
          .map((key) => ({ key, ...parseDocumentKey(key) }))
          .filter((d) => d.leadId === leadId)
          .map(({ key, kind, docId }) => ({ key, kind, docId }));
      },
    },
  };
}

function fakeSalesforce() {
  const leads = new Map();
  let seq = 0;
  return {
    leads,
    api: {
      findLeadByEmailOrPhone: async ({ email }) =>
        [...leads.values()].find((l) => l.email === email) ?? null,
      createLead: async (data) => {
        seq += 1;
        const lead = { id: `00Q${seq}`, completedSteps: [], ...data };
        leads.set(lead.id, lead);
        return { id: lead.id };
      },
      getLead: async (id) => leads.get(id) ?? null,
      updateLead: async () => {},
      setCurrentStep: async () => {},
    },
  };
}

function buildApp() {
  const sf = fakeSalesforce();
  const docs = fakeDocumentPort();
  const entregas = [];
  const ports = createPorts({
    salesforce: sf.api,
    document: docs.api,
    otp: {
      send: async (p) => {
        entregas.push(p);
        return {};
      },
    },
  });
  const otpService = createOtpService({
    otpPort: ports.otp,
    secret: OTP_SECRET,
    store: createInMemoryOtpStore(),
  });
  const sessions = createSessionManager({ secret: SESSION_SECRET });
  const app = express();
  app.use(express.json());
  app.use('/prequalify', createPrequalifyRouter({ ports, otpService, sessions }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return { app, sf, docs, entregas, sessions };
}

async function call(app, method, path, { body, token, form } = {}) {
  const srv = app.listen(0);
  const { port } = srv.address();
  try {
    const opts = { method, headers: {} };
    if (form) {
      opts.body = form;
    } else if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    if (token) opts.headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, opts);
    const buf = Buffer.from(await res.arrayBuffer());
    const texto = buf.toString('utf8');
    let json = null;
    try {
      json = texto ? JSON.parse(texto) : null;
    } catch {
      // respuesta binaria: se mira en `bytes`
    }
    return { status: res.status, headers: res.headers, body: json, bytes: buf };
  } finally {
    srv.close();
  }
}

function multipart(
  bytes,
  { kind = 'paystub', fileName = 'talonario.pdf', type = 'application/pdf' } = {}
) {
  const fd = new FormData();
  if (kind !== null) fd.set('kind', kind);
  fd.set('file', new Blob([bytes], { type }), fileName);
  return fd;
}

/** Sesion autenticada con lead creado. */
async function sesionCon(app, entregas, email, phone) {
  await call(app, 'POST', '/prequalify/otp', { body: { email, phone } });
  const ult = (canal) => [...entregas].reverse().find((e) => e.channel === canal)?.code;
  const v = await call(app, 'POST', '/prequalify/otp/verify', {
    body: { email, phone, emailCode: ult('email'), phoneCode: ult('sms') },
  });
  // El `leadId` sale de la verificacion del OTP, que es donde se crea o se
  // recupera el lead, no de `POST /leads` (ese completa el paso `start` y
  // devuelve la transicion, no el id).
  const { token, leadId } = v.body;
  await call(app, 'POST', '/prequalify/leads', {
    token,
    body: {
      email,
      phone,
      firstName: 'Juan',
      lastName: 'Del Valle',
      dob: '1985-06-15',
      loanPurpose: 'Compra',
    },
  });
  return { token, leadId };
}

// ---------------------------------------------------------------------------

test('sin sesion no se sube nada', async () => {
  const { app } = buildApp();
  const r = await call(app, 'POST', '/prequalify/leads/00Q1/documents', {
    form: multipart(PDF),
  });
  assert.equal(r.status, 401);
});

test('sube un documento y devuelve docId, nunca la clave de S3', async () => {
  const { app, entregas } = buildApp();
  const s = await sesionCon(app, entregas, 'juan@example.com', '7871234567');

  const r = await call(app, 'POST', `/prequalify/leads/${s.leadId}/documents`, {
    token: s.token,
    form: multipart(PDF),
  });

  assert.equal(r.status, 201);
  assert.match(r.body.docId, /^[a-f0-9]{32}$/);
  assert.equal(r.body.kind, 'paystub');
  // La clave lleva dentro el id del lead: es justo lo que no debe salir.
  assert.equal(r.body.key, undefined);
  assert.ok(!JSON.stringify(r.body).includes(s.leadId));
});

test('IDOR: una sesion no sube al lead de otro', async () => {
  const { app, entregas } = buildApp();
  const a = await sesionCon(app, entregas, 'a@example.com', '7871111111');
  const b = await sesionCon(app, entregas, 'b@example.com', '7872222222');

  const r = await call(app, 'POST', `/prequalify/leads/${b.leadId}/documents`, {
    token: a.token,
    form: multipart(PDF),
  });

  // 404 y no 403: un 403 confirmaria que el lead existe.
  assert.equal(r.status, 404);
});

test('IDOR: el docId de otro lead no se descarga', async () => {
  const { app, entregas } = buildApp();
  const a = await sesionCon(app, entregas, 'a@example.com', '7871111111');
  const b = await sesionCon(app, entregas, 'b@example.com', '7872222222');

  const subido = await call(app, 'POST', `/prequalify/leads/${b.leadId}/documents`, {
    token: b.token,
    form: multipart(PDF),
  });
  const docIdAjeno = subido.body.docId;

  // A conoce el docId de B y usa SU PROPIA ruta, que es el ataque realista:
  // la ruta resuelve la clave desde el lead de la sesion, asi que no encuentra.
  const r = await call(app, 'GET', `/prequalify/leads/${a.leadId}/documents/${docIdAjeno}`, {
    token: a.token,
  });
  assert.equal(r.status, 404);
});

test('lista solo los documentos del lead de la sesion', async () => {
  const { app, entregas } = buildApp();
  const a = await sesionCon(app, entregas, 'a@example.com', '7871111111');
  const b = await sesionCon(app, entregas, 'b@example.com', '7872222222');

  await call(app, 'POST', `/prequalify/leads/${a.leadId}/documents`, {
    token: a.token,
    form: multipart(PDF, { kind: 'paystub' }),
  });
  await call(app, 'POST', `/prequalify/leads/${b.leadId}/documents`, {
    token: b.token,
    form: multipart(PNG, { kind: 'licence', fileName: 'lic.png', type: 'image/png' }),
  });

  const r = await call(app, 'GET', `/prequalify/leads/${a.leadId}/documents`, { token: a.token });
  assert.equal(r.status, 200);
  assert.equal(r.body.documents.length, 1);
  assert.equal(r.body.documents[0].kind, 'paystub');
  assert.equal(r.body.documents[0].key, undefined);
  assert.equal(r.body.remaining, MAX_DOCUMENTS_PER_LEAD - 1);
});

test('descarga el propio documento, como adjunto y sin adivinar el tipo', async () => {
  const { app, entregas } = buildApp();
  const s = await sesionCon(app, entregas, 'juan@example.com', '7871234567');
  const subido = await call(app, 'POST', `/prequalify/leads/${s.leadId}/documents`, {
    token: s.token,
    form: multipart(PDF),
  });

  const r = await call(app, 'GET', `/prequalify/leads/${s.leadId}/documents/${subido.body.docId}`, {
    token: s.token,
  });

  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.equal(r.headers.get('content-disposition'), 'attachment');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(r.bytes.subarray(0, 5).equals(Buffer.from('%PDF-')));
});

test('rechaza un tipo de documento que no esta en el enum', async () => {
  const { app, entregas } = buildApp();
  const s = await sesionCon(app, entregas, 'juan@example.com', '7871234567');
  const r = await call(app, 'POST', `/prequalify/leads/${s.leadId}/documents`, {
    token: s.token,
    form: multipart(PDF, { kind: 'nomina' }),
  });
  assert.equal(r.status, 400);
});

test('acepta los tipos nuevos taxes y form1099r', async () => {
  const { app, entregas } = buildApp();
  const s = await sesionCon(app, entregas, 'juan@example.com', '7871234567');
  for (const kind of ['taxes', 'form1099r']) {
    const r = await call(app, 'POST', `/prequalify/leads/${s.leadId}/documents`, {
      token: s.token,
      form: multipart(PDF, { kind }),
    });
    assert.equal(r.status, 201, `${kind} deberia aceptarse`);
    assert.equal(r.body.kind, kind);
  }
});

test('rechaza un archivo cuyo contenido no es lo que dice el MIME', async () => {
  const { app, entregas } = buildApp();
  const s = await sesionCon(app, entregas, 'juan@example.com', '7871234567');
  // Se declara PDF pero los bytes son PNG.
  const r = await call(app, 'POST', `/prequalify/leads/${s.leadId}/documents`, {
    token: s.token,
    form: multipart(PNG, { kind: 'paystub', fileName: 'trampa.pdf', type: 'application/pdf' }),
  });
  assert.equal(r.status, 400);
});

test('sin archivo adjunto responde 400 y no 500', async () => {
  const { app, entregas } = buildApp();
  const s = await sesionCon(app, entregas, 'juan@example.com', '7871234567');
  const fd = new FormData();
  fd.set('kind', 'paystub');
  const r = await call(app, 'POST', `/prequalify/leads/${s.leadId}/documents`, {
    token: s.token,
    form: fd,
  });
  assert.equal(r.status, 400);
});

test('el nombre del archivo del cliente no decide la ruta', async () => {
  const { app, entregas, docs } = buildApp();
  const s = await sesionCon(app, entregas, 'juan@example.com', '7871234567');
  await call(app, 'POST', `/prequalify/leads/${s.leadId}/documents`, {
    token: s.token,
    form: multipart(PDF, { fileName: '../../../etc/passwd.pdf' }),
  });

  const clave = [...docs._objetos.keys()][0];
  assert.ok(clave.startsWith(`ulead${s.leadId}__`), `clave inesperada: ${clave}`);
  assert.ok(!clave.includes('..'));
  assert.ok(!clave.includes('/'));
});

test('la cuota por lead se hace cumplir en el servidor', async () => {
  const { app, entregas } = buildApp();
  const s = await sesionCon(app, entregas, 'juan@example.com', '7871234567');
  for (let i = 0; i < MAX_DOCUMENTS_PER_LEAD; i += 1) {
    const r = await call(app, 'POST', `/prequalify/leads/${s.leadId}/documents`, {
      token: s.token,
      form: multipart(PDF),
    });
    assert.equal(r.status, 201, `subida ${i + 1} deberia pasar`);
  }
  const extra = await call(app, 'POST', `/prequalify/leads/${s.leadId}/documents`, {
    token: s.token,
    form: multipart(PDF),
  });
  assert.equal(extra.status, 400);
});
