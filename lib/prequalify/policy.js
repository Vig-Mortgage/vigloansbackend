'use strict';

const { Decision, evaluatePrequalification, toClientResult } = require('./decision');

/**
 * Politica de precalificacion: la unica puerta por la que el router debe pedir
 * una decision.
 *
 * `decision.js` porta fielmente el calculo del legacy. Este modulo decide **que
 * se hace con ese calculo**, y existe porque dos cosas no pueden quedar a
 * criterio de quien escriba el endpoint:
 *
 * --------------------------------------------------------------------------
 * DECISION 1 — el motor no decide en produccion hasta que alguien firme los
 * numeros.
 *
 * Los umbrales portados (620 / 45% / 32%) estan corroborados por
 * `accionIncomeTest.php:277-278` y `calculadoraPre.php:101,104`, pero la
 * implementacion que corre hoy en produccion **rechaza a todo el mundo** por
 * dos bugs (la clave de sesion `Score` vs `score`, y la comparacion de DTI con
 * unidades mezcladas). Es decir: no hay una politica vigente que estos numeros
 * reproduzcan; hay una politica *pretendida* que nunca se ejecuto.
 *
 * Activar un motor de credito automatico en ese contexto es una decision de
 * negocio con dueno, no un detalle de despliegue. Por eso el motor viene
 * **apagado** y hay que encenderlo explicitamente con
 * `PREQUALIFY_DECISION_ENABLED=true`. Apagado, todo resultado sale a revision
 * humana. Asi el codigo se puede desplegar sin que nadie reciba una decision
 * automatica por accidente.
 *
 * --------------------------------------------------------------------------
 * DECISION 2 — el sistema NUNCA emite un rechazo automatico.
 *
 * Si esta precalificacion cuenta como *application* bajo la Regulation B
 * (12 CFR 1002.2(f)), una negativa es *adverse action* y arrastra requisitos
 * de contenido y plazo: motivos concretos, aviso FCRA, datos del bureau. Esa
 * determinacion es juridica y no se toma escribiendo codigo.
 *
 * La salida de ingenieria es no necesitar la respuesta para poder avanzar: el
 * flujo automatico **no puede** producir una negativa dirigida al solicitante.
 * Un caso que no califica se convierte en `MANUAL_REVIEW` y lo toma una
 * persona, que es quien puede emitir el aviso con lo que cumplimiento defina.
 * `DECLINED` sobrevive solo como dato interno para Salesforce.
 *
 * Esto es deliberadamente dificil de deshacer por descuido: no hay bandera que
 * convierta un `MANUAL_REVIEW` en una negativa al cliente. Habilitarlo exige
 * tocar este archivo, y este comentario.
 */

/** Lo que el flujo automatico puede concluir de cara al solicitante. */
const Outcome = Object.freeze({
  /** Califica. Se le puede decir. */
  QUALIFIED: 'QUALIFIED',
  /** No hay conclusion automatica: lo toma una persona. */
  MANUAL_REVIEW: 'MANUAL_REVIEW',
});

/** Por que quedo en revision humana. Interno, para el log y para el asesor. */
const ReviewReason = Object.freeze({
  DECISION_ENGINE_DISABLED: 'DECISION_ENGINE_DISABLED',
  DOES_NOT_MEET_CRITERIA: 'DOES_NOT_MEET_CRITERIA',
  INCOMPLETE_DATA: 'INCOMPLETE_DATA',
});

/** ¿Esta habilitado el motor? Apagado salvo que se diga que si, explicitamente. */
function isDecisionEngineEnabled(env = process.env) {
  return env.PREQUALIFY_DECISION_ENABLED === 'true';
}

/**
 * Une la salida de `experian.toDecisionInput()` con la entrada de
 * `evaluatePrequalification()`.
 *
 * La primera devuelve `score` y la segunda espera `creditScore`. Sin este
 * puente el score llega `undefined` y **todo el mundo sale rechazado** — que es
 * exactamente el bug que ya tenia el legacy con `$_SESSION['Score']` frente a
 * `$_SESSION['score']`. Se acepta cualquiera de los dos nombres a proposito.
 */
function normalizeInput(input) {
  const src = input ?? {};
  return {
    creditScore: src.creditScore ?? src.score,
    monthlyIncome: src.monthlyIncome,
    monthlyDebtPayments: src.monthlyDebtPayments,
    ...(src.assumptions ? { assumptions: src.assumptions } : {}),
  };
}

/**
 * Evalua y aplica la politica.
 *
 * @param {object} input `{score|creditScore, monthlyIncome, monthlyDebtPayments}`
 * @param {object} [options]
 * @param {object} [options.env]
 * @returns {{
 *   outcome: string,
 *   reviewReason: string|null,
 *   client: object,
 *   internal: object|null
 * }}
 *   `client` es lo unico que puede volver al solicitante. `internal` lleva el
 *   detalle para Salesforce y el asesor, y NO se serializa hacia el cliente.
 */
function decidePrequalification(input, { env = process.env } = {}) {
  if (!isDecisionEngineEnabled(env)) {
    return {
      outcome: Outcome.MANUAL_REVIEW,
      reviewReason: ReviewReason.DECISION_ENGINE_DISABLED,
      client: { outcome: Outcome.MANUAL_REVIEW },
      internal: null,
    };
  }

  let result;
  try {
    result = evaluatePrequalification(normalizeInput(input));
  } catch {
    // Datos insuficientes o inconsistentes: a revision, nunca a negativa.
    return {
      outcome: Outcome.MANUAL_REVIEW,
      reviewReason: ReviewReason.INCOMPLETE_DATA,
      client: { outcome: Outcome.MANUAL_REVIEW },
      internal: null,
    };
  }

  const internal = { ...result, client: toClientResult(result) };

  if (result.decision === Decision.QUALIFIED) {
    return {
      outcome: Outcome.QUALIFIED,
      reviewReason: null,
      // Al solicitante que califica si se le puede dar el monto estimado.
      client: {
        outcome: Outcome.QUALIFIED,
        maxHomePrice: internal.client.maxHomePrice,
        estimatedMonthlyPayment: internal.client.estimatedMonthlyPayment,
      },
      internal,
    };
  }

  // DECLINED nunca sale como negativa: se convierte en revision humana.
  return {
    outcome: Outcome.MANUAL_REVIEW,
    reviewReason: ReviewReason.DOES_NOT_MEET_CRITERIA,
    client: { outcome: Outcome.MANUAL_REVIEW },
    internal,
  };
}

module.exports = {
  Outcome,
  normalizeInput,
  ReviewReason,
  isDecisionEngineEnabled,
  decidePrequalification,
};
