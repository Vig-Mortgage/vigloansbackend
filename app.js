const express = require('express');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const multer = require('multer');
const multerS3 = require('multer-s3');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');

const app = express();
const port = 8080;
require('dotenv').config();
console.log(process.env);
const jwt = require('jsonwebtoken');

const SECRET_KEY = process.env.JWT_SECRET_KEY;

function verificarJWT(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1]; // Bearer <token>

  if (!token) {
    return res.status(403).send({ message: "Token no proporcionado." });
  }

  jwt.verify(token, SECRET_KEY, (err, decoded) => {
    if (err) {
      return res.status(401).send({ message: "Token inválido." });
    }

    req.usuario = decoded; // Guarda la información decodificada del token
    next();
  });
}



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
    contentType: multerS3.AUTO_CONTENT_TYPE, // Autodetecta y establece el Content-Type
    key: function (req, file, cb) {
      cb(null, file.originalname);
    }
  })
});

// Middleware de registro de solicitudes con Morgan
const accessLogStream = fs.createWriteStream(path.join(__dirname, 'access.log'), { flags: 'a' });
app.use(morgan('combined', { stream: accessLogStream }));

// Endpoint para subir archivos a S3
app.post('/uploadFile', verificarJWT, upload.single('file'), async (req, res) => {
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
app.get('/downloadFile/:key', verificarJWT, async (req, res) => {
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

app.listen(port, () => {
  console.log(`Servidor escuchando en el puerto:${port}`);
});

