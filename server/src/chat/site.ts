/**
 * From a site key to its workspace, and what a visitor's browser may be told about the chat.
 *
 * A visitor's request names no workspace. It carries the site key from the customer's code snippet, and this
 * file turns that into a workspace. Nothing else in a visitor's request can choose one.
 */
import type { ChatWidget } from '../../../src/data/ws-types';
import { config } from '../config';
import { sysPool } from '../db/pool';
import { SITE_KEY } from './token';

export interface Site {
  workspaceId: string;
  /** The one website that may show this chat. */
  domain: string;
}

/**
 * The workspace behind a site key, or null. A key that doesn't exist, a chat that is switched off and a
 * workspace whose sending is switched off all give the same answer from the same single lookup, so a caller
 * can't tell them apart.
 *
 * This is the one read the chat makes before a workspace is known, so it is the one read made by the system
 * role. Everything after it runs inside that workspace, under row-level security.
 */
export async function siteOf(siteKey: string | undefined): Promise<Site | null> {
  if (!siteKey || !SITE_KEY.test(siteKey)) return null;
  const { rows } = await sysPool.query(
    `select c.workspace_id, c.domain from chat_widget c join workspace w on w.id = c.workspace_id
     where c.site_key = $1 and c.is_on and c.domain <> '' and not w.kill_switch and w.deleted_at is null`,
    [siteKey],
  );
  return rows[0] ? { workspaceId: rows[0].workspace_id as string, domain: rows[0].domain as string } : null;
}

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The pages that may put the chat's frame on screen: the customer's website over https, with and without
 * "www.". A developer's own machine is added only on a development server, so a snippet can be tried locally.
 */
export function allowedParents(domain: string): string[] {
  const bare = domain.trim().toLowerCase().replace(/^www\./, '');
  // The value goes into a response header; anything that isn't a plain host name allows nobody.
  if (!DOMAIN.test(bare) || bare.length > 253) return [];
  const out = [`https://${bare}`, `https://www.${bare}`];
  if (config.stage === 'development') out.push('http://localhost:*', 'http://127.0.0.1:*');
  return out;
}

/** What any visitor's browser may read about a chat. Nothing here identifies the workspace or anyone in it. */
export interface PublicChat {
  name: string;
  icon?: string;
  color: string;
  greeting: string;
  questions: { id: string; text: string }[];
  faq: { id: string; q: string; a: string }[];
  /** The customer's own privacy policy, when they set one. */
  privacyUrl?: string;
}

/** Copies the public settings field by field, so a setting added later is never published by accident. */
export function publicChat(w: ChatWidget): PublicChat {
  return {
    name: w.name,
    ...(w.icon ? { icon: w.icon } : {}),
    color: w.color,
    greeting: w.greeting,
    questions: w.questions.map((q) => ({ id: q.id, text: q.text })),
    faq: w.faq.map((f) => ({ id: f.id, q: f.q, a: f.a })),
    ...(w.privacyUrl ? { privacyUrl: w.privacyUrl } : {}),
  };
}
