'use strict';

const logger = require('../lib/logger');

/**
 * Manejador de errores central de Express (debe montarse DESPUÉS de las rutas).
 *
 * - Registra el detalle del error del lado servidor (con datos sensibles redactados).
 * - Devuelve al cliente un mensaje genérico salvo que el error traiga un
 *   `publicMessage` y un `status` explícitos (errores de negocio controlados).
 * - Nunca filtra stack traces ni rutas internas al cliente.
 *
 * Crea errores controlados con:
 *   const e = new Error('...'); e.status = 400; e.publicMessage = 'Mensaje al usuario';
 */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const status = Number.isInteger(err.status) ? err.status : 500;

  logger.error('Unhandled request error', {
    method: req.method,
    path: req.originalUrl,
    status,
    message: err.message,
    stack: err.stack,
  });

  if (res.headersSent) return next(err);

  res.status(status).json({
    error: err.publicMessage || (status < 500 ? err.message : 'Error interno del servidor.'),
  });
}

/**
 * 404 para rutas no registradas (montar antes del errorHandler).
 */
function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Recurso no encontrado.' });
}

module.exports = { errorHandler, notFoundHandler };
