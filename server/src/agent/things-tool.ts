/**
 * Ask's way to the things a workspace tracks (deals, properties, candidates…): a read of Timmy's own store.
 * Every name, value and sentence in the answer was read out of other people's mail, so the whole result is
 * handed to the model as outside content, like mail itself.
 */
import { findThings } from '../ontology/types';
import { untrusted } from './prompts';
import type { AgentTool } from './tools';

export const findThingsTool: AgentTool = {
  kind: 'read',
  step: 'Looking through what Timmy tracks',
  def: {
    name: 'find_things',
    description:
      'Look up the things the user has chosen to track from their mail beyond people and companies, such as deals, leads, properties, candidates, jobs or invoices. Returns each match with its fields, when it was last mentioned, and the sentence and email each rests on, plus `tracked`: the kinds this workspace tracks. If a kind is not in `tracked`, say that it is not being tracked rather than that there are none. Give `type` to list one kind, `query` to search names and field values, or both.',
    parameters: { type: 'object', properties: { type: { type: 'string', description: 'A kind of thing, singular or plural: "deal", "properties"' }, query: { type: 'string', description: 'Words from a name or a field value, such as a company or an address' } } },
  },
  async run(args, t) {
    const type = String(args.type ?? '').slice(0, 80).trim();
    const query = String(args.query ?? '').slice(0, 200).trim();
    const found = await findThings(t.ctx.workspaceId, { ...(type ? { type } : {}), ...(query ? { query } : {}) });
    return { result: untrusted('things', { type: type || undefined, query: query || undefined, ...found }), outside: true };
  },
};
