'use strict';

/**
 * Parseo del reporte de credito de Experian a un modelo de dominio.
 *
 * PURO: sin red, sin reloj, sin estado global. La llamada HTTP vive en el
 * puerto (`ports/experianPort.js -> fetchCreditReport`); aqui solo entra el
 * reporte ya obtenido.
 *
 * Portado de `vigpr-joomla/prequalify/accionExperian.php` (2.034 lineas donde
 * la llamada HTTP, el parseo y el volcado a Salesforce estaban mezclados). Cada
 * campo de abajo cita la linea del legacy de la que sale. **Nada se invento**:
 * lo que el legacy no extraia, no esta aqui.
 *
 * ## Confidencialidad (regla dura)
 * El reporte trae el historial de deuda completo de una persona. **Este modelo
 * es INTERNO y no se serializa hacia el cliente.** El unico canal de salida es
 * `toDecisionInput()`, que entrega exactamente dos numeros a `decision.js`
 * (score y deudas mensuales). Ver `INTERNAL_ONLY_FIELDS`.
 *
 * Tampoco se loguea: `lib/logger.js` redacta la clave `ssn`, pero no puede
 * adivinar un reporte anidado. No pasar `profile` ni `rawReport` al logger.
 *
 * ## Forma del reporte
 * `{ creditProfile: [ { riskModel: [...], tradeline: [...], ... } ] }`
 * El legacy recorre todos los perfiles y despacha por clave de seccion
 * (`accionExperian.php:1927-2004`). Aqui se aplanan igual.
 */

const { ProviderError } = require('./ports/errors');
const { roundToCents } = require('./income');

/**
 * Modelo de score que el legacy pide y consume.
 *
 * Se pide con `addOns.riskModels.modelIndicator = ["AF"]`
 * (`accionExperian.php:367-371`) y al parsear se descarta cualquier otro
 * indicador (`accionExperian.php:969`). Si Experian devolviera varios modelos,
 * el legacy se quedaba con el ultimo porque sobrescribia `$_SESSION['Score']`
 * en cada vuelta (`accionExperian.php:977`); se replica ese comportamiento.
 */
const SCORE_MODEL_INDICATOR = 'AF';

/** Centinela de Experian para "dato no disponible" (`accionExperian.php:501`). */
const UNKNOWN = 'UNKNOWN';

/**
 * Codigos de Fraud Shield y su descripcion, verbatim de
 * `accionExperian.php:1547-1574`. Un codigo desconocido se conserva tal cual,
 * igual que hacia el legacy (`accionExperian.php:1628-1630`).
 */
const FRAUD_SHIELD_INDICATORS = Object.freeze({
  '01': 'INQUIRY/ONFILE CURRENT ADDRESS CONFLICT',
  '02': 'INQUIRY ADDRESS FIRST REPORTED < 90 DAYS',
  '03': 'INQUIRY CURRENT ADDRESS NOT ONFILE',
  '04': 'INQUIRY SSN ISSUE DATE UNVERIFIED',
  '05': 'INQUIRY SSN RECORDED AS DECEASED',
  '06': 'INQUIRY AGE YOUNGER THAN SSN ISSUED DATE',
  '07': 'CREDIT ESTABLISHED BEFORE AGE 18',
  '08': 'CREDIT ESTABLISHED PRIOR TO SSN ISSUE DATE',
  '09': 'MORE THAN 3 INQUIRIES IN LAST 30 DAYS',
  10: 'INQUIRY ADDRESS: ALERT',
  11: 'INQUIRY ADDRESS: NON-RESIDENTIAL',
  12: 'SECURITY STATEMENT PRESENT ON REPORT',
  13: 'HIGH PROBABILITY SSN BELONGS TO ANOTHER',
  14: 'INQUIRY SSN FORMAT IS INVALID',
  15: 'INQUIRY ADDRESS: CAUTIOUS',
  16: 'ONFILE ADDRESS: ALERT',
  17: 'ONFILE ADDRESS: NON-RESIDENTIAL',
  18: 'ONFILE ADDRESS: CAUTIOUS',
  19: 'CURRENT ADDRESS RPT BY NEW TRADE ONLY',
  20: 'CURRENT ADDRESS RPT BY TRADE OPEN<90 DAYS',
  21: 'TELEPHONE NUMBER INCONSISTENT WITH ONFILE ADDRESS',
  25: 'BEST ONFILE SSN RECORDED AS DECEASED',
  26: 'BEST ONFILE SSN ISSUE DATE UNVERIFIED',
  27: 'SSN REPORTED MORE FREQUENTLY FOR ANOTHER',
  30: 'MORE AUTH USER TRADES THAN OTHER TRADES',
  31: 'CURRENT ADDRESS REPORTED BY INQUIRY ONLY',
});

/**
 * Campos del modelo que **nunca** salen del backend.
 *
 * Es documentacion ejecutable: `test/prequalify.experian.test.js` verifica que
 * `toDecisionInput()` no deje pasar ninguno. Todo lo que no este en
 * `DECISION_FIELDS` es interno por defecto.
 */
const DECISION_FIELDS = Object.freeze(['score', 'monthlyDebtPayments']);

const INTERNAL_ONLY_FIELDS = Object.freeze([
  'scoreIsPresent',
  'riskModelsFound',
  'tradelines',
  'derogatory',
  'publicRecords',
  'fraudShield',
  'ofacMessages',
  'mlaMessages',
  'statements',
  'inquiries',
  'addresses',
  'employments',
  'identity',
  'summaries',
]);

// ---------------------------------------------------------------------------
// Utilidades de coercion (semantica de PHP, para no cambiar resultados)
// ---------------------------------------------------------------------------

/**
 * Equivalente a `intval()` de PHP: prefijo numerico o 0.
 *
 * Importa para el score: el legacy hace `intval($riskModel['score'] ?? null)`
 * (`accionExperian.php:975-976`), asi que un score ausente se convierte en
 * **0**, no en null. Un 0 luego cae bajo el umbral de 620 y se lee como
 * "credito insuficiente" cuando en realidad es "no hay dato". Se replica el
 * numero pero se expone `scoreIsPresent` para que la capa de decision pueda
 * distinguirlo (ver TODO en `decision.js`).
 */
function phpIntval(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : 0;
  }
  if (typeof value !== 'string') return 0;
  const match = /^\s*[+-]?\d+/.exec(value);
  return match ? Number.parseInt(match[0], 10) : 0;
}

/**
 * Monto de Experian: `"UNKNOWN"` es ausencia de dato, no un cero.
 *
 * El legacy hace esta traduccion campo por campo
 * (`accionExperian.php:501-533` para tradeline,
 * `accionExperian.php:688-727` para enhancedPaymentData). Aqui es una sola
 * funcion. Un valor no numerico tambien da `null`: sumar `NaN` a las deudas
 * envenenaria el DTI entero.
 */
function amountOrNull(value) {
  if (value === null || value === undefined) return null;
  if (value === UNKNOWN) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Texto o null; nunca `undefined` (para que el modelo serialice estable). */
function textOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

/**
 * Fecha de Experian a ISO `YYYY-MM-DD`.
 *
 * El legacy usa `date('Y-m-d', strtotime($fecha))` (`accionExperian.php:51-56`).
 * `strtotime()` no entiende el `MMDDYYYY` que devuelve Experian: retorna
 * `false` y PHP lo formatea como `1970-01-01`. Es decir, **todas** las fechas
 * que el legacy guardo en Salesforce con ese helper son epoch.
 *
 * Aqui se acepta `MMDDYYYY` e ISO y se devuelve `null` si no encaja, en vez de
 * inventar una fecha. Ninguna fecha entra en la decision de credito, asi que
 * este cambio no altera ningun resultado de scoring.
 * TODO(Roberto): confirmar con Experian el formato real de fecha por seccion
 * (`accionExperian.php:51-56` vs. el campo `dob` estructurado de
 * `consumerIdentity`, `accionExperian.php:1415-1422`).
 */
function parseExperianDate(value) {
  const text = textOrNull(value);
  if (text === null) return null;

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return text;

  const mmddyyyy = /^(\d{2})(\d{2})(\d{4})$/.exec(text);
  if (mmddyyyy) {
    const [, mm, dd, yyyy] = mmddyyyy;
    if (Number(mm) >= 1 && Number(mm) <= 12 && Number(dd) >= 1 && Number(dd) <= 31) {
      return `${yyyy}-${mm}-${dd}`;
    }
  }
  return null;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

// ---------------------------------------------------------------------------
// Acceso a las secciones del reporte
// ---------------------------------------------------------------------------

/**
 * Perfiles de credito del reporte.
 *
 * El legacy exige que `creditProfile` exista, sea array y no este vacio; si no,
 * lanza (`accionExperian.php:1927`, `accionExperian.php:2009-2011`). Se porta
 * como `ProviderError` para que `middleware/errorHandler.js` responda generico
 * y el detalle quede solo en el log.
 */
function creditProfilesOf(rawReport) {
  if (!rawReport || typeof rawReport !== 'object') {
    throw new ProviderError('experian', 'Reporte de credito vacio o no es un objeto');
  }
  const profiles = rawReport.creditProfile;
  if (!Array.isArray(profiles) || profiles.length === 0) {
    throw new ProviderError(
      'experian',
      'El perfil de credito no existe en la respuesta de la API o esta vacio'
    );
  }
  return profiles;
}

/** Aplana una seccion a traves de todos los perfiles. */
function sectionEntries(profiles, key) {
  const out = [];
  for (const profile of profiles) {
    if (!profile || typeof profile !== 'object') continue;
    for (const entry of asArray(profile[key])) {
      if (entry !== null && entry !== undefined) out.push(entry);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Secciones
// ---------------------------------------------------------------------------

/**
 * Score de credito.
 *
 * `accionExperian.php:966-977`: solo `modelIndicator === 'AF'`; el score pasa
 * por `intval`; si vienen varios gana el ultimo.
 *
 * TODO(Roberto): Experian devuelve codigos no puntuables en el mismo campo
 * (rango 9000+ para expediente fino / sin registro). `intval` los convierte en
 * un "score" de cuatro digitos que superaria cualquier umbral. El legacy nunca
 * los filtro (`accionExperian.php:975`). Hace falta la lista de codigos
 * exactos del contrato de Experian antes de tratarlos.
 */
function parseScore(profiles) {
  const models = sectionEntries(profiles, 'riskModel');
  const matching = models.filter(
    (model) => model && model.modelIndicator === SCORE_MODEL_INDICATOR
  );

  if (matching.length === 0) {
    return { score: 0, scoreIsPresent: false, riskModelsFound: models.length };
  }

  const last = matching[matching.length - 1];
  const rawScore = last.score;
  return {
    score: phpIntval(rawScore),
    scoreIsPresent: rawScore !== null && rawScore !== undefined && rawScore !== '',
    riskModelsFound: models.length,
  };
}

/** Datos ampliados de una cuenta (`accionExperian.php:616-762`). */
function parseEnhancedPaymentData(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    actualPaymentAmount: amountOrNull(raw.actualPaymentAmount),
    chargeoffAmount: amountOrNull(raw.chargeoffAmount),
    creditLimitAmount: amountOrNull(raw.creditLimitAmount),
    highBalanceAmount: amountOrNull(raw.highBalanceAmount),
    originalLoanAmount: amountOrNull(raw.originalLoanAmount),
    specialPaymentAmount: amountOrNull(raw.specialPaymentAmount),
    ciiCode: textOrNull(raw.ciiCode),
    complianceCondition: textOrNull(raw.complianceCondition),
    enhancedAccountCondition: textOrNull(raw.enhancedAccountCondition),
    enhancedAccountType: textOrNull(raw.enhancedAccountType),
    enhancedPaymentHistory84: textOrNull(raw.enhancedPaymentHistory84),
    enhancedPaymentStatus: textOrNull(raw.enhancedPaymentStatus),
    enhancedSpecialComment: textOrNull(raw.enhancedSpecialComment),
    enhancedTerms: textOrNull(raw.enhancedTerms),
    enhancedTermsFrequency: textOrNull(raw.enhancedTermsFrequency),
    maxDelinquencyCode: textOrNull(raw.maxDelinquencyCode),
    mortgageId: textOrNull(raw.mortgageId),
    originalCreditorClassificationCode: textOrNull(raw.originalCreditorClassificationCode),
    purchasedPortfolioFromName: textOrNull(raw.purchasedPortfolioFromName),
    secondaryAgencyCode: textOrNull(raw.secondaryAgencyCode),
    secondaryAgencyId: textOrNull(raw.secondaryAgencyId),
    specialPaymentCode: textOrNull(raw.specialPaymentCode),
    firstDelinquencyDate: parseExperianDate(raw.firstDelinquencyDate),
    secondDelinquencyDate: parseExperianDate(raw.secondDelinquencyDate),
    paymentLevelDate: parseExperianDate(raw.paymentLevelDate),
    specialPaymentDate: parseExperianDate(raw.specialPaymentDate),
  };
}

/**
 * Cuentas del reporte (`accionExperian.php:412-583`).
 *
 * Se conserva el mismo juego de campos que el legacy volcaba a `Tradeline__c`,
 * en camelCase. El `md5` de `Firma_Datos__c` (`accionExperian.php:453-492`) no
 * se porta: era una clave de deduplicacion contra Salesforce, no dominio.
 */
function parseTradelines(profiles) {
  return sectionEntries(profiles, 'tradeline').map((raw) => ({
    accountType: textOrNull(raw.accountType),
    amount1: amountOrNull(raw.amount1),
    amount1Qualifier: textOrNull(raw.amount1Qualifier),
    amount2: amountOrNull(raw.amount2),
    amount2Qualifier: textOrNull(raw.amount2Qualifier),
    amountBalloonPayment: amountOrNull(raw.amountBalloonPayment),
    amountPastDue: amountOrNull(raw.amountPastDue),
    balanceAmount: amountOrNull(raw.balanceAmount),
    monthlyPaymentAmount: amountOrNull(raw.monthlyPaymentAmount),
    monthlyPaymentType: textOrNull(raw.monthlyPaymentType),
    bankruptcyChapterNumber: textOrNull(raw.bankruptcyChapterNumber),
    consumerComment: textOrNull(raw.consumerComment),
    consumerDisputeFlag: textOrNull(raw.consumerDisputeFlag),
    delinquencies30Days: phpIntval(raw.delinquencies30Days),
    delinquencies60Days: phpIntval(raw.delinquencies60Days),
    delinquencies90to180Days: phpIntval(raw.delinquencies90to180Days),
    derogCounter: phpIntval(raw.derogCounter),
    ecoa: textOrNull(raw.ecoa),
    evaluation: textOrNull(raw.evaluation),
    kob: textOrNull(raw.kob),
    monthsHistory: phpIntval(raw.monthsHistory),
    openOrClosed: textOrNull(raw.openOrClosed),
    originalCreditorName: textOrNull(raw.originalCreditorName),
    paymentHistory: textOrNull(raw.paymentHistory),
    revolvingOrInstallment: textOrNull(raw.revolvingOrInstallment),
    soldToName: textOrNull(raw.soldToName),
    specialComment: textOrNull(raw.specialComment),
    status: textOrNull(raw.status),
    subscriberCode: textOrNull(raw.subscriberCode),
    subscriberName: textOrNull(raw.subscriberName),
    terms: textOrNull(raw.terms),
    balanceDate: parseExperianDate(raw.balanceDate),
    datePaymentDue: parseExperianDate(raw.datePaymentDue),
    lastPaymentDate: parseExperianDate(raw.lastPaymentDate),
    maxDelinquencyDate: parseExperianDate(raw.maxDelinquencyDate),
    openDate: parseExperianDate(raw.openDate),
    statusDate: parseExperianDate(raw.statusDate),
    enhancedPaymentData: parseEnhancedPaymentData(raw.enhancedPaymentData),
  }));
}

/**
 * Deuda mensual total: la unica cifra del reporte que entra en la decision.
 *
 * Portado de `accionExperian.php:585-589`: por cada tradeline con
 * `monthlyPaymentAmount` distinto de `UNKNOWN`, redondea a centavos
 * (`number_format(..., 2)`) y suma. El resultado quedaba en
 * `$_SESSION['MonthlyPayment']` y lo lee `accionIncome.php:29` como
 * `$deudasMensuales`.
 *
 * Se porta tal cual, con dos advertencias que NO se corrigen aqui porque son
 * decisiones de credito, no de codigo:
 *
 * TODO(Roberto): el legacy suma **todas** las cuentas, abiertas y cerradas
 * (`accionExperian.php:585` no mira `openOrClosed`). Confirmar si hay que
 * filtrar `openOrClosed === 'C'`; una cuenta cerrada no genera pago mensual.
 *
 * TODO(Roberto): tampoco mira `ecoa`, asi que las cuentas donde el solicitante
 * es usuario autorizado o codeudor suman igual. Fannie Mae permite excluir
 * ciertas obligaciones; confirmar la politica de VIG.
 */
function totalMonthlyDebtPayments(tradelines) {
  let total = 0;
  for (const tradeline of tradelines) {
    if (tradeline.monthlyPaymentAmount === null) continue;
    total += roundToCents(tradeline.monthlyPaymentAmount);
  }
  // El redondeo final solo limpia el polvo de coma flotante de la suma; el
  // legacy no lo hacia porque PHP reconvertia strings en cada vuelta.
  return roundToCents(total);
}

/**
 * Resumen de derogatorios.
 *
 * **El legacy no decide con esto.** Guarda `derogCounter`, morosidades y
 * `bankruptcyChapterNumber` en `Tradeline__c` (`accionExperian.php:553-560`) y
 * ahi mueren: `accionIncome.php` solo mira score, ingreso y deudas. Se agrega
 * aqui para que la informacion exista en el modelo, marcada como interna.
 *
 * TODO(Roberto): definir si un derogatorio (quiebra, cuenta en cobro,
 * charge-off, mora activa) debe declinar o marcar para revision manual. Hoy no
 * hace nada, ni en el legacy ni aqui. No se invento ningun umbral.
 */
function summarizeDerogatory(tradelines) {
  const summary = {
    derogCounterTotal: 0,
    delinquencies30Days: 0,
    delinquencies60Days: 0,
    delinquencies90to180Days: 0,
    accountsWithPastDue: 0,
    totalPastDueAmount: 0,
    bankruptcyChapters: [],
    chargeoffAmountTotal: 0,
  };

  for (const tradeline of tradelines) {
    summary.derogCounterTotal += tradeline.derogCounter;
    summary.delinquencies30Days += tradeline.delinquencies30Days;
    summary.delinquencies60Days += tradeline.delinquencies60Days;
    summary.delinquencies90to180Days += tradeline.delinquencies90to180Days;

    if (tradeline.amountPastDue !== null && tradeline.amountPastDue > 0) {
      summary.accountsWithPastDue += 1;
      summary.totalPastDueAmount += tradeline.amountPastDue;
    }
    if (tradeline.bankruptcyChapterNumber !== null) {
      summary.bankruptcyChapters.push(tradeline.bankruptcyChapterNumber);
    }
    const chargeoff = tradeline.enhancedPaymentData
      ? tradeline.enhancedPaymentData.chargeoffAmount
      : null;
    if (chargeoff !== null && chargeoff > 0) {
      summary.chargeoffAmountTotal += chargeoff;
    }
  }

  summary.totalPastDueAmount = roundToCents(summary.totalPastDueAmount);
  summary.chargeoffAmountTotal = roundToCents(summary.chargeoffAmountTotal);
  return summary;
}

/** Fraud Shield (`accionExperian.php:1581-1657`). */
function parseFraudShield(profiles) {
  return sectionEntries(profiles, 'fraudShield').map((raw) => {
    const codes = asArray(
      raw.fraudShieldIndicators && raw.fraudShieldIndicators.indicator
    )
      .map((code) => textOrNull(code))
      .filter((code) => code !== null);

    return {
      indicators: codes.map((code) => ({
        code,
        // Un codigo fuera de tabla se conserva literal, como el legacy
        // (`accionExperian.php:1628-1630`).
        description: FRAUD_SHIELD_INDICATORS[code] || code,
      })),
      addressCount: textOrNull(raw.addressCount),
      addressErrorCode: textOrNull(raw.addressErrorCode),
      socialCount: textOrNull(raw.socialCount),
      socialErrorCode: textOrNull(raw.socialErrorCode),
      sic: textOrNull(raw.sic),
      ssnFirstPossibleIssuanceYear: textOrNull(raw.ssnFirstPossibleIssuanceYear),
      ssnLastPossibleIssuanceYear: textOrNull(raw.ssnLastPossibleIssuanceYear),
      text: textOrNull(raw.text),
      type: textOrNull(raw.type),
      addressDate: parseExperianDate(raw.addressDate),
      dateOfBirth: parseExperianDate(raw.dateOfBirth),
      dateOfDeath: parseExperianDate(raw.dateOfDeath),
      socialDate: parseExperianDate(raw.socialDate),
    };
  });
}

/**
 * Registros publicos (`accionExperian.php:1299-1374`).
 *
 * Ojo: en el legacy esta seccion **nunca se ejecuta**. El despacho de
 * `publicRecord` esta comentado en `main()` (`accionExperian.php:1973-1977`),
 * igual que `directCheck` (`accionExperian.php:1982-1986`). Se porta el parseo
 * porque el codigo existe y los datos son relevantes, pero hoy no alimenta
 * ninguna regla.
 */
function parsePublicRecords(profiles) {
  return sectionEntries(profiles, 'publicRecord').map((raw) => ({
    adjustmentPercent: textOrNull(raw.adjustmentPercent),
    amount: amountOrNull(raw.amount),
    bankruptcyAssetAmount: amountOrNull(raw.bankruptcyAssetAmount),
    bankruptcyVoluntaryIndicator: textOrNull(raw.bankruptcyVoluntaryIndicator),
    bookPageSequence: textOrNull(raw.bookPageSequence),
    consumerComment: textOrNull(raw.consumerComment),
    courtCode: textOrNull(raw.courtCode),
    courtName: textOrNull(raw.courtName),
    disputeFlag: textOrNull(raw.disputeFlag),
    ecoa: textOrNull(raw.ecoa),
    evaluation: textOrNull(raw.evaluation),
    plaintiffName: textOrNull(raw.plaintiffName),
    referenceNumber: textOrNull(raw.referenceNumber),
    repaymentPercent: textOrNull(raw.repaymentPercent),
    status: textOrNull(raw.status),
    filingDate: parseExperianDate(raw.filingDate),
    statusDate: parseExperianDate(raw.statusDate),
  }));
}

/** Mensajes de OFAC (`accionExperian.php:1107-1128`) y MLA (`:1763-1780`). */
function parseMessages(profiles, key) {
  return sectionEntries(profiles, key).map((raw) => ({
    messageNumber: textOrNull(raw.messageNumber),
    messageText: textOrNull(raw.messageText),
  }));
}

/** Declaraciones del consumidor (`accionExperian.php:1237-1259`). */
function parseStatements(profiles) {
  return sectionEntries(profiles, 'statement').map((raw) => ({
    dateReported: parseExperianDate(raw.dateReported),
    statementText: textOrNull(raw.statementText),
    type: textOrNull(raw.type),
  }));
}

/** Consultas de credito (`accionExperian.php:1035-1068`). */
function parseInquiries(profiles) {
  return sectionEntries(profiles, 'inquiry').map((raw) => ({
    amount: amountOrNull(raw.amount),
    date: parseExperianDate(raw.date),
    kob: textOrNull(raw.kob),
    subscriberCode: textOrNull(raw.subscriberCode),
    subscriberName: textOrNull(raw.subscriberName),
    terms: textOrNull(raw.terms),
    type: textOrNull(raw.type),
  }));
}

/** Direcciones en archivo (`accionExperian.php:798-859`). */
function parseAddresses(profiles) {
  return sectionEntries(profiles, 'addressInformation').map((raw) => ({
    city: textOrNull(raw.city),
    state: textOrNull(raw.state),
    stateCode: textOrNull(raw.stateCode),
    zipCode: textOrNull(raw.zipCode),
    streetName: textOrNull(raw.streetName),
    streetPrefix: textOrNull(raw.streetPrefix),
    streetSuffix: textOrNull(raw.streetSuffix),
    unitId: textOrNull(raw.unitId),
    unitType: textOrNull(raw.unitType),
    dwellingType: textOrNull(raw.dwellingType),
    source: textOrNull(raw.source),
    timesReported: phpIntval(raw.timesReported),
    lastReportingSubscriberCode: textOrNull(raw.lastReportingSubscriberCode),
    firstReportedDate: parseExperianDate(raw.firstReportedDate),
    lastUpdatedDate: parseExperianDate(raw.lastUpdatedDate),
  }));
}

/** Patronos reportados (`accionExperian.php:1818-1854`). */
function parseEmployments(profiles) {
  return sectionEntries(profiles, 'employmentInformation').map((raw) => ({
    name: textOrNull(raw.name),
    addressFirstLine: textOrNull(raw.addressFirstLine),
    addressSecondLine: textOrNull(raw.addressSecondLine),
    addressExtraLine: textOrNull(raw.addressExtraLine),
    zipCode: textOrNull(raw.zipCode),
    source: textOrNull(raw.source),
    firstReportedDate: parseExperianDate(raw.firstReportedDate),
    lastUpdatedDate: parseExperianDate(raw.lastUpdatedDate),
  }));
}

/**
 * Identidad del consumidor (`accionExperian.php:1415-1444`).
 *
 * A diferencia del resto, `consumerIdentity` es un objeto, no un array.
 * El SSN **no se extrae**: el legacy tampoco lo hacia y no hay ninguna regla
 * que lo necesite. Que no exista en el modelo es la garantia mas barata de que
 * no se filtre a un log ni a una respuesta.
 */
function parseIdentity(profiles) {
  for (const profile of profiles) {
    if (!profile || typeof profile !== 'object') continue;
    const raw = profile.consumerIdentity;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;

    const dob = raw.dob && typeof raw.dob === 'object' ? raw.dob : {};
    const year = textOrNull(dob.year);
    const month = textOrNull(dob.month);
    const day = textOrNull(dob.day);

    return {
      // El legacy concatena year-month-day sin rellenar a dos digitos
      // (`accionExperian.php:1422`); aqui solo se compone si estan los tres.
      birthDate: year && month && day ? `${year}-${month}-${day}` : null,
      names: asArray(raw.name).map((entry) => ({
        firstName: textOrNull(entry.firstName),
        middleName: textOrNull(entry.middleName),
        surname: textOrNull(entry.surname),
        secondSurname: textOrNull(entry.secondSurname),
        generationCode: textOrNull(entry.generationCode),
        type: textOrNull(entry.type),
      })),
    };
  }
  return { birthDate: null, names: [] };
}

/**
 * Atributos de resumen (`accionExperian.php:1696-1741`).
 *
 * En el legacy esta seccion **siempre sale vacia**: el `foreach` liga
 * `$summaries` pero el cuerpo lee `$summary` (`accionExperian.php:1696-1700`),
 * una variable que no existe, asi que `$attributes` es siempre null. Aqui se
 * parsea de verdad; como nada decide con estos atributos, arreglarlo no cambia
 * ninguna decision de credito.
 */
function parseSummaries(profiles) {
  return sectionEntries(profiles, 'summaries').map((raw) => ({
    summaryType: textOrNull(raw.summaryType),
    attributes: asArray(raw.attributes).map((attribute) => ({
      id: textOrNull(attribute.id),
      value: textOrNull(attribute.value),
    })),
  }));
}

// ---------------------------------------------------------------------------
// API del modulo
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CreditProfile Modelo de dominio INTERNO del reporte.
 * @property {number} score Score AF (0 si no vino; ver `scoreIsPresent`).
 * @property {boolean} scoreIsPresent Si Experian trajo el campo `score`.
 * @property {number} riskModelsFound Cuantos `riskModel` traia el reporte.
 * @property {number} monthlyDebtPayments Suma de pagos mensuales de tradelines.
 * @property {object[]} tradelines
 * @property {object} derogatory
 * @property {object[]} publicRecords
 * @property {object[]} fraudShield
 * @property {object[]} ofacMessages
 * @property {object[]} mlaMessages
 * @property {object[]} statements
 * @property {object[]} inquiries
 * @property {object[]} addresses
 * @property {object[]} employments
 * @property {object} identity
 * @property {object[]} summaries
 */

/**
 * Parsea el reporte crudo de Experian al modelo de dominio.
 *
 * Funcion pura. No loguea, no persiste, no llama a nadie.
 *
 * @param {object} rawReport respuesta de `experianPort.fetchCreditReport()`
 * @returns {CreditProfile} modelo INTERNO — no serializar hacia el cliente
 * @throws {ProviderError} si el reporte no trae `creditProfile`
 */
function parseCreditReport(rawReport) {
  const profiles = creditProfilesOf(rawReport);

  const { score, scoreIsPresent, riskModelsFound } = parseScore(profiles);
  const tradelines = parseTradelines(profiles);

  return Object.freeze({
    score,
    scoreIsPresent,
    riskModelsFound,
    monthlyDebtPayments: totalMonthlyDebtPayments(tradelines),
    tradelines,
    derogatory: summarizeDerogatory(tradelines),
    publicRecords: parsePublicRecords(profiles),
    fraudShield: parseFraudShield(profiles),
    ofacMessages: parseMessages(profiles, 'ofac'),
    mlaMessages: parseMessages(profiles, 'mla'),
    statements: parseStatements(profiles),
    inquiries: parseInquiries(profiles),
    addresses: parseAddresses(profiles),
    employments: parseEmployments(profiles),
    identity: parseIdentity(profiles),
    summaries: parseSummaries(profiles),
  });
}

/**
 * Unico canal de salida del reporte hacia la capa de decision.
 *
 * Devuelve exactamente los dos numeros que `accionIncome.php:365` le pasaba a
 * `calcularCalificacionPrestamo`: el score (via `$_SESSION['score']`) y las
 * deudas mensuales (via `$_SESSION['MonthlyPayment']`). Todo lo demas del
 * reporte se queda dentro.
 *
 * @param {CreditProfile} profile
 * @returns {{score: number, monthlyDebtPayments: number}}
 */
function toDecisionInput(profile) {
  return {
    score: profile.score,
    monthlyDebtPayments: profile.monthlyDebtPayments,
  };
}

module.exports = {
  SCORE_MODEL_INDICATOR,
  UNKNOWN,
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
};
