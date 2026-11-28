/**
 * Ask's tools for government and public bids, through Kontract's engine (kontract/client.ts). Offered only when
 * Kontract is set up on this server.
 *
 * Everything Kontract returns was written by buyers, businesses or their websites, so it goes back to the model as
 * outside content, like mail. Reading a bid's documents uses Kontract's free text endpoint, so Timmy's own model does
 * the reading. Finding businesses costs a little, so it runs only in a conversation someone is having, within the
 * monthly limit. Tracking a bid changes only the workspace's own records, with Kontract's own copy of the notice.
 */
import type { Opportunity } from '../../../src/data/kontract-api';
import { bidTotals, dueText, placeText, STAGE_LABEL, trimNotice } from '../../../src/state/bids';
import { callKontract, kontractReady, KontractError } from '../kontract/client';
import { newId } from '../lib/ids';
import { BudgetError } from '../providers/model';
import { reduce } from '../state/engine';
import { mutate, readState } from '../state/mutate';
import { untrusted } from './prompts';
import type { AgentTool, ToolOutcome } from './tools';

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const NOTICE_ID = /^[\w.:-]{1,200}$/;

/** Kontract's or the limit's refusal, said plainly to the model; anything else is a real fault. */
async function guarded(fn: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof KontractError || e instanceof BudgetError) return { result: `${e.message} Nothing changed.` };
    throw e;
  }
}

/** A notice in a list: what it is, who buys it, where, and when it is due. */
const brief = (o: Opportunity, now: Date) => ({
  id: o.id,
  title: o.title,
  agency: o.agency,
  where: placeText(o) || undefined,
  level: o.level ?? 'federal',
  due: o.responseDeadline ?? undefined,
  dueIn: dueText(o.responseDeadline, now),
  setAside: o.setAside ?? undefined,
  naics: o.naicsCode ?? undefined,
  sample: o.isSample || undefined,
});

const searchOpportunities: AgentTool = {
  kind: 'read',
  step: 'Searching open contracts',
  available: kontractReady,
  def: {
    name: 'search_opportunities',
    description:
      'Search open government contract opportunities: federal notices from SAM.gov and state and local bids. Returns each notice’s id (for get_opportunity, read_bid_documents and track_bid), title, buying agency, place, level, deadline, set-aside and NAICS code. Notices marked `sample` are examples, not real.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words for the work, e.g. "janitorial" or "snow removal"' },
        state: { type: 'string', description: 'Two-letter state code where the work is, e.g. "OR"' },
        naics: { type: 'string', description: 'A NAICS code or its first digits' },
        level: { type: 'string', enum: ['federal', 'sled'], description: '"federal" for SAM.gov only, "sled" for state and local only; leave out for both' },
        services_only: { type: 'boolean', description: 'Leave out buys of goods' },
        limit: { type: 'integer', description: 'How many, 1-10. Default 8.' },
      },
    },
  },
  run: (args, t) =>
    guarded(async () => {
      const state = str(args.state, 2).toUpperCase();
      const naics = str(args.naics, 6);
      const r = await callKontract(
        t.ctx.workspaceId,
        'opportunities',
        (e, ws) =>
          e.opportunities(ws, {
            ...(str(args.query) ? { q: str(args.query) } : {}),
            ...(/^[A-Z]{2}$/.test(state) ? { state } : {}),
            ...(/^\d{2,6}$/.test(naics) ? { naics } : {}),
            ...(args.level === 'federal' || args.level === 'sled' ? { level: args.level } : {}),
            ...(args.services_only ? { servicesOnly: true } : {}),
            limit: Math.min(Math.max(Number(args.limit ?? 8) || 8, 1), 10),
          }),
        { runId: t.runId },
      );
      const now = new Date();
      return { result: untrusted('opportunities', { total: r.total, results: r.results.map((o) => brief(o, now)) }), outside: true };
    }),
};

const getOpportunity: AgentTool = {
  kind: 'read',
  step: 'Reading the notice',
  available: kontractReady,
  def: {
    name: 'get_opportunity',
    description: 'One open contract opportunity in full: its description, contacts, set-aside, codes and deadline, and whether the user is already tracking it as a bid.',
    parameters: { type: 'object', properties: { id: { type: 'string', description: 'The notice id from search_opportunities' } }, required: ['id'] },
  },
  run: (args, t) =>
    guarded(async () => {
      const id = str(args.id);
      if (!NOTICE_ID.test(id)) return { result: 'That isn’t a notice id.' };
      const { opportunity: o } = await callKontract(t.ctx.workspaceId, 'opportunity', (e, ws) => e.opportunity(ws, id), { runId: t.runId });
      const { state } = await readState(t.ctx.workspaceId);
      const tracked = Object.values(state.ws.bids ?? {}).find((b) => b.notice.id === o.id);
      return { result: untrusted('opportunity', { ...brief(o, new Date()), solicitation: o.solicitationNumber, office: o.office, type: o.type, contacts: o.contacts, description: (o.description ?? '').slice(0, 8000), tracked: tracked ? { bid: tracked.id, stage: STAGE_LABEL[tracked.stage] } : false }), outside: true };
    }),
};

const readBidDocuments: AgentTool = {
  kind: 'read',
  step: 'Reading the bid documents',
  available: kontractReady,
  def: {
    name: 'read_bid_documents',
    description:
      'Read a notice’s documents (the statement of work, the solicitation, price forms, amendments) as one text, a page at a time. Each document starts with <document name="…">, and PDF pages with "[Page N]". Keep reading with `offset` set to the `next_offset` it gives until that is null, when you need the rest. Quote the documents’ own words when you tell the user what they say.',
    parameters: { type: 'object', properties: { id: { type: 'string', description: 'The notice id' }, offset: { type: 'integer', description: 'Where to start reading; 0 for the beginning' } }, required: ['id'] },
  },
  run: (args, t) =>
    guarded(async () => {
      const id = str(args.id);
      if (!NOTICE_ID.test(id)) return { result: 'That isn’t a notice id.' };
      // A tracked bid's own copy lets a closed federal notice still be read.
      const { state } = await readState(t.ctx.workspaceId);
      const copy = Object.values(state.ws.bids ?? {}).find((b) => b.notice.id === id)?.notice;
      const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)) || 0);
      const page = await callKontract(t.ctx.workspaceId, 'text', (e, ws) => e.text(ws, id, { offset, limit: 20_000, ...(copy ? { opportunity: copy } : {}) }), { runId: t.runId });
      return { result: untrusted('bid-documents', { notice: id, total_chars: page.totalChars, offset: page.offset, next_offset: page.nextOffset, documents: page.documents.map((d) => ({ name: d.name, read: d.read, pages: d.pages, note: d.note })), text: page.text }), outside: true };
    }),
};

const getPastPricing: AgentTool = {
  kind: 'read',
  step: 'Looking up past awards',
  available: kontractReady,
  def: {
    name: 'get_past_pricing',
    description: 'What similar federal contracts were awarded for (USAspending.gov): the typical total and price per year, the low and high, recent awards, and which companies won them.',
    parameters: {
      type: 'object',
      properties: {
        keywords: { type: 'array', items: { type: 'string' }, description: 'One to three words for the work, e.g. ["janitorial"]' },
        naics: { type: 'string', description: 'The NAICS code' },
        state: { type: 'string', description: 'Two-letter state code' },
      },
      required: ['keywords'],
    },
  },
  run: (args, t) =>
    guarded(async () => {
      const keywords = (Array.isArray(args.keywords) ? args.keywords : [])
        .map((k) => str(k, 60))
        .filter(Boolean)
        .slice(0, 3);
      if (!keywords.length) return { result: 'Say what the work is, in a word or two.' };
      const naics = str(args.naics, 6);
      const state = str(args.state, 2).toUpperCase();
      const r = await callKontract(t.ctx.workspaceId, 'pricing', (e, ws) => e.pricing(ws, { query: { keywords, ...(/^\d{2,6}$/.test(naics) ? { naics } : {}), ...(/^[A-Z]{2}$/.test(state) ? { state } : {}), yearsBack: 5, servicesOnly: true } }), { runId: t.runId });
      return { result: untrusted('past-awards', { stats: r.stats, awards: r.awards.slice(0, 6).map((a) => ({ recipient: a.recipient, amount: a.amount, per_year: a.annualAmount, agency: a.agency, start: a.startDate, end: a.endDate, description: a.description.slice(0, 200), state: a.state })), winners: r.recipients.slice(0, 5) }), outside: true };
    }),
};

const findSubcontractors: AgentTool = {
  kind: 'read',
  step: 'Finding local businesses',
  available: kontractReady,
  def: {
    name: 'find_subcontractors',
    description: 'Find local businesses that do a kind of work near a place (name, phone, website, rating), to subcontract a bid to. This costs a little each time, so search once with the best words rather than many times.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'The kind of business, e.g. "commercial cleaning"' }, location: { type: 'string', description: 'City and state, e.g. "Portland, OR"' } }, required: ['query', 'location'] },
  },
  run: (args, t) =>
    guarded(async () => {
      if (!t.attended) return { result: 'Finding businesses can only be done in a conversation with the user. Nothing was searched.' };
      const query = str(args.query, 120);
      const location = str(args.location, 120);
      if (!query || !location) return { result: 'Say what kind of business, and where.' };
      const r = await callKontract(t.ctx.workspaceId, 'subcontractors', (e, ws) => e.subcontractors(ws, { query, location }), { runId: t.runId });
      return { result: untrusted('businesses', { source: r.source, notice: r.notice, results: r.results.slice(0, 10).map((b) => ({ name: b.name, phone: b.phone, website: b.website, address: b.address, rating: b.rating, reviews: b.reviewCount })) }), outside: true };
    }),
};

const listMyBids: AgentTool = {
  kind: 'read',
  step: 'Looking at your bids',
  available: kontractReady,
  def: {
    name: 'list_my_bids',
    description: 'The bids the user is tracking: each one’s notice, stage, deadline, how many subs are on it and how many have quoted, and its price per period and over the contract when priced.',
    parameters: { type: 'object', properties: {} },
  },
  async run(_args, t) {
    const { state } = await readState(t.ctx.workspaceId);
    const now = new Date();
    const list = Object.values(state.ws.bids ?? {})
      .sort((a, b) => (a.notice.responseDeadline ?? '9').localeCompare(b.notice.responseDeadline ?? '9'))
      .map((b) => {
        const tot = bidTotals(b);
        return { bid: b.id, notice: b.notice.id, title: b.notice.title, agency: b.notice.agency, stage: STAGE_LABEL[b.stage], due: dueText(b.notice.responseDeadline, now), subs: b.subs.length, quoted: b.subs.filter((s) => s.status === 'quoted' || s.status === 'selected').length, price_per_period: tot.price ? tot.price / 100 : undefined, contract_total: tot.contractPrice ? tot.contractPrice / 100 : undefined };
      });
    // Titles and agencies came from the notices, which other people wrote.
    return { result: untrusted('bids', { bids: list }), outside: true };
  },
};

const trackBid: AgentTool = {
  kind: 'internal',
  step: 'Tracking the bid',
  available: kontractReady,
  def: {
    name: 'track_bid',
    description: 'Start tracking a notice as one of the user’s bids, with its deadline on their to-do list. Only when the user asks to track or bid on it. Tracking the same notice again changes nothing.',
    parameters: { type: 'object', properties: { id: { type: 'string', description: 'The notice id' } }, required: ['id'] },
  },
  run: (args, t) =>
    guarded(async () => {
      if (!t.attended) return { result: 'A bid can only be started in a conversation with the user. Nothing changed.' };
      if (!t.ctx.rules.work) return { result: 'The user’s role can’t start bids in this workspace. Nothing changed.' };
      const id = str(args.id);
      if (!NOTICE_ID.test(id)) return { result: 'That isn’t a notice id.' };
      const { opportunity: notice } = await callKontract(t.ctx.workspaceId, 'opportunity', (e, ws) => e.opportunity(ws, id), { runId: t.runId });
      const out = await mutate<{ id: string; created: boolean; task?: string }>(t.ctx.workspaceId, 'bids', async (_tx, loaded) => {
        const had = Object.values(loaded.state.ws.bids ?? {}).find((b) => b.notice.id === notice.id);
        if (had) return { result: { id: had.id, created: false } };
        const bid = newId('bid');
        const made = reduce(loaded, loaded.state, { type: 'trackBid', id: bid, notice: trimNotice(notice), task: newId('tsk') });
        return { state: { ...made, route: loaded.state.route, back: loaded.state.back }, result: { id: bid, created: true, task: made.ws.bids?.[bid]?.task } };
      });
      return { result: out.created ? `Tracking it as a bid in Bids${out.task ? ', with its deadline on the to-do list' : ''}.` : 'The user was already tracking this one. Nothing changed.' };
    }),
};

export const BID_TOOLS: AgentTool[] = [searchOpportunities, getOpportunity, readBidDocuments, getPastPricing, findSubcontractors, listMyBids, trackBid];
