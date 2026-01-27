const express = require('express');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const multer = require('multer');
const multerS3 = require('multer-s3');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { PDFDocument } = require('pdf-lib');
const PDFDocumentKit = require('pdfkit');
const stream = require('stream');
const { promisify } = require('util');
const { exec } = require('child_process');
const os = require('os');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8080;
const SECRET_KEY = process.env.JWT_SECRET_KEY;
const gsExecutable = process.env.GS_EXECUTABLE || 'gs';

// Middleware para parsear JSON a nivel global
app.use(express.json());

// -------------------- HEALTH CHECK ENDPOINT --------------------
// Endpoint para el balanceador de carga (ELB/ALB)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'vigloansbackend',
    uptime: process.uptime()
  });
});

// Endpoint raíz para health checks del balanceador
app.get('/', (req, res) => {
  // Verificar si es un health check del balanceador
  const userAgent = req.get('user-agent') || '';
  if (userAgent.includes('ELB-HealthChecker') || userAgent.includes('HealthChecker')) {
    return res.status(200).json({ status: 'ok' });
  }
  res.status(404).json({ error: 'Not Found' });
});

// -------------------- ENDPOINT DE AUTENTICACIÓN --------------------
// Puedes ajustar la validación de credenciales según tus necesidades.
// En este ejemplo se utiliza usuario y contraseña fijos.
app.post('/authenticate', (req, res) => {
  console.log('req.body', req.body);
  const { username, password } = req.body;
  // Validar las credenciales (puedes hacerlo consultando una base de datos, por ejemplo)
  if (username === 'vigprsalesforce' && password === '5cBJ*THL') {
    // Genera el token con un payload básico. Puedes incluir la información que requieras.
    const token = jwt.sign({ username }, SECRET_KEY, { expiresIn: '1h' });
    return res.json({ token });
  }
  res.status(401).json({ error: 'Credenciales inválidas' });
});

// -------------------- MIDDLEWARE PARA VERIFICAR JWT --------------------
function verificarJWT(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1]; // Formato: Bearer <token>
  if (!token) {
    return res.status(403).send({ message: "Token no proporcionado." });
  }
  jwt.verify(token, SECRET_KEY, (err, decoded) => {
    if (err) {
      return res.status(401).send({ message: "Token inválido." });
    }
    req.usuario = decoded;
    next();
  });
}

// -------------------- CONFIGURACIÓN DE AWS SDK --------------------
const s3Client = new S3Client({
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  }
});

// -------------------- CONFIGURACIÓN DE MULTER --------------------
const upload = multer({
  storage: multerS3({
    s3: s3Client,
    bucket: 'vigpr-sf-prod',
    contentType: multerS3.AUTO_CONTENT_TYPE, // Autodetecta y establece el Content-Type
    key: function (req, file, cb) {
      cb(null, file.originalname);
    }
  })
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
  const key = req.params.key;
  const getParams = {
    Bucket: 'vigpr-sf-prod',
    Key: key,
  };

  console.log('=== DOWNLOAD REQUEST ===');
  console.log('Key solicitada:', key);
  console.log('Bucket:', getParams.Bucket);
  console.log('AWS Access Key en uso:', process.env.AWS_ACCESS_KEY_ID);
  console.log('========================');

  try {
    const command = new GetObjectCommand(getParams);
    const { Body } = await s3Client.send(command);
    res.setHeader('Content-Disposition', `attachment; filename=${key}`);
    Body.pipe(res);
    console.log('✅ Descarga exitosa:', key);
  } catch (err) {
    console.error('❌ Error en downloadFile:', err.message);
    console.error('Key que falló:', key);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- ENDPOINT PARA ELIMINAR ARCHIVOS DE S3 --------------------
app.delete('/deleteFile/:key', verificarJWT, async (req, res) => {
  const key = req.params.key;
  const deleteParams = {
    Bucket: 'vigpr-sf-prod',
    Key: key,
  };
  try {
    const command = new DeleteObjectCommand(deleteParams);
    await s3Client.send(command);
    console.log('Archivo eliminado:', key);
    res.json({ message: 'Archivo eliminado con éxito' });
  } catch (err) {
    console.error('Error en deleteFile:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// -------------------- NUEVO ENDPOINT: MERGE DE PDFs --------------------

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
      // Agrega una página y coloca la imagen. Ajusta dimensiones según sea necesario.
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
async function mergePDFs(pdfBuffers) {
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
  const tempInput = `${tempDir}/temp_${Date.now()}.pdf`;
  const tempOutput = `${tempDir}/optimized_${Date.now()}.pdf`;
  try {
    fs.writeFileSync(tempInput, inputBuffer);
    console.log(`PDF temporal escrito en ${tempInput}`);

    // Comando Ghostscript para optimizar PDF
    const gsCommand = `"${gsExecutable}" -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dNOPAUSE -dQUIET -dBATCH -sOutputFile=${tempOutput} ${tempInput}`;
    console.log(`Ejecutando comando Ghostscript: ${gsCommand}`);

    await new Promise((resolve, reject) => {
      exec(gsCommand, (error, stdout, stderr) => {
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

    // Eliminar archivos temporales
    fs.unlinkSync(tempInput);
    fs.unlinkSync(tempOutput);
    console.log('Archivos temporales eliminados.');
    return optimizedBuffer;
  } catch (error) {
    console.error('Error durante la optimización del PDF:', error.message);
    // Intentar eliminar archivos temporales en caso de error
    try { fs.unlinkSync(tempInput); } catch (_) {}
    try { fs.unlinkSync(tempOutput); } catch (_) {}
    throw error;
  }
}

// Función para extraer la key del archivo a partir de la URL (ajusta según la estructura de tus URLs)
function extractKeyFromUrl(url) {
  const key = url.split('/').pop();
  console.log(`Key extraída de URL: ${key}`);
  return key;
}

// Endpoint para hacer merge de PDFs (con conversión de imágenes y optimización)
app.post('/mergePDFs', verificarJWT, async (req, res) => {
  try {
    console.log('--- Inicio del endpoint /mergePDFs ---');
    const { urls } = req.body;
    if (!urls || !urls.length) {
      console.error('No se proporcionaron URLs en la petición.');
      return res.status(400).json({ error: 'No se proporcionaron URLs.' });
    }

    // Filtramos null, undefined y strings vacíos
    const validUrls = urls.filter(u => typeof u === 'string' && u.trim() !== '');
    if (!validUrls.length) {
      return res.status(400).json({ error: 'No hay URLs válidas para procesar.' });
    }

    const pdfBuffers = [];
    console.log(`Recibidas ${urls.length} URLs para procesar.`);

    // Descarga y procesamiento de cada archivo
    for (const [index, url] of validUrls.entries()) {
      console.log(`Procesando URL ${index + 1}: ${url}`);
      const key = extractKeyFromUrl(url);
      const getParams = { Bucket: 'vigpr-sf-prod', Key: key };
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
        // Si el objeto no existe, lo ignoramos y seguimos con el siguiente
        const isMissing = error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404;
        if (isMissing) {
          console.warn(`El archivo ${key} no existe en S3. Se omite y continúa.`);
          continue;
        }
        // Para otros errores, respondemos con fallo
        console.error(`Error procesando la URL ${url}:`, error.message);
        return res.status(500).json({ error: `Error procesando el archivo de la URL: ${url}` });
      }
    }

    if (pdfBuffers.length === 0) {
      console.warn('No hay archivos válidos para mergear.');
      return res.status(400).json({ error: 'Ningún documento válido encontrado para merge.' });
    }

    // Merge de los PDFs
    const mergedPdfBuffer = await mergePDFs(pdfBuffers);
    console.log('Merge de PDFs completado.');

    // Se elimina la optimización, por lo que se usará mergedPdfBuffer directamente.
    // const optimizedPdfBuffer = await optimizePDF(mergedPdfBuffer);
    // console.log('Optimización del PDF completada.');

    // Genera una key única para el PDF final
    const mergedKey = `merged_${Date.now()}.pdf`;
    console.log(`Key asignada para el PDF final: ${mergedKey}`);

    // Sube el PDF mergeado (sin optimización) a S3
    const uploadParams = {
      Bucket: 'vigpr-sf-prod',
      Key: mergedKey,
      Body: mergedPdfBuffer,  // Usamos el buffer resultante del merge directamente
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
    res.status(500).json({ error: err.message });
  }
});

const server = app.listen(port, () => {
  console.log(`Servidor escuchando en el puerto: ${port}`);
});

// Configuración de timeouts para producción
server.timeout = parseInt(process.env.SERVER_TIMEOUT || '120000', 10); // 120 segundos por defecto
server.keepAliveTimeout = parseInt(process.env.KEEP_ALIVE_TIMEOUT || '65000', 10); // 65 segundos
server.headersTimeout = parseInt(process.env.HEADERS_TIMEOUT || '66000', 10); // 66 segundos (debe ser > keepAliveTimeout)

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
