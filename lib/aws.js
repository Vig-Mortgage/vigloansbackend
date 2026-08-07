'use strict';

const { S3Client } = require('@aws-sdk/client-s3');

/**
 * Clientes de AWS del backend.
 *
 * Extraido de `app.js` (Tarea D1) sin cambiar configuracion. El cliente de
 * Secrets Manager vive en `lib/secrets.js`, que es quien lo usa.
 *
 * Se construye de forma perezosa: montarlo en el `require` obligaria a tener
 * credenciales presentes solo para importar el modulo, lo que rompe los tests.
 *
 * TODO(Roberto): las credenciales salen de S3_AWS_ACCESS_KEY_ID /
 * S3_AWS_SECRET_ACCESS_KEY, llaves de larga vida en el `.env` del servidor. El
 * CLAUDE.md pide rol IAM de instancia.
 */

let s3 = null;

/** Cliente de S3, compartido. */
function getS3Client() {
  if (!s3) {
    s3 = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey:
          process.env.S3_AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3;
}

/** Solo para tests. */
function _reset() {
  s3 = null;
}

module.exports = { getS3Client, _reset };
