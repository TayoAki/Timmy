/**
 * Proof that a visitor may read and write one conversation.
 *
 * A visitor has no account. When their first message starts a conversation, the server hands their chat window
 * a token: the conversation's id and an expiry, signed with a secret only the server holds. Every later request
 * has to carry it. The signature also covers the workspace, so a token is worth nothing on any other site key,
 * and nothing a visitor sends can name a workspace: that always comes from the site key.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { sysPool } from '../db/pool';
import { addSecret } from '../lib/log';

let secret: Promise<string> | null = null;

/** The signing secret: from the environment, or generated once and kept in the system-only secrets table. */
export function chatSecret(): Promise<string> {
  secret ??= (async () => {
    if (config.chat.secret) {
      addSecret(config.chat.secret);
      return config.chat.secret;
    }
    await sysPool.query('insert into app_secret (name, value) values ($1, $2) on conflict (name) do nothing', ['chat_token_secret', randomBytes(32).toString('hex')]);
    const { rows } = await sysPool.query('select value from app_secret where name = $1', ['chat_token_secret']);
    const value = rows[0].value as string;
    // The log masks it wherever it might appear.
    addSecret(value);
    return value;
  })();
  return secret;
}

const sign = (key: string, text: string) => createHmac('sha256', key).update(text).digest('base64url');
const signed = (workspaceId: string, conversationId: string, expires: number) => `chat-token|v1|${workspaceId}|${conversationId}|${expires}`;

const ID = /^[A-Za-z0-9_]{8,60}$/;

/** A new token for one conversation, good until `tokenDays` from now. */
export async function issueToken(workspaceId: string, conversationId: string, now = Date.now()): Promise<string> {
  const expires = Math.floor(now / 1000) + config.chat.tokenDays * 86_400;
  return `v1.${conversationId}.${expires}.${sign(await chatSecret(), signed(workspaceId, conversationId, expires))}`;
}

/**
 * The conversation a token is for, or null when the token is not one this server signed for this workspace,
 * or has expired. The comparison takes the same time whatever is wrong with it.
 */
export async function conversationOf(token: unknown, workspaceId: string, now = Date.now()): Promise<string | null> {
  if (typeof token !== 'string' || token.length > 200) return null;
  const [version, conversationId, exp, signature, ...rest] = token.split('.');
  if (version !== 'v1' || !conversationId || !exp || !signature || rest.length || !ID.test(conversationId) || !/^\d{1,12}$/.test(exp)) return null;
  const want = Buffer.from(sign(await chatSecret(), signed(workspaceId, conversationId, Number(exp))));
  const given = Buffer.from(signature);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  if (Number(exp) * 1000 < now) return null;
  return conversationId;
}

/**
 * A fingerprint of a message's text, for its effect record. The record must pin down exactly what was approved,
 * but it is never deleted, so it must not hold the words themselves: a visitor's conversation can be deleted.
 * Keyed with the server's secret, so the words cannot be guessed back from it.
 */
export async function textMark(text: string): Promise<string> {
  return createHmac('sha256', await chatSecret()).update(`chat-text|${text}`).digest('hex');
}

/** A new site key: 192 random bits, safe to put in a web address. */
export const newSiteKey = () => randomBytes(24).toString('base64url');
export const SITE_KEY = /^[A-Za-z0-9_-]{20,64}$/;
