import { config } from '../config';

/**
 * Logging with secrets removed. Anything that looks like a key, a token or a
 * signed header is masked before a line is written, and so is every secret the
 * server was configured with.
 */
const KEY_SHAPES = [
  /sk-or-v1-[A-Za-z0-9]{16,}/g,
  /\b(ak|ck|sk|pk|rk)_[A-Za-z0-9_-]{12,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,})\b/g,
  /(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/g,
];

const configured = () => [config.openrouter.apiKey, config.composio.apiKey, config.composio.webhookSecret, config.authSecret].filter((s) => s && s.length >= 8);

export function redact(text: string): string {
  let out = text;
  for (const secret of configured()) out = out.split(secret).join('[redacted]');
  for (const shape of KEY_SHAPES) out = out.replace(shape, (m, keep) => (typeof keep === 'string' && m.startsWith('postgres') ? `${keep}[redacted]@` : '[redacted]'));
  return out;
}

const SENSITIVE_FIELD = /^(authorization|cookie|set-cookie|password|secret|token|api[-_]?key|x-api-key|access[-_]?token|refresh[-_]?token)$/i;

function safe(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redact(value.length > 2000 ? `${value.slice(0, 2000)}…` : value);
  if (value instanceof Error) return redact(value.stack ?? value.message);
  if (value === null || typeof value !== 'object' || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => safe(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_FIELD.test(k) ? '[redacted]' : safe(v, depth + 1);
  return out;
}

/** Lines written, newest last. Tests read this to check nothing secret was logged. */
export const recent: string[] = [];

function write(level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) {
  const line = JSON.stringify({ at: new Date().toISOString(), level, message: redact(message), ...(fields ? (safe(fields) as object) : {}) });
  recent.push(line);
  if (recent.length > 500) recent.shift();
  if (config.stage === 'test' && level === 'info') return;
  (level === 'error' ? console.error : console.log)(line);
}

export const log = {
  info: (message: string, fields?: Record<string, unknown>) => write('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write('error', message, fields),
};
