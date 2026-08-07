# Arquitectura del backend (vigloansbackend)

Backend **único** del ecosistema VIG. Sirve hoy a la app Flutter y crece para servir la **precualificación** (Flutter + Next.js) y la **calculadora**. Este documento define cómo se organiza para que escale y se mantenga.

## Estructura de directorios (objetivo)
```
vigloansbackend/
├── app.js                 # composición: middleware global + montaje de routers + error handler
├── lib/                   # lógica de dominio y utilidades puras (testeable sin red)
│   ├── calculator.js      # cálculo hipotecario (fuente única) ✅
│   ├── logger.js          # logger estructurado con redacción de datos sensibles ✅
│   ├── secrets.js         # getSecret + caché (extraer de app.js)  [pendiente]
│   ├── aws.js             # s3Client / smClient                     [pendiente]
│   ├── mailer.js          # nodemailer con TLS (reemplaza SMTP casero) [pendiente]
│   ├── salesforce.js      # cliente SF                               [pendiente]
│   ├── experian.js        # llamada + parseo + scoring (aislado)     [pendiente]
│   └── otp.js             # generación/verificación OTP (secreto server-side) [pendiente]
├── middleware/            # middleware reutilizable de Express
│   ├── validate.js        # validación zod por body/query/params ✅
│   ├── asyncHandler.js    # propaga errores async al handler central ✅
│   ├── errorHandler.js    # errorHandler + notFoundHandler ✅
│   └── auth.js            # verificarJWT, limiters, autorización por recurso [pendiente: extraer de app.js]
├── routes/                # un router por dominio; delgados, sin lógica de negocio
│   ├── calculator.js      # /calculator ✅
│   ├── prequalify.js      # /prequalify (flujo anónimo) [próximo]
│   ├── auth.js  files.js  payments.js  support.js  config.js  [pendiente: extraer de app.js]
└── test/                  # node --test (jest/supertest opcional a futuro)
    ├── calculator.test.js ✅
    └── middleware.test.js ✅
```
✅ = ya existe. El resto es la ruta de extracción incremental desde el `app.js` monolítico (no se reescribe de golpe; se extrae dominio por dominio manteniendo el comportamiento y con tests).

## Convenciones (obligatorias para todo lo nuevo)
1. **Routers delgados, dominio en `lib/`.** El router valida, orquesta y responde; las reglas viven en un módulo de `lib/` testeable sin red.
2. **Validación con `validate(schema)`** (zod) en todo endpoint con entrada. El valor parseado queda en `req.validated[source]`.
3. **`asyncHandler`** envuelve todo handler async; nada de try/catch repetidos. Los errores van al `errorHandler` central.
4. **Errores:** para errores de negocio, `err.status` + `err.publicMessage`; el resto se responde genérico. El `errorHandler` **nunca** filtra stack traces ni internals al cliente.
5. **Logging con `lib/logger.js`** (no `console.log`). Redacta automáticamente claves sensibles (token/secret/ssn/password…). SSN y crédito jamás en logs.
6. **Secretos** desde AWS Secrets Manager vía `lib/secrets.js`; credenciales AWS por IAM role.
7. **Endpoints públicos** (sin JWT) siempre con rate-limit propio.
8. **Autorización por recurso** (anti-IDOR): validar propiedad, no solo autenticación. Ver `vig-security-review`.
9. **Tests** por módulo con `node --test` antes de dar por terminado un endpoint.
10. **12-factor:** config por entorno, logs a stdout, sin estado local; nunca escribir logs dentro del repo.

## Cómo añadir un dominio nuevo (receta)
1. `lib/<dominio>.js` con la lógica pura + sus tests en `test/<dominio>.test.js`.
2. `routes/<dominio>.js`: `validate(Schema)` + `asyncHandler` + logger, delega en `lib/`.
3. Montar en `app.js`: `app.use('/<dominio>', require('./routes/<dominio>'))`.
4. Documentar el contrato (para la precualificación, ver skill `vig-prequalify-api`).

## Estado actual
- Calculadora migrada a este patrón (router + lib + tests, 15/15).
- Infraestructura transversal creada (validate/asyncHandler/errorHandler/logger) y error handler montado en `app.js`.
- Próximo: extraer `secrets/aws/mailer/auth` de `app.js` a `lib/`+`middleware/`, y construir `routes/prequalify.js`.
