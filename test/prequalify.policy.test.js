'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  Outcome,
  ReviewReason,
  isDecisionEngineEnabled,
  decidePrequalification,
} = require('../lib/prequalify/policy');

const APAGADO = {};
const ENCENDIDO = { PREQUALIFY_DECISION_ENABLED: 'true' };

/** Perfil holgado: alto ingreso, poca deuda, buen score. */
const CALIFICA = {
  score: 780,          // llega asi desde experian.toDecisionInput()
  monthlyDebtPayments: 200,
  monthlyIncome: 9000,
};
/** Perfil que el motor rechazaria: score por debajo del minimo. */
const NO_CALIFICA = {
  score: 500,
  monthlyDebtPayments: 3000,
  monthlyIncome: 1500,
};

// --- Decision 1: el motor viene apagado ----------------------------------

test('el motor esta APAGADO salvo que se encienda explicitamente', () => {
  assert.equal(isDecisionEngineEnabled({}), false);
  assert.equal(isDecisionEngineEnabled({ PREQUALIFY_DECISION_ENABLED: 'false' }), false);
  assert.equal(isDecisionEngineEnabled({ PREQUALIFY_DECISION_ENABLED: '1' }), false);
  assert.equal(isDecisionEngineEnabled({ PREQUALIFY_DECISION_ENABLED: 'TRUE' }), false);
  assert.equal(isDecisionEngineEnabled(ENCENDIDO), true);
});

test('apagado, hasta un perfil que califica va a revision humana', () => {
  const r = decidePrequalification(CALIFICA, { env: APAGADO });
  assert.equal(r.outcome, Outcome.MANUAL_REVIEW);
  assert.equal(r.reviewReason, ReviewReason.DECISION_ENGINE_DISABLED);
  assert.equal(r.internal, null, 'apagado no se calcula nada');
});

test('apagado no filtra ningun numero al cliente', () => {
  const r = decidePrequalification(CALIFICA, { env: APAGADO });
  assert.deepEqual(Object.keys(r.client), ['outcome']);
});

// --- Decision 2: nunca una negativa automatica ---------------------------

test('un perfil que NO califica sale como revision, nunca como negativa', () => {
  const r = decidePrequalification(NO_CALIFICA, { env: ENCENDIDO });
  assert.equal(r.outcome, Outcome.MANUAL_REVIEW);
  assert.equal(r.reviewReason, ReviewReason.DOES_NOT_MEET_CRITERIA);
});

test('la palabra DECLINED nunca llega al cliente', () => {
  // Es la defensa concreta contra emitir un adverse action sin los requisitos
  // de la Regulation B.
  const r = decidePrequalification(NO_CALIFICA, { env: ENCENDIDO });
  const serializado = JSON.stringify(r.client);
  assert.ok(!serializado.includes('DECLINED'));
  assert.ok(!serializado.toLowerCase().includes('declin'));
  assert.ok(!serializado.toLowerCase().includes('rechaz'));
});

test('no hay bandera que convierta la revision en negativa', () => {
  // Cualquier combinacion de entorno debe dar MANUAL_REVIEW para un no-califica.
  for (const env of [
    APAGADO,
    ENCENDIDO,
    { ...ENCENDIDO, PREQUALIFY_ALLOW_DECLINE: 'true' },
    { ...ENCENDIDO, NODE_ENV: 'production' },
  ]) {
    const r = decidePrequalification(NO_CALIFICA, { env });
    assert.equal(r.outcome, Outcome.MANUAL_REVIEW, `env: ${JSON.stringify(env)}`);
  }
});

test('el detalle de la decision queda para Salesforce, no para el cliente', () => {
  const r = decidePrequalification(NO_CALIFICA, { env: ENCENDIDO });
  assert.ok(r.internal, 'el asesor necesita el detalle');
  assert.ok('decision' in r.internal);
  assert.ok(!('decision' in r.client));
});

// --- camino feliz ---------------------------------------------------------

test('encendido, quien califica recibe monto estimado', () => {
  const r = decidePrequalification(CALIFICA, { env: ENCENDIDO });
  assert.equal(r.outcome, Outcome.QUALIFIED);
  assert.equal(r.reviewReason, null);
  assert.ok(r.client.maxHomePrice > 0);
  assert.ok(r.client.estimatedMonthlyPayment > 0);
});

test('el cliente solo ve el resultado y las dos cifras utiles', () => {
  const r = decidePrequalification(CALIFICA, { env: ENCENDIDO });
  assert.deepEqual(
    Object.keys(r.client).sort(),
    ['estimatedMonthlyPayment', 'maxHomePrice', 'outcome']
  );
  // Ni DTI ni ratio de vivienda: son internos.
  assert.ok(!('dtiPercent' in r.client));
  assert.ok(!('housingPercent' in r.client));
});

// --- robustez -------------------------------------------------------------

test('acepta score o creditScore indistintamente', () => {
  // La costura entre experian.toDecisionInput() (score) y
  // evaluatePrequalification() (creditScore). Si no se une, el score llega
  // undefined y rechaza a todo el mundo: el mismo bug del legacy.
  const conScore = decidePrequalification(CALIFICA, { env: ENCENDIDO });
  const conCreditScore = decidePrequalification(
    { creditScore: CALIFICA.score, monthlyDebtPayments: CALIFICA.monthlyDebtPayments, monthlyIncome: CALIFICA.monthlyIncome },
    { env: ENCENDIDO }
  );
  assert.equal(conScore.outcome, Outcome.QUALIFIED);
  assert.deepEqual(conScore.client, conCreditScore.client);
});

test('datos incompletos van a revision, no revientan ni rechazan', () => {
  for (const entrada of [{}, null, undefined, { score: 'muchos' }]) {
    const r = decidePrequalification(entrada, { env: ENCENDIDO });
    assert.equal(r.outcome, Outcome.MANUAL_REVIEW, `entrada: ${JSON.stringify(entrada)}`);
  }
});

test('el resultado nunca incluye datos identificables del solicitante', () => {
  const conPii = { ...CALIFICA, email: 'juan@example.com', ssn: '123456789' };
  const r = decidePrequalification(conPii, { env: ENCENDIDO });
  const serializado = JSON.stringify(r.client);
  assert.ok(!serializado.includes('juan@example.com'));
  assert.ok(!serializado.includes('123456789'));
});
