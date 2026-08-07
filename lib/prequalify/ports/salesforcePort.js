'use strict';

const { notImplementedPort } = require('./portFactory');

/**
 * Puerto de Salesforce: persistencia del lead de precualificacion.
 *
 * Reemplaza a `accionCrearLead.php`, `accionSalesforce.php`,
 * `accionQuerySalesforce.php` y compania. La implementacion real llega en la
 * Tarea B5, con el mapeo de campos portado de esos archivos.
 *
 * Reglas que la implementacion debe cumplir:
 * - **SOQL parametrizado o escapado.** El legacy concatenaba email y telefono
 *   en el `WHERE` (`accionCrearLead.php:12`).
 * - **Nunca propagar el error crudo de Salesforce al cliente.** Envolver en
 *   `ProviderError`.
 * - El SSN va en `LASERCA__SSN__c` y no vuelve nunca en una lectura hacia el
 *   cliente.
 *
 * @typedef {object} SalesforcePort
 * @property {(criteria: {email?: string, phone?: string}) => Promise<{id: string}|null>} findLeadByEmailOrPhone
 *   Dedupe antes de crear. El legacy tenia la funcion pero la llamada estaba
 *   comentada, asi que generaba duplicados; hay que reactivarla.
 * @property {(lead: object) => Promise<{id: string}>} createLead
 * @property {(leadId: string, fields: object) => Promise<void>} updateLead
 * @property {(leadId: string) => Promise<object|null>} getLead
 *   Devuelve el lead SIN campos sensibles (nada de SSN hacia arriba).
 * @property {(leadId: string, legacyStep: number) => Promise<void>} setCurrentStep
 *   Escribe `currentStep__c`. Usar `stateMachine.toLegacyStep()` para el valor.
 */

const METHODS = Object.freeze([
  'findLeadByEmailOrPhone',
  'createLead',
  'updateLead',
  'getLead',
  'setCurrentStep',
]);

/** @returns {SalesforcePort} */
function createNotImplementedSalesforcePort() {
  return notImplementedPort('salesforce', METHODS);
}

module.exports = { METHODS, createNotImplementedSalesforcePort };
