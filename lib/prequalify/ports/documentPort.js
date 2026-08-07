'use strict';

const { notImplementedPort } = require('./portFactory');

/**
 * Puerto de documentos: evidencia del solicitante (licencia, talonarios) en S3.
 *
 * Reglas que la implementacion debe cumplir:
 * - **Prefijo de dueno obligatorio en la clave.** Es el patron anti-IDOR de la
 *   Fase 0: la clave se construye a partir del dueno, no del nombre que mande
 *   el cliente, y se valida antes de leer o borrar. Aqui el dueno es el lead,
 *   no un usuario del app.
 * - **Nunca direccionar S3 solo por nombre de archivo**, que es como se
 *   colo el IDOR original.
 * - Validar tipo y tamano antes de subir; el nombre que manda el cliente es
 *   dato, no ruta.
 *
 * @typedef {object} DocumentPort
 * @property {(upload: {
 *   leadId: string,
 *   kind: 'licence'|'paystub'|'other',
 *   fileName: string,
 *   contentType: string,
 *   bytes: Buffer
 * }) => Promise<{key: string}>} upload
 *   Devuelve la clave ya prefijada por dueno. El llamador no la construye.
 * @property {(request: {leadId: string, key: string, expiresInSeconds?: number})
 *   => Promise<string>} getDownloadUrl
 *   URL firmada y temporal. Debe verificar que `key` pertenece a `leadId`
 *   ANTES de firmar: un token valido no basta, hay que autorizar el recurso.
 * @property {(request: {leadId: string}) => Promise<Array<{key: string, kind: string}>>} listDocuments
 */

const METHODS = Object.freeze(['upload', 'getDownloadUrl', 'listDocuments']);

/** @returns {DocumentPort} */
function createNotImplementedDocumentPort() {
  return notImplementedPort('document', METHODS);
}

module.exports = { METHODS, createNotImplementedDocumentPort };
