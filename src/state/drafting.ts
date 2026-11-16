/*
 * Drafts Timmy writes when you ask: a nudge for something you're waiting on,
 * or a reply to the latest message. Given your words ("say yes, Thursday",
 * "tell him I'm happy to do the intro this week"), the draft says that; with
 * none, it's a short holding reply that promises a date. Nothing in it is
 * Timmy's own notes, and every draft waits for your approval.
 */
import { NOW } from '../data/mock';
import type { Draft, Thread } from '../data/types';
import { parseDue, weekdayShort, weekdayWord, workdaysAhead } from '../lib/when';
import { firstName, midSentence } from './ws';

/** Your sign-off, from the writing rule "Sign off with “Best, Taylor”". */
const SIGN = 'Best,\nTaylor';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const sentence = (s: string) => {
  const t = cap(s.trim().replace(/\s+/g, ' '));
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

/** The topic in a subject line: "Re: SSO add-on — separate contract?" → "SSO add-on". */
export function topicOf(subject: string): string {
  return subject
    .replace(/^((re|fwd?|fw)\s*:\s*)+/i, '')
    .replace(/^(approval needed|request|reminder|action required|quick one|question)\s*:\s*/i, '')
    .split(/\s+[—–-]\s+|:\s/)[0]!
    .replace(/\s+by (end of day|eod|today|tomorrow|\w+day)\b.*$/i, '')
    .replace(/[?.!\s]+$/, '')
    .trim();
}

const theTopic = (subject: string) => {
  const t = topicOf(subject);
  return /^(the|a|an|your|my|our)\b/i.test(t) ? midSentence(t) : `the ${midSentence(t)}`;
};

/** Who you'd be writing to: the latest sender who isn't you. */
const replyTo = (t: Thread) =>
  [...t.messages].reverse().find((m) => m.from !== 'me')?.from ?? t.participants.find((p) => p !== 'me') ?? 'me';

/** "by Wednesday", "by tomorrow", "by end of day". */
const byWhen = (d: Date) => {
  const w = weekdayWord(d);
  return w === 'today' ? 'by end of day' : `by ${w}`;
};

const keyWords = (x: string) => new Set(x.toLowerCase().match(/[a-z]{4,}/g) ?? []);
/** The subject and the item say the same thing ("Updated onboarding mockups"). */
const sameThing = (a: string, b: string) => {
  const A = keyWords(a);
  return [...keyWords(b)].filter((w) => A.has(w)).length >= Math.min(2, A.size);
};

/** A nudge for what someone owes you. */
function nudge(t: Thread): Draft {
  const w = t.waiting!;
  const by = w.due && w.due > NOW ? w.due : workdaysAhead(2);
  const item = midSentence(w.item);
  const generic = /^a (reply|response|answer)$/i.test(w.item);
  const note = w.since ? `my ${w.since.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} note` : 'my last note';
  const lead =
    w.due && w.due < NOW
      ? `Following up on ${generic ? note : `the ${item}`}, which was due ${w.due.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}.`
      : generic || sameThing(topicOf(t.subject), w.item)
        ? `Following up on ${note}.`
        : `Following up on ${note} about ${theTopic(t.subject)}.`;
  const ask = generic
    ? `Could you get back to me ${byWhen(by)}?`
    : /approv/i.test(w.item)
      ? `Could you let me know ${byWhen(by)} whether ${theTopic(t.subject)} is approved?`
      : `Could you send the ${item} ${byWhen(by)}?`;
  return {
    kind: 'nudge',
    to: [w.on],
    subject: `${generic ? topicOf(t.subject) : w.item} by ${weekdayShort(by)}?`,
    body: `Hi ${firstName(w.on)},\n\n${lead} ${ask}\n\n${SIGN}`,
    sources: (t.docs ?? []).slice(0, 2),
    trackAs: { on: w.on, item: w.item, due: by },
  };
}

/** What your words ask the reply to say: "sure, happy to do the intro this week". */
export function readInstruction(note: string): { text: string; said: string; tone: 'yes' | 'no' | null; when?: Date } {
  let s = note
    .trim()
    .replace(/^(please\s+)?(can you\s+|could you\s+)?/i, '')
    .replace(/^(make it|keep it)\s+(shorter|brief|short)\s*(,|and)?\s*/i, '')
    .replace(/^(draft|write)( me)?( a| the)?( quick| short| brief)?( reply| response| email| note| answer)?( back)?\b\s*(,|:|and|to (him|her|them)|saying|that says)?\s*/i, '')
    .replace(/^(reply|respond|answer)( to (him|her|them|this|it))?\s*(,|:|and|saying)?\s*/i, '')
    .replace(/^(tell|let)\s+(him|her|them|\w+)\s+(know\s+)?(that\s+)?/i, '')
    .replace(/^(say|saying)\s+(that\s+)?/i, '')
    .trim();
  // "draft a reply", "write back", "answer it": no words of yours to put in.
  if (/^(back|it|this|that|him|her|them|now|please)?[\s.!?]*$/i.test(s)) s = '';
  const said = s;
  const yes = s.match(/^(yes|yeah|yep|sure|ok(ay)?|absolutely|of course|sounds good|happy to|works for me)\b[,.!]?\s*/i);
  const no = s.match(/^(no|nope|decline|pass|not this time|can'?t|cannot|unfortunately)\b[,.!]?\s*/i);
  const tone = yes ? 'yes' : no ? 'no' : null;
  // You're writing to them now: "intro him Thursday" → "intro you Thursday".
  s = s.replace(/\b(him|her)\b(?!\s+(know|to\b))/gi, 'you').replace(/\b(his)\b/gi, 'your');
  const when = parseDue(s);
  if (yes && !/^happy to|^works for me/i.test(yes[1]!)) s = s.slice(yes[0].length);
  if (no && /^(no|nope|decline|pass)$/i.test(no[1]!)) s = s.slice(no[0].length).replace(/^(thanks|thank you)\b[,.!]?\s*/i, '');
  const lead = yes ? cap(yes[1]!.toLowerCase().replace(/^yeah|^yep/, 'yes').replace(/^ok(ay)?/, 'Sure')) : '';
  const onlyDay = s.replace(/\b(on|by|this|next|works?|is fine|for me)\b/gi, '').replace(/\b(sun|mon|tues?|wed|thu|thurs|fri|sat)(day|nesday|rsday|urday)?\b|\btoday\b|\btomorrow\b|\bweek\b/gi, '').replace(/[\s,.!]+/g, '') === '';
  let text: string;
  if (tone === 'yes' && (!s || onlyDay)) text = when ? `${lead || 'Yes'}, ${cap(weekdayWord(when))} works for me.` : `${lead || 'Yes'}, that works for me.`;
  else if (tone === 'no' && (!s || onlyDay)) text = 'Thanks for thinking of me, but I can’t make that work this time.';
  else if (lead && /^(happy to|works for me)/i.test(lead) === false) text = sentence(`${lead}, ${s}`);
  else text = sentence(s);
  // A weekday on its own ("thursday") reads better capitalized.
  text = text.replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g, (d) => cap(d));
  return { text, said, tone, when };
}

/**
 * The draft for a thread: a nudge if you're waiting on someone and gave no
 * instructions; otherwise a reply that says what you asked it to.
 */
export function draftFor(t: Thread, note?: string): Draft {
  const words = note?.trim();
  if (!words && t.box === 'waiting' && t.waiting) return nudge(t);
  const who = t.box === 'waiting' && t.waiting ? t.waiting.on : replyTo(t);
  const subject = /^re:/i.test(t.subject) ? t.subject : `Re: ${t.subject}`;
  let line: string;
  if (words) line = readInstruction(words).text;
  else {
    const by = t.due && t.due > NOW ? t.due : workdaysAhead(1);
    line = `Thanks for the note about ${theTopic(t.subject)}. I’m on it and will come back to you ${byWhen(by)}.`;
  }
  return {
    kind: 'reply',
    to: [who],
    subject,
    body: `Hi ${firstName(who)},\n\n${line}\n\n${SIGN}`,
    sources: (t.docs ?? []).slice(0, 2),
  };
}

const PLEASANTRY = /^(happy to|hope|thanks (again|for)|let me know if|feel free|looking forward|the updated .* is attached|attached is)/i;

/** The same email, shorter: the ask, the numbers and the sign-off. Null if it's already short. */
export function shorter(body: string): string | null {
  const paras = body.split(/\n\n+/);
  if (paras.length < 3) return null;
  const [greeting, ...rest] = paras;
  const signoff = rest.pop()!;
  const keep: string[] = [];
  rest.forEach((p, i) => {
    if (p.trim().startsWith('•')) {
      // Bullets carry the numbers; drop the ones that only compare or explain.
      const lines = p.split('\n').filter((l) => /\d/.test(l) || /\?/.test(l) || /:/.test(l));
      if (lines.length) keep.push(lines.join('\n'));
      return;
    }
    if (PLEASANTRY.test(p.trim())) return;
    if (i === 0) {
      // Keep the answer (first sentence) and the ask; keep what the ask points back to ("send it").
      const sentences = (p.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [p]).map((x) => x.trim());
      const q = sentences.findIndex((x) => /\?/.test(x));
      if (q < 0) return void keep.push(p);
      const picked = new Set([0, q]);
      if (q > 0 && /\b(it|that|this|them)\b/i.test(sentences[q]!)) picked.add(q - 1);
      keep.push(sentences.filter((_, j) => picked.has(j)).join(' '));
      return;
    }
    if (/\?/.test(p)) keep.push(p);
  });
  const out = [greeting, ...keep, signoff].join('\n\n');
  return out.length < body.length - 10 ? out : null;
}
