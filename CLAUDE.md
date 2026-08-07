# CLAUDE.md — vigloansbackend (Backend único)

Node/Express. Es el **backend único** del ecosistema VIG: hoy sirve a la app Flutter; se expande para servir también la **precualificación** (Flutter + Next.js) y la **calculadora** como API.

## Stack y ejecución
- Node + Express, `pm2` (`ecosystem.config.js`). Entrada actual: `app.js` (monolito — en refactor a `src/`).
- Secretos: **AWS Secrets Manager** con caché TTL. Credenciales AWS por **IAM role** de la instancia/tarea (no keys de larga vida en env).
- `helmet`, `express-rate-limit`, `trust proxy` activos. Mantenerlos.

## Arquitectura objetivo (refactor)
```
src/
  app.js            # configura Express, monta routers
  server.js         # arranque, timeouts, graceful shutdown
  config/secrets.js # getSecret + caché
  middleware/auth.js# verificarJWT, limiters, verificación de propiedad de recurso
  lib/{aws,pdf,mailer,salesforce,experian,otp}.js
  routes/{auth,config,files,payments,pdf,support,prequalify,calculator}.js
test/               # jest + supertest por router
```

## Módulos nuevos (norte de arquitectura del ecosistema)
- **`routes/prequalify.js`** — reemplaza los `accion*.php` de Joomla. Flujo **anónimo** (lead capture) con su propia auth (OTP → token de sesión server-side), rate-limit y CORS para orígenes web/app. Endpoints lógicos: `POST /prequalify/otp`, `POST /prequalify/otp/verify`, `POST /prequalify/leads`, `GET /prequalify/leads`, `PATCH /prequalify/leads/:id/personal`, `POST /prequalify/leads/:id/credit-check` (Experian), `PUT .../addresses|employment|income`, `POST .../documents`, `POST .../coborrower`, `GET /geo/states|cities`, `POST /prequalify/notifications`.
  - El **parseo + scoring de Experian** (hoy 2.034 líneas mezcladas en `accionExperian.php`) va aislado en `lib/experian.js`. Las **reglas de decisión** en su propia capa. La **máquina de estados del wizard** explícita (no implícita como el `currentStep__c` actual).
- **`routes/calculator.js`** — única fuente de verdad de los cálculos hipotecarios. `POST /calculator/quote` recibe parámetros y devuelve pago, LTV, MIP/PMI, funding fee y amortización. Flutter y Next.js dejan de calcular localmente.

## Reglas de seguridad específicas (de la auditoría)
- **Autorización por recurso.** `/downloadFile`, `/deleteFile`, `/mergePDFs`: prefijar los keys de S3 por usuario (`{sfUserId}/...`) y **validar el prefijo contra `req.usuario`** antes de leer/borrar. Nunca direccionar S3 solo por nombre de archivo. (Origen: IDOR crítico.)
- **Verificación de pago ATH:** re-consultar contra Evertec por `referenceNumber`. **Nunca** aceptar `COMPLETED` confiando en `rawResponse` del cliente.
- **`/support/contact`** y todo endpoint público: `rate-limit` + validación zod. Sanitizar CRLF en campos que van a cabeceras SMTP; escapar HTML en el cuerpo del correo.
- **Correo:** usar `nodemailer` con TLS verificado. Prohibido SMTP casero en claro y `rejectUnauthorized:false`.
- **JWT:** fijar `algorithms:['HS256']` en `verify`; expiración corta; **no** embeber el access token de Salesforce dentro del JWT.
- El OTP **nunca** vuelve en la respuesta. Rate-limit + lockout por intentos.
- `req.usuario` decodificado del JWT **debe usarse** para autorizar, no solo existir.

## Convenciones
- Validación con **zod** en todo input externo.
- Errores: mensaje genérico al cliente; detalle a `console.error`/logger. Nunca exponer `details` crudos de Salesforce/terceros.
- Logs a stdout (12-factor). **`access.log` no se escribe dentro del repo.**
- Tests con jest/supertest por router antes de dar por hecho un endpoint.

## No commitear
`node_modules/`, `.env`, `access.log`, `*.log`, `config-check-result.json`, scripts operativos sueltos (mover a `scripts/`). Añadir `.gitignore` (hoy incompleto) y `.env.example`.
