'use strict';

/**
 * Calculadora hipotecaria — fuente ÚNICA de verdad (backend único VIG).
 *
 * Portado con paridad desde:
 *   - vigpr-nextjs/lib/calculator/logic.ts  (FinancialCalc, CALC_CONFIG, Validator)
 *   - vigpr-nextjs/components/sections/CalculatorSection.tsx  (orquestación calculateMortgage)
 *
 * Los clientes (Flutter y Next.js) deben consumir este cálculo vía la API
 * (POST /calculator/quote) en lugar de reimplementarlo. Cualquier ajuste de
 * tasas/reglas se hace AQUÍ.
 */

const CALC_CONFIG = {
  limits: {
    propertyValue: { min: 70000, max: 2211600 },
    interestRate: { min: 0, max: 30 },
    loanTerms: [15, 30],
  },
  fha: {
    ufmipRate: 0.0175,
    loanBaseThreshold: 726200,
    mipRates: {
      '30': {
        base: { ltv90: { rate: 0.50, duration: 120 }, ltv95: { rate: 0.50, duration: null }, ltv95plus: { rate: 0.55, duration: null } },
        jumbo: { ltv90: { rate: 0.70, duration: 120 }, ltv95: { rate: 0.70, duration: null }, ltv95plus: { rate: 0.75, duration: null } },
      },
      '15': {
        base: { ltv78: { rate: 0.15, duration: 120 }, ltv90: { rate: 0.15, duration: 120 }, ltv90plus: { rate: 0.40, duration: null } },
        jumbo: { ltv78: { rate: 0.15, duration: 120 }, ltv90: { rate: 0.40, duration: 120 }, ltv90plus: { rate: 0.65, duration: null } },
      },
    },
  },
  va: {
    fundingFeeRates: {
      purchase: {
        firstTime: { downPayment5OrLess: 0.0215, downPayment5to10: 0.0150, downPayment10Plus: 0.0125 },
        subsequent: { downPayment5OrLess: 0.0330, downPayment5to10: 0.0150, downPayment10Plus: 0.0125 },
      },
      refi: {
        streamline: { firstTime: 0.005, subsequent: 0.005 },
        cashOut: { firstTime: 0.023, subsequent: 0.036 },
      },
    },
  },
  insurance: { defaultRate: 0.00022 },
  conventional: {
    pmiRates: {
      '30': {
        '760': { '5-9': 0.69, '10-15': 0.46, '16-19': 0.23, '20+': 0.00 },
        '740-759': { '5-9': 0.89, '10-15': 0.59, '16-19': 0.26, '20+': 0.00 },
        '720-739': { '5-9': 1.13, '10-15': 0.75, '16-19': 0.32, '20+': 0.00 },
        '700-719': { '5-9': 1.33, '10-15': 0.90, '16-19': 0.37, '20+': 0.00 },
      },
      '15': {
        '760': { '5-9': 0.42, '10-15': 0.30, '16-19': 0.18, '20+': 0.00 },
        '740-759': { '5-9': 0.53, '10-15': 0.37, '16-19': 0.20, '20+': 0.00 },
        '720-739': { '5-9': 0.67, '10-15': 0.46, '16-19': 0.23, '20+': 0.00 },
        '700-719': { '5-9': 0.79, '10-15': 0.54, '16-19': 0.26, '20+': 0.00 },
      },
    },
  },
};

const FinancialCalc = {
  calculateLTV(loanAmount, propertyValue) {
    if (!propertyValue || propertyValue === 0) return 0;
    return (loanAmount / propertyValue) * 100;
  },

  calculateMonthlyPayment(principal, annualRate, termYears) {
    if (principal === 0 || termYears === 0) return 0;
    const monthlyRate = annualRate / 100 / 12;
    const numPayments = termYears * 12;
    if (monthlyRate === 0) return principal / numPayments;
    const factor = Math.pow(1 + monthlyRate, numPayments);
    return (principal * monthlyRate * factor) / (factor - 1);
  },

  calculateMonthlyInterest(annualRate, balance) {
    return (balance * (annualRate / 100)) / 12;
  },

  calculateUFMIP(loanBase) {
    return Math.round(loanBase * CALC_CONFIG.fha.ufmipRate);
  },

  calculateMIPRate(loanBase, ltv, loanTerm) {
    const threshold = CALC_CONFIG.fha.loanBaseThreshold;
    const isJumbo = loanBase > threshold;
    const termKey = loanTerm > 15 ? '30' : '15';

    const mipConfig = CALC_CONFIG.fha.mipRates[termKey];
    if (!mipConfig) return { rate: 0.50, duration: null };

    const config = isJumbo ? mipConfig.jumbo : mipConfig.base;
    let rate = 0.50;
    let duration = null;

    if (loanTerm > 15) {
      if (ltv <= 90) { rate = config.ltv90.rate; duration = config.ltv90.duration; }
      else if (ltv <= 95) { rate = config.ltv95.rate; duration = config.ltv95.duration; }
      else { rate = config.ltv95plus.rate; duration = config.ltv95plus.duration; }
    } else {
      if (ltv <= 78) { rate = config.ltv78 ? config.ltv78.rate : 0.15; duration = config.ltv78 ? config.ltv78.duration : 120; }
      else if (ltv <= 90) { rate = config.ltv90 ? config.ltv90.rate : 0.15; duration = config.ltv90 ? config.ltv90.duration : 120; }
      else { rate = config.ltv90plus ? config.ltv90plus.rate : 0.40; duration = config.ltv90plus ? config.ltv90plus.duration : null; }
    }
    return { rate, duration };
  },

  calculateMonthlyMIP(baseAmount, mipRate) {
    return (baseAmount * mipRate / 100) / 12;
  },

  calculateVAFundingFee(loanBase, downPaymentPercent, transactionType, isFirstTime, isCashOut = false /*, isReserve = false */) {
    const config = CALC_CONFIG.va.fundingFeeRates;

    if (transactionType === 'purchase') {
      const purchaseConfig = isFirstTime ? config.purchase.firstTime : config.purchase.subsequent;
      let rate;
      if (downPaymentPercent > 10) rate = purchaseConfig.downPayment10Plus;
      else if (downPaymentPercent > 5) rate = purchaseConfig.downPayment5to10;
      else rate = purchaseConfig.downPayment5OrLess;
      return loanBase * rate;
    }

    const refiType = isCashOut ? 'cashOut' : 'streamline';
    const refiConfig = config.refi[refiType];
    let rate;
    if (isCashOut) rate = isFirstTime ? refiConfig.firstTime : refiConfig.subsequent;
    else rate = refiConfig.firstTime;
    return loanBase * rate;
  },

  calculateUSDAFee(loanBase) {
    return (loanBase * 0.35 / 100) / 12;
  },

  calculatePMIRate(ficoScore, downPaymentPercent, loanTerm) {
    const config = CALC_CONFIG.conventional.pmiRates;
    const termConfig = config[String(loanTerm)] || config['30'];
    const ficoConfig = termConfig[ficoScore] || termConfig['760'];
    let rangeKey;
    if (downPaymentPercent >= 20) rangeKey = '20+';
    else if (downPaymentPercent >= 16) rangeKey = '16-19';
    else if (downPaymentPercent >= 10) rangeKey = '10-15';
    else rangeKey = '5-9';
    return ficoConfig[rangeKey] || 0;
  },

  calculateMonthlyPMI(propertyValue, pmiRate) {
    return (propertyValue * pmiRate / 100) / 12;
  },

  generateAmortizationTable(principal, annualRate, termYears, monthlyPayment, taxes, insurance, mip, maintenance, mipDuration = null, options = {}) {
    const totalPayments = termYears * 12;
    const table = [];
    let balance = principal;

    const loanType = options.loanType || null;
    const propertyValue = options.propertyValue || 0;
    const isConventional = loanType === 'CONV';

    for (let period = 1; period <= totalPayments; period++) {
      const interest = this.calculateMonthlyInterest(annualRate, balance);

      let currentMip = mip;
      if (isConventional && propertyValue > 0) {
        const currentLTV = (balance / propertyValue) * 100;
        currentMip = currentLTV > 78 ? mip : 0;
      } else if (mipDuration !== null) {
        currentMip = period <= mipDuration ? mip : 0;
      }

      const currentPayment = monthlyPayment - (mip - currentMip);
      const principalPayment = currentPayment - interest - taxes - insurance - currentMip - maintenance;
      balance = Math.max(0, balance - principalPayment);

      table.push({
        period,
        payment: currentPayment,
        principal: principalPayment,
        interest,
        taxesInsuranceFees: taxes + insurance + currentMip + maintenance,
        balance: Math.abs(balance),
      });
    }
    return table;
  },

  round(value) {
    return Math.round(value * 100) / 100;
  },
};

const Validator = {
  getMinDownPayment(propertyValue, loanType) {
    const rates = { FHA: 0.035, VA: 0, USDA: 0, CONV: 0.05, CONVENCIONAL: 0.05 };
    const rate = rates[loanType] != null ? rates[loanType] : rates.FHA;
    return propertyValue * rate;
  },
};

/**
 * Normaliza el tipo de préstamo para la orquestación (CONVENCIONAL -> CONV).
 */
function normalizeLoanType(loanType) {
  return loanType === 'CONVENCIONAL' ? 'CONV' : loanType;
}

/**
 * Orquestación completa de un quote hipotecario. Espejo de calculateMortgage().
 *
 * @param {object} input
 * @param {'purchase'|'refi'} input.transactionType
 * @param {'FHA'|'VA'|'USDA'|'CONV'|'CONVENCIONAL'} input.loanType
 * @param {number} input.price            Valor de la propiedad
 * @param {15|30} input.years
 * @param {number} input.interest         Tasa anual (%)
 * @param {'dollar'|'percent'} [input.downPaymentMode='percent']  purchase: modo del enganche
 * @param {number} input.downPaymentValue  purchase: enganche ($ o %); refi: monto del préstamo (balance)
 * @param {number} [input.taxes=0]         Impuestos mensuales
 * @param {number} [input.insurance]       Seguro mensual (default: price*0.00022 redondeado)
 * @param {number} [input.hoa=0]           HOA/mantenimiento mensual
 * @param {string} [input.creditScore='760'] FICO (para PMI convencional)
 * @param {boolean} [input.isVaFirstTime=true]
 * @param {boolean} [input.isCashOut=false]
 * @param {number} [input.cashOutAmount=0]
 * @param {boolean} [input.isVaReserve=false]
 * @param {boolean} [input.isVaFundingFeeExempt=false]
 * @param {boolean} [input.includeAmortization=false]
 */
function computeQuote(input) {
  const transactionType = input.transactionType;
  const loanType = normalizeLoanType(input.loanType);
  const term = parseInt(input.years, 10);
  const validPrice = Math.max(0, Number(input.price) || 0);
  const validInterest = Math.max(0, Number(input.interest) || 0);
  const downPaymentMode = input.downPaymentMode || 'percent';
  const inputValue2 = Number(input.downPaymentValue) || 0;

  const taxes = Number(input.taxes) || 0;
  const insurance = (input.insurance != null)
    ? Number(input.insurance)
    : Math.round(validPrice * CALC_CONFIG.insurance.defaultRate);
  const hoa = Number(input.hoa) || 0;

  const creditScore = input.creditScore || '760';
  const isVaFirstTime = input.isVaFirstTime != null ? !!input.isVaFirstTime : true;
  const isCashOut = !!input.isCashOut;
  const cashOutAmount = Number(input.cashOutAmount) || 0;
  const isVaReserve = !!input.isVaReserve;
  const isVaFundingFeeExempt = !!input.isVaFundingFeeExempt;

  // 1. Base loan, LTV, down payment
  let loanBase = 0;
  let downPaymentAmount = 0;
  let dpPercent = 0;

  if (transactionType === 'purchase') {
    if (downPaymentMode === 'dollar') {
      downPaymentAmount = inputValue2;
      dpPercent = validPrice > 0 ? (downPaymentAmount / validPrice) * 100 : 0;
    } else {
      dpPercent = inputValue2;
      downPaymentAmount = (validPrice * dpPercent) / 100;
    }
    loanBase = validPrice - downPaymentAmount;
  } else {
    loanBase = inputValue2;
    if (isCashOut && cashOutAmount > 0) loanBase += cashOutAmount;
    downPaymentAmount = validPrice - loanBase;
    dpPercent = validPrice > 0 ? (downPaymentAmount / validPrice) * 100 : 0;
  }

  loanBase = Math.max(0, loanBase);
  const ltv = validPrice > 0 ? (loanBase / validPrice) * 100 : 0;

  // 2. Upfront fees
  let upfrontFee = 0;
  if (loanType === 'FHA') {
    upfrontFee = FinancialCalc.calculateUFMIP(loanBase);
  } else if (loanType === 'VA') {
    if (!isVaFundingFeeExempt) {
      upfrontFee = FinancialCalc.calculateVAFundingFee(loanBase, dpPercent, transactionType, isVaFirstTime, isCashOut, isVaReserve);
    }
  }

  const totalLoanAmount = loanBase + upfrontFee;

  // 3. Monthly P&I
  const pi = FinancialCalc.calculateMonthlyPayment(totalLoanAmount, validInterest, term);

  // 4. Monthly MIP/PMI
  let monthlyMIP = 0;
  let mipDurationForTable = null;

  if (loanType === 'FHA') {
    const { rate, duration } = FinancialCalc.calculateMIPRate(loanBase, ltv, term);
    const mipBase = validPrice - upfrontFee; // paridad legacy
    monthlyMIP = FinancialCalc.calculateMonthlyMIP(mipBase, rate);
    mipDurationForTable = duration;
  } else if (loanType === 'USDA') {
    monthlyMIP = FinancialCalc.calculateUSDAFee(loanBase);
  } else if (loanType === 'CONV') {
    if (ltv > 80) {
      const rate = FinancialCalc.calculatePMIRate(creditScore, dpPercent, term);
      monthlyMIP = FinancialCalc.calculateMonthlyPMI(validPrice, rate);
    }
  }

  // 5. Total
  const total = pi + monthlyMIP + taxes + insurance + hoa;

  const result = {
    monthlyPrincipalAndInterest: pi,
    monthlyMIP,
    monthlyTaxes: taxes,
    monthlyInsurance: insurance,
    monthlyHOA: hoa,
    totalMonthlyPayment: total,
    loanBase,
    totalLoanAmount,
    upfrontFee,
    downPaymentAmount,
    downPaymentPercent: dpPercent,
    ltv,
    minDownPayment: Validator.getMinDownPayment(validPrice, input.loanType),
  };

  if (input.includeAmortization) {
    result.amortizationTable = FinancialCalc.generateAmortizationTable(
      totalLoanAmount, validInterest, term, total, taxes, insurance, monthlyMIP, hoa,
      mipDurationForTable, { loanType, propertyValue: validPrice }
    );
  }

  return result;
}

module.exports = { CALC_CONFIG, FinancialCalc, Validator, computeQuote, normalizeLoanType };
