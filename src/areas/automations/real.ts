/*
 * Which blocks really run on a real workspace, and which can only be drawn and test-run for now.
 * The canvas shows the reason next to such a block, and the server gives the same reason when it
 * refuses to switch the automation on. Both read this file, so they can't disagree.
 */
import type { AutoNode } from '../../data/ws-types';
import { KIND } from './catalog';

/** What each block that can't run yet is waiting for, as the end of the sentence “<block> …”. */
const NOT_YET: Record<string, string> = {
  form: 'needs a lead form, and none can be connected yet',
  drive: 'needs Timmy to watch a Drive folder, and it only lists Drive files for now',
  meeting: 'needs Timmy to know when a meeting ends, and it can’t yet',
  deal: 'needs a CRM, and none can be connected yet',
  crm: 'needs a CRM, and none can be connected yet',
  file: 'needs Timmy to save files to Drive, and it only lists Drive files for now',
  campaign: 'needs campaigns that run on a real workspace, and they don’t yet',
};

/** The one place a notice from an automation can go for now. */
export const NOTIFY_IN_TIMMY = 'Timmy (Today page)';

/** Why a block of this kind can't run on a real workspace yet, or null when it can. */
export function kindNotYet(kindId: string): string | null {
  const k = KIND[kindId];
  const why = NOT_YET[kindId];
  return k && why ? `“${k.label}” ${why}.` : null;
}

/** Why this step, with its settings, can't run on a real workspace yet, or null when it can. */
export function stepNotYet(n: Pick<AutoNode, 'kind' | 'config'>): string | null {
  const whole = kindNotYet(n.kind);
  if (whole) return whole;
  if (n.kind === 'notify' && n.config.where && n.config.where !== NOTIFY_IN_TIMMY) return `“Notify me” is set to Slack, and Slack can’t be connected yet. Choose “${NOTIFY_IN_TIMMY}”.`;
  return null;
}
