'use strict';

const { notImplementedPort } = require('./portFactory');

/**
 * Puerto de Experian: consulta del reporte de credito.
 *
 * El puerto **solo trae el reporte**. El parseo y el scoring viven aparte, en
 * `lib/prequalify/experian.js` (Tarea B6), porque hoy estan mezclados con la
 * llamada HTTP en las 2.034 lineas de `accionExperian.php`.
 *
 * Reglas que la implementacion debe cumplir:
 * - **El reporte crudo no sale del backend.** Al cliente solo va el score y la
 *   decision. El reporte trae historial completo de deudas de una persona.
 * - **El SSN no se escribe en logs.** Ni el reporte. `lib/logger.js` redacta la
 *   clave `ssn`, pero no puede adivinar un reporte anidado: no lo loguees.
 * - TLS verificado siempre; nada de `rejectUnauthorized:false`.
 * - Sin ramas de prueba en el flujo real (el legacy forzaba un score de 620
 *   para un email concreto en `accionIncome.php:26`).
 *
 * @typedef {object} ExperianPort
 * @property {(applicant: {
 *   firstName: string,
 *   lastName: string,
 *   dob: string,
 *   ssn: string,
 *   address: {line1: string, city: string, state: string, zipCode: string}
 * }) => Promise<object>} fetchCreditReport
 *   Devuelve el reporte crudo para que la capa de dominio lo parsee. Nunca se
 *   serializa hacia el cliente.
 */

const METHODS = Object.freeze(['fetchCreditReport']);

/** @returns {ExperianPort} */
function createNotImplementedExperianPort() {
  return notImplementedPort('experian', METHODS);
}

module.exports = { METHODS, createNotImplementedExperianPort };
