/**
 * The chat's bot check, with no outside service: a small proof of work.
 *
 * The public settings hand the chat window a challenge the server signed for this workspace. Before the first
 * message of a conversation, the window looks for a number that, written after the challenge, gives a SHA-256
 * hash starting with `bits` zero bits: about 2^bits tries for the window (in a Web Worker, so the page stays
 * responsive), one hash for the server to check. A challenge starts one conversation at most: visitor.ts keeps
 * each one used until it would have expired, inside the transaction that starts the conversation. Messages
 * inside a conversation carry its token instead and need no new work.
 *
 * It is a speed bump, not a wall. It stops a script that only sends requests, and makes every conversation cost
 * one that does the work some computing. The limits per address and the caps per day still bound what gets through.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { chatSecret } from './token';

/** A challenge that checked out: what is kept so it can't start a second conversation. */
export interface Proof {
  nonce: string;
  /** Seconds since 1970, when the challenge stops working. */
  expires: number;
}

/** What the chat window is handed: the challenge itself, and how many zero bits its answer must give. */
export interface Challenge {
  id: string;
  bits: number;
}

/** The difficulty in force, kept within what a phone can do in a few seconds. A setting that isn't a number means the default. */
export const difficulty = () => {
  const bits = Math.floor(config.chat.challengeBits);
  return Number.isFinite(bits) ? Math.min(24, Math.max(0, bits)) : 18;
};

const sign = (key: string, text: string) => createHmac('sha256', key).update(text).digest('base64url');
const signed = (workspaceId: string, nonce: string, expires: number, bits: number) => `chat-challenge|c1|${workspaceId}|${nonce}|${expires}|${bits}`;
const NONCE = /^[A-Za-z0-9_-]{22}$/;

/** A new challenge for one workspace's chat window. */
export async function newChallenge(workspaceId: string, now = Date.now()): Promise<Challenge> {
  const bits = difficulty();
  const nonce = randomBytes(16).toString('base64url');
  const expires = Math.floor(now / 1000) + config.chat.challengeMinutes * 60;
  return { id: `c1.${nonce}.${expires}.${bits}.${sign(await chatSecret(), signed(workspaceId, nonce, expires, bits))}`, bits };
}

/** How many zero bits the hash of a challenge and an answer starts with. */
export function zeroBits(challenge: string, answer: string): number {
  const hash = createHash('sha256').update(`${challenge}:${answer}`).digest();
  let n = 0;
  for (const byte of hash) {
    if (byte === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(byte) - 24;
  }
  return n;
}

/**
 * Whether an answer solves a challenge this server signed for this workspace, in time and at today's difficulty.
 * Returns what to keep so it is used once, or null. Nothing is read from the database here: whether it was used
 * before is checked where the conversation is started.
 */
export async function checkChallenge(workspaceId: string, challenge: unknown, answer: unknown, now = Date.now()): Promise<Proof | null> {
  if (typeof challenge !== 'string' || challenge.length > 200 || typeof answer !== 'string' || !/^\d{1,15}$/.test(answer)) return null;
  const [version, nonce, exp, bitsText, signature, ...rest] = challenge.split('.');
  if (version !== 'c1' || rest.length || !nonce || !NONCE.test(nonce) || !exp || !/^\d{1,12}$/.test(exp) || !bitsText || !/^\d{1,2}$/.test(bitsText) || !signature) return null;
  const expires = Number(exp);
  const bits = Number(bitsText);
  const want = Buffer.from(sign(await chatSecret(), signed(workspaceId, nonce, expires, bits)));
  const given = Buffer.from(signature);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  if (expires * 1000 < now) return null;
  // A challenge handed out before the difficulty was raised is not enough any more; the window fetches a new one.
  if (bits < difficulty()) return null;
  if (zeroBits(challenge, answer) < bits) return null;
  return { nonce, expires };
}
