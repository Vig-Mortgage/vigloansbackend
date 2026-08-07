'use strict';

/**
 * Envuelve un handler async para que cualquier rechazo se propague al
 * manejador de errores central (evita try/catch repetidos en cada ruta).
 *
 *   router.post('/x', asyncHandler(async (req, res) => { ... }));
 */
module.exports = function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
