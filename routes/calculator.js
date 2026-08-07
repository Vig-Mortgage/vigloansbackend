'use strict';

/**
 * Router de la calculadora hipotecaria (API pública, sin datos sensibles).
 * POST /calculator/quote  → cálculo completo del pago mensual.
 * GET  /calculator/config → límites y tablas de tasas (para poblar la UI).
 *
 * Validación de entrada con zod. Este router es la fuente única de cálculo
 * para Flutter y Next.js.
 */

const express = require('express');
const { z } = require('zod');
const { computeQuote, CALC_CONFIG } = require('../lib/calculator');

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
  isVaFundingFeeExempt: z.boolean().optional(),
  includeAmortization: z.boolean().optional(),
});

router.post('/quote', (req, res) => {
  const parsed = QuoteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Parámetros inválidos.',
      details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  try {
    const quote = computeQuote(parsed.data);
    return res.json(quote);
  } catch (err) {
    console.error('Error en /calculator/quote:', err.message);
    return res.status(500).json({ error: 'Error interno al calcular la cotización.' });
  }
});

router.get('/config', (req, res) => {
  res.json({
    limits: CALC_CONFIG.limits,
    insuranceDefaultRate: CALC_CONFIG.insurance.defaultRate,
    creditScores: ['760', '740-759', '720-739', '700-719'],
    loanTypes: ['FHA', 'VA', 'USDA', 'CONV'],
  });
});

module.exports = router;
