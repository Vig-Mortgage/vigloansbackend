'use strict';

/**
 * Middleware de validación con zod, reutilizable en cualquier router.
 * Valida una parte de la request ('body' | 'query' | 'params') contra un
 * esquema zod. Si falla, responde 400 con detalles; si pasa, deja el valor
 * parseado en req.validated[source].
 *
 *   router.post('/quote', validate(QuoteSchema), handler);
 *   // en el handler: const data = req.validated.body;
 */
module.exports = function validate(schema, source = 'body') {
  return function (req, res, next) {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return res.status(400).json({
        error: 'Parámetros inválidos.',
        details: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    req.validated = req.validated || {};
    req.validated[source] = result.data;
    next();
  };
};
