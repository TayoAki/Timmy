/**
 * Replying, from the Unibox or a lead's panel, to a lead who wrote back.
 *
 * A first cold email is never sent through the mail provider: the person sends it from their own mail app (the
 * owner's decision; see the engine). Once the lead has written back, though, answering them is an ordinary reply
 * in an ordinary thread, so it takes the ordinary reply path: the typed text becomes that thread's draft and is
 * sent the way Send sends any draft. That makes it an `email.reply` effect at the Action gateway, with the same
 * approval rules (someone who must not send from that mailbox waits for its owner), the same undo window, and the
 * same idempotency key, so it is sent once.
 *
 * Which thread: the lead's newest reply that Timmy holds as mail. Its copy in the Unibox carries the provider's
 * message id (see `noteLeadMail` in sync/ingest.ts), and the thread on Timmy's side holds a message with that id.
 * The reply goes to the address that wrote, which is the lead's own: a display name never decides it.
 */
import type { Action, State } from '../../../src/state/store';

export type LeadReply =
  /** The lead has never written back: the first cold email, which the person sends from their mail app. */
  | { kind: 'cold' }
  /** The thread with the reply as its draft, and the action that sends that draft. */
  | { kind: 'reply'; withDraft: State; action: Action }
  | { kind: 'refused'; reason: string };

/** The provider's id of a message, from the id its copy in the Unibox was given: "gm-" + message id + "-" + lead id. */
const messageIdOf = (unibox: string, leadId: string) => (unibox.startsWith('gm-') && unibox.endsWith(`-${leadId}`) ? unibox.slice(3, -(leadId.length + 1)) : null);

export function leadReply(state: State, op: { lead: string; subject?: string; body: string }): LeadReply {
  const lead = state.out.leads[op.lead];
  if (!lead) return { kind: 'cold' };
  const replies = state.out.messages.filter((m) => m.lead === lead.id && m.dir === 'in' && m.channel === 'email').sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  if (!replies.length) return { kind: 'cold' };

  for (const r of replies) {
    const id = messageIdOf(r.id, lead.id);
    if (!id) continue;
    const thread = state.threads.find((t) => !!t.ext?.threadKey && !!t.ext.connectionId && t.messages.some((m) => m.id === id));
    const wrote = thread?.messages.find((m) => m.id === id);
    if (!thread || !wrote) continue;
    const body = typeof op.body === 'string' ? op.body.trim() : '';
    if (!body) return { kind: 'refused', reason: `Write your reply to ${lead.first} first.` };
    // The address that wrote is the lead's own: sync only files a message under a lead by its parsed address.
    const subject = typeof op.subject === 'string' && op.subject.trim() ? op.subject.trim().slice(0, 300) : `Re: ${thread.subject}`;
    const draft = { to: [wrote.from], subject, body, sources: [], kind: 'reply' as const };
    const withDraft: State = { ...state, threads: state.threads.map((t) => (t.id === thread.id ? { ...t, draft } : t)) };
    return { kind: 'reply', withDraft, action: { type: 'sendDraft', id: thread.id, track: false } };
  }
  return { kind: 'refused', reason: `${lead.first} wrote back, but that email isn’t in Timmy’s inbox, so Timmy can’t reply in that thread. Reply from your mail app instead.` };
}
