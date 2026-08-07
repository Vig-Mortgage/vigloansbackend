// Script para verificar los campos del secreto vigloans/app-config
// Ejecutar con: node scripts/check-app-config.mjs

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { config } from 'dotenv';
import { writeFileSync } from 'fs';

config();

const client = new SecretsManagerClient({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.SM_AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.SM_AWS_SECRET_ACCESS_KEY,
  },
});

async function checkConfig() {
  try {
    const command = new GetSecretValueCommand({ SecretId: 'vigloans/app-config' });
    const response = await client.send(command);
    const config = JSON.parse(response.SecretString);
    
    console.log('=== Campos en vigloans/app-config ===');
    console.log(JSON.stringify(Object.keys(config), null, 2));
    
    // Verificar campos necesarios para los proxys
    const requiredFields = [
      'sf_host', 'sf_community_host', 'sf_client_id_ios', 'sf_client_secret_ios',
      'sf_redirect_url', 'paypal_domain_url', 'paypal_client_id', 'paypal_secret_key',
      'ath_public_token', 'node_host'
    ];
    
    console.log('\n=== Campos requeridos ===');
    for (const field of requiredFields) {
      const exists = config[field] !== undefined;
      const value = exists ? (field.includes('secret') || field.includes('key') ? '***PRESENT***' : config[field]) : 'FALTA';
      console.log(`${exists ? '✅' : '❌'} ${field}: ${value}`);
    }

    writeFileSync('config-check-result.json', JSON.stringify({ keys: Object.keys(config), checks: requiredFields.map(f => ({ field: f, exists: config[f] !== undefined })) }, null, 2));
    console.log('\nResultado guardado en config-check-result.json');
  } catch (e) {
    console.error('Error:', e.message);
  }
}

checkConfig();
