'use strict';

const { NotImplementedError } = require('./errors');

/**
 * Construye un puerto cuyos metodos lanzan [NotImplementedError].
 *
 * Es el valor por defecto de todo puerto: sin credenciales configuradas la
 * llamada falla con 501 en vez de devolver datos inventados.
 *
 * @param {string} name nombre del puerto
 * @param {readonly string[]} methods metodos del contrato
 */
function notImplementedPort(name, methods) {
  const port = {};
  for (const method of methods) {
    const stub = async () => {
      throw new NotImplementedError(name, method);
    };
    // Marca para que `portAvailability` distinga un stub de una implementacion
    // real sin tener que invocarlo.
    stub.isNotImplemented = true;
    port[method] = stub;
  }
  return Object.freeze(port);
}

/**
 * Combina la implementacion por defecto con la que se inyecte.
 *
 * Rechaza metodos que no estan en el contrato: sin esto, un `sendOtp` donde
 * el contrato dice `send` se instalaria sin ruido y el puerto seguiria
 * lanzando 501 en produccion sin que nadie entienda por que.
 *
 * @param {string} name
 * @param {readonly string[]} methods
 * @param {object} [implementation] metodos reales a inyectar
 */
function buildPort(name, methods, implementation) {
  const base = notImplementedPort(name, methods);
  if (implementation == null) return base;

  if (typeof implementation !== 'object') {
    throw new TypeError(`La implementacion de '${name}' debe ser un objeto`);
  }

  const port = { ...base };
  for (const [key, value] of Object.entries(implementation)) {
    if (!methods.includes(key)) {
      throw new TypeError(
        `'${key}' no pertenece al contrato del puerto '${name}'. Metodos validos: ${methods.join(', ')}`
      );
    }
    if (typeof value !== 'function') {
      throw new TypeError(`'${name}.${key}' debe ser una funcion`);
    }
    port[key] = value;
  }
  return Object.freeze(port);
}

module.exports = { notImplementedPort, buildPort };
