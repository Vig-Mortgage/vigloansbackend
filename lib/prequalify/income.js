'use strict';

/**
 * Conversion de ingreso a mensual.
 *
 * El legacy calculaba esto en el navegador (`js/scripts.js:590-611`) y el
 * backend guardaba el total que le mandara el cliente. Aqui se recalcula
 * server-side: el cliente puede mostrar el estimado, pero la cifra que se
 * guarda y con la que se decide la sale de este modulo.
 *
 * Los multiplicadores son los del legacy y coinciden con la guia de Fannie Mae
 * para base pay (B3-3.1-03): semanal x52/12, bisemanal x26/12, quincenal x2.
 *
 * Nota de nomenclatura: en el formulario legacy el input se llama
 * `MonthlyIncome` pero contiene el **pago por periodo**, y `TotalIncome` es el
 * derivado **mensual**. Los nombres estaban invertidos. En la API se llaman
 * `grossPayPerPeriod` y `monthlyIncome`, que es lo que de verdad son.
 */

/** Periodos de pago al ano por frecuencia. */
const PAY_PERIODS_PER_YEAR = Object.freeze({
  Weekly: 52,
  Biweekly: 26,
  Semimonthly: 24,
});

const MONTHS_PER_YEAR = 12;

/** Redondeo a centavos, igual que el `toFixed(2)` del legacy. */
function roundToCents(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Ingreso mensual a partir del pago por periodo y la frecuencia.
 *
 * Un pensionado o retirado declara directamente su mensualidad y no tiene
 * frecuencia: el legacy salta el radio en ese caso (`scripts.js:591-593`).
 *
 * @param {object} input
 * @param {number} input.grossPayPerPeriod pago bruto de un periodo
 * @param {'Weekly'|'Biweekly'|'Semimonthly'} [input.incomeFrequency]
 * @param {boolean} [input.retiredOrPensioner=false]
 * @returns {number} ingreso mensual redondeado a centavos
 * @throws {RangeError} si falta la frecuencia y no es pensionado
 */
function monthlyIncomeFrom({
  grossPayPerPeriod,
  incomeFrequency,
  retiredOrPensioner = false,
}) {
  // `Number(null)` y `Number('')` son 0, y `Number(true)` es 1: sin este filtro
  // un pago ausente se colaria como ingreso cero en vez de dar error.
  const esConvertible =
    typeof grossPayPerPeriod === 'number' ||
    (typeof grossPayPerPeriod === 'string' && grossPayPerPeriod.trim() !== '');
  const pay = esConvertible ? Number(grossPayPerPeriod) : NaN;
  if (!Number.isFinite(pay) || pay < 0) {
    throw new RangeError('grossPayPerPeriod debe ser un numero no negativo');
  }

  if (retiredOrPensioner) return roundToCents(pay);

  const periods = PAY_PERIODS_PER_YEAR[incomeFrequency];
  if (!periods) {
    throw new RangeError(`Frecuencia de ingreso desconocida: ${String(incomeFrequency)}`);
  }

  return roundToCents((pay * periods) / MONTHS_PER_YEAR);
}

module.exports = {
  PAY_PERIODS_PER_YEAR,
  MONTHS_PER_YEAR,
  monthlyIncomeFrom,
  roundToCents,
};
