'use strict';

const crypto = require('node:crypto');

/**
 * Logica de documentos de la precualificacion (licencia/pasaporte, talonarios).
 *
 * Todo aqui es puro: construye y valida claves de S3, pero **no habla con AWS**.
 * El acceso real vive detras de `ports/documentPort.js`, que se apoya en estas
 * funciones para cumplir su contrato ("devuelve la clave ya prefijada por
 * dueno", "verifica que la clave pertenece al lead ANTES de firmar").
 *
 * Por que existe este modulo: el legacy subia a S3 con
 * `'Key' => $file_name` — el nombre que mandaba el cliente, tal cual
 * (`upload_and_analyze.php:46`). Eso es exactamente el IDOR que encontro la
 * auditoria: quien adivina un nombre lee (o pisa) el documento de otro. Aqui el
 * nombre del cliente **nunca** decide la ruta.
 *
 * Ademas el legacy renombraba a `{nameFile}_{counter}_{idLead}.{ext}`
 * (`test_draganddrop/upload.php:80`): el id del dueno iba al FINAL, asi que no
 * servia de prefijo ni para autorizar ni para listar. Se invierte.
 */

// ---------------------------------------------------------------------------
// Esquema de claves — reutiliza el patron anti-IDOR de la Fase 0
// ---------------------------------------------------------------------------

/**
 * `app.js` fijo en la Fase 0 el esquema `u{sfUserId}__{...}` con
 * `OWNED_KEY_REGEX = /^u([A-Za-z0-9]+)__/`. Se reutiliza tal cual, cambiando
 * solo quien es el dueno: aqui el dueno es el **lead**, no un usuario del app
 * (la precualificacion es un flujo anonimo).
 *
 * El id de dueno queda `lead{leadId}`, de modo que la clave completa es:
 *
 *   ulead{LEADID}__{kind}_{docId}[_{slug}].{ext}
 *   p. ej. ulead00Q1t000005AbCdEAK__paystub_9f3c1a2b4d5e6f70_talonario.pdf
 *
 * Tres propiedades que se ganan por elegir este esquema y no otro:
 *
 * 1. **La Fase 0 lo bloquea gratis.** Un documento de lead SI casa con
 *    `OWNED_KEY_REGEX`, y su dueno (`lead00Q…`) nunca va a coincidir con el
 *    `sfUserId` de un token del app: `authorizeKeyOwnership` responde 403. Si
 *    se hubiera usado un prefijo con `/` (`prequalify/leads/…`) el regex no
 *    casaria y caeria en la rama de "clave legacy", que hoy se permite por
 *    grandfathering — un usuario del app podria descargar el talonario de un
 *    solicitante.
 * 2. **Sobrevive intacto a `sanitizeFilename` de `app.js`**, que convierte
 *    `/` y `\` en `_` y borra `..`. La clave solo usa `[A-Za-z0-9._-]`, asi que
 *    pasar por ese helper la deja igual (es idempotente). Con separadores de
 *    ruta la clave se corromperia al pasar por cualquier endpoint viejo.
 * 3. **El doble guion bajo delimita sin ambiguedad.** `ulead1__` no es prefijo
 *    de `ulead12__…`, asi que un `Prefix` de S3 no puede colarse al vecino.
 *    Depende de que el leadId sea estrictamente alfanumerico (ver [LEAD_ID_RE]).
 */
const OWNER_NAMESPACE = 'lead';
const OWNER_SEPARATOR = '__';

/**
 * Un Id de Salesforce son 15 o 18 caracteres alfanumericos. Se acepta un rango
 * mas ancho por si el lead se identifica con un id propio antes de existir en
 * la org, pero **solo alfanumerico**: ni `/`, ni `.`, ni `-`, ni `_`. Esa
 * restriccion es la que hace imposible el path traversal en el segmento de
 * dueno y la que garantiza que `__` delimita sin ambiguedad.
 */
const LEAD_ID_RE = /^[A-Za-z0-9]{1,64}$/;

/** Tipos de documento. Son exactamente los del contrato de `documentPort`. */
const DocumentKind = Object.freeze({
  /** Licencia de conducir o pasaporte (`licenceOrPassport` en el form legacy). */
  LICENCE: 'licence',
  /** Talonario de pago. */
  PAYSTUB: 'paystub',
  /**
   * Planillas de contribucion sobre ingresos. El wizard legacy pedia 2
   * (`Taxes` en `LEGACY_EXPECTED_FILE_COUNT`).
   */
  TAXES: 'taxes',
  /** Form 1099-R: distribucion de pension o retiro. El legacy pedia 1. */
  FORM_1099R: 'form1099r',
  /** Lo que no encaja en los anteriores: evidencia suelta. */
  OTHER: 'other',
});

const DOCUMENT_KINDS = Object.freeze(Object.values(DocumentKind));

/**
 * Cuantos archivos espera el wizard por situacion laboral. Sale de
 * `js/scripts_mobile.js:145-177`, que es donde el legacy fijaba `minFiles`/
 * `maxFiles` en el navegador (y por tanto donde se podian saltar).
 *
 * Los cuatro tipos de este mapa tienen ya su valor en [DocumentKind], asi que
 * la clave de S3 los distingue. Se amplio el enum el 2026-08-31, ANTES de que
 * se subiera ningun documento con el flujo nuevo: hacerlo despues habria
 * obligado a renombrar objetos ya existentes en el bucket.
 */
const LEGACY_EXPECTED_FILE_COUNT = Object.freeze({
  licenceOrPassport: 1,
  Paystub: 3,
  'Form_1099-R': 1,
  Taxes: 2,
});

/**
 * Tope de documentos por lead. No lo hereda del legacy (no habia tope
 * server-side: `skipDocuments` y los contadores vivian en el navegador). Es un
 * limite de abuso: la precualificacion es anonima y sin tope un bot convierte
 * el endpoint en almacenamiento gratis.
 */
const MAX_DOCUMENTS_PER_LEAD = 12;

// ---------------------------------------------------------------------------
// Tipo y tamano
// ---------------------------------------------------------------------------

/**
 * Lista blanca de tipos, con la extension **canonica** de cada uno.
 *
 * La extension sale de aqui, nunca del nombre que manda el cliente: asi no hay
 * forma de guardar un objeto con extension `.php`, `.svg` o `.html` que luego
 * alguien sirva desde un bucket mal configurado.
 *
 * El legacy validaba `['image/jpeg','image/png','application/pdf']` en
 * `test_draganddrop/upload.php:56` pero el `accept` del formulario decia
 * `image/*,application/pdf` (`index.php:915`), asi que la foto de un iPhone
 * (HEIC) se ofrecia y luego se rechazaba. Se admite HEIC/HEIF para cerrar ese
 * hueco, con la advertencia de [NEEDS_CONVERSION_FOR_OCR].
 */
const ALLOWED_CONTENT_TYPES = Object.freeze({
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
});

/**
 * Amazon Textract (que es quien lee los talonarios, ver `upload_and_analyze.php`)
 * solo acepta JPEG, PNG, PDF y TIFF. Un HEIC entra al bucket pero hay que
 * convertirlo antes de mandarlo a analizar, o el analisis falla en silencio.
 *
 * TODO(Roberto): decidir donde va esa conversion (¿lambda al subir, o el
 * cliente convierte antes de enviar?). Hasta entonces, un HEIC se guarda pero
 * no se OCR-ea.
 */
const NEEDS_CONVERSION_FOR_OCR = Object.freeze(['image/heic', 'image/heif']);

/**
 * 10 MB por archivo.
 *
 * El legacy permitia 150 MB (`test_draganddrop/upload.php:64`) y el multer de
 * `app.js` 200 MB. Para la foto de una licencia o un talonario eso no es un
 * limite, es un vector de denegacion de servicio en un endpoint **publico y
 * anonimo**: 200 MB por peticion saturan memoria y ancho de banda gratis.
 *
 * TODO(Roberto): confirmar que 10 MB basta para un PDF de planilla escaneada de
 * varias paginas. Si no, subir a 25 MB, pero no volver a los 150.
 */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Un archivo de 0 bytes no es un documento; suele ser un envio roto. */
const MIN_FILE_BYTES = 1;

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

/**
 * Entrada invalida del cliente (tipo, tamano, nombre, kind).
 *
 * Sigue la convencion de `middleware/errorHandler.js`: `status` fija el codigo
 * y `publicMessage` es lo unico que ve el cliente.
 */
class DocumentValidationError extends Error {
  /**
   * @param {string} message detalle interno (va al log, no al cliente)
   * @param {string} [publicMessage] mensaje para el cliente
   */
  constructor(message, publicMessage = 'Documento inválido.') {
    super(message);
    this.name = 'DocumentValidationError';
    this.status = 400;
    this.publicMessage = publicMessage;
  }
}

/**
 * La clave pedida no pertenece al lead del token.
 *
 * Mensaje deliberadamente identico al de `authorizeKeyOwnership` en `app.js`
 * ("No autorizado para este recurso."): si el 403 de un recurso ajeno se
 * distinguiera del de un recurso inexistente, la respuesta serviria para
 * enumerar que claves existen.
 */
class DocumentAccessError extends Error {
  /** @param {string} message detalle interno (va al log, no al cliente) */
  constructor(message) {
    super(message);
    this.name = 'DocumentAccessError';
    this.status = 403;
    this.publicMessage = 'No autorizado para este recurso.';
  }
}

// ---------------------------------------------------------------------------
// Saneamiento del nombre que manda el cliente
// ---------------------------------------------------------------------------

/**
 * Convierte el nombre que manda el cliente en un nombre inofensivo.
 *
 * El nombre es **dato**, no ruta. Esta funcion no construye la clave: solo
 * produce algo mostrable y un slug opcional. Aun asi se sanea a fondo porque
 * acaba en metadatos de S3 y en cabeceras `Content-Disposition`.
 *
 * Se neutraliza, en este orden:
 * - **bytes nulos** (`\0`): en cualquier capa escrita en C truncan la cadena,
 *   asi que `foto.pdf\0.php` puede guardarse como una cosa y leerse como otra;
 * - el resto de caracteres de control, que rompen cabeceras;
 * - **separadores de ruta**: se queda solo el ultimo segmento, lo que mata de
 *   una vez `../../etc/passwd`, `..\\..\\win.ini` y `C:\\ruta\\archivo.pdf`;
 * - puntos y espacios iniciales (`..`, `.htaccess`);
 * - cualquier caracter fuera de `[A-Za-z0-9._-]`.
 *
 * @param {unknown} fileName nombre tal como lo mando el cliente
 * @returns {string} nombre seguro, o `''` si no quedo nada utilizable
 */
function sanitizeFileName(fileName) {
  let name = String(fileName ?? '');

  // Los nulos primero: si no, el basename se calcularia sobre una cadena que
  // otra capa vera truncada.
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f]/g, '');

  // Basename. `pop()` sobre el split deja solo el ultimo segmento.
  name = name.split(/[\\/]/).pop() ?? '';

  name = name.replace(/^[.\s]+/, '');
  name = name.replace(/[^A-Za-z0-9._-]/g, '-');
  name = name.replace(/-{2,}/g, '-');
  name = name.slice(0, 100);
  name = name.replace(/[.\s-]+$/, '');

  return name;
}

/**
 * Slug corto y legible para incrustar en la clave.
 *
 * Se limita a `[a-z0-9-]` (ni `.` ni `_`) para que el parser de claves no tenga
 * ambiguedad: el `_` separa campos y el `.` marca la extension.
 *
 * @param {unknown} fileName
 * @returns {string} slug, o `''` si no queda nada
 */
function slugFromFileName(fileName) {
  const safe = sanitizeFileName(fileName);
  const withoutExtension = safe.replace(/\.[A-Za-z0-9]{1,10}$/, '');
  return withoutExtension
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

// ---------------------------------------------------------------------------
// Identidad del dueno
// ---------------------------------------------------------------------------

/**
 * Valida el leadId y lo devuelve tal cual.
 *
 * No normaliza mayusculas: los Id de Salesforce de 15 caracteres **son**
 * sensibles a mayusculas (`00Q1t...AbC` y `00Q1t...abc` son leads distintos).
 * Bajarlos a minusculas fundiria dos duenos en uno.
 *
 * @param {unknown} leadId
 * @returns {string}
 * @throws {DocumentValidationError} si no es alfanumerico
 */
function assertLeadId(leadId) {
  const value = typeof leadId === 'string' ? leadId : '';
  if (!LEAD_ID_RE.test(value)) {
    throw new DocumentValidationError(
      `leadId invalido: ${JSON.stringify(String(leadId))}`,
      'Solicitud inválida.'
    );
  }
  return value;
}

/** Id de dueno del lead: `lead{leadId}`. */
function ownerIdFor(leadId) {
  return `${OWNER_NAMESPACE}${assertLeadId(leadId)}`;
}

/**
 * Prefijo de todas las claves del lead: `ulead{leadId}__`.
 *
 * Es lo que va en el `Prefix` de un `ListObjectsV2` y lo que valida
 * [keyBelongsToLead]. Termina en `__`, asi que no puede colarse a un lead cuyo
 * id empiece igual.
 */
function ownerPrefix(leadId) {
  return `u${ownerIdFor(leadId)}${OWNER_SEPARATOR}`;
}

/** Alias explicito para quien lee el codigo del puerto. */
const listPrefixForLead = ownerPrefix;

// ---------------------------------------------------------------------------
// Construccion y lectura de claves
// ---------------------------------------------------------------------------

/**
 * Forma completa de una clave. El `kind` va por alternancia explicita (y no
 * como `[a-z]+`) para que no pueda comerse parte del `docId`.
 */
const KEY_RE = new RegExp(
  `^u${OWNER_NAMESPACE}([A-Za-z0-9]{1,64})${OWNER_SEPARATOR}` +
    `(${DOCUMENT_KINDS.join('|')})` +
    '_([a-f0-9]{16,64})' +
    '(?:_([a-z0-9-]{1,32}))?' +
    '\\.([a-z0-9]{2,5})$'
);

/** Identificador aleatorio del documento. 128 bits: no se adivina. */
function generateDocumentId() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Construye la clave de S3 de un documento.
 *
 * **El nombre del cliente no entra en la ruta.** Solo aporta, como mucho, un
 * slug saneado al final; la carpeta la fija el dueno, el tipo lo fija el enum y
 * la extension la fija el MIME validado.
 *
 * @param {object} input
 * @param {string} input.leadId dueno del documento
 * @param {'licence'|'paystub'|'taxes'|'form1099r'|'other'} input.kind
 * @param {string} input.contentType MIME declarado (se valida contra la lista blanca)
 * @param {string} [input.fileName] nombre del cliente; solo para el slug
 * @param {string} [input.docId] id del documento; por defecto aleatorio
 * @returns {{key: string, docId: string, extension: string, safeFileName: string}}
 * @throws {DocumentValidationError}
 */
function buildDocumentKey({ leadId, kind, contentType, fileName, docId } = {}) {
  const prefix = ownerPrefix(leadId);
  const safeKind = assertDocumentKind(kind);
  const extension = extensionFor(contentType);

  const id = docId === undefined ? generateDocumentId() : String(docId);
  if (!/^[a-f0-9]{16,64}$/.test(id)) {
    throw new DocumentValidationError(`docId invalido: ${JSON.stringify(id)}`);
  }

  const slug = slugFromFileName(fileName);
  const suffix = slug ? `_${slug}` : '';
  const key = `${prefix}${safeKind}_${id}${suffix}.${extension}`;

  // Cinturon y tirantes: si algun dia alguien afloja una de las validaciones de
  // arriba, la clave que sale de aqui tiene que seguir siendo parseable y del
  // dueno correcto. Falla en construccion, no al descargar.
  if (!keyBelongsToLead(key, leadId)) {
    throw new DocumentValidationError(`Clave construida invalida: ${key}`);
  }

  return { key, docId: id, extension, safeFileName: sanitizeFileName(fileName) };
}

/**
 * Descompone una clave. `null` si no sigue el esquema (clave ajena, legacy o
 * manipulada).
 *
 * @param {unknown} key
 * @returns {{ownerId: string, leadId: string, kind: string, docId: string,
 *            slug: string|null, extension: string}|null}
 */
function parseDocumentKey(key) {
  if (typeof key !== 'string') return null;
  // Un separador de ruta o un `..` no pueden aparecer en una clave nuestra.
  // Se comprueba aparte del regex para que quede explicito el porque.
  if (key.includes('/') || key.includes('\\') || key.includes('..')) return null;

  const match = KEY_RE.exec(key);
  if (!match) return null;

  const [, leadId, kind, docId, slug, extension] = match;
  return {
    ownerId: `${OWNER_NAMESPACE}${leadId}`,
    leadId,
    kind,
    docId,
    slug: slug ?? null,
    extension,
  };
}

/**
 * ¿Esta clave pertenece a este lead?
 *
 * **No es un `startsWith`.** Se parsea la clave entera y se compara el id del
 * dueno completo, que es lo que impide dos trampas clasicas:
 * - prefijo parcial: `ulead00Q1__…` no pertenece al lead `00Q12`;
 * - clave con ruta: `otro/../ulead00Q1__…` no parsea y se rechaza.
 *
 * @param {unknown} key
 * @param {unknown} leadId
 * @returns {boolean}
 */
function keyBelongsToLead(key, leadId) {
  const parsed = parseDocumentKey(key);
  if (!parsed) return false;

  let expected;
  try {
    expected = ownerIdFor(leadId);
  } catch {
    return false;
  }

  // Comparacion sensible a mayusculas: ver [assertLeadId].
  return parsed.ownerId === expected;
}

/**
 * Igual que [keyBelongsToLead] pero lanza. Es lo que debe llamar el puerto
 * ANTES de firmar una URL, leer o borrar: autorizacion por recurso, no solo
 * autenticacion.
 *
 * @param {unknown} key
 * @param {unknown} leadId
 * @returns {string} la clave, ya verificada
 * @throws {DocumentAccessError}
 */
function assertKeyBelongsToLead(key, leadId) {
  if (!keyBelongsToLead(key, leadId)) {
    // El detalle (que clave, que lead) va al log del servidor, no al cliente.
    throw new DocumentAccessError(
      `Acceso cruzado bloqueado: clave ${JSON.stringify(String(key))} no pertenece al lead ${JSON.stringify(String(leadId))}`
    );
  }
  return String(key);
}

// ---------------------------------------------------------------------------
// Validacion de la subida
// ---------------------------------------------------------------------------

/** @throws {DocumentValidationError} */
function assertDocumentKind(kind) {
  if (!DOCUMENT_KINDS.includes(kind)) {
    throw new DocumentValidationError(
      `Tipo de documento desconocido: ${JSON.stringify(String(kind))}`,
      'Tipo de documento no permitido.'
    );
  }
  return kind;
}

/**
 * Normaliza un MIME: minusculas y sin parametros.
 * Un navegador puede mandar `image/jpeg; charset=binary`.
 */
function normalizeContentType(contentType) {
  return String(contentType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

/**
 * Extension canonica del MIME. Lanza si el tipo no esta en la lista blanca.
 * @throws {DocumentValidationError}
 */
function extensionFor(contentType) {
  const normalized = normalizeContentType(contentType);
  const extension = ALLOWED_CONTENT_TYPES[normalized];
  if (!extension) {
    throw new DocumentValidationError(
      `Tipo de archivo no permitido: ${JSON.stringify(normalized)}`,
      'Solo aceptamos PDF e imágenes (JPG, PNG, HEIC).'
    );
  }
  return extension;
}

/** ¿Esta el MIME en la lista blanca? */
function isAllowedContentType(contentType) {
  return Object.hasOwn(ALLOWED_CONTENT_TYPES, normalizeContentType(contentType));
}

/**
 * Firmas de archivo (magic numbers) de los tipos que aceptamos.
 *
 * Hace falta porque el `Content-Type` lo elige el cliente: renombrar
 * `shell.php` a `talonario.pdf` y declarar `application/pdf` es gratis. Con la
 * firma real el bucket solo recibe lo que dice recibir.
 */
const MAGIC_NUMBERS = Object.freeze([
  { type: 'application/pdf', offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { type: 'image/jpeg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/png', offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // HEIC/HEIF son contenedores ISO-BMFF: el marcador 'ftyp' esta en el byte 4 y
  // la marca concreta ('heic', 'heix', 'mif1'...) justo despues.
  { type: 'image/heic', offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
]);

/**
 * Detecta el tipo real a partir de los primeros bytes.
 *
 * @param {Buffer|Uint8Array} bytes
 * @returns {string|null} MIME detectado, o `null` si no reconoce la firma
 */
function sniffContentType(bytes) {
  if (!bytes || typeof bytes.length !== 'number') return null;
  for (const { type, offset, bytes: magic } of MAGIC_NUMBERS) {
    if (bytes.length < offset + magic.length) continue;
    let coincide = true;
    for (let i = 0; i < magic.length; i += 1) {
      if (bytes[offset + i] !== magic[i]) {
        coincide = false;
        break;
      }
    }
    if (coincide) return type;
  }
  return null;
}

/**
 * ¿El tipo detectado es compatible con el declarado?
 * HEIC y HEIF comparten contenedor, asi que la firma no los distingue.
 */
function contentTypesMatch(declared, sniffed) {
  if (declared === sniffed) return true;
  const heif = new Set(['image/heic', 'image/heif']);
  return heif.has(declared) && heif.has(sniffed);
}

/**
 * Valida una subida completa: tipo, tamano y (si hay bytes) firma real.
 *
 * @param {object} input
 * @param {'licence'|'paystub'|'taxes'|'form1099r'|'other'} input.kind
 * @param {string} input.contentType MIME declarado por el cliente
 * @param {string} [input.fileName] nombre del cliente
 * @param {number} [input.size] tamano en bytes; se infiere de `bytes` si falta
 * @param {Buffer|Uint8Array} [input.bytes] contenido, para verificar la firma
 * @returns {{kind: string, contentType: string, extension: string,
 *            size: number, safeFileName: string, needsConversionForOcr: boolean}}
 * @throws {DocumentValidationError}
 */
function validateUpload({ kind, contentType, fileName, size, bytes } = {}) {
  const safeKind = assertDocumentKind(kind);
  const normalized = normalizeContentType(contentType);
  const extension = extensionFor(normalized);

  const effectiveSize = typeof size === 'number' ? size : bytes?.length;
  if (!Number.isFinite(effectiveSize) || !Number.isInteger(effectiveSize)) {
    throw new DocumentValidationError(
      `Tamano no determinable: ${String(size)}`,
      'No pudimos leer el archivo.'
    );
  }
  if (effectiveSize < MIN_FILE_BYTES) {
    throw new DocumentValidationError(
      `Archivo vacio (${effectiveSize} bytes)`,
      'El archivo está vacío.'
    );
  }
  if (effectiveSize > MAX_FILE_BYTES) {
    throw new DocumentValidationError(
      `Archivo demasiado grande: ${effectiveSize} bytes`,
      `El archivo excede el máximo de ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))} MB.`
    );
  }

  // Solo si hay contenido: el puerto puede validar antes de recibir el cuerpo
  // (p. ej. para emitir una URL de subida directa) y entonces no hay bytes.
  if (bytes) {
    const sniffed = sniffContentType(bytes);
    if (!sniffed || !contentTypesMatch(normalized, sniffed)) {
      throw new DocumentValidationError(
        `Firma de archivo no coincide con el tipo declarado (${normalized} vs ${sniffed ?? 'desconocido'})`,
        'El archivo no parece ser del tipo indicado.'
      );
    }
  }

  return {
    kind: safeKind,
    contentType: normalized,
    extension,
    size: effectiveSize,
    safeFileName: sanitizeFileName(fileName),
    needsConversionForOcr: NEEDS_CONVERSION_FOR_OCR.includes(normalized),
  };
}

/**
 * Valida la subida y devuelve ya la clave donde debe guardarse.
 * Es el unico camino que deberia usar `documentPort.upload`.
 *
 * @param {object} input igual que [validateUpload] mas `leadId` y `docId`
 * @returns {{key: string, docId: string, kind: string, contentType: string,
 *            extension: string, size: number, safeFileName: string,
 *            needsConversionForOcr: boolean}}
 * @throws {DocumentValidationError}
 */
function prepareUpload({ leadId, kind, contentType, fileName, size, bytes, docId } = {}) {
  const validated = validateUpload({ kind, contentType, fileName, size, bytes });
  const built = buildDocumentKey({
    leadId,
    kind: validated.kind,
    contentType: validated.contentType,
    fileName,
    docId,
  });
  return { ...validated, key: built.key, docId: built.docId };
}

/**
 * Cuota de documentos por lead.
 *
 * @param {number} currentCount cuantos tiene ya el lead
 * @throws {DocumentValidationError} si ya llego al tope
 */
function assertWithinLeadQuota(currentCount) {
  const count = Number(currentCount);
  if (!Number.isInteger(count) || count < 0) {
    throw new DocumentValidationError(`Conteo invalido: ${String(currentCount)}`);
  }
  if (count >= MAX_DOCUMENTS_PER_LEAD) {
    throw new DocumentValidationError(
      `Lead con ${count} documentos, tope ${MAX_DOCUMENTS_PER_LEAD}`,
      'Alcanzaste el máximo de documentos para esta solicitud.'
    );
  }
}

/**
 * Filtra una lista de claves dejando solo las del lead.
 *
 * Defensa en profundidad para `documentPort.listDocuments`: aunque el listado
 * venga de un `ListObjectsV2` con `Prefix`, no se confia en que el prefijo se
 * haya aplicado bien. Un listado mal filtrado revela nombres de documentos de
 * otros solicitantes.
 *
 * @param {Array<string|{key: string}>} keys
 * @param {string} leadId
 * @returns {Array<{key: string, kind: string, docId: string}>}
 */
function filterKeysForLead(keys, leadId) {
  if (!Array.isArray(keys)) return [];
  return keys
    .map((entry) => (typeof entry === 'string' ? entry : entry?.key))
    .filter((key) => keyBelongsToLead(key, leadId))
    .map((key) => {
      const { kind, docId } = parseDocumentKey(key);
      return { key, kind, docId };
    });
}

module.exports = {
  // esquema
  OWNER_NAMESPACE,
  OWNER_SEPARATOR,
  LEAD_ID_RE,
  KEY_RE,
  DocumentKind,
  DOCUMENT_KINDS,
  // limites
  ALLOWED_CONTENT_TYPES,
  NEEDS_CONVERSION_FOR_OCR,
  MAX_FILE_BYTES,
  MIN_FILE_BYTES,
  MAX_DOCUMENTS_PER_LEAD,
  LEGACY_EXPECTED_FILE_COUNT,
  // errores
  DocumentValidationError,
  DocumentAccessError,
  // saneamiento
  sanitizeFileName,
  slugFromFileName,
  // dueno y claves
  assertLeadId,
  ownerIdFor,
  ownerPrefix,
  listPrefixForLead,
  generateDocumentId,
  buildDocumentKey,
  parseDocumentKey,
  keyBelongsToLead,
  assertKeyBelongsToLead,
  filterKeysForLead,
  // validacion
  assertDocumentKind,
  normalizeContentType,
  isAllowedContentType,
  extensionFor,
  sniffContentType,
  validateUpload,
  prepareUpload,
  assertWithinLeadQuota,
};
