/**
 * Structured logger. Per Imperative #7: every log line is JSON, carries a
 * correlation id, and NEVER includes raw user input or PII.
 */

function correlationId(): string {
  // Lightweight id; replaced by backend-issued id when an API response provides it.
  const k = 'infamous.cid';
  const existing = sessionStorage.getItem(k);
  if (existing) return existing;
  const fresh = crypto.randomUUID();
  sessionStorage.setItem(k, fresh);
  return fresh;
}

type Level = 'info' | 'warn' | 'error';

function emit(level: Level, event: string, data: Record<string, unknown> = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    cid: correlationId(),
    ua: navigator.userAgent,
    url: location.pathname,
    ...stripPii(data)
  };
  if (level === 'error') console.error(JSON.stringify(entry));
  else if (level === 'warn') console.warn(JSON.stringify(entry));
  else console.info(JSON.stringify(entry));
}

const PII_KEYS = /^(password|token|secret|otp|cvv|pin|email|phone|ssn)$/i;
function stripPii<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    if (PII_KEYS.test(k)) out[k] = '[redacted]';
    else out[k] = obj[k];
  }
  return out;
}

export const logEvent = (event: string, data?: Record<string, unknown>) => emit('info', event, data);
export const logWarn = (event: string, data?: Record<string, unknown>) => emit('warn', event, data);
export const logError = (event: string, data?: Record<string, unknown>) => emit('error', event, data);

/** Web Vitals — captured in production only. */
export function reportVital(name: string, value: number) {
  if (!import.meta.env.PROD) return;
  logEvent('webvital', { name, value: Math.round(value) });
}
