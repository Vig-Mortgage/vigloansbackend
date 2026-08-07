'use strict';

/**
 * Router de la precualificacion hipotecaria (flujo ANONIMO de captura de lead).
 *
 * Reemplaza los `accion*.php` de Joomla. Auth propia: OTP -> token de sesion
 * emitido server-side, distinta del login del app. Rate-limit y CORS propios.
 *
 * Reglas que este router hace cumplir, todas con test:
 * - El OTP **nunca** vuelve en una respuesta.
 * - Los motivos internos de fallo del OTP NO se distinguen hacia el cliente:
 *   `INVALID`, `NOT_FOUND` y `EXPIRED` responden lo mismo, o se podrian
 *   enumerar destinos con reto activo.
 * - **Autorizacion por recurso**: la sesion solo toca SU lead. Un token valido
 *   no basta (origen: el IDOR de la auditoria).
 * - La maquina de estados manda: no se puede saltar un paso.
 * - Sin proveedores configurados, 501 limpio (lo produce el puerto).
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');

const validate = require('../middleware/validate');
const asyncHandler = require('../middleware/asyncHandler');
const logger = require('../lib/logger');
const { bearerFrom } = require('../lib/prequalify/session');
const { VerifyResult, RequestResult } = require('../lib/prequalify/otp');
const {
  Step,
  canEnter,
  nextStep,
  resumeStep,
  requiredSteps,
  toLegacyStep,
} = require('../lib/prequalify/stateMachine');
const schemas = require('../lib/prequalify/schemas');

/** Mensaje unico para todo fallo de verificacion de OTP (anti-enumeracion). */
const OTP_FALLO = 'El codigo no es valido o expiro. Solicita uno nuevo.';

/**
 * Campos del lead que pueden volver al cliente.
 *
 * Es una **lista blanca**, no una lista negra: cualquier campo que el puerto
 * agregue en el futuro queda fuera por defecto. El contrato de `getLead` ya
 * dice que no debe devolver el SSN, pero confiar en la disciplina del puerto es
 * como se filtran los datos: si un dia devuelve el registro completo de
 * Salesforce, aqui no pasa.
 */
const CAMPOS_PUBLICOS = Object.freeze([
  'email',
  'phone',
  'firstName',
  'middleName',
  'lastName',
  'loanPurpose',
  'typeOfCredit',
  'citizenship',
  'maritalStatus',
  'dependents',
  'completedSteps',
]);

/** Proyeccion segura del lead. Lo desconocido no sale. */
function vistaPublica(lead) {
  const salida = {};
  for (const campo of CAMPOS_PUBLICOS) {
    if (lead?.[campo] !== undefined) salida[campo] = lead[campo];
  }
  return salida;
}

const LeadIdParams = z.object({ id: z.string().min(1).max(64) });

/**
 * @param {object} deps
 * @param {object} deps.ports contenedor de `lib/prequalify/ports`
 * @param {object} deps.otpService `lib/prequalify/otp`.createOtpService(...)
 * @param {object} deps.sessions `lib/prequalify/session`.createSessionManager(...)
 */
function createPrequalifyRouter({ ports, otpService, sessions } = {}) {
  if (!ports || !otpService || !sessions) {
    throw new TypeError('createPrequalifyRouter requiere { ports, otpService, sessions }');
  }

  const router = express.Router();

  // ---------------------------------------------------------------------
  // Rate limits. El servicio de OTP limita por DESTINO; esto limita por IP,
  // que es lo que impide rotar destinos y usar el endpoint como ametralladora
  // de SMS a nuestra costa.
  // ---------------------------------------------------------------------
  const otpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Demasiadas solicitudes de codigo. Intente mas tarde.' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  const flowLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 120,
    message: { error: 'Demasiadas solicitudes. Intente mas tarde.' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // ---------------------------------------------------------------------
  // Sesion + autorizacion por recurso
  // ---------------------------------------------------------------------

  /** Exige sesion valida y la deja en `req.prequal`. */
  function requireSession(req, res, next) {
    const session = sessions.verify(bearerFrom(req.headers.authorization));
    if (!session) {
      return res.status(401).json({ error: 'Sesion invalida o expirada.' });
    }
    req.prequal = session;
    next();
  }

  /**
   * Un token valido NO basta: tiene que ser el token de ESE lead.
   *
   * Se responde 404 y no 403 a proposito: un 403 confirmaria que el lead
   * existe, que es justo lo que un atacante quiere saber al iterar ids.
   */
  function authorizeLead(req, res, next) {
    if (req.prequal.leadId !== req.validated.params.id) {
      logger.warn('prequalify.idor_bloqueado', {
        sesion: req.prequal.leadId,
        solicitado: req.validated.params.id,
        ip: req.ip,
      });
      return res.status(404).json({ error: 'Recurso no encontrado.' });
    }
    next();
  }

  /** Carga el lead y comprueba que el paso pedido es entrable. */
  function requireStep(step) {
    return asyncHandler(async (req, res, next) => {
      const lead = await ports.salesforce.getLead(req.prequal.leadId);
      if (!lead) return res.status(404).json({ error: 'Recurso no encontrado.' });

      if (!canEnter(step, lead)) {
        return res.status(409).json({
          error: 'Faltan pasos previos.',
          expectedStep: resumeStep(lead),
        });
      }
      req.lead = lead;
      next();
    });
  }

  /** Aplica un paso: persiste, marca completado y devuelve el siguiente. */
  async function applyStep(req, res, step, fields) {
    const leadId = req.prequal.leadId;
    const completedSteps = [...new Set([...(req.lead.completedSteps ?? []), step])];

    // `completedSteps` viaja con los datos del paso. Sin esto la marca vive solo
    // en memoria del request y el lead nunca avanza: al volver, `resumeStep`
    // devolveria siempre el mismo paso.
    // TODO(Roberto): hace falta un campo en el Lead donde persistirlo. El
    // `currentStep__c` legacy es un solo numero y no distingue "hice el paso 3
    // pero me falta el 2", que si puede pasar con los pasos opcionales.
    await ports.salesforce.updateLead(leadId, { ...fields, completedSteps });

    const contexto = { ...req.lead, completedSteps };
    const siguiente = nextStep(step, contexto);
    const legacy = toLegacyStep(siguiente);
    if (legacy !== null) await ports.salesforce.setCurrentStep(leadId, legacy);

    logger.info('prequalify.step', { step, siguiente });
    res.json({ step, nextStep: siguiente, remainingSteps: pendientes(contexto) });
  }

  function pendientes(lead) {
    const hechos = new Set(lead.completedSteps ?? []);
    return requiredSteps(lead).filter((s) => !hechos.has(s));
  }

  // ---------------------------------------------------------------------
  // OTP
  // ---------------------------------------------------------------------

  router.post(
    '/otp',
    otpLimiter,
    validate(schemas.otpRequestSchema),
    asyncHandler(async (req, res) => {
      const { email, phone, phoneChannel } = req.validated.body;

      // Se piden LOS DOS. Si cualquiera esta en cooldown o bloqueado, se
      // informa y no se manda ninguno: recibir solo uno de dos codigos es
      // confuso y ademas gastaria el envio del otro.
      const [correo, telefono] = await Promise.all([
        otpService.requestCode({ channel: 'email', destination: email }),
        // El reto se identifica como 'phone' pase lo que pase; `phoneChannel`
        // solo decide por donde se entrega. Asi reenviar por WhatsApp no crea
        // un reto distinto del que se pidio por SMS.
        otpService.requestCode({
          channel: 'phone',
          destination: phone,
          deliveryChannel: phoneChannel,
        }),
      ]);

      const problema = [correo, telefono].find((r) => r.result !== RequestResult.SENT);
      if (problema) {
        return res
          .status(429)
          .set('Retry-After', String(problema.retryAfterSeconds ?? 60))
          .json({
            error: 'Espera antes de solicitar otro codigo.',
            retryAfterSeconds: problema.retryAfterSeconds,
          });
      }

      // Ningun codigo aparece aqui: `requestCode` solo devuelve metadatos.
      res.status(202).json({
        sent: true,
        channels: ['email', phoneChannel],
        expiresInSeconds: correo.expiresInSeconds,
      });
    })
  );

  router.post(
    '/otp/verify',
    otpLimiter,
    validate(schemas.otpVerifySchema),
    asyncHandler(async (req, res) => {
      const { email, phone, emailCode, phoneCode } = req.validated.body;

      // Se comprueban los dos SIEMPRE, sin cortocircuito. Si se saliera al
      // primer fallo, el tiempo de respuesta revelaria cual de los dos codigos
      // estaba mal, y ademas el canal que si acerto no gastaria intento —
      // dando barra libre para adivinarlos de uno en uno.
      const [correo, telefono] = await Promise.all([
        otpService.verifyCode({ channel: 'email', destination: email, code: emailCode }),
        otpService.verifyCode({ channel: 'phone', destination: phone, code: phoneCode }),
      ]);

      const bloqueado = [correo, telefono].find((r) => r.result === VerifyResult.LOCKED);
      if (bloqueado) {
        return res
          .status(429)
          .set('Retry-After', String(bloqueado.retryAfterSeconds ?? 900))
          .json({ error: 'Demasiados intentos. Intenta mas tarde.' });
      }

      if (correo.result !== VerifyResult.OK || telefono.result !== VerifyResult.OK) {
        // No se dice CUAL fallo: distinguirlo permite enumerar que correos y
        // telefonos tienen un reto activo, y ademas facilita atacarlos por
        // separado.
        logger.info('prequalify.otp_fallido', {
          email: correo.result,
          phone: telefono.result,
        });
        return res.status(401).json({ error: OTP_FALLO });
      }

      // Ambos verificados: se localiza o crea el lead y se emite la sesion.
      const existente = await ports.salesforce.findLeadByEmailOrPhone({ email, phone });
      const lead = existente ?? (await ports.salesforce.createLead({ email, phone }));

      const previos = (await ports.salesforce.getLead(lead.id))?.completedSteps ?? [];
      await ports.salesforce.updateLead(lead.id, {
        completedSteps: [...new Set([...previos, Step.OTP_VERIFY])],
      });

      const { token, expiresInSeconds } = sessions.issue({ leadId: lead.id });
      logger.info('prequalify.sesion_emitida', { nuevo: !existente });

      res.json({ token, expiresInSeconds, leadId: lead.id });
    })
  );

  // ---------------------------------------------------------------------
  // Lead
  // ---------------------------------------------------------------------

  router.use(flowLimiter);

  router.get(
    '/leads',
    requireSession,
    asyncHandler(async (req, res) => {
      const lead = await ports.salesforce.getLead(req.prequal.leadId);
      if (!lead) return res.status(404).json({ error: 'Recurso no encontrado.' });

      res.json({
        leadId: req.prequal.leadId,
        currentStep: resumeStep(lead),
        remainingSteps: pendientes(lead),
        lead: vistaPublica(lead),
      });
    })
  );

  /** Registra un paso con datos: valida, autoriza y aplica. */
  function stepRoute(method, path, step, schema) {
    router[method](
      path,
      requireSession,
      validate(LeadIdParams, 'params'),
      authorizeLead,
      validate(schema),
      requireStep(step),
      asyncHandler((req, res) => applyStep(req, res, step, req.validated.body))
    );
  }

  /**
   * `start`: persiste la identidad recogida antes del OTP.
   *
   * El lead nace en `/otp/verify` (que es donde hay algo que autorizar), pero
   * ahi solo se guardan email y telefono. Nombre, apellido, fecha de nacimiento
   * y proposito se recogen en la primera pantalla y se persisten aqui, ya con
   * sesion. Sin este endpoint el paso `start` no se completa nunca y
   * `resumeStep` se queda clavado — era un hueco real del contrato.
   *
   * El orden en que se completan `start` y `otpVerify` no importa: `canEnter`
   * comprueba pertenencia al conjunto de completados, no secuencia.
   */
  router.post(
    '/leads',
    requireSession,
    validate(schemas.startSchema),
    requireStep(Step.START),
    asyncHandler((req, res) => applyStep(req, res, Step.START, req.validated.body))
  );

  stepRoute('patch', '/leads/:id/personal', Step.PERSONAL, schemas.personalSchema);
  stepRoute('put', '/leads/:id/addresses', Step.CURRENT_ADDRESS, schemas.currentAddressSchema);
  stepRoute(
    'put',
    '/leads/:id/addresses/mailing',
    Step.MAILING_ADDRESS,
    schemas.mailingAddressSchema
  );
  stepRoute('put', '/leads/:id/employment', Step.EMPLOYMENT, schemas.employmentSchema);
  stepRoute('put', '/leads/:id/income', Step.INCOME, schemas.incomeSchema);
  stepRoute('post', '/leads/:id/coborrower', Step.COBORROWER, schemas.coborrowerSchema);

  router.post(
    '/leads/:id/credit-check',
    requireSession,
    validate(LeadIdParams, 'params'),
    authorizeLead,
    requireStep(Step.CREDIT_CHECK),
    asyncHandler(async (req, res) => {
      // TODO(Roberto): faltan DOS cosas para cerrar este paso, y ninguna es el
      // proveedor — el adaptador de Experian ya esta escrito, cableado y
      // probado contra UAT con reportes reales.
      //
      // 1. EL ADAPTADOR DE SALESFORCE. `fetchCreditReport` necesita nombre,
      //    apellido, fecha de nacimiento y direccion del solicitante. Eso vive
      //    en el Lead, y hoy no hay con que leerlo.
      //
      // 2. DE DONDE SALE EL SSN. Es una decision de diseno, no un cableado.
      //    El SSN se escribe en Salesforce y **nunca se relee** a proposito
      //    (`salesforceMapper.js`, SENSITIVE_LEAD_FIELDS), asi que no se puede
      //    recuperar de ahi para la consulta. Las opciones:
      //
      //      a) Que el cliente lo reenvie en esta peticion, como hacia el
      //         legacy (`scripts.js:1010-1029`). Simple, pero el SSN vuelve a
      //         viajar por la red y a estar en memoria del navegador.
      //      b) Guardarlo server-side entre el paso `personal` y este, atado a
      //         la sesion y con vida corta. No vuelve a viajar, pero hay que
      //         decidir donde vive (hoy el almacen de OTP es en memoria y no
      //         sirve multi-instancia) y garantizar que se borra.
      //
      //    (b) es mejor para el dato pero exige infraestructura; (a) es lo que
      //    ya funciona en produccion hoy. Hay que elegir antes de escribir el
      //    codigo, porque el contrato del endpoint cambia segun la opcion.
      //
      // Mientras tanto se responde 501 explicitamente, sin llamar al puerto:
      // llamarlo con datos incompletos daria un 502 de Experian y haria pensar
      // que el problema es del proveedor.
      res.status(501).json({ error: 'Este servicio no esta disponible en este momento.' });
    })
  );

  /**
   * `submit`: cierra la solicitud.
   *
   * No recibe datos: todo se envio en los pasos anteriores. Solo marca el paso
   * y deja el lead listo para que lo tome un asesor. La decision de credito NO
   * se emite aqui — ver `lib/prequalify/policy.js`.
   */
  router.post(
    '/leads/:id/submit',
    requireSession,
    validate(LeadIdParams, 'params'),
    authorizeLead,
    requireStep(Step.SUBMIT),
    asyncHandler((req, res) => applyStep(req, res, Step.SUBMIT, {}))
  );

  return router;
}

module.exports = { createPrequalifyRouter, OTP_FALLO, CAMPOS_PUBLICOS, vistaPublica };
