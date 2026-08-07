'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SCORE_MODEL_INDICATOR,
  FRAUD_SHIELD_INDICATORS,
  DECISION_FIELDS,
  INTERNAL_ONLY_FIELDS,
  phpIntval,
  amountOrNull,
  parseExperianDate,
  parseCreditReport,
  totalMonthlyDebtPayments,
  summarizeDerogatory,
  toDecisionInput,
} = require('../lib/prequalify/experian');

const {
  SAMPLE_CREDIT_REPORT,
  EMPTY_CREDIT_REPORT,
  NO_AF_SCORE_REPORT,
} = require('./fixtures/experianReport.sample');

/**
 * Los valores esperados replican `vigpr-joomla/prequalify/accionExperian.php`.
 * Cada bloque cita la linea del legacy de la que sale la regla.
 */

// ---------------------------------------------------------------------------
// Coerciones
// ---------------------------------------------------------------------------

test('phpIntval replica intval() de PHP (accionExperian.php:976)', () => {
  assert.equal(phpIntval('0705'), 705);
  assert.equal(phpIntval('705'), 705);
  assert.equal(phpIntval(705), 705);
  assert.equal(phpIntval('9002'), 9002);
  // Un score ausente se vuelve 0, no null: de ahi el TODO en decision.js.
  assert.equal(phpIntval(null), 0);
  assert.equal(phpIntval(undefined), 0);
  assert.equal(phpIntval('abc'), 0);
  assert.equal(phpIntval('70a'), 70);
});

test('amountOrNull trata UNKNOWN como ausencia (accionExperian.php:501-533)', () => {
  assert.equal(amountOrNull('UNKNOWN'), null);
  assert.equal(amountOrNull(null), null);
  assert.equal(amountOrNull(''), null);
  assert.equal(amountOrNull('   '), null);
  assert.equal(amountOrNull('350'), 350);
  assert.equal(amountOrNull('125.50'), 125.5);
  assert.equal(amountOrNull(0), 0);
  // Un texto no numerico nunca debe convertirse en NaN: envenenaria el DTI.
  assert.equal(amountOrNull('mucho'), null);
});

test('parseExperianDate acepta MMDDYYYY e ISO, y no inventa fechas', () => {
  assert.equal(parseExperianDate('03152019'), '2019-03-15');
  assert.equal(parseExperianDate('2019-03-15'), '2019-03-15');
  assert.equal(parseExperianDate(null), null);
  assert.equal(parseExperianDate(''), null);
  assert.equal(parseExperianDate('no es fecha'), null);
  // El legacy producia 1970-01-01 para estos casos (strtotime devolvia false,
  // accionExperian.php:51-56). Aqui es null, que es honesto.
  assert.equal(parseExperianDate('99999999'), null);
});

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

test('extrae el score solo del modelo AF (accionExperian.php:969-976)', () => {
  const profile = parseCreditReport(SAMPLE_CREDIT_REPORT);
  assert.equal(SCORE_MODEL_INDICATOR, 'AF');
  assert.equal(profile.score, 705);
  assert.equal(profile.scoreIsPresent, true);
  // El modelo V4 del fixture trae 999 y debe quedar fuera.
  assert.notEqual(profile.score, 999);
  assert.equal(profile.riskModelsFound, 2);
});

test('sin modelo AF el score es 0 y scoreIsPresent lo delata', () => {
  const profile = parseCreditReport(NO_AF_SCORE_REPORT);
  assert.equal(profile.score, 0);
  assert.equal(profile.scoreIsPresent, false);
});

test('con varios modelos AF gana el ultimo (accionExperian.php:977 sobrescribia)', () => {
  const profile = parseCreditReport({
    creditProfile: [
      {
        riskModel: [
          { modelIndicator: 'AF', score: '0600' },
          { modelIndicator: 'AF', score: '0720' },
        ],
      },
    ],
  });
  assert.equal(profile.score, 720);
});

test('reporte sin creditProfile lanza (accionExperian.php:2009-2011)', () => {
  assert.throws(() => parseCreditReport(EMPTY_CREDIT_REPORT), /experian/i);
  assert.throws(() => parseCreditReport(null), /experian/i);
  assert.throws(() => parseCreditReport({ creditProfile: [] }), /experian/i);
});

test('el error de reporte vacio no filtra internals al cliente', () => {
  try {
    parseCreditReport(EMPTY_CREDIT_REPORT);
    assert.fail('debio lanzar');
  } catch (err) {
    assert.equal(err.name, 'ProviderError');
    assert.equal(err.status, 502);
    assert.doesNotMatch(err.publicMessage, /experian/i);
  }
});

// ---------------------------------------------------------------------------
// Deuda mensual (la unica cifra del reporte que decide)
// ---------------------------------------------------------------------------

test('suma los pagos mensuales de los tradelines (accionExperian.php:585-589)', () => {
  const profile = parseCreditReport(SAMPLE_CREDIT_REPORT);
  // 350 + 125.50 + 24.25 = 499.75.  El tradeline con 'UNKNOWN' y el que no
  // trae `monthlyPaymentAmount` no suman.
  assert.equal(profile.monthlyDebtPayments, 499.75);
});

test('UNKNOWN no cuenta como cero al sumar deudas', () => {
  const total = totalMonthlyDebtPayments([
    { monthlyPaymentAmount: 100 },
    { monthlyPaymentAmount: null },
    { monthlyPaymentAmount: 0 },
  ]);
  assert.equal(total, 100);
});

test('redondea cada pago a centavos, como number_format(...,2)', () => {
  const total = totalMonthlyDebtPayments([
    { monthlyPaymentAmount: 10.005 },
    { monthlyPaymentAmount: 0.1 },
    { monthlyPaymentAmount: 0.2 },
  ]);
  assert.equal(total, 10.31);
});

test('sin tradelines la deuda mensual es 0, no NaN', () => {
  const profile = parseCreditReport({ creditProfile: [{ riskModel: [] }] });
  assert.equal(profile.monthlyDebtPayments, 0);
  assert.equal(profile.tradelines.length, 0);
});

test('el legacy suma tambien las cuentas cerradas (comportamiento portado)', () => {
  const profile = parseCreditReport(SAMPLE_CREDIT_REPORT);
  const cerrada = profile.tradelines.find(
    (t) => t.subscriberName === 'FINANCIERA IMAGINARIA TRES'
  );
  assert.equal(cerrada.openOrClosed, 'C');
  assert.equal(cerrada.monthlyPaymentAmount, 24.25);
  // Queda dentro del total: es el comportamiento del legacy, marcado como
  // TODO(Roberto) en experian.js.
  assert.equal(profile.monthlyDebtPayments, 499.75);
});

// ---------------------------------------------------------------------------
// Tradelines y derogatorios
// ---------------------------------------------------------------------------

test('normaliza los campos de tradeline que el legacy volcaba a Salesforce', () => {
  const profile = parseCreditReport(SAMPLE_CREDIT_REPORT);
  const primera = profile.tradelines[0];

  assert.equal(primera.subscriberName, 'BANCO DE PRUEBA UNO');
  assert.equal(primera.balanceAmount, 12500);
  assert.equal(primera.monthlyPaymentAmount, 350);
  assert.equal(primera.amountPastDue, null); // venia 'UNKNOWN'
  assert.equal(primera.amount2, null); // venia 'UNKNOWN'
  assert.equal(primera.openDate, '2019-03-15');
  assert.equal(primera.revolvingOrInstallment, 'I');
  assert.equal(primera.enhancedPaymentData.highBalanceAmount, 20000);
  assert.equal(primera.enhancedPaymentData.creditLimitAmount, null);
});

test('resume derogatorios sin que afecten la decision', () => {
  const profile = parseCreditReport(SAMPLE_CREDIT_REPORT);
  const d = profile.derogatory;

  assert.equal(d.derogCounterTotal, 2);
  assert.equal(d.delinquencies30Days, 3);
  assert.equal(d.delinquencies60Days, 1);
  assert.equal(d.delinquencies90to180Days, 3);
  assert.equal(d.accountsWithPastDue, 1);
  assert.equal(d.totalPastDueAmount, 1800);
  assert.deepEqual(d.bankruptcyChapters, ['7']);
  assert.equal(d.chargeoffAmountTotal, 1800);

  // El resumen NO viaja a la decision: eso es lo que hace el legacy y lo que
  // esta marcado como TODO(Roberto).
  assert.equal('derogatory' in toDecisionInput(profile), false);
});

test('summarizeDerogatory con cartera limpia da ceros', () => {
  const d = summarizeDerogatory([
    {
      derogCounter: 0,
      delinquencies30Days: 0,
      delinquencies60Days: 0,
      delinquencies90to180Days: 0,
      amountPastDue: 0,
      bankruptcyChapterNumber: null,
      enhancedPaymentData: null,
    },
  ]);
  assert.equal(d.derogCounterTotal, 0);
  assert.equal(d.accountsWithPastDue, 0);
  assert.deepEqual(d.bankruptcyChapters, []);
});

// ---------------------------------------------------------------------------
// Otras secciones
// ---------------------------------------------------------------------------

test('traduce los indicadores de Fraud Shield (accionExperian.php:1547-1574)', () => {
  const profile = parseCreditReport(SAMPLE_CREDIT_REPORT);
  const indicadores = profile.fraudShield[0].indicators;

  assert.equal(indicadores[0].code, '07');
  assert.equal(indicadores[0].description, 'CREDIT ESTABLISHED BEFORE AGE 18');
  assert.equal(indicadores[1].code, '21');
  assert.equal(
    indicadores[1].description,
    'TELEPHONE NUMBER INCONSISTENT WITH ONFILE ADDRESS'
  );
  // Codigo fuera de tabla: se conserva literal (accionExperian.php:1628-1630).
  assert.equal(indicadores[2].code, '77');
  assert.equal(indicadores[2].description, '77');
  assert.equal(FRAUD_SHIELD_INDICATORS['05'], 'INQUIRY SSN RECORDED AS DECEASED');
});

test('parsea identidad, direcciones, patronos, consultas y mensajes', () => {
  const profile = parseCreditReport(SAMPLE_CREDIT_REPORT);

  assert.equal(profile.identity.birthDate, '1980-01-01');
  assert.equal(profile.identity.names[0].surname, 'NOEXISTE');
  assert.equal(profile.addresses[0].city, 'CIUDAD DE PRUEBA');
  assert.equal(profile.addresses[0].firstReportedDate, '2019-01-01');
  assert.equal(profile.employments[0].name, 'PATRONO FICTICIO SA');
  assert.equal(profile.inquiries[0].date, '2025-11-05');
  assert.equal(profile.ofacMessages[0].messageNumber, '000');
  assert.equal(profile.mlaMessages[0].messageNumber, '001');
  assert.equal(profile.statements[0].type, 'G');
});

test('parsea summaries, que el legacy nunca llego a leer (accionExperian.php:1696-1700)', () => {
  const profile = parseCreditReport(SAMPLE_CREDIT_REPORT);
  assert.equal(profile.summaries[0].summaryType, 'Profile Summary');
  assert.equal(profile.summaries[0].attributes.length, 2);
  assert.equal(profile.summaries[0].attributes[0].id, 'totalTradeItems');
});

test('parsea publicRecord aunque el legacy tenia el despacho comentado', () => {
  const profile = parseCreditReport(SAMPLE_CREDIT_REPORT);
  assert.equal(profile.publicRecords.length, 1);
  assert.equal(profile.publicRecords[0].amount, 4500);
  assert.equal(profile.publicRecords[0].filingDate, '2018-05-20');
});

// ---------------------------------------------------------------------------
// Confidencialidad: el reporte no sale del backend
// ---------------------------------------------------------------------------

test('toDecisionInput entrega solo score y deudas mensuales', () => {
  const profile = parseCreditReport(SAMPLE_CREDIT_REPORT);
  const input = toDecisionInput(profile);

  assert.deepEqual(Object.keys(input).sort(), [...DECISION_FIELDS].sort());
  assert.deepEqual(input, { score: 705, monthlyDebtPayments: 499.75 });
});

test('ningun campo interno se cuela por toDecisionInput', () => {
  const profile = parseCreditReport(SAMPLE_CREDIT_REPORT);
  const serializado = JSON.stringify(toDecisionInput(profile));

  for (const campo of INTERNAL_ONLY_FIELDS) {
    assert.equal(
      serializado.includes(campo),
      false,
      `el campo interno '${campo}' no debe salir de experian.js`
    );
  }
  // Ni rastro de acreedores, direcciones o patronos.
  assert.doesNotMatch(serializado, /BANCO DE PRUEBA/);
  assert.doesNotMatch(serializado, /PATRONO FICTICIO/);
  assert.doesNotMatch(serializado, /NOEXISTE/);
});

test('el parser no extrae SSN de ninguna seccion', () => {
  const conSsn = JSON.parse(JSON.stringify(SAMPLE_CREDIT_REPORT));
  // Aunque Experian mandara un SSN en el reporte, no debe aparecer en el modelo.
  conSsn.creditProfile[0].consumerIdentity.ssn = { ssn: '000000000' };
  conSsn.creditProfile[0].ssn = [{ ssn: '000000000' }];

  const profile = parseCreditReport(conSsn);
  const serializado = JSON.stringify(profile);

  // Ninguna clave se llama `ssn`. Fraud Shield si aporta
  // `ssnFirstPossibleIssuanceYear`/`ssnLastPossibleIssuanceYear`, que son
  // metadatos del rango de emision, no el numero (accionExperian.php:1591-1592).
  assert.doesNotMatch(serializado, /"ssn"\s*:/i);
  // Y ningun valor con forma de SSN.
  assert.doesNotMatch(serializado, /\b\d{9}\b/);
  assert.doesNotMatch(serializado, /\b\d{3}-\d{2}-\d{4}\b/);
});

test('el modelo es inmutable en su nivel superior', () => {
  const profile = parseCreditReport(SAMPLE_CREDIT_REPORT);
  assert.throws(() => {
    'use strict';
    profile.score = 850;
  }, TypeError);
});
