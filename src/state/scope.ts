/*
 * Narrowing Timmy to one project (the picker at the top of the sidebar).
 * The brief, mail lists, Approvals, Tasks, the bottom bar and Ask Timmy all
 * read through these, so one choice changes everything consistently.
 */
import type { Thread } from '../data/types';
import type { Invoice, WEvent } from '../data/ws-types';
import { openApprovals, type Approval } from './approvals';
import { useStore, type State } from './store';

export const threadInScope = (s: State, t: Thread) => !s.scope || t.project === s.scope;

export const approvalInScope = (s: State, a: Approval) =>
  !s.scope || a.project === s.scope || (!!a.thread && s.threads.find((t) => t.id === a.thread)?.project === s.scope);

/** An event belongs to the project through its email, its notes doc, its files or the deal's contact. */
export const eventInScope = (s: State, e: WEvent) => {
  if (!s.scope) return true;
  const p = s.ws.projects[s.scope];
  if (!p) return true;
  if (e.thread && s.threads.find((t) => t.id === e.thread)?.project === p.id) return true;
  if (p.notesDoc && e.notesDoc === p.notesDoc) return true;
  if (e.docs?.some((d) => s.ws.files[d]?.project === p.id || s.ws.files[d]?.folder === p.folder)) return true;
  const contact = p.deal ? s.deals[p.deal]?.contact : undefined;
  return !!contact && e.with.includes(contact);
};

export const scopedThreads = (s: State, list: Thread[] = s.threads) => list.filter((t) => threadInScope(s, t));
/** Invoices and quotes belong to a project through their own project, set when they are started or on their page. */
export const invoiceInScope = (s: State, x: Invoice) => !s.scope || x.project === s.scope;
export const scopedInvoices = (s: State) => Object.values(s.ws.invoices ?? {}).filter((x) => invoiceInScope(s, x));
export const scopedApprovals = (s: State) => openApprovals(s).filter((a) => approvalInScope(s, a));

export function useScope() {
  const { state } = useStore();
  const project = state.scope ? (state.ws.projects[state.scope] ?? null) : null;
  return { project, focus: state.focus };
}
