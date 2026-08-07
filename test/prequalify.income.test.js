'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PAY_PERIODS_PER_YEAR,
  monthlyIncomeFrom,
} = require('../lib/prequalify/income');

/**
 * Los valores esperados replican `js/scripts.js:590-611`, que es donde el
 * legacy calculaba esto en el navegador. Coinciden con la guia de Fannie Mae
 * para base pay (B3-3.1-03).
 */

test('bisemanal: pago x26/12, igual que el legacy', () => {
  assert.equal(
    monthlyIncomeFrom({ grossPayPerPeriod: 1200, incomeFrequency: 'Biweekly' }),
    Number(((1200 * 26) / 12).toFixed(2))
  );
  assert.equal(
    monthlyIncomeFrom({ grossPayPerPeriod: 1200, incomeFrequency: 'Biweekly' }),
    2600
  );
});

test('semanal: pago x52/12', () => {
  assert.equal(
    monthlyIncomeFrom({ grossPayPerPeriod: 600, incomeFrequency: 'Weekly' }),
    2600
  );
});

test('quincenal: pago x2 (equivale a x24/12)', () => {
  assert.equal(
    monthlyIncomeFrom({ grossPayPerPeriod: 1300, incomeFrequency: 'Semimonthly' }),
    2600
  );
  assert.equal(PAY_PERIODS_PER_YEAR.Semimonthly / 12, 2);
});

test('pensionado: la mensualidad va tal cual y no necesita frecuencia', () => {
  assert.equal(
    monthlyIncomeFrom({ grossPayPerPeriod: 1850.5, retiredOrPensioner: true }),
    1850.5
  );
});

test('redondea a centavos', () => {
  // 1000 * 52 / 12 = 4333.333...
  assert.equal(
    monthlyIncomeFrom({ grossPayPerPeriod: 1000, incomeFrequency: 'Weekly' }),
    4333.33
  );
});

test('cero es valido y da cero', () => {
  assert.equal(
    monthlyIncomeFrom({ grossPayPerPeriod: 0, incomeFrequency: 'Biweekly' }),
    0
  );
});

test('exige frecuencia conocida cuando no es pensionado', () => {
  assert.throws(
    () => monthlyIncomeFrom({ grossPayPerPeriod: 1000 }),
    RangeError
  );
  assert.throws(
    () => monthlyIncomeFrom({ grossPayPerPeriod: 1000, incomeFrequency: 'Monthly' }),
    RangeError
  );
});

test('rechaza pagos no numericos o negativos', () => {
  for (const pago of [-1, 'mucho', null, undefined, NaN, Infinity]) {
    assert.throws(
      () => monthlyIncomeFrom({ grossPayPerPeriod: pago, incomeFrequency: 'Weekly' }),
      RangeError,
      `pago: ${String(pago)}`
    );
  }
});

test('el ingreso ya no depende de lo que diga el cliente', () => {
  // Mismo pago y frecuencia => mismo mensual, sin importar que mande el cliente.
  const a = monthlyIncomeFrom({ grossPayPerPeriod: 1200, incomeFrequency: 'Biweekly' });
  const b = monthlyIncomeFrom({
    grossPayPerPeriod: 1200,
    incomeFrequency: 'Biweekly',
    totalIncome: 999999,
    monthlyIncome: 999999,
  });
  assert.equal(a, b);
});
