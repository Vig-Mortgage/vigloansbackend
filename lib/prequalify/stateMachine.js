'use strict';

/**
 * Maquina de estados del wizard de precualificacion.
 *
 * El PHP legacy no tenia maquina de estados: el orden vivia repartido entre el
 * orden de los <fieldset> de `index.php`, los handlers de `js/scripts.js` y un
 * campo `currentStep__c` numerico que cada `accion*.php` escribia a mano. Aqui
 * queda explicito y puro, para que el backend sea quien decide en que paso esta
 * un lead y cual sigue. El cliente solo pregunta.
 *
 * Todo en este modulo son funciones puras: sin red, sin fecha/hora, sin estado
 * global.
 */

/** Pasos del wizard, en orden. */
const Step = {
  START: 'start',
  OTP_VERIFY: 'otpVerify',
  PERSONAL: 'personal',
  CURRENT_ADDRESS: 'currentAddress',
  PREVIOUS_ADDRESS: 'previousAddress',
  MAILING_ADDRESS: 'mailingAddress',
  CREDIT_CHECK: 'creditCheck',
  EMPLOYMENT: 'employment',
  INCOME: 'income',
  COBORROWER: 'coborrower',
  SUBMIT: 'submit',
  DONE: 'done',
};

/** Orden canonico. `DONE` es terminal y no se "completa". */
const STEP_ORDER = [
  Step.START,
  Step.OTP_VERIFY,
  Step.PERSONAL,
  Step.CURRENT_ADDRESS,
  Step.PREVIOUS_ADDRESS,
  Step.MAILING_ADDRESS,
  Step.CREDIT_CHECK,
  Step.EMPLOYMENT,
  Step.INCOME,
  Step.COBORROWER,
  Step.SUBMIT,
  Step.DONE,
];

/**
 * Pasos que solo aplican bajo cierta condicion. Cada uno declara como leer esa
 * condicion del contexto del lead.
 *
 * OJO — `previousAddress` y `mailingAddress` estan en el HTML legacy
 * (`index.php` los define como `fieldsetAddress2` y `fieldsetMailingAddress`) y
 * tienen endpoint propio (`accionDireccionAnterior.php`,
 * `accionMailingAddress.php`), pero **ningun JS los muestra jamas**: en el
 * wizard legacy son inalcanzables. No hay, por tanto, regla heredada que
 * determine cuando pedirlos.
 *
 * TODO(Roberto): definir las condiciones reales. Lo habitual en la industria es
 * pedir direccion anterior cuando el solicitante lleva menos de 2 anos en la
 * actual, y direccion postal cuando difiere de la fisica. No se codifica ese
 * umbral porque seria inventarlo. Mientras tanto ambos pasos se omiten salvo
 * que el contexto lo pida explicitamente.
 */
const OPTIONAL_STEPS = {
  [Step.PREVIOUS_ADDRESS]: (ctx) => ctx.needsPreviousAddress === true,
  [Step.MAILING_ADDRESS]: (ctx) => ctx.mailingAddressDiffers === true,
  // Portado del legacy: el radio `TypeOfCredit` distingue credito individual de
  // credito con co-deudor, y de ahi cuelga todo el flujo de
  // `accionCrearLeadCoBorrower.php` / `co-borrower.php`.
  [Step.COBORROWER]: (ctx) => ctx.typeOfCredit === 'CoborrowerCredit',
};

/**
 * Equivalencia con el `currentStep__c` de Salesforce.
 *
 * Es un contrato con los leads que YA existen en la org, no una decision de
 * diseno: el legacy guarda un numero y `js/script_finish.js` lo traduce al
 * fieldset donde reanudar. La semantica es "proximo paso a completar":
 *
 *   accionCrearLead.php:254               -> '1' -> reanuda en PersonalInformation
 *   accionSalesforce.php:327              -> '2' -> reanuda en CurrentAddress
 *   accionExperian.php:995                -> '3' -> reanuda en Employment
 *   accionEmployment_SelfEmployment.php:302 -> '4' -> reanuda en Income
 *   accionIncome.php:360                  -> '5' -> reanuda en Submit
 *
 * El legacy no tiene numero para los pasos que nunca alcanza
 * (previousAddress, mailingAddress) ni para el co-deudor.
 */
const LEGACY_STEP_TO_STEP = {
  1: Step.PERSONAL,
  2: Step.CURRENT_ADDRESS,
  3: Step.EMPLOYMENT,
  4: Step.INCOME,
  5: Step.SUBMIT,
};

const STEP_TO_LEGACY_STEP = {
  [Step.PERSONAL]: 1,
  [Step.CURRENT_ADDRESS]: 2,
  [Step.EMPLOYMENT]: 3,
  [Step.INCOME]: 4,
  [Step.SUBMIT]: 5,
};

function isStep(value) {
  return STEP_ORDER.includes(value);
}

function stepIndex(step) {
  return STEP_ORDER.indexOf(step);
}

function isTerminal(step) {
  return step === Step.DONE;
}

/** ¿Este paso aplica para el lead descrito por `ctx`? */
function appliesTo(step, ctx = {}) {
  const predicate = OPTIONAL_STEPS[step];
  return predicate ? predicate(ctx) : true;
}

/** Pasos que este lead debe completar, en orden (excluye `DONE`). */
function requiredSteps(ctx = {}) {
  return STEP_ORDER.filter(
    (step) => step !== Step.DONE && appliesTo(step, ctx)
  );
}

/**
 * Siguiente paso despues de `current`, omitiendo los opcionales que no aplican.
 *
 * @param {string} current paso actual
 * @param {object} [ctx] contexto del lead (typeOfCredit, banderas de direccion)
 * @returns {string} el siguiente paso, o `Step.DONE` si no queda ninguno
 * @throws {RangeError} si `current` no es un paso conocido
 */
function nextStep(current, ctx = {}) {
  if (!isStep(current)) {
    throw new RangeError(`Paso desconocido: ${String(current)}`);
  }
  if (isTerminal(current)) return Step.DONE;

  for (let i = stepIndex(current) + 1; i < STEP_ORDER.length; i += 1) {
    const candidate = STEP_ORDER[i];
    if (candidate === Step.DONE) return Step.DONE;
    if (appliesTo(candidate, ctx)) return candidate;
  }
  return Step.DONE;
}

/**
 * ¿Puede el lead entrar a `step` ahora mismo?
 *
 * Se permite entrar si todos los pasos aplicables anteriores estan completos.
 * Volver a un paso ya completado tambien se permite (el wizard deja corregir
 * datos); avanzar saltandose pasos, no.
 *
 * @param {string} step paso al que se quiere entrar
 * @param {object} leadState `{ completedSteps: string[], ...ctx }`
 * @returns {boolean}
 */
function canEnter(step, leadState = {}) {
  if (!isStep(step) || isTerminal(step)) return false;
  if (!appliesTo(step, leadState)) return false;

  const completed = new Set(
    Array.isArray(leadState.completedSteps) ? leadState.completedSteps : []
  );

  return requiredSteps(leadState)
    .filter((candidate) => stepIndex(candidate) < stepIndex(step))
    .every((candidate) => completed.has(candidate));
}

/**
 * Primer paso pendiente del lead: donde reanudar.
 *
 * @param {object} leadState `{ completedSteps: string[], ...ctx }`
 * @returns {string} paso pendiente, o `Step.DONE` si ya termino
 */
function resumeStep(leadState = {}) {
  const completed = new Set(
    Array.isArray(leadState.completedSteps) ? leadState.completedSteps : []
  );
  return (
    requiredSteps(leadState).find((step) => !completed.has(step)) ?? Step.DONE
  );
}

/** Traduce un `currentStep__c` de Salesforce a un paso. `null` si no mapea. */
function fromLegacyStep(value) {
  const numeric = typeof value === 'string' ? Number(value) : value;
  return LEGACY_STEP_TO_STEP[numeric] ?? null;
}

/**
 * Traduce un paso al `currentStep__c` que espera Salesforce.
 * `null` para los pasos que el legacy no numera.
 */
function toLegacyStep(step) {
  return STEP_TO_LEGACY_STEP[step] ?? null;
}

module.exports = {
  Step,
  STEP_ORDER,
  isStep,
  stepIndex,
  isTerminal,
  appliesTo,
  requiredSteps,
  nextStep,
  canEnter,
  resumeStep,
  fromLegacyStep,
  toLegacyStep,
};
