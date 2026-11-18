/**
 * Sorting rules a person writes: "mail from anyone at linkedin.com → archive it", "mail with ‘invoice’ in the
 * subject → Read Through", "mail from dana@acme.com → the Acme project, and always show it to me".
 *
 * Plain code applies them, never a model, so a rule does exactly what it says whatever an email claims. Both sides
 * run this file: the browser to preview a rule and to sort what is already waiting, the server to check a rule
 * before it is saved and to apply it to mail as it arrives.
 */
import { PEOPLE } from '../data/mock';
import type { MailRule, MailRuleBox, Rule, Thread } from '../data/types';
import type { WS } from '../data/ws-types';

export const RULE_BOXES: MailRuleBox[] = ['archived', 'read-through', 'follow-up'];

/** What each choice does, in the words the screens use. */
export const RULE_BOX_WORDS: Record<MailRuleBox, string> = {
  archived: 'archive it',
  'read-through': 'move it to Read Through',
  'follow-up': 'always show it to me (never archive it)',
};

/** Rules that file mail away by themselves. "Show it to me" only ever keeps mail in front of the person. */
export const filesAway = (box: MailRuleBox | undefined): box is 'archived' | 'read-through' => box === 'archived' || box === 'read-through';

export const MAX_FROM = 20;
export const MAX_WORDS = 10;
const MAX_WORD = 60;

/** Free mail services: a rule for one person there names their address, never everyone at gmail.com. */
export const PERSONAL_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'fastmail.com', 'hey.com', 'zoho.com', 'yandex.com', 'mail.com']);

const ADDRESS = /^[^\s@<>"',;]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const DOMAIN = /^@?[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** "Anyone at Acme.com" → "@acme.com"; "<Dana@Acme.com>" → "dana@acme.com". Null when it is neither. */
export function normalFrom(raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/^anyone at\s+/, '').replace(/^<|>$/g, '');
  if (ADDRESS.test(v)) return v;
  if (DOMAIN.test(v)) return v.startsWith('@') ? v : `@${v}`;
  return null;
}

const normalWords = (list: unknown): string[] =>
  Array.isArray(list)
    ? [...new Set(list.filter((w): w is string => typeof w === 'string').map((w) => w.replace(/\s+/g, ' ').trim().toLowerCase()).filter((w) => w.length >= 2 && w.length <= MAX_WORD))]
    : [];

/**
 * A rule in its stored form, or why it can't be one. Used by the screen before it saves and by the server, which
 * keeps only what this returns: nothing a caller adds besides the listed fields survives.
 */
export function checkMailRule(raw: unknown, projects: WS['projects']): { rule: MailRule } | { problem: string } {
  const r = (raw ?? {}) as { when?: Record<string, unknown>; then?: Record<string, unknown> };
  const fromIn = Array.isArray(r.when?.from) ? (r.when!.from as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  const from = [...new Set(fromIn.map(normalFrom))];
  if (from.includes(null)) return { problem: `“${fromIn[from.indexOf(null)]}” isn’t an email address or a domain.` };
  const subject = normalWords(r.when?.subject);
  const words = normalWords(r.when?.words);
  if (from.length > MAX_FROM) return { problem: `A rule can name up to ${MAX_FROM} senders.` };
  if (subject.length > MAX_WORDS || words.length > MAX_WORDS) return { problem: `A rule can look for up to ${MAX_WORDS} words.` };
  if (!from.length && !subject.length && !words.length) return { problem: 'Say which mail the rule is for: who it’s from, or words it has.' };
  const box = r.then?.box;
  if (box !== undefined && !RULE_BOXES.includes(box as MailRuleBox)) return { problem: 'That isn’t something a rule can do with mail.' };
  const project = r.then?.project;
  if (project !== undefined && (typeof project !== 'string' || !Object.hasOwn(projects, project) || projects[project]!.status !== 'active')) return { problem: 'That project isn’t open any more.' };
  if (!box && !project) return { problem: 'Say what the rule does: archive it, move it to Read Through, show it to you, or put it in a project.' };
  return {
    rule: {
      when: { ...(from.length ? { from: from as string[] } : {}), ...(subject.length ? { subject } : {}), ...(words.length ? { words } : {}) },
      then: { ...(box ? { box: box as MailRuleBox } : {}), ...(project ? { project } : {}) },
    },
  };
}

/* ───────────── Matching ───────────── */

/** The address behind a person id: a synced sender is "mail:<address>", anyone else is looked up. */
export const addressOf = (id: string): string => (id.startsWith('mail:') ? id.slice(5) : (PEOPLE[id]?.email ?? '')).toLowerCase();

/** The newest message someone else sent in the thread. A rule is about mail that comes in. */
export const newestReceived = (t: Thread) => [...t.messages].reverse().find((m) => m.from !== 'me');

const fromMatches = (entry: string, address: string) => {
  if (!address) return false;
  if (!entry.startsWith('@')) return address === entry;
  const domain = address.split('@')[1] ?? '';
  return domain === entry.slice(1) || domain.endsWith(`.${entry.slice(1)}`);
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A word is matched whole ("pay" doesn't match "payroll"); a phrase or a symbol, anywhere. */
const wordIn = (word: string, text: string) => (/^[\p{L}\p{N}' -]+$/u.test(word) ? new RegExp(`(^|[^\\p{L}\\p{N}])${escape(word)}($|[^\\p{L}\\p{N}])`, 'iu').test(text) : text.toLowerCase().includes(word));

export function ruleMatches(rule: MailRule, t: Thread): boolean {
  const m = newestReceived(t);
  if (!m) return false;
  const { from, subject, words } = rule.when;
  if (from?.length && !from.some((f) => fromMatches(f, addressOf(m.from)))) return false;
  if (subject?.length && !subject.some((w) => wordIn(w, t.subject))) return false;
  if (words?.length) {
    const text = `${t.subject}\n${m.body.join('\n')}`;
    if (!words.some((w) => wordIn(w, text))) return false;
  }
  return true;
}

/**
 * The rules that decide a thread: the first enabled rule with a place for it, and the first with a project.
 * "Show it to me" outranks a rule that files mail away, so a rule that keeps mail in sight always wins.
 */
export function rulesFor(rules: Rule[], t: Thread): { box?: Rule; project?: Rule } {
  const on = rules.filter((r) => r.enabled && r.mail && ruleMatches(r.mail, t));
  const keep = on.find((r) => r.mail!.then.box === 'follow-up');
  return { box: keep ?? on.find((r) => !!r.mail!.then.box), project: on.find((r) => !!r.mail!.then.project) };
}

/** The suggestion a rule gives a thread waiting in Triage. */
export function ruleSuggestion(rule: Rule, t: Thread): NonNullable<Thread['suggestion']> {
  const box = rule.mail!.then.box!;
  return {
    box,
    confidence: 'high',
    reason: `Your rule: ${rule.text}`,
    rule: rule.id,
    ...(box === 'follow-up' ? { effort: t.suggestion?.effort ?? 'quick' } : {}),
    // Mail kept in sight is still read by Timmy, for what it asks; mail a rule files away needs no reading.
    ...(box === 'follow-up' && t.suggestion?.provisional ? { provisional: true } : {}),
  };
}

/* ───────────── Words ───────────── */

const list = (xs: string[], join = 'or') => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} ${join} ${xs[xs.length - 1]}`);
const fromWords = (f: string) => (f.startsWith('@') ? `anyone at ${f.slice(1)}` : f);

/** "Mail from anyone at linkedin.com: archive it." */
export function describeMailRule(rule: MailRule, projects: WS['projects']): string {
  const { from, subject, words } = rule.when;
  const who = [
    from?.length ? `from ${list(from.map(fromWords))}` : '',
    subject?.length ? `with ${list(subject.map((w) => `“${w}”`))} in the subject` : '',
    words?.length ? `that mentions ${list(words.map((w) => `“${w}”`))}` : '',
  ].filter(Boolean);
  const project = rule.then.project ? projects[rule.then.project] : undefined;
  const does = [rule.then.box ? RULE_BOX_WORDS[rule.then.box] : '', project ? `put it in ${project.name}` : ''].filter(Boolean);
  return `Mail ${who.join(' and ')}: ${list(does, 'and')}.`;
}

/**
 * Who "mail from this sender" means for a thread: their company's domain, or their own address when they write
 * from a free mail service or from the person's own company. Null when the thread has no outside sender.
 */
export function senderKey(t: Thread, myAddress: string): string | null {
  const m = newestReceived(t);
  const address = m ? addressOf(m.from) : '';
  const domain = address.split('@')[1];
  if (!address || !domain) return null;
  const mine = myAddress.toLowerCase().split('@')[1];
  return PERSONAL_MAIL.has(domain) || domain === mine ? address : `@${domain}`;
}

/* ───────────── What a new rule does to what is already here ───────────── */

export interface RuleSweep {
  threads: Thread[];
  tasks: WS['tasks'];
  /** Threads waiting in Triage that now have the rule as Timmy's suggestion. */
  suggested: number;
  /** Threads put in the rule's project. */
  placed: number;
}

/**
 * A new or re-enabled rule applied to the mail already here, inside Timmy only: a thread waiting in Triage gets the
 * rule's place as a suggestion Timmy is sure of (filed when the person accepts it), and every thread it matches that
 * isn't in a project yet goes in the rule's project, with its to-dos. Nothing is filed in the mailbox here: that
 * happens for mail that arrives after the rule, as it arrives.
 */
export function sweepRule(threads: Thread[], tasks: WS['tasks'], rule: Rule, rules: Rule[]): RuleSweep {
  const out: RuleSweep = { threads, tasks, suggested: 0, placed: 0 };
  if (!rule.mail || !rule.enabled) return out;
  const placed = new Map<string, string>();
  out.threads = threads.map((t) => {
    if (!ruleMatches(rule.mail!, t)) return t;
    let next = t;
    const project = rule.mail!.then.project;
    if (project && !t.project) {
      next = { ...next, project };
      placed.set(t.id, project);
      out.placed++;
    }
    // The rule that decides this thread among all of them (a rule that keeps mail in sight wins over this one).
    const decides = rulesFor(rules, t).box;
    if (rule.mail!.then.box && t.box === 'inbox' && decides?.id === rule.id && t.suggestion?.rule !== rule.id) {
      next = { ...next, suggestion: ruleSuggestion(rule, t) };
      out.suggested++;
    }
    return next;
  });
  if (placed.size) {
    const moved = Object.values(tasks).filter((x) => x.thread && !x.project && placed.has(x.thread));
    if (moved.length) out.tasks = { ...tasks, ...Object.fromEntries(moved.map((x) => [x.id, { ...x, project: placed.get(x.thread!)! }])) };
  }
  return out;
}
