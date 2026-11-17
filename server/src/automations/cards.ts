/**
 * How what an automation puts forward shows in Approvals, and what deciding it does to the thread.
 *
 *   - A Send step puts forward the reply its own Draft step wrote, which is the draft on the thread. Approvals shows
 *     the automation's card in place of the draft's own, so the same email isn't offered twice; deciding the card
 *     settles both: Send sends the draft, and Don't send discards it.
 *   - Not everyone who may approve a send may decide an automation's question or email: only an owner or admin,
 *     or the person whose mailbox the email leaves from (see `mayDecide` in gateway/policy.ts). The card says so,
 *     so the screen can show everyone else who it is waiting for instead of buttons that would be refused.
 */
import type { PendingEffect } from '../../../src/live/types';
import type { State } from '../../../src/state/store';
import type { EffectRow } from '../gateway/gateway';
import { isAutomationEffect } from './keys';

const isMail = (kind: string) => kind === 'email.reply' || kind === 'email.send';

/** What an automation's waiting effect adds to its card in Approvals. Nothing for any other effect. */
export function automationCard(e: Pick<EffectRow, 'idempotency_key' | 'kind' | 'on_behalf_of' | 'preview'>): Pick<PendingEffect, 'replacesDraft' | 'decidedBy'> {
  if (!isAutomationEffect(e)) return {};
  if (!isMail(e.kind)) return { decidedBy: {} };
  return { ...(e.preview.thread ? { replacesDraft: true } : {}), decidedBy: e.on_behalf_of ? { person: e.on_behalf_of } : {} };
}

/**
 * After a person decides an automation's email: turned down, the draft it would have sent goes from the thread too,
 * so its card doesn't come back on its own. A draft someone changed since it was put forward is theirs, and stays.
 */
export function afterAutomationDecision(state: State, e: Pick<EffectRow, 'idempotency_key' | 'kind' | 'status' | 'payload' | 'preview'>): State {
  if (!isAutomationEffect(e) || !isMail(e.kind) || e.status !== 'declined' || !e.preview.thread) return state;
  const p = e.payload as { subject?: string; body?: string };
  const t = state.threads.find((x) => x.id === e.preview.thread);
  if (!t?.draft || t.draft.subject !== p.subject || t.draft.body !== p.body) return state;
  return {
    ...state,
    threads: state.threads.map((x) => (x.id === t.id ? { ...x, draft: undefined, history: [...(x.history ?? []), { at: new Date(), text: 'The automation’s reply was turned down in Approvals, so Timmy’s draft was discarded' }] } : x)),
  };
}
