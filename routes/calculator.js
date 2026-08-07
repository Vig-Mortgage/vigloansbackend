'use strict';

/**
 * Router de la calculadora hipotecaria (API pública, sin datos sensibles).
 *   POST /calculator/quote  → cálculo completo del pago mensual.
 *   GET  /calculator/config → límites y tablas de tasas (para poblar la UI).
 *
 * Fuente única de cálculo para Flutter y Next.js.
 * Usa el patrón estándar del backend: validate(zod) + asyncHandler + logger.
 */

const express = require('express');
const { z } = require('zod');
const { computeQuote, CALC_CONFIG } = require('../lib/calculator');
const validate = require('../middleware/validate');
const asyncHandler = require('../middleware/asyncHandler');
const logger = require('../lib/logger');

const router = express.Router();

const QuoteSchema = z.object({
  transactionType: z.enum(['purchase', 'refi']),
  loanType: z.enum(['FHA', 'VA', 'USDA', 'CONV', 'CONVENCIONAL']),
  price: z.number().positive().max(CALC_CONFIG.limits.propertyValue.max * 2),
  years: z.union([z.literal(15), z.literal(30)]),
  interest: z.number().min(CALC_CONFIG.limits.interestRate.min).max(CALC_CONFIG.limits.interestRate.max),
  downPaymentMode: z.enum(['dollar', 'percent']).optional(),
  downPaymentValue: z.number().min(0),
  taxes: z.number().min(0).optional(),
  insurance: z.number().min(0).optional(),
  hoa: z.number().min(0).optional(),
  creditScore: z.enum(['760', '740-759', '720-739', '700-719']).optional(),
  isVaFirstTime: z.boolean().optional(),
  isCashOut: z.boolean().optional(),
  cashOutAmount: z.number().min(0).optional(),
  isVaReserve: z.boolean().optional(),
  // Funding Fee del préstamo VA: OPCIONAL. true => exento (upfrontFee = 0).
  isVaFundingFeeExempt: z.boolean().optional(),
  includeAmortization: z.boolean().optional(),
});

router.post(
  '/quote',
  validate(QuoteSchema),
  asyncHandler(async (req, res) => {
    const quote = computeQuote(req.validated.body);
    logger.info('calculator.quote', {
      loanType: req.validated.body.loanType,
      transactionType: req.validated.body.transactionType,
      vaExempt: !!req.validated.body.isVaFundingFeeExempt,
    });
    res.json(quote);
  })
);

router.get(
  '/config',
  asyncHandler(async (req, res) => {
    res.json({
      limits: CALC_CONFIG.limits,
      insuranceDefaultRate: CALC_CONFIG.insurance.defaultRate,
      creditScores: ['760', '740-759', '720-739', '700-719'],
      loanTypes: ['FHA', 'VA', 'USDA', 'CONV'],
      // El funding fee VA puede marcarse como exento con isVaFundingFeeExempt=true.
      vaFundingFeeExemptSupported: true,
    });
  })
);

module.exports = router;
