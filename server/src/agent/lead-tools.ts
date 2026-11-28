/**
 * Ask's tool for suggesting leads that fit the workspace's offer, through Treg (treg/leads.ts). Offered only when
 * Treg is set up. It adds leads with checked emails to "Suggested by Timmy" and contacts nobody. Names and companies
 * came from data providers, so what goes back to the model is outside content.
 */
import { tregReady } from '../treg/client';
import { suggestLeads } from '../treg/leads';
import { readState } from '../state/mutate';
import { untrusted } from './prompts';
import type { AgentTool } from './tools';

export const suggestLeadsTool: AgentTool = {
  kind: 'internal',
  step: 'Finding leads that fit your offer',
  available: tregReady,
  def: {
    name: 'suggest_leads',
    description:
      'Find people at companies that fit the user’s offer and its ideal customer, through the workspace’s lead data, and add them to the “Suggested by Timmy” list in Outbound, each with an email that was checked. It costs a little per lead and is limited per day. Nobody is contacted. Only when the user asks for leads. Give `ask` for what to look for ("dental practices in Austin"); leave it out to use the offer’s ideal customer.',
    parameters: { type: 'object', properties: { ask: { type: 'string', description: 'What to look for, in the user’s words' }, count: { type: 'integer', description: 'How many, 1-25. Default 10.' } } },
  },
  async run(args, t) {
    if (!t.attended) return { result: 'Leads can only be found in a conversation with the user. Nothing was searched.' };
    if (!t.ctx.rules.work) return { result: 'The user’s role can’t add leads in this workspace. Nothing changed.' };
    const ask = typeof args.ask === 'string' ? args.ask.slice(0, 200) : '';
    const count = Number.isInteger(args.count) ? Math.min(Math.max(args.count as number, 1), 25) : undefined;
    const r = await suggestLeads(t.ctx.workspaceId, { ask, ...(count ? { count } : {}), runId: t.runId });
    if (!r.ok) return { result: `${r.error} Nothing was added.` };
    const { state } = await readState(t.ctx.workspaceId);
    const added = Object.values(state.out.leads)
      .filter((l) => l.suggested && Date.now() - new Date(l.suggested.at).getTime() < 10 * 60_000)
      .slice(0, r.added)
      .map((l) => ({ name: `${l.first} ${l.last}`, title: l.title, company: l.company, fits: l.suggested!.why.slice(0, 3) }));
    return { result: untrusted('suggested-leads', { added: r.added, skipped: r.skipped, left_today: r.left, leads: added, note: 'They are in Outbound › Leads › Suggested by Timmy. Nobody was contacted.' }), outside: true };
  },
};
