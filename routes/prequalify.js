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
    await ports.salesforce.updateLead(leadId, fields);

    const contexto = {
      ...req.lead,
      completedSteps: [...new Set([...(req.lead.completedSteps ?? []), step])],
    };
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
      const { channel, email, phone } = req.validated.body;
      const destination = channel === 'email' ? email : phone;

      const resultado = await otpService.requestCode({ channel, destination });

      // El codigo no aparece por ningun lado: `requestCode` solo devuelve
      // metadatos y aqui tampoco se agrega nada.
      if (resultado.result === RequestResult.SENT) {
        return res.status(202).json({
          sent: true,
          expiresInSeconds: resultado.expiresInSeconds,
        });
      }
      // Cooldown, lockout o tope de envios: el usuario legitimo necesita saber
      // cuanto esperar, asi que aqui si se informa.
      return res
        .status(429)
        .set('Retry-After', String(resultado.retryAfterSeconds ?? 60))
        .json({
          error: 'Espera antes de solicitar otro codigo.',
          retryAfterSeconds: resultado.retryAfterSeconds,
        });
    })
  );

  router.post(
    '/otp/verify',
    otpLimiter,
    validate(schemas.otpVerifySchema),
    asyncHandler(async (req, res) => {
      const { code, email, phone } = req.validated.body;
      const channel = email ? 'email' : 'sms';
      const destination = email ?? phone;

      const resultado = await otpService.verifyCode({ channel, destination, code });

      if (resultado.result === VerifyResult.LOCKED) {
        return res
          .status(429)
          .set('Retry-After', String(resultado.retryAfterSeconds ?? 900))
          .json({ error: 'Demasiados intentos. Intenta mas tarde.' });
      }

      if (resultado.result !== VerifyResult.OK) {
        // INVALID, NOT_FOUND y EXPIRED responden IGUAL: distinguirlos permite
        // averiguar que telefonos y correos tienen un reto activo.
        logger.info('prequalify.otp_fallido', { motivo: resultado.result });
        return res.status(401).json({ error: OTP_FALLO });
      }

      // Verificado: se localiza o crea el lead y se emite la sesion.
      const existente = await ports.salesforce.findLeadByEmailOrPhone({ email, phone });
      const lead = existente ?? (await ports.salesforce.createLead({ email, phone }));

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

  stepRoute('patch', '/leads/:id/personal', Step.PERSONAL, schemas.personalSchema);
  stepRoute('put', '/leads/:id/addresses', Step.CURRENT_ADDRESS, schemas.currentAddressSchema);
  stepRoute(
    'put',
    '/leads/:id/addresses/previous',
    Step.PREVIOUS_ADDRESS,
    schemas.previousAddressSchema
  );
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
      // El puerto trae el reporte; el parseo y la decision viven en
      // `lib/prequalify/experian.js` y `decision.js` (Tarea B6).
      await ports.experian.fetchCreditReport({ leadId: req.prequal.leadId });
      // Sin proveedor configurado no se llega aqui: el puerto lanza 501.
      res.status(501).json({ error: 'Este servicio no esta disponible en este momento.' });
    })
  );

  return router;
}

module.exports = { createPrequalifyRouter, OTP_FALLO, CAMPOS_PUBLICOS, vistaPublica };
