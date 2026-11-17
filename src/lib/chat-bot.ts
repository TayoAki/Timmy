/*
 * What the website chat says back, as plain rules. No model is asked.
 *
 * The preview on the Set up screen and the server both run this file, so a
 * visitor on a real website gets exactly what the preview shows:
 *   - a help desk answer, word for word, when the question matches one;
 *   - the email question, then the owner's own questions in order;
 *   - a hand-over when someone asks for a person.
 *
 * It only reads the chat's own settings and the visitor's words. It never sees
 * mail, documents or anything else in the workspace.
 */
import type { ChatWidget } from '../data/ws-types';

/** An email address somewhere in what the visitor wrote. */
export const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;

const STOP = new Set(['the', 'and', 'you', 'your', 'are', 'for', 'with', 'how', 'what', 'does', 'have', 'there', 'can', 'any', 'is', 'do', 'a', 'an', 'it', 'of', 'to', 'in', 'on', 'we', 'i', 'my']);
const SYN: Record<string, string> = { price: 'cost', pricing: 'cost', much: 'cost', costs: 'cost', expensive: 'cost', trial: 'free', saml: 'sso', okta: 'sso', login: 'sso' };

const words = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => SYN[w] ?? w);

/** The help desk answer that best matches what the visitor wrote, if any matches well. */
export function matchFaq(faq: ChatWidget['faq'], text: string) {
  const t = new Set(words(text));
  let best: { f: ChatWidget['faq'][number]; score: number } | null = null;
  for (const f of faq) {
    const q = words(f.q);
    const score = q.filter((w) => t.has(w)).length / Math.max(1, Math.min(q.length, 3));
    if (score > (best?.score ?? 0)) best = { f, score };
  }
  return best && best.score >= 0.5 ? best.f : null;
}

/** Where one conversation is in the script. */
export interface Talk {
  email?: string;
  name?: string;
  /** How many of the owner's questions have been answered. */
  q: number;
  answers: Record<string, string>;
  booked?: string;
  handedOff?: boolean;
}

export interface Reply {
  text: string;
  /** Offer times to pick from (the demo's preview only). */
  slots?: boolean;
  /** This reply asks for the visitor's email, so the privacy notice belongs with it. */
  asksEmail?: boolean;
}

export interface BotOptions {
  /** Who the visitor is told will follow up: a first name in the demo, the business's name on a real site. */
  owner: string;
  /**
   * Whether a call can be booked from the chat. Off on a real workspace for now: no times are ever offered,
   * and a hand-off set to "offer a call" takes an email instead.
   */
  booking: boolean;
}

/** The name a visitor is given for whoever follows up, on a real website: the business, never a person. */
export const followUpName = (w: Pick<ChatWidget, 'name'>) => w.name.trim() || 'the team';

export const newTalk = (): Talk => ({ q: 0, answers: {} });

/** What Timmy says to one message from a visitor, and where the conversation is afterwards. */
export function respond(w: ChatWidget, st: Talk, text: string, opts: BotOptions): { replies: Reply[]; st: Talk } {
  const owner = opts.owner;
  const handoff = w.handoff === 'book' && !opts.booking ? 'email' : w.handoff;
  const next: Talk = { ...st, answers: { ...st.answers } };
  const ask = (): Reply[] => {
    if (!next.email) return [{ text: 'What’s the best email to reach you?', asksEmail: true }];
    const q = w.questions[next.q];
    if (q) return [{ text: q.text }];
    if (opts.booking && w.booking && !next.booked) return [{ text: `Thanks! Want to talk it through with ${owner}? Pick a time:`, slots: true }];
    return [{ text: `Thanks! ${owner} will be in touch at ${next.email}.` }];
  };

  if (/\b(human|person|someone|agent|real|talk to|speak to|manager|call me|phone)\b/i.test(text)) {
    next.handedOff = true;
    const em = text.match(EMAIL)?.[0];
    if (em) next.email = em;
    if (handoff === 'book') return { replies: [{ text: `Happy to set that up with ${owner}. Pick a time:`, slots: true }], st: next };
    if (handoff === 'email' && !next.email) return { replies: [{ text: `Leave your email and ${owner} will write back today.`, asksEmail: true }], st: next };
    return { replies: [{ text: `I’ve let ${owner} know. They’ll reply here${next.email ? `, or by email at ${next.email}` : '. What’s the best email in case you step away?'}`, ...(next.email ? {} : { asksEmail: true }) }], st: next };
  }

  const em = text.match(EMAIL)?.[0];
  if (em && !next.email) {
    next.email = em;
    const local = em.split('@')[0]!.split(/[._-]/)[0]!;
    next.name = local.charAt(0).toUpperCase() + local.slice(1);
    const rest = ask();
    return { replies: [{ text: `Thanks, ${next.name}! ${rest[0]!.text}`, slots: rest[0]!.slots }], st: next };
  }

  const f = matchFaq(w.faq, text);
  if (f) return { replies: [{ text: f.a }, ...(next.email ? [] : ask())], st: next };

  if (next.email && next.q < w.questions.length) {
    next.answers[w.questions[next.q]!.id] = text.trim();
    next.q += 1;
    return { replies: ask(), st: next };
  }

  if (!next.email) return { replies: [{ text: `Good question. I don’t have that answer yet, so ${owner} will reply. What’s the best email to reach you?`, asksEmail: true }], st: next };
  return { replies: [{ text: `Thanks. I’ve passed that to ${owner}.` }], st: next };
}
