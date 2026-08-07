'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { computeQuote, FinancialCalc } = require('../lib/calculator');

const approx = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

test('FHA purchase 200k @ 3.5% down, 30yr, 6.5% — paridad de piezas exactas', () => {
  const q = computeQuote({
    transactionType: 'purchase',
    loanType: 'FHA',
    price: 200000,
    years: 30,
    interest: 6.5,
    downPaymentMode: 'percent',
    downPaymentValue: 3.5,
    taxes: 0,
    insurance: 0,
    hoa: 0,
  });

  assert.ok(approx(q.loanBase, 193000), `loanBase=${q.loanBase}`);
  assert.ok(approx(q.downPaymentAmount, 7000), `dp=${q.downPaymentAmount}`);
  assert.ok(approx(q.downPaymentPercent, 3.5), `dp%=${q.downPaymentPercent}`);
  assert.ok(approx(q.ltv, 96.5), `ltv=${q.ltv}`);
  assert.strictEqual(q.upfrontFee, 3378);            // round(193000*0.0175)
  assert.ok(approx(q.totalLoanAmount, 196378), `total=${q.totalLoanAmount}`);
  assert.ok(approx(q.minDownPayment, 7000), `minDp=${q.minDownPayment}`); // 200000*0.035
  // MIP: base=price-ufmip=196622, rate 0.55 (ltv>95), mensual = 196622*0.0055/12
  assert.ok(approx(q.monthlyMIP, 90.1184, 0.001), `monthlyMIP=${q.monthlyMIP}`);
  // P&I sobre 196378 @ 6.5% 30yr ≈ 1241.2
  assert.ok(approx(q.monthlyPrincipalAndInterest, 1241.2, 0.5), `pi=${q.monthlyPrincipalAndInterest}`);
  // total = pi + mip (taxes/ins/hoa = 0)
  assert.ok(approx(q.totalMonthlyPayment, q.monthlyPrincipalAndInterest + q.monthlyMIP, 0.0001));
});

test('CONV con 20% down no lleva PMI (ltv<=80)', () => {
  const q = computeQuote({
    transactionType: 'purchase',
    loanType: 'CONV',
    price: 300000,
    years: 30,
    interest: 7,
    downPaymentMode: 'percent',
    downPaymentValue: 20,
    taxes: 0, insurance: 0, hoa: 0,
  });
  assert.strictEqual(q.ltv, 80);
  assert.strictEqual(q.monthlyMIP, 0);
  assert.strictEqual(q.upfrontFee, 0);
  assert.strictEqual(q.loanBase, 240000);
});

test('CONV con 10% down y FICO 720-739 lleva PMI', () => {
  const q = computeQuote({
    transactionType: 'purchase',
    loanType: 'CONV',
    price: 300000,
    years: 30,
    interest: 7,
    downPaymentMode: 'percent',
    downPaymentValue: 10,
    creditScore: '720-739',
    taxes: 0, insurance: 0, hoa: 0,
  });
  // PMI rate 30yr/720-739/10-15 = 0.75 → mensual = 300000*0.0075/12 = 187.5
  assert.ok(approx(q.monthlyMIP, 187.5, 0.001), `pmi=${q.monthlyMIP}`);
});

test('VA purchase exento de funding fee → upfront 0', () => {
  const q = computeQuote({
    transactionType: 'purchase', loanType: 'VA', price: 250000, years: 30, interest: 6,
    downPaymentMode: 'percent', downPaymentValue: 0, isVaFundingFeeExempt: true,
    taxes: 0, insurance: 0, hoa: 0,
  });
  assert.strictEqual(q.upfrontFee, 0);
  assert.strictEqual(q.loanBase, 250000);
});

test('VA purchase first-time, 0% down → funding fee 2.15%', () => {
  const q = computeQuote({
    transactionType: 'purchase', loanType: 'VA', price: 250000, years: 30, interest: 6,
    downPaymentMode: 'percent', downPaymentValue: 0, isVaFirstTime: true,
    taxes: 0, insurance: 0, hoa: 0,
  });
  assert.ok(approx(q.upfrontFee, 250000 * 0.0215, 0.001), `ff=${q.upfrontFee}`);
});

test('USDA aplica fee anual 0.35% mensualizado', () => {
  const q = computeQuote({
    transactionType: 'purchase', loanType: 'USDA', price: 200000, years: 30, interest: 6.5,
    downPaymentMode: 'percent', downPaymentValue: 0, taxes: 0, insurance: 0, hoa: 0,
  });
  // (200000*0.35/100)/12 = 58.333...
  assert.ok(approx(q.monthlyMIP, (200000 * 0.35 / 100) / 12, 0.001), `usda=${q.monthlyMIP}`);
});

test('seguro por defecto = price*0.00022 redondeado cuando no se envía', () => {
  const q = computeQuote({
    transactionType: 'purchase', loanType: 'CONV', price: 300000, years: 30, interest: 7,
    downPaymentMode: 'percent', downPaymentValue: 20, taxes: 0, hoa: 0,
  });
  assert.strictEqual(q.monthlyInsurance, Math.round(300000 * 0.00022)); // 66
});

test('refi CONV: downPaymentValue es el balance del préstamo', () => {
  const q = computeQuote({
    transactionType: 'refi', loanType: 'CONV', price: 300000, years: 30, interest: 6.5,
    downPaymentValue: 240000, taxes: 0, insurance: 0, hoa: 0,
  });
  assert.strictEqual(q.loanBase, 240000);
  assert.strictEqual(q.ltv, 80);
});

test('amortización opcional: 360 filas y balance final ~0', () => {
  const q = computeQuote({
    transactionType: 'purchase', loanType: 'FHA', price: 200000, years: 30, interest: 6.5,
    downPaymentMode: 'percent', downPaymentValue: 3.5, taxes: 0, insurance: 0, hoa: 0,
    includeAmortization: true,
  });
  assert.strictEqual(q.amortizationTable.length, 360);
  assert.ok(q.amortizationTable[359].balance < 1, `balance final=${q.amortizationTable[359].balance}`);
});
