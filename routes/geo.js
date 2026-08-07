'use strict';

/**
 * Datos geograficos para poblar los formularios (API publica, sin datos
 * sensibles).
 *
 *   GET /geo/states     → lista de estados y territorios de EEUU
 *   GET /geo/zip/:zip   → ciudad y estado a partir del ZIP
 *
 * Sustituye a `getStates.php` y `getCities.php` del legacy. Este ultimo tenia
 * inyeccion SQL: metia `$_POST['stateId']` crudo en el WHERE.
 *
 * DESVIACION DEL CONTRATO ORIGINAL: no hay `GET /geo/cities?state=`. Los dos
 * dropdowns encadenados (estado -> ciudad, con miles de opciones) se sustituyen
 * por un campo de ZIP que autocompleta ciudad y estado. Un campo en vez de
 * tres, y no hace falta mantener un catalogo de ciudades.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');

const { listStates } = require('../lib/geo/usStates');
const { createZipLookup } = require('../lib/geo/zipLookup');
const validate = require('../middleware/validate');
const asyncHandler = require('../middleware/asyncHandler');
const logger = require('../lib/logger');

/**
 * @param {object} [deps]
 * @param {(zip: string) => Promise<object|null>} [deps.lookupZip] inyectable para tests
 */
function createGeoRouter({ lookupZip = createZipLookup({ logger }) } = {}) {
  const router = express.Router();

  // Endpoints publicos sin JWT: limite propio para que no se usen como
  // proxy gratuito contra el servicio de ZIP.
  const geoLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    message: { error: 'Demasiadas consultas. Intente de nuevo en unos minutos.' },
    standardHeaders: true,
    legacyHeaders: false,
  });
  router.use(geoLimiter);

  const ZipParams = z.object({
    zip: z.string().regex(/^\d{5}(-\d{4})?$/, 'ZIP invalido'),
  });

  // La lista no cambia: que la cachee el cliente y el CDN.
  router.get('/states', (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.json({ states: listStates() });
  });

  router.get(
    '/zip/:zip',
    validate(ZipParams, 'params'),
    asyncHandler(async (req, res) => {
      const { zip } = req.validated.params;
      const place = await lookupZip(zip);

      if (!place) {
        // Tambien cubre el caso de que el servicio externo este caido: el
        // cliente debe permitir escribir ciudad y estado a mano.
        return res.status(404).json({ error: 'ZIP no encontrado.' });
      }

      res.set('Cache-Control', 'public, max-age=86400');
      res.json(place);
    })
  );

  return router;
}

module.exports = { createGeoRouter };
