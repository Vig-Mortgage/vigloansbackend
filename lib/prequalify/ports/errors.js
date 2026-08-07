'use strict';

/**
 * Error de puerto sin implementar.
 *
 * Un puerto sin credenciales configuradas **falla en claro**: no devuelve datos
 * falsos ni un "exito" vacio. Un mock silencioso en el flujo real es como se
 * cuelan los backdoors (ver el score forzado de `accionIncome.php:26`), asi que
 * la ausencia de proveedor tiene que ser ruidosa.
 *
 * Se integra con `middleware/errorHandler.js`: `status` fija el codigo HTTP y
 * `publicMessage` es lo unico que ve el cliente. El nombre del proveedor va en
 * `provider` para el log, nunca en la respuesta.
 */
class NotImplementedError extends Error {
  /**
   * @param {string} port nombre del puerto (p. ej. 'salesforce')
   * @param {string} method metodo invocado
   */
  constructor(port, method) {
    super(`Puerto '${port}' sin implementar: ${method}()`);
    this.name = 'NotImplementedError';
    this.status = 501;
    this.publicMessage = 'Este servicio no esta disponible en este momento.';
    this.port = port;
    this.method = method;
  }
}

/**
 * Error de un proveedor externo (Salesforce, Experian, Twilio, S3).
 *
 * Nunca se expone el mensaje crudo del tercero: puede traer identificadores
 * internos, fragmentos de query o PII. El detalle queda en `cause` para el
 * logger, que ya redacta claves sensibles.
 */
class ProviderError extends Error {
  /**
   * @param {string} provider
   * @param {string} message mensaje interno (no se envia al cliente)
   * @param {object} [options]
   * @param {number} [options.status=502]
   * @param {unknown} [options.cause]
   */
  constructor(provider, message, { status = 502, cause } = {}) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderError';
    this.status = status;
    this.publicMessage = 'No pudimos completar la operacion. Intenta de nuevo mas tarde.';
    this.provider = provider;
    if (cause !== undefined) this.cause = cause;
  }
}

module.exports = { NotImplementedError, ProviderError };
