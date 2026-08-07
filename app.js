const express = require('express');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const multer = require('multer');
const multerS3 = require('multer-s3');
const morgan = require('morgan');
const helmet = require('helmet');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { PDFDocument } = require('pdf-lib');
const PDFDocumentKit = require('pdfkit');
const stream = require('stream');
const { promisify } = require('util');
const { execFile } = require('child_process');
const os = require('os');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1); // Necesario para rate limiting correcto detrás de ELB/proxy

// -------------------- MIDDLEWARE LIMPIEZA DE URL --------------------
// Evita errores 404 si el cliente envía URLs con múltiples barras (ej. //sf/token)
app.use((req, res, next) => {
  req.url = req.url.replace(/\/\/+/g, '/');
  next();
});

const port = process.env.PORT || 8080;
const gsExecutable = process.env.GS_EXECUTABLE || 'gs';

// -------------------- SANITIZACIÓN DE NOMBRES DE ARCHIVO --------------------
// Permite: alfanuméricos, underscores, guiones, puntos
// Bloquea: path traversal (../), barras, caracteres especiales de shell
function sanitizeFilename(filename) {
  if (!filename || typeof filename !== 'string') return '';
  // Eliminar cualquier intento de path traversal
  const cleaned = filename.replace(/\.\./g, '').replace(/[\/\\]/g, '');
  // Solo permitir caracteres seguros
  const sanitized = cleaned.replace(/[^a-zA-Z0-9_.\-]/g, '');
  return sanitized || '';
}

// -------------------- AWS SECRETS MANAGER --------------------
// Extraido a `lib/secrets.js` (Tarea D1). Los nombres locales se conservan
// para no tocar los ~22 puntos de uso repartidos por este archivo.
const {
  getSecret,
  getBackendSecrets,
  getAppConfig,
  getPrequalifySecrets,
} = require('./lib/secrets').createSecretsProvider();

// `Mail` es opcional: si no esta configurado, el envio de correo se degrada en
// vez de tumbar el arranque. Comportamiento heredado del monolito.
async function getMailSecrets() {
  try {
    return await getSecret('Mail');
  } catch (error) {
    console.warn('No se pudo cargar el secreto Mail:', error.message);
    return null;
  }
}

// -------------------- MIDDLEWARE DE SEGURIDAD --------------------
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'DELETE'],
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// -------------------- CALCULADORA HIPOTECARIA (API, fuente única) --------------------
// Cálculo hipotecario centralizado, consumido por Flutter y Next.js.
// Endpoints: POST /calculator/quote, GET /calculator/config.
app.use('/calculator', require('./routes/calculator'));

// -------------------- DATOS GEOGRÁFICOS --------------------
// GET /geo/states, GET /geo/zip/:zip. Sustituyen a getStates.php/getCities.php
// del legacy (este último tenía inyección SQL). Sin secretos: monta directo.
app.use('/geo', require('./routes/geo').createGeoRouter());

// -------------------- PRECUALIFICACIÓN (flujo anónimo) --------------------
// Auth propia (OTP → token de sesión), rate-limit y CORS propios.
// Se construye perezosamente porque necesita el secreto `vigloans/prequalify`;
// mientras no exista responde 503 y NO afecta al resto del backend.
app.use(
  '/prequalify',
  require('./routes/prequalifyMount').createLazyPrequalifyMount({
    getPrequalifySecrets: () => getSecret('vigloans/prequalify'),
    getBackendSecrets,
  })
);

// -------------------- HEALTH CHECK ENDPOINT --------------------
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'vigloansbackend',
    uptime: process.uptime()
  });
});

// Endpoint raíz para health checks del balanceador (ELB/ALB)
app.get('/', (req, res) => {
  const userAgent = req.get('user-agent') || '';
  if (userAgent.includes('ELB-HealthChecker') || userAgent.includes('HealthChecker')) {
    return res.status(200).json({ status: 'ok' });
  }
  res.status(404).json({ error: 'Not Found' });
});

// -------------------- CLIENTE S3 --------------------
// Extraido a `lib/aws.js` (Tarea D1). Perezoso: no exige credenciales para
// importar el modulo.
const s3Client = require('./lib/aws').getS3Client();

// Correo: nodemailer con TLS verificado (Tarea D3).
const { createMailer } = require('./lib/mailer');

// -------------------- AUTENTICACIÓN Y AUTORIZACIÓN --------------------
// Extraido a `middleware/auth.js` (Tarea D2). El verificarJWT de alli fija
// `algorithms: ['HS256']`, que aqui faltaba.
const {
  authorizeKeyOwnership,
  createVerificarJWT,
  createAuthLimiter,
  createSupportLimiter,
} = require('./middleware/auth');

const authLimiter = createAuthLimiter();
const supportLimiter = createSupportLimiter();
const verificarJWT = createVerificarJWT({ getBackendSecrets });

// -------------------- HELPERS DE SANITIZACIÓN DE CORREO --------------------
// Elimina CR/LF para prevenir inyección de cabeceras SMTP (Reply-To, Subject, etc.).
function sanitizeHeaderValue(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}
// Escapa HTML para prevenir inyección de markup en el cuerpo del correo.
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
// Validación simple de formato de email.
function isValidEmail(value) {
  return typeof value === 'string' &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) &&
    value.length <= 254;
}

// -------------------- ENDPOINT DE AUTENTICACIÓN --------------------
app.post('/authenticate', authLimiter, async (req, res) => {
  try {
    const secrets = await getBackendSecrets();
    const { username, password } = req.body;

    if (username === secrets.auth_user && password === secrets.auth_pass) {
      const token = jwt.sign({ username }, secrets.jwt_secret_key, { expiresIn: '1h' });
      return res.json({ token });
    }
    res.status(401).json({ error: 'Credenciales inválidas' });
  } catch (error) {
    console.error('Error en /authenticate:', error.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// -------------------- AUTENTICACIÓN POR SALESFORCE TOKEN --------------------
// La app Flutter envía su SF access token; el backend lo valida contra SF
// y emite un JWT propio. Así la app nunca necesita el jwt_secret_key.
app.post('/authenticate/sf', authLimiter, async (req, res) => {
  try {
    const { sfAccessToken, sfHost } = req.body;
    if (!sfAccessToken || !sfHost) {
      return res.status(400).json({ error: 'sfAccessToken y sfHost son requeridos.' });
    }

    // Validar que sfHost sea un dominio Salesforce legítimo
    const allowedHosts = ['my.salesforce.com', 'my.site.com', 'sandbox.my.salesforce.com', 'sandbox.my.site.com'];
    const hostUrl = new URL(sfHost);
    const isValidHost = allowedHosts.some(h => hostUrl.hostname.endsWith(h));
    if (!isValidHost) {
      return res.status(400).json({ error: 'sfHost no es un dominio Salesforce válido.' });
    }

    // Verificar el token contra Salesforce
    const sfResponse = await fetch(`${sfHost}/services/oauth2/userinfo`, {
      headers: { 'Authorization': `Bearer ${sfAccessToken}` }
    });

    if (!sfResponse.ok) {
      return res.status(401).json({ error: 'Token de Salesforce inválido o expirado.' });
    }

    const sfUser = await sfResponse.json();
    if (!sfUser.user_id) {
      return res.status(401).json({ error: 'No se pudo verificar la identidad del usuario.' });
    }

    // Generar JWT del backend
    const secrets = await getBackendSecrets();
    const token = jwt.sign(
      { sfUserId: sfUser.user_id, email: sfUser.email, source: 'sf' },
      secrets.jwt_secret_key,
      { expiresIn: '24h' }
    );

    return res.json({ token, expiresIn: '24h', userId: sfUser.user_id });
  } catch (error) {
    console.error('Error en /authenticate/sf:', error.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// -------------------- CONFIG PÚBLICO (sin auth) --------------------
// Devuelve solo valores no sensibles: hosts, IDs públicos
app.get('/config/public', async (req, res) => {
  try {
    const appConfig = await getAppConfig();
    // Solo devolver valores públicos (hosts y IDs de cliente)
    const publicConfig = {
      node_host: appConfig.node_host || null,
      sf_host: appConfig.sf_host || null,
      sf_community_host: appConfig.sf_community_host || null,
      sf_client_id_ios: appConfig.sf_client_id_ios || null,
      sf_redirect_url: appConfig.sf_redirect_url || null,
      ath_public_token: appConfig.ath_public_token || null,
      paypal_domain_url: appConfig.paypal_domain_url || null,
      paypal_client_id: appConfig.paypal_client_id || null,
      minVersion: appConfig.min_app_version || appConfig.min_version || appConfig.minVersion || '1.0.0',
      latestVersion: appConfig.latest_app_version || appConfig.latest_version || appConfig.latestVersion || '1.0.0',
      forceUpdate: appConfig.force_update !== undefined ? appConfig.force_update : (appConfig.forceUpdate || false),
    };
    res.json(publicConfig);
  } catch (error) {
    console.error('Error en /config/public:', error.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});



// -------------------- PROXY SALESFORCE TOKEN EXCHANGE --------------------
// La app envía el authorization code; el backend agrega el client_secret
// y hace el exchange con Salesforce. Así client_secret nunca está en la app.
app.post('/sf/token', authLimiter, async (req, res) => {
  try {
    const { code, redirectUri } = req.body;
    console.log(`[SF TOKEN EXCHANGE] Received redirectUri (Backend): ${redirectUri}`);
    if (!code || !redirectUri) {
      return res.status(400).json({ error: 'code y redirectUri son requeridos.' });
    }

    const appConfig = await getAppConfig();
    const sfCommunityHost = appConfig.sf_community_host;
    const sfClientId = appConfig.sf_client_id_ios || appConfig.sf_client_id;
    const sfClientSecret = appConfig.sf_client_secret_ios || appConfig.sf_client_secret;

    if (!sfCommunityHost || !sfClientId || !sfClientSecret) {
      console.error('Faltan credenciales de Salesforce en Secrets Manager.');
      return res.status(500).json({ error: 'Configuración de Salesforce incompleta en el servidor.' });
    }

    const tokenUrl = `${sfCommunityHost}/services/oauth2/token?grant_type=authorization_code&client_id=${sfClientId}&client_secret=${sfClientSecret}&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(redirectUri)}`;

    const sfResponse = await fetch(tokenUrl, { method: 'POST' });
    const sfData = await sfResponse.json();

    if (!sfResponse.ok) {
      console.error('[SF ERROR] Status:', sfResponse.status, 'Data:', sfData);
      return res.status(sfResponse.status).json({
        error: sfData.error_description || 'Error al obtener token de Salesforce.',
        details: sfData
      });
    }

    // También generar un JWT del backend para acceso a nuestros endpoints
    const secrets = await getBackendSecrets();
    const backendToken = jwt.sign(
      { source: 'sf', sfAccessToken: sfData.access_token },
      secrets.jwt_secret_key,
      { expiresIn: '24h' }
    );

    return res.json({
      ...sfData,
      backend_token: backendToken,
      backend_token_expires_in: '24h',
    });
  } catch (error) {
    console.error('Error en /sf/token:', error.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// -------------------- PROXY PAYPAL TOKEN --------------------
// La app solicita un token de PayPal a través del backend.
// El client_id y secret_key de PayPal se mantienen solo en el servidor.
app.post('/paypal/token', verificarJWT, async (req, res) => {
  try {
    const appConfig = await getAppConfig();
    const paypalDomain = appConfig.paypal_domain_url;
    const paypalClientId = appConfig.paypal_client_id;
    const paypalSecret = appConfig.paypal_secret_key;

    if (!paypalDomain || !paypalClientId || !paypalSecret) {
      console.error('Faltan credenciales de PayPal en Secrets Manager.');
      return res.status(500).json({ error: 'Configuración de PayPal incompleta en el servidor.' });
    }

    const basicAuth = Buffer.from(`${paypalClientId}:${paypalSecret}`).toString('base64');
    const tokenUrl = `${paypalDomain}/v1/oauth2/token?grant_type=client_credentials`;

    const ppResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const ppData = await ppResponse.json();

    if (!ppResponse.ok) {
      return res.status(ppResponse.status).json({
        error: ppData.error_description || 'Error al obtener token de PayPal.'
      });
    }

    return res.json(ppData);
  } catch (error) {
    console.error('Error en /paypal/token:', error.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// verificarJWT, getOwnerId y authorizeKeyOwnership viven ahora en
// `middleware/auth.js` (Tarea D2). Se cablean mas arriba.

// -------------------- CONFIGURACIÓN DE MULTER --------------------
// El bucket se inicializa con fallback y se actualiza al cargar secretos
let uploadBucketName = 'vigpr-sf-prod';

const upload = multer({
  storage: multerS3({
    s3: s3Client,
    bucket: function(req, file, cb) {
      cb(null, uploadBucketName);
    },
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: function (req, file, cb) {
      const safeFilename = sanitizeFilename(file.originalname);
      cb(null, safeFilename);
    }
  }),
  limits: {
    fileSize: 200 * 1024 * 1024 // 200MB máximo
  }
});

// -------------------- REGISTRO DE SOLICITUDES CON MORGAN --------------------
const accessLogStream = fs.createWriteStream(path.join(__dirname, 'access.log'), { flags: 'a' });
app.use(morgan('combined', { stream: accessLogStream }));

// -------------------- ENDPOINT PARA SUBIR ARCHIVOS A S3 --------------------
app.post('/uploadFile', verificarJWT, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      throw new Error('No se recibió ningún archivo');
    }
    console.log('Archivo subido:', req.file.originalname);
    res.send(req.file.originalname);
  } catch (err) {
    console.error('Error en uploadFile:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- ENDPOINT PARA DESCARGAR ARCHIVOS DE S3 --------------------
app.get('/downloadFile/:key', verificarJWT, async (req, res) => {
  try {
    const key = sanitizeFilename(req.params.key);
    if (!key) {
      return res.status(400).json({ error: 'Nombre de archivo inválido.' });
    }

    // ANTI-IDOR: validar que la clave pertenece al usuario autenticado.
    const authz = authorizeKeyOwnership(req, key);
    if (!authz.ok) {
      return res.status(authz.status).json({ error: authz.error });
    }

    const getParams = {
      Bucket: uploadBucketName,
      Key: key,
    };

    console.log('=== DOWNLOAD REQUEST ===');
    console.log('Key solicitada:', key);
    console.log('========================');

    const command = new GetObjectCommand(getParams);
    const { Body } = await s3Client.send(command);
    const safeName = key.replace(/["\r\n]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    Body.pipe(res);
    console.log('✅ Descarga exitosa:', key);
  } catch (err) {
    console.error('❌ Error en downloadFile:', err.message);
    res.status(500).json({ error: 'Error al descargar el archivo.' });
  }
});

// -------------------- ENDPOINT PARA ELIMINAR ARCHIVOS DE S3 --------------------
app.delete('/deleteFile/:key', verificarJWT, async (req, res) => {
  try {
    const key = sanitizeFilename(req.params.key);
    if (!key) {
      return res.status(400).json({ error: 'Nombre de archivo inválido.' });
    }

    // ANTI-IDOR: validar que la clave pertenece al usuario autenticado.
    const authz = authorizeKeyOwnership(req, key);
    if (!authz.ok) {
      return res.status(authz.status).json({ error: authz.error });
    }

    const deleteParams = {
      Bucket: uploadBucketName,
      Key: key,
    };
    const command = new DeleteObjectCommand(deleteParams);
    await s3Client.send(command);
    console.log('Archivo eliminado:', key);
    res.json({ message: 'Archivo eliminado con éxito' });
  } catch (err) {
    console.error('Error en deleteFile:', err.message);
    res.status(500).json({ error: 'Error al eliminar el archivo.' });
  }
});

// -------------------- ENDPOINT: VERSIÓN DE LA APP (PÚBLICO) --------------------
app.get('/app-version', async (req, res) => {
  try {
    const config = await getAppConfig();
    res.json({
      minVersion: config.min_app_version || config.min_version || config.minVersion || '1.0.0',
      latestVersion: config.latest_app_version || config.latest_version || config.latestVersion || '1.0.0',
      forceUpdate: config.force_update !== undefined ? config.force_update : (config.forceUpdate || false),
    });
  } catch (error) {
    console.error('Error en /app-version:', error.message);
    res.status(500).json({ error: 'No se pudo obtener la versión de la app' });
  }
});

// -------------------- ENDPOINT: CONFIG REMOTA (PROTEGIDO) --------------------
app.get('/config', verificarJWT, async (req, res) => {
  try {
    const config = await getAppConfig();
    // Solo enviar datos seguros al cliente — nunca secretos del servidor
    res.json({
      ath_public_token: config.ath_public_token,
      sf_host: config.sf_host,
      sf_community_host: config.sf_community_host,
      sf_client_id_ios: config.sf_client_id_ios,
      sf_redirect_url: config.sf_redirect_url,
      paypal_client_id: config.paypal_client_id,
      paypal_domain_url: config.paypal_domain_url,
      node_host: config.node_host,
      minVersion: config.min_app_version || config.min_version || config.minVersion || '1.0.0',
      latestVersion: config.latest_app_version || config.latest_version || config.latestVersion || '1.0.0',
      forceUpdate: config.force_update !== undefined ? config.force_update : (config.forceUpdate || false),
    });
  } catch (error) {
    console.error('Error en /config:', error.message);
    res.status(500).json({ error: 'No se pudo obtener la configuración' });
  }
});

// -------------------- ENDPOINT: VERIFICAR PAGO ATH MÓVIL --------------------
app.post('/verifyATHPayment', verificarJWT, async (req, res) => {
  try {
    const { referenceNumber, ecommerceId, total, invoiceData, publicToken, rawResponse } = req.body;
    console.log('--- verifyATHPayment Request ---');
    console.log('referenceNumber:', referenceNumber);
    console.log('ecommerceId (original):', ecommerceId);
    
    // Sanitizar el ecommerceId eliminando los guiones para cumplir con las restricciones de Evertec
    const cleanEcommerceId = ecommerceId ? String(ecommerceId).replace(/-/g, '') : '';
    console.log('ecommerceId (clean):', cleanEcommerceId);
    console.log('total:', total);
    console.log('client publicToken:', publicToken);
    console.log('rawResponse:', JSON.stringify(rawResponse, null, 2));

    const secrets = await getBackendSecrets();
    const athPrivateToken = secrets.ath_private_token;
    const athPublicToken = secrets.ath_public_token;

    console.log('backend publicToken (primeros/últimos 4):', athPublicToken ? `${athPublicToken.substring(0, 4)}...${athPublicToken.slice(-4)}` : 'N/A');
    if (publicToken && athPublicToken && publicToken !== athPublicToken) {
      console.warn('⚠️ ADVERTENCIA: El publicToken del cliente no coincide con el del backend!');
    }
    console.log('--------------------------------');

    if (!referenceNumber || !cleanEcommerceId) {
      return res.status(400).json({ error: 'referenceNumber y ecommerceId son obligatorios.' });
    }

    if (!athPrivateToken || !athPublicToken) {
      console.error('ATH tokens no configurados en Secrets Manager.');
      return res.status(500).json({ error: 'Configuración de ATH Móvil incompleta.' });
    }

    // Crear JWT para autenticarse con la API de ATH Móvil
    const athJwt = jwt.sign(
      { publicToken: athPublicToken },
      athPrivateToken,
      { expiresIn: '10m' }
    );

    // Verificar el pago con ATH Móvil API
    const athResponse = await fetch(
      'https://payments.athmovil.com/api/business-transaction/ecommerce/business/findPayment',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${athJwt}`,
        },
        body: JSON.stringify({
          publicToken: athPublicToken,
          ecommerceId: cleanEcommerceId,
        }),
      }
    );

    if (!athResponse.ok) {
      const errorText = await athResponse.text();
      console.error('Error en ATH API:', athResponse.status, errorText);

      // Bypass especial para iOS debido a la incompatibilidad con ecommerceId/paymentId nativo
      let errorObj = {};
      try {
        errorObj = JSON.parse(errorText || '{}');
      } catch (e) {
        // Ignorar error de parsing si no es un JSON
      }
      
      const isIdNotExistError = athResponse.status === 409 && 
        (errorObj.errorcode === 'BTRA_0031' || errorText.includes('does not exist') || errorText.includes('EcommerceId'));

      if (isIdNotExistError && rawResponse && rawResponse.status === 'COMPLETED' && rawResponse.referenceNumber) {
        console.warn('⚠️ [iOS BYPASS] La API de Evertec no reconoció el ecommerceId, pero se recibió una confirmación de pago nativa válida (rawResponse) en iOS. Aplicando bypass de seguridad.');
        
        // Responder con éxito usando los datos locales de la transacción
        return res.json({
          success: true,
          referenceNumber: rawResponse.referenceNumber,
          total: rawResponse.total || total,
          status: 'COMPLETED',
          message: 'Bypass aplicado por incompatibilidad de ID en iOS.'
        });
      }

      return res.status(400).json({
        success: false,
        error: `Error al verificar con ATH Móvil: ${athResponse.status}`,
      });
    }

    const athData = await athResponse.json();
    console.log('Respuesta de ATH Móvil:', JSON.stringify(athData));

    // Verificar que el pago está confirmado
    if (athData.ecommerceStatus !== 'CONFIRMED' && athData.status !== 'completed') {
      return res.json({
        success: false,
        error: `Pago no confirmado. Estado: ${athData.ecommerceStatus || athData.status}`,
      });
    }

    // Verificar que el monto coincide (si se proporcionó)
    if (total && athData.total) {
      const expectedTotal = parseFloat(total);
      const actualTotal = parseFloat(athData.total);
      if (Math.abs(expectedTotal - actualTotal) > 0.01) {
        return res.json({
          success: false,
          error: `Monto no coincide. Esperado: ${expectedTotal}, Recibido: ${actualTotal}`,
        });
      }
    }

    // Pago verificado exitosamente
    console.log('✅ Pago ATH verificado:', referenceNumber);

    res.json({
      success: true,
      referenceNumber: athData.referenceNumber || referenceNumber,
      total: athData.total,
      status: athData.ecommerceStatus || athData.status,
    });

  } catch (error) {
    console.error('Error en /verifyATHPayment:', error.message);
    res.status(500).json({ error: 'Error al verificar el pago' });
  }
});

// -------------------- ENDPOINT: MERGE DE PDFs --------------------

// Promisifica el pipeline de streams
const pipelinePromise = promisify(stream.pipeline);

// Función para convertir un stream a buffer
async function streamToBuffer(readableStream) {
  const chunks = [];
  try {
    for await (const chunk of readableStream) {
      chunks.push(chunk);
    }
    console.log('Stream convertido a buffer correctamente.');
    return Buffer.concat(chunks);
  } catch (error) {
    console.error('Error al convertir el stream a buffer:', error.message);
    throw error;
  }
}

// Función básica para verificar si un buffer es un PDF (verifica encabezado)
function isPDF(buffer) {
  const result = buffer.slice(0, 4).toString() === '%PDF';
  console.log(`Verificación de PDF: ${result}`);
  return result;
}

// Función para convertir una imagen (buffer) a PDF utilizando PDFKit
async function convertImageToPDF(imageBuffer) {
  console.log('Convirtiendo imagen a PDF...');
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocumentKit({ autoFirstPage: false });
      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        const pdfData = Buffer.concat(buffers);
        console.log('Imagen convertida a PDF exitosamente.');
        resolve(pdfData);
      });
      doc.addPage();
      doc.image(imageBuffer, {
        fit: [500, 700],
        align: 'center',
        valign: 'center'
      });
      doc.end();
    } catch (err) {
      console.error('Error al convertir imagen a PDF:', err.message);
      reject(err);
    }
  });
}

// Función para unir varios PDFs utilizando pdf-lib
async function mergePDFBuffers(pdfBuffers) {
  console.log('Iniciando el merge de PDFs...');
  try {
    const mergedPdf = await PDFDocument.create();
    for (const [index, pdfBuffer] of pdfBuffers.entries()) {
      console.log(`Procesando PDF ${index + 1}/${pdfBuffers.length}...`);
      const pdf = await PDFDocument.load(pdfBuffer);
      const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      copiedPages.forEach(page => mergedPdf.addPage(page));
    }
    const mergedData = await mergedPdf.save();
    console.log('Merge de PDFs completado.');
    return mergedData;
  } catch (error) {
    console.error('Error al unir PDFs:', error.message);
    throw error;
  }
}

// Función para optimizar el PDF utilizando Ghostscript (requiere Ghostscript instalado)
async function optimizePDF(inputBuffer) {
  console.log('Iniciando optimización del PDF...');
  const tempDir = os.tmpdir();
  const tempInput = path.join(tempDir, `temp_${Date.now()}.pdf`);
  const tempOutput = path.join(tempDir, `optimized_${Date.now()}.pdf`);
  try {
    fs.writeFileSync(tempInput, inputBuffer);
    console.log(`PDF temporal escrito en ${tempInput}`);

    const gsArgs = [
      '-sDEVICE=pdfwrite',
      '-dCompatibilityLevel=1.4',
      '-dPDFSETTINGS=/ebook',
      '-dNOPAUSE',
      '-dQUIET',
      '-dBATCH',
      `-sOutputFile=${tempOutput}`,
      tempInput,
    ];
    console.log(`Ejecutando Ghostscript: ${gsExecutable} ${gsArgs.join(' ')}`);

    await new Promise((resolve, reject) => {
      execFile(gsExecutable, gsArgs, (error, stdout, stderr) => {
        if (error) {
          console.error('Error al ejecutar Ghostscript:', error.message);
          return reject(error);
        }
        console.log('Ghostscript ejecutado correctamente.');
        resolve();
      });
    });

    const optimizedBuffer = fs.readFileSync(tempOutput);
    console.log(`PDF optimizado leído desde ${tempOutput}`);

    fs.unlinkSync(tempInput);
    fs.unlinkSync(tempOutput);
    console.log('Archivos temporales eliminados.');
    return optimizedBuffer;
  } catch (error) {
    console.error('Error durante la optimización del PDF:', error.message);
    try { fs.unlinkSync(tempInput); } catch (_) {}
    try { fs.unlinkSync(tempOutput); } catch (_) {}
    throw error;
  }
}

// Función para extraer la key del archivo a partir de la URL
function extractKeyFromUrl(url) {
  const key = url.split('/').pop();
  console.log(`Key extraída de URL: ${key}`);
  return key;
}

// Endpoint para hacer merge de PDFs (con conversión de imágenes)
app.post('/mergePDFs', verificarJWT, async (req, res) => {
  try {
    console.log('--- Inicio del endpoint /mergePDFs ---');
    const { urls } = req.body;
    if (!urls || !urls.length) {
      console.error('No se proporcionaron URLs en la petición.');
      return res.status(400).json({ error: 'No se proporcionaron URLs.' });
    }

    const validUrls = urls.filter(u => typeof u === 'string' && u.trim() !== '');
    if (!validUrls.length) {
      return res.status(400).json({ error: 'No hay URLs válidas para procesar.' });
    }

    const bucketName = uploadBucketName;
    const pdfBuffers = [];
    console.log(`Recibidas ${urls.length} URLs para procesar.`);

    for (const [index, url] of validUrls.entries()) {
      console.log(`Procesando URL ${index + 1}: ${url}`);
      const key = sanitizeFilename(extractKeyFromUrl(url));

      // ANTI-IDOR: cada clave debe pertenecer al usuario autenticado.
      const authz = authorizeKeyOwnership(req, key);
      if (!authz.ok) {
        return res.status(authz.status).json({ error: authz.error });
      }

      const getParams = { Bucket: bucketName, Key: key };
      try {
        const command = new GetObjectCommand(getParams);
        const { Body } = await s3Client.send(command);
        console.log(`Archivo descargado: ${key}`);
        const fileBuffer = await streamToBuffer(Body);

        if (isPDF(fileBuffer)) {
          console.log(`El archivo ${key} es un PDF.`);
          pdfBuffers.push(fileBuffer);
        } else {
          console.log(`El archivo ${key} NO es un PDF. Convirtiendo imagen a PDF...`);
          const pdfBuffer = await convertImageToPDF(fileBuffer);
          pdfBuffers.push(pdfBuffer);
        }
      } catch (error) {
        const isMissing = error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404;
        if (isMissing) {
          console.warn(`El archivo ${key} no existe en S3. Se omite y continúa.`);
          continue;
        }
        console.error(`Error procesando la URL ${url}:`, error.message);
        return res.status(500).json({ error: `Error procesando el archivo de la URL: ${url}` });
      }
    }

    if (pdfBuffers.length === 0) {
      console.warn('No hay archivos válidos para mergear.');
      return res.status(400).json({ error: 'Ningún documento válido encontrado para merge.' });
    }

    const mergedPdfBuffer = await mergePDFBuffers(pdfBuffers);
    console.log('Merge de PDFs completado.');

    const mergedKey = `merged_${Date.now()}.pdf`;
    console.log(`Key asignada para el PDF final: ${mergedKey}`);

    const uploadParams = {
      Bucket: bucketName,
      Key: mergedKey,
      Body: mergedPdfBuffer,
      ContentType: 'application/pdf'
    };
    console.log('Subiendo PDF final a S3...');
    const putCommand = new PutObjectCommand(uploadParams);
    await s3Client.send(putCommand);
    console.log('PDF final subido a S3 exitosamente.');

    res.json({ message: 'Merge realizado exitosamente.', key: mergedKey });
    console.log('--- Fin del endpoint /mergePDFs ---');
  } catch (err) {
    console.error('Error en mergePDFs:', err.message);
    res.status(500).json({ error: 'Error al procesar el merge de archivos.' });
  }
});

// -------------------- ENDPOINT DE CONTACTO DE SOPORTE --------------------
// Envía un correo con los datos del formulario a info@vigmortgage.com
app.post('/support/contact', supportLimiter, async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;

    if (!name || !email || !subject || !message) {
      return res.status(400).json({ error: 'Todos los campos son requeridos (name, email, subject, message).' });
    }

    // Validar tipos y longitudes para evitar payloads abusivos.
    if (typeof name !== 'string' || typeof subject !== 'string' || typeof message !== 'string') {
      return res.status(400).json({ error: 'Formato de campos inválido.' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'El correo de contacto no es válido.' });
    }
    if (name.length > 120 || subject.length > 200 || message.length > 5000) {
      return res.status(400).json({ error: 'Uno o más campos exceden la longitud permitida.' });
    }

    // Sanitizar: valores que van a CABECERAS SMTP no pueden contener CR/LF;
    // valores que van al cuerpo HTML se escapan para evitar inyección de markup.
    const safeName = sanitizeHeaderValue(name);
    const safeSubject = sanitizeHeaderValue(subject);
    const safeEmail = sanitizeHeaderValue(email);
    const htmlName = escapeHtml(safeName);
    const htmlEmail = escapeHtml(safeEmail);
    const htmlSubject = escapeHtml(safeSubject);
    const htmlMessage = escapeHtml(message);

    console.log(`[SOPORTE] Recibido mensaje de ${safeName} (${safeEmail}): Asunto: ${safeSubject}`);

    // Para enviar el correo, usaremos el cliente SMTP nativo con las credenciales del secreto 'Mail'
    const mailSecrets = await getMailSecrets();
    const smtpHost = mailSecrets?.MAIL_HOST || 'mail.smtp2go.com';
    const smtpPort = mailSecrets?.MAIL_PORT || '2525';
    const smtpUser = mailSecrets?.MAIL_USERNAME || 'vigmortgage';
    const smtpPass = mailSecrets?.MAIL_PASSWORD;

    if (!smtpPass) {
      console.warn('⚠️ Credenciales del secreto Mail no encontradas. Simulando el envío del correo en consola.');
      console.log('--- EMAIL SIMULADO ---');
      console.log(`Para: info@vigmortgage.com`);
      console.log(`De: ${safeName} <${safeEmail}>`);
      console.log(`Asunto: [Soporte App] ${safeSubject}`);
      console.log('Mensaje: [omitido del log]');
      console.log('----------------------');

      return res.json({ message: 'Mensaje de soporte enviado exitosamente (Simulado).' });
    }

    // Formato HTML del correo para soporte
    const htmlTemplate = `<div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 600px; border: 1px solid #e0e0e0; border-radius: 8px;">
      <h2 style="color: #0A6FAF; margin-top: 0;">Nuevo Mensaje de Soporte</h2>
      <p style="color: #666; font-size: 14px;">Recibido desde la aplicación móvil VIG Loans</p>
      <hr style="border: 0; border-top: 1px solid #eee; margin: 15px 0;" />
      <p style="margin: 8px 0;"><strong>Nombre:</strong> ${htmlName}</p>
      <p style="margin: 8px 0;"><strong>Correo de contacto:</strong> <a href="mailto:${htmlEmail}" style="color: #0A6FAF;">${htmlEmail}</a></p>
      <p style="margin: 8px 0;"><strong>Asunto:</strong> ${htmlSubject}</p>
      <div style="background-color: #f8fafc; padding: 15px; border-left: 4px solid #0A6FAF; border-radius: 4px; margin-top: 15px;">
        <p style="white-space: pre-wrap; margin: 0; font-size: 14px; line-height: 1.5;">${htmlMessage}</p>
      </div>
      <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0 10px 0;" />
      <p style="font-size: 12px; color: #999; text-align: center; margin: 0;">Puedes responder a este correo para comunicarte directamente con ${htmlName}.</p>
    </div>`;

    // Envío por SMTP2GO con `lib/mailer.js` (nodemailer, TLS verificado).
    //
    // Se respeta el secreto `Mail` TAL CUAL: MAIL_PORT=443 y
    // MAIL_ENCRYPTION=ssl. El cliente casero anterior ignoraba ambos y clavaba
    // el puerto 2525, que no negocia TLS: la contraseña de SMTP2GO viajaba
    // legible en cada mensaje de soporte.
    const mailer = createMailer({ credentials: mailSecrets });
    await mailer.sendMail({
      from: 'info@vigmortgage.com',
      to: 'info@vigmortgage.com',
      replyTo: safeEmail,
      subject: `[Soporte App] ${safeSubject}`,
      html: htmlTemplate,
    });

    console.log('✅ Correo de soporte enviado exitosamente vía SMTP2GO.');
    return res.json({ message: 'Mensaje de soporte enviado exitosamente.' });

  } catch (error) {
    console.error('Error en /support/contact:', error.message);
    res.status(500).json({ error: 'Error interno al procesar el contacto de soporte.' });
  }
});

// El cliente SMTP casero vivia aqui. Iba por TCP en claro al puerto 2525 y
// nunca emitia STARTTLS, asi que la contrasena de SMTP2GO viajaba legible.
// Sustituido por `lib/mailer.js` (nodemailer con TLS verificado).

// -------------------- MANEJO DE ERRORES (después de todas las rutas) --------------------
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
app.use(notFoundHandler);   // 404 JSON para rutas no registradas
app.use(errorHandler);      // manejador central: no filtra internals al cliente

// -------------------- INICIAR EL SERVIDOR --------------------
// Precargar secretos antes de que el servidor acepte conexiones
async function startServer() {
  try {
    // Precargar secretos al inicio
    console.log('Cargando secretos desde AWS Secrets Manager...');
    const backendSecrets = await getBackendSecrets();
    await getAppConfig();

    // Actualizar bucket name desde Secrets Manager
    if (backendSecrets.s3_bucket_name) {
      uploadBucketName = backendSecrets.s3_bucket_name;
      console.log(`✅ Bucket S3 configurado: ${uploadBucketName}`);
    }
    console.log('✅ Secretos cargados correctamente.');
  } catch (error) {
    console.warn('⚠️ No se pudieron cargar los secretos al inicio:', error.message);
    console.warn('El servidor iniciará con fallbacks. Los secretos se cargarán bajo demanda.');
  }

  const server = app.listen(port, () => {
    console.log(`Servidor escuchando en el puerto: ${port}`);
  });

  // Configuración de timeouts para producción
  server.timeout = parseInt(process.env.SERVER_TIMEOUT || '120000', 10);
  server.keepAliveTimeout = parseInt(process.env.KEEP_ALIVE_TIMEOUT || '65000', 10);
  server.headersTimeout = parseInt(process.env.HEADERS_TIMEOUT || '66000', 10);

  // Manejo de errores del servidor
  server.on('error', (err) => {
    console.error('Error del servidor:', err);
    if (err.code === 'EADDRINUSE') {
      console.error(`Puerto ${port} ya está en uso`);
      process.exit(1);
    }
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('SIGTERM recibido, cerrando servidor...');
    server.close(() => {
      console.log('Servidor cerrado');
      process.exit(0);
    });
  });
}

startServer();
