const express = require('express');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const multer = require('multer');
const multerS3 = require('multer-s3');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 3000;
require('dotenv').config();


// Configura AWS SDK v3
const s3Client = new S3Client({
  region: 'us-east-1',
  credentials: {

  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  }
});

// Configura Multer para usar multer-s3
const upload = multer({
  storage: multerS3({
    s3: s3Client,
    bucket: 'vigpr-sf-prod',
    key: function (req, file, cb) {
      cb(null, file.originalname);
    }
  })
});

// Middleware de registro de solicitudes con Morgan
const accessLogStream = fs.createWriteStream(path.join(__dirname, 'access.log'), { flags: 'a' });
app.use(morgan('combined', { stream: accessLogStream }));

// Endpoint para subir archivos a S3
app.post('/uploadFile', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      throw new Error('No se recibió ningún archivo');
    }
    console.log('Archivo subido:', req.file.originalname);
    res.send("Archivo subido con éxito.");
  } catch (err) {
    console.error('Error en uploadFile:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// Endpoint para descargar archivos de S3
app.get('/downloadFile/:key', async (req, res) => {
  const key = req.params.key;

  const getParams = {
    Bucket: 'vigpr-sf-prod',
    Key: key,
  };

  try {
    const command = new GetObjectCommand(getParams);
    const { Body } = await s3Client.send(command);

    res.setHeader('Content-Disposition', `attachment; filename=${key}`);
    Body.pipe(res);
  } catch (err) {
    console.error('Error en downloadFile:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint para eliminar archivos de S3
app.delete('/deleteFile/:key', async (req, res) => {
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

app.listen(port, () => {
  console.log(`Servidor escuchando en el puerto:${port}`);
});
