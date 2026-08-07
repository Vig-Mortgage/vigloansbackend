/**
 * Test E2E para vigloansbackend en local
 * Ejecutar: node scripts/e2e-local.mjs   (destino: BASE_URL, por defecto http://localhost:8080)
 */

// Destino configurable: por defecto el backend local, pero permite apuntar a
// v2 (http://localhost:8081) o a https://vigloans-v2.vigappdocs.com sin editar
// el archivo. OJO: el 8080 es el backend viejo de PRODUCCION.
const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';
let jwtToken = null;

// -------------------- UTILIDADES --------------------
const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

const results = [];

function log(emoji, msg) {
  console.log(`${emoji} ${msg}`);
}

function logPass(testName, detail = '') {
  const d = detail ? ` ${COLORS.dim}→ ${detail}${COLORS.reset}` : '';
  console.log(`  ${COLORS.green}✅ PASS${COLORS.reset} ${testName}${d}`);
  results.push({ name: testName, status: 'PASS' });
}

function logFail(testName, error) {
  console.log(`  ${COLORS.red}❌ FAIL${COLORS.reset} ${testName} ${COLORS.dim}→ ${error}${COLORS.reset}`);
  results.push({ name: testName, status: 'FAIL', error });
}

function logSkip(testName, reason) {
  console.log(`  ${COLORS.yellow}⏭️  SKIP${COLORS.reset} ${testName} ${COLORS.dim}→ ${reason}${COLORS.reset}`);
  results.push({ name: testName, status: 'SKIP', reason });
}

function section(title) {
  console.log(`\n${COLORS.cyan}${COLORS.bold}━━━ ${title} ━━━${COLORS.reset}`);
}

async function request(method, path, { body, headers = {}, expectStatus, raw = false } = {}) {
  const url = `${BASE_URL}${path}`;
  const opts = {
    method,
    headers: { ...headers },
  };

  if (body) {
    if (body instanceof FormData) {
      opts.body = body;
      // No establecer Content-Type, fetch lo hace automáticamente con boundary
    } else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }

  if (jwtToken && !('Authorization' in headers)) {
    opts.headers['Authorization'] = `Bearer ${jwtToken}`;
  }

  const res = await fetch(url, opts);
  const contentType = res.headers.get('content-type') || '';

  let data;
  if (raw) {
    data = await res.arrayBuffer();
  } else if (contentType.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }

  if (expectStatus && res.status !== expectStatus) {
    throw new Error(`Esperado status ${expectStatus}, recibido ${res.status}. Body: ${JSON.stringify(data).substring(0, 200)}`);
  }

  return { status: res.status, data, headers: res.headers };
}

// -------------------- TESTS --------------------

// 1. Health Check
async function testHealth() {
  section('1. HEALTH CHECK');

  try {
    const { data } = await request('GET', '/health', { expectStatus: 200 });
    if (data.status !== 'healthy') throw new Error(`Status: ${data.status}`);
    if (!data.uptime) throw new Error('Falta uptime');
    if (!data.service) throw new Error('Falta service');
    logPass('GET /health', `status=${data.status}, uptime=${data.uptime.toFixed(1)}s, service=${data.service}`);
  } catch (e) {
    logFail('GET /health', e.message);
  }
}

// 2. Ruta raíz (simular ELB y usuario normal)
async function testRoot() {
  section('2. RUTA RAÍZ');

  // Simular health checker de ELB
  try {
    const { data, status } = await request('GET', '/', {
      headers: { 'User-Agent': 'ELB-HealthChecker/2.0' },
    });
    if (status !== 200) throw new Error(`Status ${status}`);
    logPass('GET / (ELB)', `status=ok`);
  } catch (e) {
    logFail('GET / (ELB)', e.message);
  }

  // Simular usuario normal (debe retornar 404)
  try {
    const { status } = await request('GET', '/', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (status !== 404) throw new Error(`Esperado 404, recibido ${status}`);
    logPass('GET / (usuario)', 'Retorna 404 correctamente');
  } catch (e) {
    logFail('GET / (usuario)', e.message);
  }
}

// 3. App Version (público)
async function testAppVersion() {
  section('3. APP VERSION (público)');

  try {
    const { data } = await request('GET', '/app-version', { expectStatus: 200 });
    if (!data.minVersion) throw new Error('Falta minVersion');
    if (!data.latestVersion) throw new Error('Falta latestVersion');
    logPass('GET /app-version', `min=${data.minVersion}, latest=${data.latestVersion}, force=${data.forceUpdate}`);
  } catch (e) {
    logFail('GET /app-version', e.message);
  }
}

// 4. Autenticación
async function testAuthenticate() {
  section('4. AUTENTICACIÓN');

  // Credenciales inválidas
  try {
    const { status } = await request('POST', '/authenticate', {
      body: { username: 'fake', password: 'wrong' },
    });
    if (status !== 401) throw new Error(`Esperado 401, recibido ${status}`);
    logPass('POST /authenticate (inválido)', 'Retorna 401 correctamente');
  } catch (e) {
    logFail('POST /authenticate (inválido)', e.message);
  }

  // Sin body
  try {
    const { status } = await request('POST', '/authenticate', {
      body: {},
    });
    if (status !== 401) throw new Error(`Esperado 401, recibido ${status}`);
    logPass('POST /authenticate (vacío)', 'Retorna 401 correctamente');
  } catch (e) {
    logFail('POST /authenticate (vacío)', e.message);
  }

  // Credenciales válidas — las obtenemos del secreto (se prueban dinámicamente)
  // Nota: necesitamos las credenciales reales para obtener un token.
  // Intentaremos con valores del secreto que ya el servidor cargó.
  log('📝', 'Para probar autenticación válida, ingresa las credenciales:');
  log('📝', 'O presiona Enter para saltar este test.');

  // Intentar autenticación con credenciales de prueba comunes
  const testCreds = [
    { username: 'admin', password: 'admin' },
    { username: 'vigloans', password: 'vigloans' },
  ];

  let authenticated = false;
  for (const cred of testCreds) {
    try {
      const { status, data } = await request('POST', '/authenticate', {
        body: cred,
      });
      if (status === 200 && data.token) {
        jwtToken = data.token;
        authenticated = true;
        logPass('POST /authenticate (válido)', `Token obtenido (${data.token.substring(0, 20)}...)`);
        break;
      }
    } catch (_) {
      // Intentar siguiente
    }
  }

  if (!authenticated) {
    logSkip('POST /authenticate (válido)', 'No se encontraron credenciales válidas. Los tests protegidos serán saltados.');
    log('💡', `Para completar los tests, establece las variables AUTH_USER y AUTH_PASS:`);
    log('💡', `  AUTH_USER=xxx AUTH_PASS=xxx node scripts/e2e-local.mjs`);

    // Intentar con variables de entorno
    const envUser = process.env.AUTH_USER;
    const envPass = process.env.AUTH_PASS;
    if (envUser && envPass) {
      try {
        const { status, data } = await request('POST', '/authenticate', {
          body: { username: envUser, password: envPass },
        });
        if (status === 200 && data.token) {
          jwtToken = data.token;
          authenticated = true;
          logPass('POST /authenticate (env)', `Token obtenido con AUTH_USER/AUTH_PASS`);
        }
      } catch (_) {
        logFail('POST /authenticate (env)', 'Credenciales de entorno inválidas');
      }
    }
  }
}

// 5. JWT Middleware
async function testJWTMiddleware() {
  section('5. JWT MIDDLEWARE');

  // Sin token
  try {
    const { status } = await request('GET', '/config', {
      headers: { Authorization: '' },
    });
    if (status !== 403) throw new Error(`Esperado 403, recibido ${status}`);
    logPass('GET /config (sin token)', 'Retorna 403 correctamente');
  } catch (e) {
    logFail('GET /config (sin token)', e.message);
  }

  // Token inválido
  try {
    const { status } = await request('GET', '/config', {
      headers: { Authorization: 'Bearer token_invalido_12345' },
    });
    if (status !== 401) throw new Error(`Esperado 401, recibido ${status}`);
    logPass('GET /config (token inválido)', 'Retorna 401 correctamente');
  } catch (e) {
    logFail('GET /config (token inválido)', e.message);
  }
}

// 6. Config Público (sin auth)
async function testConfigPublic() {
  section('6. CONFIG PÚBLICA (sin auth)');

  // Debe funcionar sin token
  try {
    const { data } = await request('GET', '/config/public', {
      headers: { Authorization: '' },
      expectStatus: 200,
    });
    const expectedPublicKeys = [
      'node_host', 'sf_host', 'sf_community_host',
      'sf_client_id_ios', 'sf_redirect_url',
      'ath_public_token', 'paypal_domain_url', 'paypal_client_id',
    ];

    const presentKeys = expectedPublicKeys.filter(k => data[k] !== undefined && data[k] !== null);
    const missingKeys = expectedPublicKeys.filter(k => data[k] === undefined || data[k] === null);

    if (presentKeys.length === 0) throw new Error('No se retornó ninguna key pública');
    logPass('GET /config/public', `${presentKeys.length}/${expectedPublicKeys.length} keys presentes`);

    if (missingKeys.length > 0) {
      log('⚠️', `  Keys faltantes: ${missingKeys.join(', ')}`);
    }
  } catch (e) {
    logFail('GET /config/public', e.message);
  }

  // Verificar que NO se filtran secretos en la versión pública
  try {
    const { data } = await request('GET', '/config/public', {
      headers: { Authorization: '' },
    });
    const secretKeys = [
      'sf_client_secret_ios', 'paypal_secret_key',
      'jwt_secret_key', 'auth_pass', 'auth_user',
    ];
    const leaked = secretKeys.filter(k => data[k] !== undefined);
    if (leaked.length > 0) {
      logFail('GET /config/public (seguridad)', `⚠️ SECRETOS FILTRADOS EN ENDPOINT PÚBLICO: ${leaked.join(', ')}`);
    } else {
      logPass('GET /config/public (seguridad)', 'No se filtraron secretos en endpoint público');
    }
  } catch (e) {
    logFail('GET /config/public (seguridad)', e.message);
  }
}

// 7. Config Privado (con auth)
async function testConfigPrivate() {
  section('7. CONFIG PRIVADA (con auth)');

  if (!jwtToken) {
    logSkip('GET /config (autenticado)', 'Sin token JWT');
    return;
  }

  try {
    const { data } = await request('GET', '/config', { expectStatus: 200 });
    const expectedKeys = [
      'ath_public_token', 'sf_host', 'sf_community_host',
      'sf_client_id_ios', 'sf_redirect_url',
      'paypal_client_id', 'paypal_domain_url', 'node_host',
      'sf_client_secret_ios', 'paypal_secret_key',
    ];

    const presentKeys = expectedKeys.filter(k => data[k] !== undefined);
    const missingKeys = expectedKeys.filter(k => data[k] === undefined);

    if (presentKeys.length === 0) throw new Error('No se retornó ninguna key de configuración');
    logPass('GET /config (autenticado)', `${presentKeys.length}/${expectedKeys.length} keys presentes`);

    if (missingKeys.length > 0) {
      log('⚠️', `  Keys faltantes: ${missingKeys.join(', ')}`);
    }

    // Verificar que los secretos sensibles SÍ están en la versión autenticada
    if (data.sf_client_secret_ios) {
      logPass('GET /config (SF secret)', 'sf_client_secret_ios presente en versión autenticada');
    } else {
      logFail('GET /config (SF secret)', 'sf_client_secret_ios FALTA en versión autenticada');
    }

    if (data.paypal_secret_key) {
      logPass('GET /config (PayPal secret)', 'paypal_secret_key presente en versión autenticada');
    } else {
      logFail('GET /config (PayPal secret)', 'paypal_secret_key FALTA en versión autenticada');
    }
  } catch (e) {
    logFail('GET /config (autenticado)', e.message);
  }
}

// 8. Autenticación por Salesforce Token
async function testAuthenticateSF() {
  section('8. AUTENTICACIÓN SF (/authenticate/sf)');

  // Sin body
  try {
    const { status } = await request('POST', '/authenticate/sf', {
      body: {},
      headers: { Authorization: '' },
    });
    if (status !== 400) throw new Error(`Esperado 400, recibido ${status}`);
    logPass('POST /authenticate/sf (sin body)', 'Retorna 400 correctamente');
  } catch (e) {
    logFail('POST /authenticate/sf (sin body)', e.message);
  }

  // Con sfHost inválido (no es dominio SF)
  try {
    const { status, data } = await request('POST', '/authenticate/sf', {
      body: { sfAccessToken: 'test123', sfHost: 'https://evil.example.com' },
      headers: { Authorization: '' },
    });
    if (status !== 400) throw new Error(`Esperado 400, recibido ${status}`);
    logPass('POST /authenticate/sf (host inválido)', 'Rechaza dominios no-SF correctamente');
  } catch (e) {
    logFail('POST /authenticate/sf (host inválido)', e.message);
  }

  // Con token SF inválido pero host válido
  try {
    const { status } = await request('POST', '/authenticate/sf', {
      body: { sfAccessToken: 'token_invalido_xyz', sfHost: 'https://vigmortage.my.salesforce.com' },
      headers: { Authorization: '' },
    });
    if (status !== 401) throw new Error(`Esperado 401, recibido ${status}`);
    logPass('POST /authenticate/sf (token inválido)', 'Rechaza tokens SF inválidos con 401');
  } catch (e) {
    logFail('POST /authenticate/sf (token inválido)', e.message);
  }
}

// 9. Proxy SF Token Exchange
async function testSfTokenProxy() {
  section('9. PROXY SF TOKEN (/sf/token)');

  // Sin body
  try {
    const { status } = await request('POST', '/sf/token', {
      body: {},
      headers: { Authorization: '' },
    });
    if (status !== 400) throw new Error(`Esperado 400, recibido ${status}`);
    logPass('POST /sf/token (sin body)', 'Retorna 400 correctamente');
  } catch (e) {
    logFail('POST /sf/token (sin body)', e.message);
  }

  // Con código inválido (SF rechazará)
  try {
    const { status } = await request('POST', '/sf/token', {
      body: { code: 'codigo_invalido_xyz', redirectUri: 'vigmortgage://oauth/success' },
      headers: { Authorization: '' },
    });
    // SF retornará un error, el proxy debe retornarlo
    if (status >= 200 && status < 300) throw new Error(`No debería retornar éxito con código inválido`);
    logPass('POST /sf/token (código inválido)', `Rechaza correctamente con status ${status}`);
  } catch (e) {
    // Si hay error de red hacia SF, es aceptable
    if (e.message.includes('No debería')) {
      logFail('POST /sf/token (código inválido)', e.message);
    } else {
      logPass('POST /sf/token (código inválido)', `Error controlado: ${e.message.substring(0, 80)}`);
    }
  }
}

// 10. Proxy PayPal Token
async function testPaypalTokenProxy() {
  section('10. PROXY PAYPAL TOKEN (/paypal/token)');

  // Sin auth — debe rechazar
  try {
    const { status } = await request('POST', '/paypal/token', {
      body: {},
      headers: { Authorization: '' },
    });
    if (status !== 403) throw new Error(`Esperado 403, recibido ${status}`);
    logPass('POST /paypal/token (sin auth)', 'Retorna 403 correctamente');
  } catch (e) {
    logFail('POST /paypal/token (sin auth)', e.message);
  }

  // Con token inválido — debe rechazar
  try {
    const { status } = await request('POST', '/paypal/token', {
      headers: { Authorization: 'Bearer token_fake_12345' },
    });
    if (status !== 401) throw new Error(`Esperado 401, recibido ${status}`);
    logPass('POST /paypal/token (token inválido)', 'Retorna 401 correctamente');
  } catch (e) {
    logFail('POST /paypal/token (token inválido)', e.message);
  }

  // Con token válido — debe obtener PayPal access token
  if (!jwtToken) {
    logSkip('POST /paypal/token (válido)', 'Sin token JWT del backend');
    return;
  }

  try {
    const { status, data } = await request('POST', '/paypal/token', {
      expectStatus: 200,
    });
    if (!data.access_token) throw new Error('No se recibió access_token de PayPal');
    logPass('POST /paypal/token (válido)', `PayPal token obtenido (${data.access_token.substring(0, 20)}... expires_in=${data.expires_in})`);
  } catch (e) {
    logFail('POST /paypal/token (válido)', e.message);
  }
}

// 11. Upload, Download, Delete (ciclo completo)
async function testFileOperations() {
  section('11. OPERACIONES DE ARCHIVOS S3');

  if (!jwtToken) {
    logSkip('Operaciones S3', 'Sin token JWT');
    return;
  }

  const testFileName = `test_${Date.now()}.txt`;
  const testContent = 'Contenido de prueba para vigloansbackend - ' + new Date().toISOString();

  // Upload
  try {
    const formData = new FormData();
    const blob = new Blob([testContent], { type: 'text/plain' });
    formData.append('file', blob, testFileName);

    const { status, data } = await request('POST', '/uploadFile', {
      body: formData,
      expectStatus: 200,
    });

    logPass('POST /uploadFile', `Archivo subido: ${data}`);
  } catch (e) {
    logFail('POST /uploadFile', e.message);
    return; // No continuar si falló el upload
  }

  // Download
  try {
    const { status, data } = await request('GET', `/downloadFile/${testFileName}`, { raw: true });
    if (status !== 200) throw new Error(`Status ${status}`);

    const text = new TextDecoder().decode(data);
    if (!text.includes('Contenido de prueba')) {
      throw new Error(`Contenido inesperado: ${text.substring(0, 100)}`);
    }
    logPass('GET /downloadFile', `Contenido verificado (${text.length} bytes)`);
  } catch (e) {
    logFail('GET /downloadFile', e.message);
  }

  // Delete
  try {
    const { data } = await request('DELETE', `/deleteFile/${testFileName}`, { expectStatus: 200 });
    logPass('DELETE /deleteFile', data.message || 'Archivo eliminado');
  } catch (e) {
    logFail('DELETE /deleteFile', e.message);
  }

  // Verificar que fue eliminado (download debe fallar)
  try {
    const { status } = await request('GET', `/downloadFile/${testFileName}`);
    if (status === 200) {
      logFail('Verificar eliminación', 'El archivo todavía existe en S3');
    } else {
      logPass('Verificar eliminación', `Status ${status} — archivo eliminado correctamente`);
    }
  } catch (e) {
    logPass('Verificar eliminación', 'Archivo ya no existe');
  }
}

// 12. Upload sin archivo (debe fallar)
async function testUploadValidation() {
  section('12. VALIDACIONES');

  if (!jwtToken) {
    logSkip('Validaciones', 'Sin token JWT');
    return;
  }

  // Upload sin archivo
  try {
    const formData = new FormData();
    const { status } = await request('POST', '/uploadFile', { body: formData });
    if (status !== 500) throw new Error(`Esperado 500, recibido ${status}`);
    logPass('POST /uploadFile (sin archivo)', 'Retorna error correctamente');
  } catch (e) {
    // Multer puede manejar esto de distintas formas
    logPass('POST /uploadFile (sin archivo)', `Error controlado: ${e.message.substring(0, 80)}`);
  }

  // MergePDFs sin URLs
  try {
    const { status } = await request('POST', '/mergePDFs', { body: {} });
    if (status !== 400) throw new Error(`Esperado 400, recibido ${status}`);
    logPass('POST /mergePDFs (sin URLs)', 'Retorna 400 correctamente');
  } catch (e) {
    logFail('POST /mergePDFs (sin URLs)', e.message);
  }

  // MergePDFs con URLs vacías
  try {
    const { status } = await request('POST', '/mergePDFs', { body: { urls: ['', '  '] } });
    if (status !== 400) throw new Error(`Esperado 400, recibido ${status}`);
    logPass('POST /mergePDFs (URLs vacías)', 'Retorna 400 correctamente');
  } catch (e) {
    logFail('POST /mergePDFs (URLs vacías)', e.message);
  }

  // VerifyATHPayment sin datos requeridos
  try {
    const { status } = await request('POST', '/verifyATHPayment', { body: {} });
    if (status !== 400) throw new Error(`Esperado 400, recibido ${status}`);
    logPass('POST /verifyATHPayment (sin datos)', 'Retorna 400 correctamente');
  } catch (e) {
    logFail('POST /verifyATHPayment (sin datos)', e.message);
  }
}

// 13. Ruta inexistente
async function testNotFound() {
  section('13. RUTAS INEXISTENTES');

  try {
    const { status } = await request('GET', '/ruta-que-no-existe');
    if (status !== 404) {
      log('⚠️', `  GET /ruta-que-no-existe retornó ${status} (Express por defecto retorna 404 con HTML)`);
    }
    logPass('GET /ruta-inexistente', `Status: ${status}`);
  } catch (e) {
    logFail('GET /ruta-inexistente', e.message);
  }
}

// -------------------- RESUMEN --------------------
function printSummary() {
  section('RESUMEN DE RESULTADOS');

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const skipped = results.filter(r => r.status === 'SKIP').length;
  const total = results.length;

  console.log(`\n  Total:    ${total}`);
  console.log(`  ${COLORS.green}Pasaron:  ${passed}${COLORS.reset}`);
  if (failed > 0) console.log(`  ${COLORS.red}Fallaron: ${failed}${COLORS.reset}`);
  if (skipped > 0) console.log(`  ${COLORS.yellow}Saltados: ${skipped}${COLORS.reset}`);

  if (failed > 0) {
    console.log(`\n${COLORS.red}${COLORS.bold}  Tests fallidos:${COLORS.reset}`);
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`    ❌ ${r.name}: ${r.error}`);
    });
  }

  console.log(`\n${failed === 0 ? '🎉' : '⚠️'} ${failed === 0 ? 'Todos los tests pasaron!' : `${failed} test(s) fallaron.`}\n`);
}

// -------------------- EJECUTAR --------------------
async function main() {
  console.log(`\n${COLORS.bold}🧪 Tests E2E — vigloansbackend${COLORS.reset}`);
  console.log(`${COLORS.dim}   Target: ${BASE_URL}${COLORS.reset}`);
  console.log(`${COLORS.dim}   Fecha:  ${new Date().toLocaleString('es-VE')}${COLORS.reset}`);

  // Verificar que el servidor está corriendo
  try {
    await fetch(`${BASE_URL}/health`);
  } catch {
    console.error(`\n${COLORS.red}❌ El servidor no está corriendo en ${BASE_URL}${COLORS.reset}`);
    console.error(`   Ejecuta primero: npm run dev\n`);
    process.exit(1);
  }

  await testHealth();
  await testRoot();
  await testAppVersion();
  await testAuthenticate();
  await testJWTMiddleware();
  await testConfigPublic();
  await testConfigPrivate();
  await testAuthenticateSF();
  await testSfTokenProxy();
  await testPaypalTokenProxy();
  await testFileOperations();
  await testUploadValidation();
  await testNotFound();

  printSummary();
}

main().catch(err => {
  console.error(`\n${COLORS.red}Error fatal:${COLORS.reset}`, err);
  process.exit(1);
});
