import jwt from 'jsonwebtoken';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import dotenv from 'dotenv';

dotenv.config();

const smClient = new SecretsManagerClient({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.SM_AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.SM_AWS_SECRET_ACCESS_KEY,
  }
});

async function main() {
  try {
    console.log('Obteniendo JWT Secret del Secrets Manager...');
    const command = new GetSecretValueCommand({ SecretId: 'vigloans/backend' });
    const response = await smClient.send(command);
    const secrets = JSON.parse(response.SecretString);

    const testToken = jwt.sign(
      { username: 'test_real_support', source: 'test' },
      secrets.jwt_secret_key,
      { expiresIn: '5m' }
    );

    // Host del backend de producción
    const url = 'https://vigloans-v2.vigappdocs.com/support/contact';

    console.log(`Enviando mensaje de prueba REAL a ${url}...`);
    const apiResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${testToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Prueba de Soporte VIG App',
        email: 'test_soporte@vigmortgage.com',
        subject: 'Mensaje de Prueba de Envío Real - SMTP2GO',
        message: 'Esta es una prueba de verificación del sistema de soporte desde la App VIG Loans utilizando la API de SMTP2GO.'
      })
    });

    const status = apiResponse.status;
    const data = await apiResponse.json();

    console.log(`\n=== RESPUESTA DEL SERVIDOR (Status: ${status}) ===`);
    console.log(data);

    if (status === 200) {
      console.log('\n✅ Petición procesada con éxito por el servidor de producción.');
    } else {
      console.error('\n❌ La petición falló.');
    }
  } catch (error) {
    console.error('Error durante la prueba:', error.message);
  }
}

main();
