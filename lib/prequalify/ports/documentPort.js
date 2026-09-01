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
 *   kind: 'licence'|'paystub'|'taxes'|'form1099r'|'other',
 *   fileName: string,
 *   contentType: string,
 *   bytes: Buffer
 * }) => Promise<{key: string}>} upload
 *   Devuelve la clave ya prefijada por dueno. El llamador no la construye.
 * @property {(request: {leadId: string, key: string}) => Promise<{
 *   body: NodeJS.ReadableStream, contentType: string, contentLength: number|undefined
 * }>} getDocument
 *   Devuelve el contenido para que la ruta lo reenvie. Debe verificar que
 *   `key` pertenece a `leadId` ANTES de leer: un token valido no basta, hay
 *   que autorizar el recurso.
 *
 *   POR QUE UN FLUJO Y NO UNA URL FIRMADA. Una URL firmada vive por su cuenta:
 *   sobrevive al cierre de la sesion, se puede reenviar por WhatsApp y
 *   cualquiera que la tenga lee el documento hasta que caduca. Sirviendo por
 *   el backend, cada descarga vuelve a pasar por la sesion y por la
 *   comprobacion de dueno. Es ademas lo que ya hace `/downloadFile` de
 *   `app.js`, asi que el ecosistema tiene un solo patron y no dos.
 *
 *   El coste es que los bytes pasan por el servidor. Con talonarios y
 *   licencias (pocos MB, poco volumen) no compensa optimizarlo.
 * @property {(request: {leadId: string}) => Promise<Array<{key: string, kind: string}>>} listDocuments
 */

const METHODS = Object.freeze(['upload', 'getDocument', 'listDocuments']);

/** @returns {DocumentPort} */
function createNotImplementedDocumentPort() {
  return notImplementedPort('document', METHODS);
}

module.exports = { METHODS, createNotImplementedDocumentPort };
