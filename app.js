const express = require('express');
const multer = require('multer');
const AWS = require('aws-sdk');

const app = express();
const port = 3000;

// Configura AWS
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

const s3 = new AWS.S3();

// Configura Multer para manejar la carga de archivos
const upload = multer({ dest: 'uploads/' });

// Endpoint para subir archivos
app.post('/upload', upload.single('file'), (req, res) => {
  const file = req.file;

  const params = {
    Bucket: 'vigpr-sf-prod',
    Key: file.originalname,
    Body: file.buffer,
  };

  s3.upload(params, (err, data) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    res.json({ message: 'Archivo subido con éxito', data });
  });
});

// Endpoint para descargar archivos
app.get('/download/:key', (req, res) => {
  const key = req.params.key;

  const params = {
    Bucket: 'vigpr-sf-prod',
    Key: key,
  };

  s3.getObject(params, (err, data) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    res.setHeader('Content-Disposition', `attachment; filename=${key}`);
    res.send(data.Body);
  });
});

// Endpoint para eliminar archivos
app.delete('/delete/:key', (req, res) => {
  const key = req.params.key;

  const params = {
    Bucket: 'vigpr-sf-prod',
    Key: key,
  };

  s3.deleteObject(params, (err, data) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    res.json({ message: 'Archivo eliminado con éxito', data });
  });
});

app.listen(port, () => {
  console.log(`Servidor en http://localhost:${port}`);
});
