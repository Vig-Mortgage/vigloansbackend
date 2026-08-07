'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  MIN_CREDIT_SCORE,
  MAX_DTI_PERCENT,
  MAX_HOUSING_PERCENT,
  HOME_PRICE_MIN,
  HOME_PRICE_MAX,
  LOAN_ASSUMPTIONS,
  FHA_CONSTANTS,
  Decision,
  Reason,
  fhaAnnualMipRate,
  fhaMonthlyPayment,
  meetsCreditScore,
  findMaxHomePrice,
  evaluatePrequalification,
  toClientResult,
  toSalesforceLeadFields,
} = require('../lib/prequalify/decision');

/**
 * Los valores esperados replican `vigpr-joomla/prequalify/accionIncome.php`
 * (`calcularPagoMensualFHA` :192-239 y `calcularCalificacionPrestamo` :241-335),
 * contrastados con `accionIncomeTest.php:237-290` y `calculadoraPre.php:85-121`.
 */

// ---------------------------------------------------------------------------
// Umbrales portados
// ---------------------------------------------------------------------------

test('los umbrales son los del legacy, sin inventos', () => {
  // accionIncome.php:302 / accionIncomeTest.php:276 / calculadoraPre.php:100
  assert.equal(MIN_CREDIT_SCORE, 620);
  // accionIncomeTest.php:277 / calculadoraPre.php:104
  assert.equal(MAX_DTI_PERCENT, 45);
  // accionIncomeTest.php:278 / calculadoraPre.php:101
  assert.equal(MAX_HOUSING_PERCENT, 32);
  // accionIncome.php:365
  assert.equal(HOME_PRICE_MIN, 70000);
  assert.equal(HOME_PRICE_MAX, 498257);
  // accionIncome.php:241 (valores por defecto de la firma)
  assert.deepEqual({ ...LOAN_ASSUMPTIONS }, {
    downPaymentPercent: 3.5,
    termYears: 30,
    annualInterestRate: 7,
  });
  // accionIncome.php:195, :196, :204, :225
  assert.equal(FHA_CONSTANTS.hazardInsuranceMonthlyRate, 0.022 / 100);
  assert.equal(FHA_CONSTANTS.ltvPercent, 96.5);
  assert.equal(FHA_CONSTANTS.loanBaseThreshold, 726200);
  assert.equal(FHA_CONSTANTS.upfrontMipRate, 0.0175);
});

test('el score minimo es inclusivo (accionIncome.php:302 usa >=)', () => {
  assert.equal(meetsCreditScore(619), false);
  assert.equal(meetsCreditScore(620), true);
  assert.equal(meetsCreditScore(621), true);
});

// ---------------------------------------------------------------------------
// Pago mensual FHA: paridad literal con el legacy
// ---------------------------------------------------------------------------

/**
 * Transcripcion independiente de `calcularPagoMensualFHA`
 * (`accionIncome.php:192-239`). Existe solo para probar paridad: si alguien
 * toca `fhaMonthlyPayment`, este test lo delata.
 */
function pagoLegacy(precioHogar, porcentajeProntoPago, anosPrestamo, tasaInteresAnual) {
  const montoProntoPago = precioHogar * (porcentajeProntoPago / 100);
  let montoPrestamo = precioHogar - montoProntoPago;
  const seguroMensual = precioHogar * (0.022 / 100);
  const margen = 96.5;
  const prestamoBase = (precioHogar * margen) / 100;

  let mipRate = 0;
  if (anosPrestamo > 15) {
    if (prestamoBase <= 726200) {
      if (margen <= 95) mipRate = 0.5;
      else if (margen > 95) mipRate = 0.55;
    } else if (prestamoBase > 726200) {
      if (margen <= 95) mipRate = 0.7;
      else if (margen > 95) mipRate = 0.75;
    }
  }

  const upfrontMIP = montoPrestamo * 0.0175;
  montoPrestamo += upfrontMIP;

  const tasaMensual = tasaInteresAnual / 100 / 12;
  const totalPagos = anosPrestamo * 12;
  const arriba = tasaMensual * (1 + tasaMensual) ** totalPagos;
  const abajo = (1 + tasaMensual) ** totalPagos - 1;
  const pago = (montoPrestamo * arriba) / abajo;

  const seguroFHA = (precioHogar - upfrontMIP) * mipRate * (1 / 100) * (1 / 12);

  return Math.round(pago + seguroMensual + seguroFHA);
}

test('fhaMonthlyPayment reproduce calcularPagoMensualFHA (accionIncome.php:192-239)', () => {
  for (const precio of [70000, 100000, 150000, 200000, 266620, 350000, 498257, 900000]) {
    assert.equal(
      fhaMonthlyPayment(precio, LOAN_ASSUMPTIONS),
      pagoLegacy(precio, 3.5, 30, 7),
      `precio ${precio}`
    );
  }
});

test('el pago se redondea a dolares enteros (accionIncome.php:236)', () => {
  const pago = fhaMonthlyPayment(200000, LOAN_ASSUMPTIONS);
  assert.equal(Number.isInteger(pago), true);
  assert.equal(pago, 1441);
});

test('tasa de MIP segun el LTV clavado en 96.5 (accionIncome.php:196-222)', () => {
  // 96.5 > 95 y prestamo base bajo el umbral -> 0.55
  assert.equal(fhaAnnualMipRate(100000, 96.5, 30), 0.55);
  // Sobre 726200 -> 0.75
  assert.equal(fhaAnnualMipRate(800000, 96.5, 30), 0.75);
  // Ramas que el LTV clavado nunca alcanza, pero que el legacy define.
  assert.equal(fhaAnnualMipRate(100000, 90, 30), 0.5);
  assert.equal(fhaAnnualMipRate(800000, 90, 30), 0.7);
  // A 15 anos el legacy deja mip_rate en 0 (accionIncome.php:200-203).
  assert.equal(fhaAnnualMipRate(100000, 96.5, 15), 0);
});

// ---------------------------------------------------------------------------
// Decision por score
// ---------------------------------------------------------------------------

test('score bajo el minimo declina sin buscar precio (accionIncome.php:312-333)', () => {
  const r = evaluatePrequalification({
    creditScore: 619,
    monthlyIncome: 6000,
    monthlyDebtPayments: 499.75,
  });
  assert.equal(r.decision, Decision.DECLINED);
  assert.equal(r.reason, Reason.CREDIT_SCORE_BELOW_MINIMUM);
  assert.equal(r.maxHomePrice, 0);
  // El legacy igual reportaba los ratios del punto medio del rango completo.
  assert.equal(r.estimatedMonthlyPayment, fhaMonthlyPayment(284128, LOAN_ASSUMPTIONS));
});

test('score exactamente 620 no declina por credito', () => {
  const r = evaluatePrequalification({
    creditScore: 620,
    monthlyIncome: 6000,
    monthlyDebtPayments: 0,
  });
  assert.notEqual(r.reason, Reason.CREDIT_SCORE_BELOW_MINIMUM);
  assert.equal(r.decision, Decision.QUALIFIED);
});

test('score 0 (reporte sin score) declina por credito, no por asequibilidad', () => {
  // Es el comportamiento del legacy via intval(null) -> 0, y esta marcado como
  // TODO(Roberto) en decision.js: "sin score" deberia ser un caso propio.
  const r = evaluatePrequalification({
    creditScore: 0,
    monthlyIncome: 20000,
    monthlyDebtPayments: 0,
  });
  assert.equal(r.reason, Reason.CREDIT_SCORE_BELOW_MINIMUM);
});

// ---------------------------------------------------------------------------
// Busqueda del precio maximo
// ---------------------------------------------------------------------------

test('califica y devuelve el precio maximo real', () => {
  const r = evaluatePrequalification({
    creditScore: 705,
    monthlyIncome: 6000,
    monthlyDebtPayments: 499.75,
  });
  assert.equal(r.decision, Decision.QUALIFIED);
  assert.equal(r.reason, Reason.QUALIFIED);
  assert.equal(r.maxHomePrice, 266620);
  assert.equal(r.housingPercent, 32);
  assert.equal(r.dtiPercent, 40.3292);
  assert.equal(r.estimatedMonthlyPayment, 1920);
});

test('el precio devuelto es el maximo: un dolar mas rompe algun ratio', () => {
  const income = 6000;
  const debts = 499.75;
  const r = evaluatePrequalification({
    creditScore: 705,
    monthlyIncome: income,
    monthlyDebtPayments: debts,
  });

  const ratios = (precio) => {
    const pago = fhaMonthlyPayment(precio, LOAN_ASSUMPTIONS);
    return {
      dti: ((debts + pago) / income) * 100,
      housing: (pago / income) * 100,
    };
  };

  const dentro = ratios(r.maxHomePrice);
  assert.ok(dentro.dti <= MAX_DTI_PERCENT);
  assert.ok(dentro.housing <= MAX_HOUSING_PERCENT);

  const fuera = ratios(r.maxHomePrice + 1);
  assert.ok(fuera.dti > MAX_DTI_PERCENT || fuera.housing > MAX_HOUSING_PERCENT);
});

test('ingreso insuficiente: no califica y el precio es 0 (accionIncome.php:254-263)', () => {
  const r = evaluatePrequalification({
    creditScore: 705,
    monthlyIncome: 1200,
    monthlyDebtPayments: 0,
  });
  assert.equal(r.decision, Decision.DECLINED);
  assert.equal(r.reason, Reason.INSUFFICIENT_AFFORDABILITY);
  assert.equal(r.maxHomePrice, 0);
});

test('las deudas hunden a quien con el mismo ingreso si calificaria', () => {
  const base = { creditScore: 705, monthlyIncome: 2200 };
  const sinDeudas = evaluatePrequalification({ ...base, monthlyDebtPayments: 0 });
  const conDeudas = evaluatePrequalification({ ...base, monthlyDebtPayments: 900 });

  assert.equal(sinDeudas.decision, Decision.QUALIFIED);
  assert.equal(conDeudas.decision, Decision.DECLINED);
  assert.equal(conDeudas.maxHomePrice, 0);
});

test('ingreso alto topa en el maximo del rango (accionIncome.php:365)', () => {
  const r = evaluatePrequalification({
    creditScore: 780,
    monthlyIncome: 25000,
    monthlyDebtPayments: 0,
  });
  assert.equal(r.decision, Decision.QUALIFIED);
  assert.equal(r.maxHomePrice, HOME_PRICE_MAX);
});

test('mas deuda nunca sube el precio maximo (monotonia)', () => {
  let anterior = Infinity;
  for (const deudas of [0, 100, 250, 500, 1000, 1500]) {
    const r = evaluatePrequalification({
      creditScore: 700,
      monthlyIncome: 8000,
      monthlyDebtPayments: deudas,
    });
    assert.ok(
      r.maxHomePrice <= anterior,
      `deudas ${deudas}: ${r.maxHomePrice} > ${anterior}`
    );
    anterior = r.maxHomePrice;
  }
});

test('mas ingreso nunca baja el precio maximo (monotonia)', () => {
  let anterior = -1;
  for (const ingreso of [2000, 3000, 4500, 6000, 9000, 15000]) {
    const r = evaluatePrequalification({
      creditScore: 700,
      monthlyIncome: ingreso,
      monthlyDebtPayments: 300,
    });
    assert.ok(
      r.maxHomePrice >= anterior,
      `ingreso ${ingreso}: ${r.maxHomePrice} < ${anterior}`
    );
    anterior = r.maxHomePrice;
  }
});

test('findMaxHomePrice converge en pocas iteraciones y es determinista', () => {
  const args = {
    monthlyIncome: 6000,
    monthlyDebtPayments: 499.75,
    assumptions: LOAN_ASSUMPTIONS,
    min: HOME_PRICE_MIN,
    max: HOME_PRICE_MAX,
  };
  const a = findMaxHomePrice(args);
  const b = findMaxHomePrice(args);
  assert.deepEqual(a, b);
  // log2(498257-70000) ~ 18.7
  assert.ok(a.iterations <= 20, `iteraciones: ${a.iterations}`);
});

// ---------------------------------------------------------------------------
// Ratios y formato
// ---------------------------------------------------------------------------

test('DTI y Housing se reportan con 4 decimales (accionIncome.php:251-252)', () => {
  const r = evaluatePrequalification({
    creditScore: 705,
    monthlyIncome: 5333,
    monthlyDebtPayments: 417.33,
  });
  for (const valor of [r.dtiPercent, r.housingPercent]) {
    assert.equal(valor, Math.round(valor * 10000) / 10000);
  }
});

test('DTI incluye las deudas y Housing no (accionIncome.php:248-249)', () => {
  const r = evaluatePrequalification({
    creditScore: 705,
    monthlyIncome: 6000,
    monthlyDebtPayments: 600,
  });
  const esperadoHousing = (r.estimatedMonthlyPayment / 6000) * 100;
  const esperadoDti = ((600 + r.estimatedMonthlyPayment) / 6000) * 100;
  assert.equal(r.housingPercent, Math.round(esperadoHousing * 10000) / 10000);
  assert.equal(r.dtiPercent, Math.round(esperadoDti * 10000) / 10000);
});

// ---------------------------------------------------------------------------
// Validacion de entrada
// ---------------------------------------------------------------------------

test('ingreso no positivo falla en claro (el legacy producia INF)', () => {
  for (const ingreso of [0, -1, null, undefined, NaN, 'mucho', Infinity]) {
    assert.throws(
      () =>
        evaluatePrequalification({
          creditScore: 700,
          monthlyIncome: ingreso,
          monthlyDebtPayments: 0,
        }),
      RangeError,
      `ingreso: ${String(ingreso)}`
    );
  }
});

test('deudas negativas o score no numerico fallan', () => {
  assert.throws(
    () =>
      evaluatePrequalification({
        creditScore: 700,
        monthlyIncome: 5000,
        monthlyDebtPayments: -1,
      }),
    RangeError
  );
  assert.throws(
    () =>
      evaluatePrequalification({
        creditScore: 'excelente',
        monthlyIncome: 5000,
        monthlyDebtPayments: 0,
      }),
    RangeError
  );
});

// ---------------------------------------------------------------------------
// Sin backdoors (accionIncome.php:26-28 NO se porto)
// ---------------------------------------------------------------------------

test('la decision no depende de la identidad del solicitante', () => {
  const base = { creditScore: 610, monthlyIncome: 6000, monthlyDebtPayments: 100 };
  const conEmailDelBackdoor = evaluatePrequalification({
    ...base,
    Email: 'rochugui10@gmail.com',
    email: 'rochugui10@gmail.com',
    FirstName: 'Quien',
    LastName: 'Sea',
  });
  const sinEmail = evaluatePrequalification(base);

  assert.deepEqual(conEmailDelBackdoor, sinEmail);
  // El legacy forzaba 620 para ese email y lo dejaba pasar. Aqui declina.
  assert.equal(conEmailDelBackdoor.reason, Reason.CREDIT_SCORE_BELOW_MINIMUM);
});

/** Quita comentarios de bloque y de linea: deja solo codigo ejecutable. */
function soloCodigo(fuente) {
  return fuente.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

test('el codigo ejecutable no contiene el backdoor del legacy', () => {
  // El email SI puede aparecer en la documentacion (hay que dejar constancia de
  // que `accionIncome.php:26-28` existio y no se porto); lo que no puede
  // aparecer es una rama que lo compare.
  const libDir = path.join(__dirname, '..', 'lib', 'prequalify');
  for (const archivo of ['decision.js', 'experian.js']) {
    const codigo = soloCodigo(fs.readFileSync(path.join(libDir, archivo), 'utf8'));
    assert.doesNotMatch(codigo, /rochugui/i, `${archivo}: el backdoor esta en el codigo`);
    assert.doesNotMatch(codigo, /@gmail\./i, `${archivo}: email hardcodeado en el codigo`);
    assert.doesNotMatch(codigo, /\bemail\b/i, `${archivo}: la decision no debe ver el email`);
  }
});

test('la evaluacion es pura: mismos argumentos, mismo resultado', () => {
  const args = { creditScore: 700, monthlyIncome: 7000, monthlyDebtPayments: 350 };
  assert.deepEqual(
    evaluatePrequalification(args),
    evaluatePrequalification({ ...args })
  );
});

// ---------------------------------------------------------------------------
// Salidas
// ---------------------------------------------------------------------------

test('toClientResult no expone score ni deudas del reporte', () => {
  const r = evaluatePrequalification({
    creditScore: 705,
    monthlyIncome: 6000,
    monthlyDebtPayments: 499.75,
  });
  const cliente = toClientResult(r);

  assert.deepEqual(Object.keys(cliente).sort(), [
    'decision',
    'dtiPercent',
    'estimatedMonthlyPayment',
    'housingPercent',
    'maxHomePrice',
    'reason',
  ]);

  const serializado = JSON.stringify(cliente);
  assert.doesNotMatch(serializado, /705/);
  assert.doesNotMatch(serializado, /499\.75/);
  // Los umbrales internos tampoco viajan.
  assert.equal('thresholds' in cliente, false);
  assert.equal('assumptions' in cliente, false);
});

test('toSalesforceLeadFields mapea los campos del legacy (accionIncome.php:257-273)', () => {
  const r = evaluatePrequalification({
    creditScore: 705,
    monthlyIncome: 6000,
    monthlyDebtPayments: 499.75,
  });
  assert.deepEqual(toSalesforceLeadFields(r), {
    DTI__c: 40.3292,
    Housing__c: 32,
    Cantidad__c: 266620,
  });
});

test('quien no califica va a Salesforce con Cantidad__c = 0 (accionIncome.php:255)', () => {
  const r = evaluatePrequalification({
    creditScore: 610,
    monthlyIncome: 6000,
    monthlyDebtPayments: 0,
  });
  assert.equal(toSalesforceLeadFields(r).Cantidad__c, 0);
});
