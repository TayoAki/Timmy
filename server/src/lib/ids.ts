import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** A new id with a readable prefix: newId('eff') → "eff_3k9x…". Time-ordered, then random. */
export function newId(prefix: string): string {
  let t = Date.now();
  let time = '';
  for (let i = 0; i < 9; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rand = Array.from(randomBytes(10), (b) => ALPHABET[b % 32]).join('');
  return `${prefix}_${time}${rand}`;
}

/** JSON with keys in a fixed order, so the same value always hashes the same. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export const hashOf = (value: unknown) => sha256(canonical(value));
