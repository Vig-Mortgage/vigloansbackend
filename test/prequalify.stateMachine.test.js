'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  Step,
  STEP_ORDER,
  isStep,
  isTerminal,
  appliesTo,
  requiredSteps,
  nextStep,
  canEnter,
  resumeStep,
  fromLegacyStep,
  toLegacyStep,
  needsPreviousAddress,
  MIN_MONTHS_AT_CURRENT_ADDRESS,
} = require('../lib/prequalify/stateMachine');

/** Lead individual, sin direcciones opcionales: el camino del legacy. */
const INDIVIDUAL = { typeOfCredit: 'IndividualCredit' };
const CONJUNTO = { typeOfCredit: 'CoborrowerCredit' };

// --- orden y transiciones -------------------------------------------------

test('el camino base omite los pasos opcionales que no aplican', () => {
  const camino = [];
  let step = Step.START;
  camino.push(step);
  while (!isTerminal(step)) {
    step = nextStep(step, INDIVIDUAL);
    camino.push(step);
  }

  assert.deepEqual(camino, [
    Step.START,
    Step.OTP_VERIFY,
    Step.PERSONAL,
    Step.CURRENT_ADDRESS,
    Step.CREDIT_CHECK,
    Step.EMPLOYMENT,
    Step.INCOME,
    Step.SUBMIT,
    Step.DONE,
  ]);
});

test('credito conjunto intercala el paso de co-deudor antes de submit', () => {
  assert.equal(nextStep(Step.INCOME, CONJUNTO), Step.COBORROWER);
  assert.equal(nextStep(Step.COBORROWER, CONJUNTO), Step.SUBMIT);
  // Individual lo salta por completo.
  assert.equal(nextStep(Step.INCOME, INDIVIDUAL), Step.SUBMIT);
});

test('las direcciones opcionales solo entran si el contexto lo pide', () => {
  assert.equal(nextStep(Step.CURRENT_ADDRESS, INDIVIDUAL), Step.CREDIT_CHECK);

  assert.equal(
    nextStep(Step.CURRENT_ADDRESS, { ...INDIVIDUAL, needsPreviousAddress: true }),
    Step.PREVIOUS_ADDRESS
  );
  assert.equal(
    nextStep(Step.CURRENT_ADDRESS, { ...INDIVIDUAL, mailingAddressDiffers: true }),
    Step.MAILING_ADDRESS
  );
  // Con ambas, respeta el orden del formulario legacy: anterior antes que postal.
  const ambas = { ...INDIVIDUAL, needsPreviousAddress: true, mailingAddressDiffers: true };
  assert.equal(nextStep(Step.CURRENT_ADDRESS, ambas), Step.PREVIOUS_ADDRESS);
  assert.equal(nextStep(Step.PREVIOUS_ADDRESS, ambas), Step.MAILING_ADDRESS);
  assert.equal(nextStep(Step.MAILING_ADDRESS, ambas), Step.CREDIT_CHECK);
});

// --- regla URLA: direccion anterior si <2 anos en la actual ---------------

test('needsPreviousAddress se deriva del tiempo en la direccion actual', () => {
  assert.equal(MIN_MONTHS_AT_CURRENT_ADDRESS, 24);
  // Menos de 2 anos -> hay que pedirla.
  assert.equal(needsPreviousAddress({ currentAddressYears: 1, currentAddressMonths: 11 }), true);
  assert.equal(needsPreviousAddress({ currentAddressYears: 0, currentAddressMonths: 3 }), true);
  // Justo 2 anos o mas -> no.
  assert.equal(needsPreviousAddress({ currentAddressYears: 2, currentAddressMonths: 0 }), false);
  assert.equal(needsPreviousAddress({ currentAddressYears: 5, currentAddressMonths: 6 }), false);
});

test('needsPreviousAddress acepta anos o meses por separado', () => {
  assert.equal(needsPreviousAddress({ currentAddressMonths: 30 }), false);
  assert.equal(needsPreviousAddress({ currentAddressMonths: 12 }), true);
  assert.equal(needsPreviousAddress({ currentAddressYears: 3 }), false);
});

test('needsPreviousAddress: la bandera explicita gana sobre lo derivado', () => {
  assert.equal(
    needsPreviousAddress({ needsPreviousAddress: true, currentAddressYears: 10 }),
    true
  );
  assert.equal(
    needsPreviousAddress({ needsPreviousAddress: false, currentAddressYears: 0, currentAddressMonths: 1 }),
    false
  );
});

test('needsPreviousAddress es false si no hay dato de tiempo', () => {
  assert.equal(needsPreviousAddress({}), false);
  assert.equal(needsPreviousAddress(), false);
});

test('el wizard intercala la direccion anterior cuando lleva <2 anos', () => {
  const recienMudado = { ...INDIVIDUAL, currentAddressYears: 1, currentAddressMonths: 0 };
  assert.equal(nextStep(Step.CURRENT_ADDRESS, recienMudado), Step.PREVIOUS_ADDRESS);
  assert.equal(nextStep(Step.PREVIOUS_ADDRESS, recienMudado), Step.CREDIT_CHECK);

  const arraigado = { ...INDIVIDUAL, currentAddressYears: 8, currentAddressMonths: 0 };
  assert.equal(nextStep(Step.CURRENT_ADDRESS, arraigado), Step.CREDIT_CHECK);
});

test('canEnter bloquea el credito si falta la direccion anterior exigida', () => {
  const state = {
    ...INDIVIDUAL,
    currentAddressYears: 0,
    currentAddressMonths: 8,
    completedSteps: [Step.START, Step.OTP_VERIFY, Step.PERSONAL, Step.CURRENT_ADDRESS],
  };
  assert.equal(canEnter(Step.PREVIOUS_ADDRESS, state), true);
  assert.equal(canEnter(Step.CREDIT_CHECK, state), false);
});

test('nextStep es idempotente en el estado terminal', () => {
  assert.equal(nextStep(Step.DONE, INDIVIDUAL), Step.DONE);
  assert.equal(nextStep(Step.SUBMIT, INDIVIDUAL), Step.DONE);
});

test('nextStep rechaza un paso desconocido en vez de devolver algo raro', () => {
  assert.throws(() => nextStep('pasoInventado', INDIVIDUAL), RangeError);
  assert.throws(() => nextStep(undefined, INDIVIDUAL), RangeError);
  assert.throws(() => nextStep(null, INDIVIDUAL), RangeError);
});

test('STEP_ORDER no tiene duplicados y termina en DONE', () => {
  assert.equal(new Set(STEP_ORDER).size, STEP_ORDER.length);
  assert.equal(STEP_ORDER.at(-1), Step.DONE);
  assert.ok(STEP_ORDER.every(isStep));
});

test('requiredSteps refleja el contexto y excluye DONE', () => {
  assert.ok(!requiredSteps(INDIVIDUAL).includes(Step.DONE));
  assert.ok(!requiredSteps(INDIVIDUAL).includes(Step.COBORROWER));
  assert.ok(requiredSteps(CONJUNTO).includes(Step.COBORROWER));
});

test('appliesTo: los pasos obligatorios aplican siempre', () => {
  assert.equal(appliesTo(Step.PERSONAL, {}), true);
  assert.equal(appliesTo(Step.COBORROWER, {}), false);
  assert.equal(appliesTo(Step.PREVIOUS_ADDRESS, {}), false);
});

// --- canEnter -------------------------------------------------------------

test('canEnter exige que los pasos anteriores esten completos', () => {
  const state = { ...INDIVIDUAL, completedSteps: [Step.START, Step.OTP_VERIFY] };
  assert.equal(canEnter(Step.PERSONAL, state), true);
  // Saltarse personal para colarse en empleo, no.
  assert.equal(canEnter(Step.EMPLOYMENT, state), false);
  assert.equal(canEnter(Step.INCOME, state), false);
  assert.equal(canEnter(Step.SUBMIT, state), false);
});

test('canEnter permite volver a un paso ya completado (corregir datos)', () => {
  const state = {
    ...INDIVIDUAL,
    completedSteps: [Step.START, Step.OTP_VERIFY, Step.PERSONAL, Step.CURRENT_ADDRESS],
  };
  assert.equal(canEnter(Step.PERSONAL, state), true);
  assert.equal(canEnter(Step.CURRENT_ADDRESS, state), true);
  assert.equal(canEnter(Step.CREDIT_CHECK, state), true);
});

test('canEnter no exige los pasos opcionales que no aplican', () => {
  const state = {
    ...INDIVIDUAL,
    completedSteps: [Step.START, Step.OTP_VERIFY, Step.PERSONAL, Step.CURRENT_ADDRESS],
  };
  // previousAddress no aplica, asi que no bloquea el paso de credito.
  assert.equal(canEnter(Step.CREDIT_CHECK, state), true);

  // Pero si aplica y falta, si bloquea.
  const conAnterior = { ...state, needsPreviousAddress: true };
  assert.equal(canEnter(Step.CREDIT_CHECK, conAnterior), false);
  assert.equal(canEnter(Step.PREVIOUS_ADDRESS, conAnterior), true);
});

test('canEnter rechaza pasos que no aplican, desconocidos o terminales', () => {
  const state = { ...INDIVIDUAL, completedSteps: STEP_ORDER };
  assert.equal(canEnter(Step.COBORROWER, state), false); // no aplica a individual
  assert.equal(canEnter(Step.DONE, state), false);
  assert.equal(canEnter('pasoInventado', state), false);
});

test('canEnter tolera un leadState vacio o sin completedSteps', () => {
  assert.equal(canEnter(Step.START, {}), true);
  assert.equal(canEnter(Step.PERSONAL, {}), false);
  assert.equal(canEnter(Step.START, { completedSteps: 'no-es-arreglo' }), true);
});

// --- resumeStep -----------------------------------------------------------

test('resumeStep devuelve el primer paso pendiente', () => {
  assert.equal(resumeStep({ ...INDIVIDUAL, completedSteps: [] }), Step.START);
  assert.equal(
    resumeStep({ ...INDIVIDUAL, completedSteps: [Step.START, Step.OTP_VERIFY] }),
    Step.PERSONAL
  );
});

test('resumeStep devuelve DONE cuando ya se completo todo lo aplicable', () => {
  const completedSteps = requiredSteps(INDIVIDUAL);
  assert.equal(resumeStep({ ...INDIVIDUAL, completedSteps }), Step.DONE);

  // El mismo conjunto NO alcanza para un credito conjunto: falta el co-deudor.
  assert.equal(resumeStep({ ...CONJUNTO, completedSteps }), Step.COBORROWER);
});

// --- interoperabilidad con currentStep__c del legacy -----------------------

test('fromLegacyStep respeta el mapeo de js/script_finish.js', () => {
  assert.equal(fromLegacyStep(1), Step.PERSONAL);
  assert.equal(fromLegacyStep(2), Step.CURRENT_ADDRESS);
  assert.equal(fromLegacyStep(3), Step.EMPLOYMENT);
  assert.equal(fromLegacyStep(4), Step.INCOME);
  assert.equal(fromLegacyStep(5), Step.SUBMIT);
});

test('fromLegacyStep acepta el numero como string (asi lo guarda Salesforce)', () => {
  assert.equal(fromLegacyStep('3'), Step.EMPLOYMENT);
});

test('fromLegacyStep devuelve null para valores fuera del mapa', () => {
  for (const value of [0, 6, 99, '', null, undefined, 'abc']) {
    assert.equal(fromLegacyStep(value), null, `valor: ${String(value)}`);
  }
});

test('toLegacyStep es la inversa donde el legacy tiene numero', () => {
  for (const legacy of [1, 2, 3, 4, 5]) {
    assert.equal(toLegacyStep(fromLegacyStep(legacy)), legacy);
  }
});

test('toLegacyStep devuelve null para los pasos que el legacy no numera', () => {
  for (const step of [
    Step.START,
    Step.OTP_VERIFY,
    Step.PREVIOUS_ADDRESS,
    Step.MAILING_ADDRESS,
    Step.CREDIT_CHECK,
    Step.COBORROWER,
    Step.DONE,
  ]) {
    assert.equal(toLegacyStep(step), null, `paso: ${step}`);
  }
});
