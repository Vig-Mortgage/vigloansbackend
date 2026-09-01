'use strict';

const {
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');

const { ProviderError } = require('../ports/errors');
const logger = require('../../logger');
const {
  prepareUpload,
  assertKeyBelongsToLead,
  assertWithinLeadQuota,
  listPrefixForLead,
  parseDocumentKey,
  generateDocumentId,
} = require('../documents');

/**
 * Almacenamiento de documentos del solicitante en S3.
 *
 * Implementa `ports/documentPort.js`. Toda la logica de claves, validacion y
 * pertenencia vive en `lib/prequalify/documents.js`, que es puro; aqui solo
 * esta la conversacion con AWS.
 *
 * QUE ARREGLA RESPECTO AL LEGACY
 *
 * `upload_and_analyze.php:46` subia con `'Key' => $file_name`: el nombre que
 * mandaba el cliente, tal cual. Quien adivinaba un nombre leia o pisaba el
 * documento de otro — el IDOR de la auditoria. Aqui el nombre del cliente
 * **nunca** decide la ruta: la clave la construye `prepareUpload` a partir del
 * lead, del tipo y de un identificador aleatorio de 128 bits.
 *
 * AUTORIZACION POR RECURSO
 *
 * Ninguna operacion acepta una clave del cliente sin comprobar antes que
 * pertenece al lead de la sesion (`assertKeyBelongsToLead`). Un token valido
 * no basta: es exactamente la leccion del IDOR de `/downloadFile`.
 *
 * QUE NO SE LOGUEA
 *
 * Ni el contenido, ni el nombre original del archivo — un talonario suele
 * llamarse con el nombre y el patrono de la persona. Al log va el tipo, el
 * tamano y el identificador del documento, que no dicen nada de nadie.
 */

/** Mismo valor por defecto que `app.js`, para no divergir si falta el secreto. */
const BUCKET_POR_DEFECTO = 'vigpr-sf-prod';

/**
 * @param {object} deps
 * @param {() => object} deps.getS3Client
 * @param {() => Promise<object|null>} [deps.getBackendSecrets] de aqui sale `s3_bucket_name`
 */
function createDocumentStorageAdapter({ getS3Client, getBackendSecrets = null } = {}) {
  if (typeof getS3Client !== 'function') {
    throw new TypeError('createDocumentStorageAdapter necesita getS3Client');
  }

  let bucketCacheado = null;

  /**
   * El nombre del bucket sale del secreto igual que en `app.js`, y se cachea:
   * es un valor de configuracion que no cambia en caliente, y resolverlo en
   * cada subida seria una llamada a Secrets Manager por archivo.
   */
  async function bucket() {
    if (bucketCacheado) return bucketCacheado;
    let nombre = BUCKET_POR_DEFECTO;
    if (getBackendSecrets) {
      const secretos = await getBackendSecrets().catch(() => null);
      if (secretos?.s3_bucket_name) nombre = secretos.s3_bucket_name;
    }
    bucketCacheado = nombre;
    logger.info('prequalify.documentos_bucket', { bucket: nombre });
    return nombre;
  }

  /**
   * Envuelve un fallo de AWS.
   *
   * El mensaje de S3 puede traer el nombre del bucket y la clave completa; se
   * queda en el log del servidor. Al cliente le llega el mensaje generico de
   * `ProviderError`.
   */
  function comoErrorDeProveedor(operacion, causa) {
    return new ProviderError('document', `${operacion}: ${causa?.message ?? causa}`, {
      cause: causa,
    });
  }

  async function listarClaves(leadId) {
    const Bucket = await bucket();
    const Prefix = listPrefixForLead(leadId);
    const claves = [];
    let token;
    // S3 pagina a 1000. El tope por lead es muy inferior, pero se pagina de
    // todos modos: confiar en que "nunca habra tantos" es como se cuelan los
    // fallos que solo aparecen en produccion.
    do {
      const salida = await getS3Client().send(
        new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken: token })
      );
      for (const objeto of salida.Contents ?? []) claves.push(objeto.Key);
      token = salida.IsTruncated ? salida.NextContinuationToken : undefined;
    } while (token);
    return claves;
  }

  return {
    /**
     * Sube un documento y devuelve la clave ya prefijada por dueno.
     *
     * El orden importa: primero se cuenta lo que el lead ya tiene (cuota),
     * despues se valida el archivo, y solo entonces se escribe. Validar
     * despues de subir dejaria basura en el bucket cuando el archivo no pasa.
     */
    async upload({ leadId, kind, fileName, contentType, bytes } = {}) {
      const existentes = await listarClaves(leadId).catch((e) => {
        throw comoErrorDeProveedor('listar para cuota', e);
      });
      assertWithinLeadQuota(existentes.length);

      // `prepareUpload` valida tipo, tamano y firma real del archivo, y lanza
      // `DocumentValidationError` (400) si algo no cuadra. No es un fallo del
      // proveedor, asi que NO se envuelve en `ProviderError`.
      const preparado = prepareUpload({
        leadId,
        kind,
        fileName,
        contentType,
        bytes,
        docId: generateDocumentId(),
      });

      const Bucket = await bucket();
      try {
        await getS3Client().send(
          new PutObjectCommand({
            Bucket,
            Key: preparado.key,
            Body: bytes,
            ContentType: preparado.contentType,
            // Los documentos de un solicitante no son publicos jamas.
            ServerSideEncryption: 'AES256',
          })
        );
      } catch (e) {
        throw comoErrorDeProveedor('subir', e);
      }

      logger.info('prequalify.documento_subido', {
        // Nada del nombre original: un talonario se llama con el nombre y el
        // patrono de la persona.
        kind: preparado.kind,
        docId: preparado.docId,
        bytes: preparado.size,
        needsConversionForOcr: preparado.needsConversionForOcr,
      });

      return { key: preparado.key };
    },

    /**
     * Devuelve el contenido para que la ruta lo reenvie.
     *
     * `assertKeyBelongsToLead` va PRIMERO y lanza `DocumentAccessError` (403)
     * si la clave no es del lead. Sin esa linea, una sesion valida podria leer
     * el documento de cualquier otro solicitante con solo cambiar la clave.
     */
    async getDocument({ leadId, key } = {}) {
      const clave = assertKeyBelongsToLead(key, leadId);
      const Bucket = await bucket();
      try {
        const salida = await getS3Client().send(
          new GetObjectCommand({ Bucket, Key: clave })
        );
        return {
          body: salida.Body,
          contentType: salida.ContentType,
          contentLength: salida.ContentLength,
        };
      } catch (e) {
        throw comoErrorDeProveedor('leer', e);
      }
    },

    /**
     * Lista lo que el lead ya subio.
     *
     * El `Prefix` acota a las claves del lead, pero cada clave se vuelve a
     * comprobar con `parseDocumentKey`: un prefijo mal formado o un objeto
     * ajeno que hubiera acabado ahi no se cuela por confiar en el filtro de S3.
     */
    async listDocuments({ leadId } = {}) {
      const claves = await listarClaves(leadId).catch((e) => {
        throw comoErrorDeProveedor('listar', e);
      });
      const documentos = [];
      for (const key of claves) {
        const partes = parseDocumentKey(key);
        if (!partes || partes.leadId !== leadId) continue;
        documentos.push({ key, kind: partes.kind, docId: partes.docId });
      }
      return documentos;
    },
  };
}

module.exports = { createDocumentStorageAdapter };
