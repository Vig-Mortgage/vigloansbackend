'use strict';

/**
 * Reglas de decision de la precualificacion.
 *
 * PURO: sin red, sin reloj, sin estado global. Entra el score (de
 * `experian.js -> toDecisionInput`), el ingreso mensual (de `income.js`) y las
 * deudas mensuales; sale una decision y el precio maximo de vivienda.
 *
 * Portado de `vigpr-joomla/prequalify/accionIncome.php` (funciones
 * `calcularPagoMensualFHA` y `calcularCalificacionPrestamo`, lineas 192-335),
 * con dos fuentes de contraste que implementan la misma regla:
 *   - `accionIncomeTest.php:237-290`  (misma funcion, umbrales en porcentaje)
 *   - `calculadoraPre.php:85-121`     (la misma regla en JS del navegador)
 *
 * Cada umbral cita su linea. **Nada se invento.** Donde el legacy es ambiguo o
 * esta roto queda un `TODO(Roberto)` en vez de una suposicion: son decisiones
 * de credito.
 *
 * ## Lo que NO se porto
 * `accionIncome.php:26-28` forzaba `$puntuacionCrediticia = 620` cuando el
 * email era `rochugui10@gmail.com`. Es un backdoor de produccion: un solicitante
 * conocido saltaba el filtro de credito. **No existe aqui, ni tras un flag.**
 * La decision no recibe el email ni ningun dato de identidad, precisamente para
 * que no se pueda volver a colar una rama por solicitante.
 */

const { roundToCents } = require('./income');

// ---------------------------------------------------------------------------
// Umbrales portados
// ---------------------------------------------------------------------------

/**
 * Score minimo. Inclusivo (`>=`).
 *
 * Fuente (tres implementaciones coincidentes del legacy):
 *   - `accionIncome.php:302`      -> `if ($puntuacionCrediticia >= 620)`
 *   - `accionIncomeTest.php:276`  -> idem
 *   - `calculadoraPre.php:100`    -> `if (puntuacionCrediticia >= 620)`
 * Es el unico umbral de score en todo el legacy (barrido de `prequalify/`).
 */
const MIN_CREDIT_SCORE = 620;

/**
 * DTI maximo, en **porcentaje**. Inclusivo (`<=`).
 *
 * Fuente:
 *   - `accionIncomeTest.php:277` -> `if ($dti <= 45)`   con `$dti` en %
 *   - `calculadoraPre.php:104`   -> `if (dti <= 45)`    con `dti` en %
 *
 * TODO(Roberto): el archivo de **produccion** `accionIncome.php:303` compara
 * `if ($dti_decimal <= 0.45)`, pero `$dti_decimal` ya viene multiplicado por
 * 100 (`accionIncome.php:248`). Es una discordancia de unidades: la condicion
 * solo se cumple con un DTI de 0.45%, es decir practicamente nunca. Efecto en
 * produccion: la busqueda binaria baja siempre, termina en el piso de $70.000 y
 * `accionIncome.php:254` devuelve `Cantidad__c = 0` — **todo el mundo sale "no
 * califica"**. Aqui se porta la intencion (45%), que es lo que dicen las otras
 * dos implementaciones. Confirmar que 45% es la politica vigente antes de
 * poner esto en produccion: arreglar el bug cambia el resultado de todos los
 * casos.
 */
const MAX_DTI_PERCENT = 45;

/**
 * Ratio de vivienda maximo (pago de la casa / ingreso), en **porcentaje**.
 * Inclusivo (`<=`).
 *
 * Fuente:
 *   - `accionIncomeTest.php:278` -> `if ($housing <= 32)`
 *   - `calculadoraPre.php:101`   -> `if (housing <= 32)`
 *
 * Mismo problema de unidades en produccion: `accionIncome.php:304` compara
 * contra `0.32`. Ver la nota de `MAX_DTI_PERCENT`.
 */
const MAX_HOUSING_PERCENT = 32;

/**
 * Rango de busqueda del precio de vivienda: `accionIncome.php:365`
 * (`calcularCalificacionPrestamo(..., 70000, 498257, ...)`).
 *
 * El piso de $70.000 es ademas la condicion de "no califica"
 * (`accionIncome.php:254`) y coincide con `CALC_CONFIG.limits.propertyValue.min`
 * de `lib/calculator.js`.
 *
 * TODO(Roberto): $498.257 es el limite FHA de una unidad ("floor") del ano
 * 2024, usado aqui como tope de **precio** de la vivienda, no de prestamo. Dos
 * cosas a confirmar: (a) que el tope deba seguir siendo el limite FHA y no el
 * de Puerto Rico del ano en curso, y (b) quien lo actualiza cada ano. Hoy esta
 * congelado en el codigo del legacy.
 */
const HOME_PRICE_MIN = 70000;
const HOME_PRICE_MAX = 498257;

/**
 * Supuestos del prestamo con los que se cotiza el pago mensual.
 * `accionIncome.php:241` (valores por defecto de la firma, nunca sobrescritos
 * por la llamada de `accionIncome.php:365`).
 *
 * TODO(Roberto): la tasa de 7% esta clavada en el codigo desde el legacy. Debe
 * salir de configuracion (o de una tasa vigente), no de una constante: una
 * precualificacion cotizada a una tasa vieja promete un precio que no existe.
 */
const LOAN_ASSUMPTIONS = Object.freeze({
  downPaymentPercent: 3.5,
  termYears: 30,
  annualInterestRate: 7,
});

/**
 * Constantes de `calcularPagoMensualFHA` (`accionIncome.php:192-239`).
 *
 * `ltvPercent: 96.5` esta **clavado** en `accionIncome.php:196` (`$margen`) y
 * no se deriva de `downPaymentPercent`. Con el 3.5% por defecto coinciden
 * (100 - 3.5 = 96.5), asi que hoy no hay diferencia; con cualquier otro
 * enganche el legacy calcularia mal el MIP.
 * TODO(Roberto): confirmar si el ratio de vivienda debe cotizarse siempre a
 * 3.5% de enganche o seguir al enganche real del solicitante.
 */
const FHA_CONSTANTS = Object.freeze({
  /** Seguro de riesgo mensual: `precio * (0.022/100)` (`accionIncome.php:195`). */
  hazardInsuranceMonthlyRate: 0.022 / 100,
  /** Upfront MIP 1.75% del prestamo (`accionIncome.php:225`). */
  upfrontMipRate: 0.0175,
  /** Umbral de prestamo "jumbo" FHA (`accionIncome.php:204`). */
  loanBaseThreshold: 726200,
  /** LTV clavado en `accionIncome.php:196`. */
  ltvPercent: 96.5,
});

/** Decisiones posibles. */
const Decision = Object.freeze({
  QUALIFIED: 'QUALIFIED',
  DECLINED: 'DECLINED',
});

/**
 * Motivos, en codigo. El legacy devolvia texto en espanol al cliente
 * (`accionIncome.php:280`, `accionIncome.php:325`); aqui viaja un codigo y la
 * traduccion se hace en el borde (Flutter / Next.js), como el resto de la API.
 *
 *   QUALIFIED                  -> "El precio maximo del hogar que puede
 *                                 permitirse es: $X"        (`:280`)
 *   CREDIT_SCORE_BELOW_MINIMUM -> "Lo siento, su puntuacion crediticia es
 *                                 inferior a 620."          (`:325`)
 *   INSUFFICIENT_AFFORDABILITY -> "Lo siento, usted no califica para un
 *                                 prestamo hipotecario"     (`:280`)
 */
const Reason = Object.freeze({
  QUALIFIED: 'QUALIFIED',
  CREDIT_SCORE_BELOW_MINIMUM: 'CREDIT_SCORE_BELOW_MINIMUM',
  INSUFFICIENT_AFFORDABILITY: 'INSUFFICIENT_AFFORDABILITY',
});

// ---------------------------------------------------------------------------
// Calculo del pago mensual usado para calificar
// ---------------------------------------------------------------------------

/** Redondeo a N decimales, como `round($x, 4)` de PHP (`accionIncome.php:251`). */
function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Tasa anual de MIP segun LTV y plazo (`accionIncome.php:203-223`).
 *
 * Con plazo <= 15 anos el legacy deja `mip_rate = 0`: no cobra MIP mensual
 * (`accionIncome.php:200-203`). Es incompleto respecto a HUD, pero como
 * `LOAN_ASSUMPTIONS.termYears` es 30 nunca se alcanza esa rama en el flujo
 * real. Se porta tal cual para no cambiar resultados.
 *
 * @returns {number} tasa anual en porcentaje (p. ej. 0.55 = 0.55%)
 */
function fhaAnnualMipRate(loanBase, ltvPercent, termYears) {
  if (termYears <= 15) return 0;

  const isJumbo = loanBase > FHA_CONSTANTS.loanBaseThreshold;
  if (!isJumbo) {
    return ltvPercent <= 95 ? 0.5 : 0.55;
  }
  return ltvPercent <= 95 ? 0.7 : 0.75;
}

/**
 * Pago mensual FHA con el que el legacy califica.
 *
 * Portado literal de `calcularPagoMensualFHA` (`accionIncome.php:192-239`):
 * principal e interes sobre el prestamo con el UFMIP financiado, mas seguro de
 * riesgo, mas MIP mensual; el total se redondea a dolares enteros
 * (`accionIncome.php:236`).
 *
 * TODO(Roberto): tres divergencias con `lib/calculator.js`, que es la fuente
 * unica de la calculadora publica. Converger cambiaria el precio maximo que se
 * le promete al solicitante, asi que es una decision de negocio, no un
 * refactor:
 *   1. La base del MIP anual aqui es `precio - upfrontMIP`
 *      (`accionIncome.php:234`), que no corresponde a ninguna base de HUD;
 *      `lib/calculator.js:327` ya usa el Base Loan Amount.
 *   2. El pago de calificacion no incluye contribuciones (CRIM en Puerto Rico)
 *      ni HOA. `accionIncome.php:236` solo suma seguro de riesgo y MIP.
 *   3. El MIP no tiene duracion: el legacy calcula `margen_duracion`
 *      (`accionIncome.php:208`) y nunca lo usa.
 *
 * @param {number} homePrice precio de la vivienda
 * @param {{downPaymentPercent:number, termYears:number, annualInterestRate:number}} assumptions
 * @returns {number} pago mensual redondeado a dolares enteros
 */
function fhaMonthlyPayment(homePrice, assumptions) {
  const { downPaymentPercent, termYears, annualInterestRate } = assumptions;

  const downPayment = homePrice * (downPaymentPercent / 100);
  const loanBase = homePrice - downPayment;
  const hazardInsurance = homePrice * FHA_CONSTANTS.hazardInsuranceMonthlyRate;

  // El legacy evalua el MIP contra un LTV clavado, no contra el enganche real.
  const ltvPercent = FHA_CONSTANTS.ltvPercent;
  const mipBasisLoan = (homePrice * ltvPercent) / 100;
  const mipRate = fhaAnnualMipRate(mipBasisLoan, ltvPercent, termYears);

  const upfrontMip = loanBase * FHA_CONSTANTS.upfrontMipRate;
  const financedLoan = loanBase + upfrontMip;

  const monthlyRate = annualInterestRate / 100 / 12;
  const payments = termYears * 12;

  let principalAndInterest;
  if (monthlyRate === 0) {
    principalAndInterest = payments === 0 ? 0 : financedLoan / payments;
  } else {
    const factor = (1 + monthlyRate) ** payments;
    principalAndInterest = (financedLoan * monthlyRate * factor) / (factor - 1);
  }

  const monthlyMip = ((homePrice - upfrontMip) * mipRate) / 100 / 12;

  return Math.round(principalAndInterest + hazardInsurance + monthlyMip);
}

/** Ratios de la iteracion, con el redondeo a 4 decimales de `accionIncome.php:251-252`. */
function ratiosAt(homePrice, monthlyIncome, monthlyDebtPayments, assumptions) {
  const monthlyPayment = fhaMonthlyPayment(homePrice, assumptions);
  const dtiPercent = ((monthlyDebtPayments + monthlyPayment) / monthlyIncome) * 100;
  const housingPercent = (monthlyPayment / monthlyIncome) * 100;
  return {
    homePrice,
    monthlyPayment,
    dtiPercent: roundTo(dtiPercent, 4),
    housingPercent: roundTo(housingPercent, 4),
    withinLimits: dtiPercent <= MAX_DTI_PERCENT && housingPercent <= MAX_HOUSING_PERCENT,
  };
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

function requirePositiveNumber(value, name) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new RangeError(`${name} debe ser un numero mayor que cero`);
  }
  return numeric;
}

function requireNonNegativeNumber(value, name) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new RangeError(`${name} debe ser un numero no negativo`);
  }
  return numeric;
}

/**
 * ¿Alcanza el score?  `accionIncome.php:302`.
 *
 * TODO(Roberto): `experian.js` reproduce el `intval` del legacy, asi que un
 * reporte **sin score** (expediente fino, "no hit") llega aqui como 0 y sale
 * como `CREDIT_SCORE_BELOW_MINIMUM`. El legacy nunca distinguio los dos casos.
 * Decidir si "sin score" debe ser un resultado propio (revision manual) en vez
 * de una declinacion por credito: son situaciones distintas para el solicitante
 * y para el adverse action notice.
 */
function meetsCreditScore(creditScore) {
  return creditScore >= MIN_CREDIT_SCORE;
}

/**
 * Precio maximo de vivienda que el solicitante puede sostener.
 *
 * Busqueda binaria portada de `calcularCalificacionPrestamo`
 * (`accionIncome.php:241-335`), pasada de recursiva a iterativa (mismo
 * recorrido, sin riesgo de pila):
 *   - corta cuando `max - min <= 1`             (`accionIncome.php:243`)
 *   - punto medio con `floor`                   (`accionIncome.php:244`)
 *   - si el punto medio cumple ambos ratios, sube (`medio+1, max`)
 *     (`accionIncome.php:305`); si no, baja (`min, medio-1`)
 *     (`accionIncome.php:307`, `:310`)
 *   - al terminar, si el piso sigue en $70.000 el solicitante no califica
 *     (`accionIncome.php:254`)
 *
 * Los ratios que se reportan son los del punto medio del ultimo intervalo, no
 * los de `maxHomePrice`: es lo que el legacy guardaba en `DTI__c`/`Housing__c`
 * (`accionIncome.php:245-252`).
 *
 * @returns {{maxHomePrice:number, dtiPercent:number, housingPercent:number, monthlyPayment:number, iterations:number}}
 */
function findMaxHomePrice({ monthlyIncome, monthlyDebtPayments, assumptions, min, max }) {
  let low = min;
  let high = max;
  let iterations = 0;

  while (high - low > 1) {
    iterations += 1;
    const mid = Math.floor((low + high) / 2);
    const ratios = ratiosAt(mid, monthlyIncome, monthlyDebtPayments, assumptions);
    if (ratios.withinLimits) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
    // `high` puede quedar por debajo de `low`; el legacy tampoco lo corregia y
    // el corte `high - low <= 1` lo absorbe en la vuelta siguiente.
    if (high < low) break;
  }

  const finalMid = Math.floor((low + high) / 2);
  const finalRatios = ratiosAt(finalMid, monthlyIncome, monthlyDebtPayments, assumptions);

  return {
    // `low <= HOME_PRICE_MIN` significa que la busqueda nunca logro subir del
    // piso: ni la vivienda mas barata del rango le cuadra.
    maxHomePrice: low <= HOME_PRICE_MIN ? 0 : low,
    dtiPercent: finalRatios.dtiPercent,
    housingPercent: finalRatios.housingPercent,
    monthlyPayment: finalRatios.monthlyPayment,
    iterations,
  };
}

/**
 * @typedef {object} PrequalificationResult
 * @property {'QUALIFIED'|'DECLINED'} decision
 * @property {string} reason codigo de `Reason`
 * @property {number} maxHomePrice precio maximo ($0 si no califica)
 * @property {number} dtiPercent ratio deuda/ingreso, en %
 * @property {number} housingPercent ratio vivienda/ingreso, en %
 * @property {number} estimatedMonthlyPayment pago con el que se califico
 * @property {object} thresholds umbrales aplicados
 * @property {object} assumptions supuestos del prestamo
 */

/**
 * Evalua la precualificacion.
 *
 * Funcion pura: mismos argumentos, mismo resultado. No recibe email, nombre ni
 * ningun identificador — no hay por donde meter una excepcion por solicitante.
 *
 * TODO(Roberto): `monthlyDebtPayments` sale solo del reporte de credito. El
 * wizard captura ademas la pension alimentaria (`DoyoupayforChildSupport` y
 * `Howmuch`, `accionIncome.php:128` y `:138`) y la guarda en `Income__c`, pero
 * **nunca la suma al DTI** (`accionIncome.php:365` pasa unicamente
 * `$_SESSION['MonthlyPayment']`). Fannie Mae la trata como obligacion
 * recurrente. Confirmar si debe entrar en el DTI: si entra, cambia el resultado
 * de todo solicitante que pague pension.
 *
 * TODO(Roberto): el flujo de co-deudor (`accionCrearLeadCoBorrower.php`,
 * `js/scripts_co-borrower.js:1263`) reusa este mismo endpoint con la sesion del
 * solicitante principal, asi que el legacy nunca combino dos ingresos ni dos
 * scores. Definir la regla: ¿ingresos sumados y score menor de los dos?
 *
 * @param {object} input
 * @param {number} input.creditScore score de `experian.toDecisionInput()`
 * @param {number} input.monthlyIncome ingreso mensual de `income.monthlyIncomeFrom()`
 * @param {number} input.monthlyDebtPayments deudas de `experian.toDecisionInput()`
 * @param {object} [input.assumptions] sobrescribe `LOAN_ASSUMPTIONS`
 * @returns {PrequalificationResult}
 * @throws {RangeError} si el ingreso no es positivo o las entradas no son numeros
 */
function evaluatePrequalification({
  creditScore,
  monthlyIncome,
  monthlyDebtPayments,
  assumptions: overrides,
} = {}) {
  const score = requireNonNegativeNumber(creditScore, 'creditScore');
  // El legacy dividia entre el ingreso sin comprobarlo: con ingreso 0 PHP
  // producia INF y guardaba un DTI infinito en Salesforce. Aqui falla en claro.
  const income = requirePositiveNumber(monthlyIncome, 'monthlyIncome');
  const debts = requireNonNegativeNumber(monthlyDebtPayments, 'monthlyDebtPayments');

  const assumptions = Object.freeze({ ...LOAN_ASSUMPTIONS, ...(overrides || {}) });
  const thresholds = Object.freeze({
    minCreditScore: MIN_CREDIT_SCORE,
    maxDtiPercent: MAX_DTI_PERCENT,
    maxHousingPercent: MAX_HOUSING_PERCENT,
    homePriceMin: HOME_PRICE_MIN,
    homePriceMax: HOME_PRICE_MAX,
  });

  if (!meetsCreditScore(score)) {
    // `accionIncome.php:312-333`: sale de inmediato con `Cantidad__c = 0`, pero
    // igual reporta los ratios calculados en el punto medio del rango completo
    // (`accionIncome.php:291-300`). Se replica para no perder ese dato.
    const mid = Math.floor((HOME_PRICE_MIN + HOME_PRICE_MAX) / 2);
    const ratios = ratiosAt(mid, income, debts, assumptions);
    return {
      decision: Decision.DECLINED,
      reason: Reason.CREDIT_SCORE_BELOW_MINIMUM,
      maxHomePrice: 0,
      dtiPercent: ratios.dtiPercent,
      housingPercent: ratios.housingPercent,
      estimatedMonthlyPayment: ratios.monthlyPayment,
      thresholds,
      assumptions,
    };
  }

  const search = findMaxHomePrice({
    monthlyIncome: income,
    monthlyDebtPayments: debts,
    assumptions,
    min: HOME_PRICE_MIN,
    max: HOME_PRICE_MAX,
  });

  const qualified = search.maxHomePrice > 0;
  return {
    decision: qualified ? Decision.QUALIFIED : Decision.DECLINED,
    reason: qualified ? Reason.QUALIFIED : Reason.INSUFFICIENT_AFFORDABILITY,
    maxHomePrice: search.maxHomePrice,
    dtiPercent: search.dtiPercent,
    housingPercent: search.housingPercent,
    estimatedMonthlyPayment: search.monthlyPayment,
    thresholds,
    assumptions,
  };
}

/**
 * Carga util que puede viajar al cliente.
 *
 * Deliberadamente **no** incluye el score ni las deudas mensuales: son datos
 * del reporte de credito y el reporte no sale del backend (ver la cabecera de
 * `experian.js`). Si el score debe mostrarse al solicitante, es una decision de
 * negocio con implicaciones de FCRA, no un detalle de serializacion.
 *
 * DTI y ratio de vivienda si van: el legacy los devolvia
 * (`accionIncome.php:282-286`) y se derivan de datos que el propio solicitante
 * aporto o puede recalcular.
 *
 * @param {PrequalificationResult} result
 */
function toClientResult(result) {
  return {
    decision: result.decision,
    reason: result.reason,
    maxHomePrice: roundToCents(result.maxHomePrice),
    dtiPercent: result.dtiPercent,
    housingPercent: result.housingPercent,
    estimatedMonthlyPayment: result.estimatedMonthlyPayment,
  };
}

/**
 * Campos del Lead de Salesforce que el legacy escribia con la decision
 * (`accionIncome.php:257-273`). `Cantidad__c` es currency(18,2).
 *
 * @param {PrequalificationResult} result
 */
function toSalesforceLeadFields(result) {
  return {
    DTI__c: result.dtiPercent,
    Housing__c: result.housingPercent,
    Cantidad__c: roundToCents(result.maxHomePrice),
  };
}

module.exports = {
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
};
