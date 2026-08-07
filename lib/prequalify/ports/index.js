'use strict';

const { buildPort } = require('./portFactory');
const { NotImplementedError, ProviderError } = require('./errors');
const salesforcePort = require('./salesforcePort');
const experianPort = require('./experianPort');
const otpPort = require('./otpPort');
const notificationPort = require('./notificationPort');
const documentPort = require('./documentPort');

/**
 * Contenedor de puertos de la precualificacion.
 *
 * Toda dependencia externa (Salesforce, Experian, Twilio/WhatsApp, SMTP, S3)
 * entra por aqui. El servicio se construye con los puertos inyectados, asi que
 * en tests se pasan mocks y en produccion las implementaciones reales, sin que
 * la logica de dominio cambie ni sepa quien esta al otro lado.
 *
 * Sin implementacion inyectada, cada metodo lanza [NotImplementedError] (501).
 * Es deliberado: un proveedor no configurado tiene que fallar en claro y no
 * devolver datos falsos.
 *
 * @example
 *   // produccion
 *   const ports = createPorts({ salesforce: realSalesforce, experian: realExperian });
 *
 *   // test
 *   const ports = createPorts({
 *     salesforce: { createLead: async () => ({ id: '00Q...' }) },
 *   });
 */
const PORT_SPECS = Object.freeze({
  salesforce: salesforcePort.METHODS,
  experian: experianPort.METHODS,
  otp: otpPort.METHODS,
  notification: notificationPort.METHODS,
  document: documentPort.METHODS,
});

const PORT_NAMES = Object.freeze(Object.keys(PORT_SPECS));

/**
 * @param {Partial<Record<keyof PORT_SPECS, object>>} [implementations]
 * @returns {Record<string, object>} contenedor congelado
 */
function createPorts(implementations = {}) {
  if (implementations == null || typeof implementations !== 'object') {
    throw new TypeError('createPorts espera un objeto de implementaciones');
  }

  // Un puerto mal escrito ('salesForce', 'experia') se instalaria como puerto
  // desconocido y el real seguiria en 501, sin pista de por que.
  for (const name of Object.keys(implementations)) {
    if (!PORT_NAMES.includes(name)) {
      throw new TypeError(
        `Puerto desconocido: '${name}'. Puertos validos: ${PORT_NAMES.join(', ')}`
      );
    }
  }

  const ports = {};
  for (const [name, methods] of Object.entries(PORT_SPECS)) {
    ports[name] = buildPort(name, methods, implementations[name]);
  }
  return Object.freeze(ports);
}

/**
 * ¿Que puertos tienen implementacion real? Util para un endpoint de salud y
 * para decidir por adelantado si un paso del wizard va a poder ejecutarse.
 *
 * @param {Record<string, object>} ports
 * @returns {Record<string, boolean>}
 */
function portAvailability(ports) {
  const availability = {};
  for (const [name, methods] of Object.entries(PORT_SPECS)) {
    const port = ports?.[name];
    availability[name] = Boolean(
      port && methods.some((method) => port[method]?.isNotImplemented !== true)
    );
  }
  return availability;
}

module.exports = {
  PORT_SPECS,
  PORT_NAMES,
  createPorts,
  portAvailability,
  NotImplementedError,
  ProviderError,
};
