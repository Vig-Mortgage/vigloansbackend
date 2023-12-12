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
    Bucket: 'nombre-de-tu-bucket',
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

// Agrega más endpoints según tus necesidades (descargar, eliminar, etc.)

app.listen(port, () => {
  console.log(`Servidor en http://localhost:${port}`);
});
