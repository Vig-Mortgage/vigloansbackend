'use strict';

/**
 * Logger estructurado mínimo (sin dependencias).
 *
 * - Escribe JSON a stdout/stderr (12-factor); en producción lo recoge el agente de logs.
 * - Redacta claves sensibles (tokens, secretos, SSN, contraseñas) en cualquier
 *   nivel de anidación antes de emitir.
 * - Niveles controlados por LOG_LEVEL (debug|info|warn|error). Default: info.
 *
 * Reemplaza gradualmente los console.log dispersos del backend.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const currentLevel = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

// Claves cuyo valor nunca debe aparecer en logs.
const SENSITIVE_KEY = /(pass|password|secret|token|authorization|ssn|social|api[_-]?key|client[_-]?secret|private)/i;

function redact(value, seen = new Set()) {
  if (value == null) return value;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => redact(v, seen));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(k)) out[k] = '[REDACTED]';
    else out[k] = redact(v, seen);
  }
  return out;
}

function emit(level, msg, meta) {
  if (LEVELS[level] < currentLevel) return;
  const entry = { level, msg, ts: new Date().toISOString() };
  if (meta !== undefined) entry.meta = redact(meta);
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

module.exports = {
  debug: (msg, meta) => emit('debug', msg, meta),
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
  redact,
};
