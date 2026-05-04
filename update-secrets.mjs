// Script para agregar los secretos faltantes a vigloans/app-config
// Los valores se toman de los hardcoded que estamos eliminando de la app.
// Ejecutar con: node update-secrets.mjs

import { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { config } from 'dotenv';

config();

const client = new SecretsManagerClient({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.SM_AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.SM_AWS_SECRET_ACCESS_KEY,
  },
});

async function updateSecrets() {
  try {
    // 1. Leer config actual
    const getCommand = new GetSecretValueCommand({ SecretId: 'vigloans/app-config' });
    const response = await client.send(getCommand);
    const currentConfig = JSON.parse(response.SecretString);

    console.log('Config actual:', Object.keys(currentConfig));

    // 2. Agregar los secretos faltantes
    // Estos valores venían hardcoded en la app Flutter
    currentConfig.sf_client_secret_ios = '632F1061CDE36A767AF168CE3C1849F6CF1CABC51F6EBD5BD4910D884AD2C439';
    currentConfig.paypal_secret_key = 'EGbfgCW491MX3EV5GlzqzTrzuCGVjJqvPryhqY5g8LvbIDdcTCGTCbkXGQAH6sS1_YAiyKk6-EtEKMlD';

    // 3. Guardar
    const putCommand = new PutSecretValueCommand({
      SecretId: 'vigloans/app-config',
      SecretString: JSON.stringify(currentConfig),
    });
    await client.send(putCommand);

    console.log('✅ Secretos actualizados correctamente:');
    console.log('  - sf_client_secret_ios: AGREGADO');
    console.log('  - paypal_secret_key: AGREGADO');
    console.log('\nCampos totales:', Object.keys(currentConfig));
  } catch (e) {
    console.error('❌ Error:', e.message);
  }
}

updateSecrets();
