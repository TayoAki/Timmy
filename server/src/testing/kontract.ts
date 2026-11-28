/**
 * A stand-in for Kontract's engine API, used by the tests and by servers run on stand-ins. It answers from the
 * sample notices in src/data/bids-sample.ts the way the real engine would: searches filter them, documents are read
 * from their sample text, quotes are checked against that text, and paid calls report a cost. Every call is kept in
 * `calls`, with the workspace it was for, so tests can see what Timmy asked.
 */
import { sampleBreakdown, sampleDetails, sampleDocuments, sampleOpportunities, samplePermitContractors, samplePricing, sampleSite, sampleSubs } from '../../../src/data/bids-sample';
import type { HealthResponse, Opportunity, PricingQuery } from '../../../src/data/kontract-api';
import type { KontractEngine, OpportunitySearch, Paid } from '../kontract/client';
import { KontractError } from '../kontract/errors';

/** What the paid calls cost here, in millionths of a dollar (roughly Kontract's own prices). */
export const FAKE_COST = { breakdownClaude: 0, detailsClaude: 120_000, subcontractors: 35_000, website: 2_000 };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

export class FakeKontract implements KontractEngine {
  calls: { endpoint: string; ws: string; body?: unknown }[] = [];
  /** The next call to this endpoint fails with this status (once). */
  failNext: Record<string, { status: number; message: string; retryAfter?: number }> = {};
  /** Notices that have closed: they no longer come back by id, as on the real engine. */
  closed = new Set<string>();
  now = () => new Date();

  reset() {
    this.calls = [];
    this.failNext = {};
    this.closed.clear();
  }

  private take(endpoint: string, ws: string, body?: unknown) {
    if (!/^[a-z0-9-]{1,64}$/.test(ws)) throw new KontractError(502, 'Timmy’s connection to Kontract isn’t set up right. The people who run Timmy have been told.');
    this.calls.push({ endpoint, ws, ...(body !== undefined ? { body } : {}) });
    const f = this.failNext[endpoint];
    if (f) {
      delete this.failNext[endpoint];
      throw new KontractError(f.status, f.message, f.retryAfter);
    }
  }

  private open(id: string): Opportunity | undefined {
    return this.closed.has(id) ? undefined : sampleOpportunities(this.now()).find((o) => o.id === id);
  }

  /** A closed federal notice may be read from the copy the caller sends; anything else needs an open one. */
  private readable(id: string, copy?: Opportunity): Opportunity {
    const o = this.open(id) ?? (copy && copy.id === id && (copy.level ?? 'federal') === 'federal' ? copy : undefined);
    if (!o) throw new KontractError(404, 'No open notice with that id. For a closed federal notice, send the opportunity you saved.');
    return o;
  }

  async health(): Promise<HealthResponse> {
    return { ok: true, samAsOf: this.now().toISOString(), notices: 4, sledBids: 1, permitFeeds: { ok: 21, failing: 0 } };
  }

  async opportunities(ws: string, s: OpportunitySearch) {
    this.take('opportunities', ws, s);
    const words = (s.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    let all = sampleOpportunities(this.now()).filter((o) => !this.closed.has(o.id));
    if (words.length) all = all.filter((o) => words.every((w) => `${o.title} ${o.agency} ${o.description ?? ''}`.toLowerCase().includes(w)));
    if (s.state) all = all.filter((o) => o.placeOfPerformance.state === s.state);
    if (s.naics) all = all.filter((o) => o.naicsCode?.startsWith(s.naics!));
    if (s.servicesOnly) all = all.filter((o) => o.serviceKind !== 'product');
    if (s.level === 'federal') all = all.filter((o) => (o.level ?? 'federal') === 'federal');
    if (s.level === 'sled') all = all.filter((o) => o.level === 'state' || o.level === 'local');
    if (s.setAside) all = all.filter((o) => o.setAsideCode === s.setAside);
    const offset = s.offset ?? 0;
    const limit = Math.min(s.limit ?? 100, 100);
    const results = all.slice(offset, offset + limit).map(({ description: _d, ...o }) => o);
    return { data: { results, total: all.length, offset, source: 'sample' as const, dataAsOf: this.now().toISOString(), sledTotal: all.filter((o) => o.level !== 'federal').length }, costMicro: 0 };
  }

  async opportunity(ws: string, id: string) {
    this.take('opportunity', ws);
    const o = this.open(id);
    if (!o) throw new KontractError(404, 'No open notice with that id.');
    return { data: { opportunity: o }, costMicro: 0 };
  }

  async details(ws: string, id: string, body: { claude?: boolean; opportunity?: Opportunity }) {
    this.take('details', ws, body);
    this.readable(id, body.opportunity);
    return { data: { details: sampleDetails(id, this.now()) }, costMicro: body.claude ? FAKE_COST.detailsClaude : 0 };
  }

  async breakdown(ws: string, id: string, body: { opportunity?: Opportunity }) {
    this.take('breakdown', ws, body);
    this.readable(id, body.opportunity);
    return { data: { breakdown: sampleBreakdown(id, this.now()), source: 'rules' as const }, costMicro: FAKE_COST.breakdownClaude };
  }

  /** The documents as one text, like the real engine: the notice, then each document in a tag. */
  private wholeText(o: Opportunity) {
    const docs = sampleDocuments(o.id, this.now());
    let text = `<document name="Notice">\n${o.title}\n\n${o.description ?? ''}\n</document>\n\n`;
    const documents = [{ id: 'notice', name: 'Notice', read: 'read' as const, pages: null, chars: text.length, startsAt: 0, excerpted: false }];
    docs.forEach((d, i) => {
      const part = `<document name="${d.name}">\n${d.text}\n</document>\n\n`;
      documents.push({ id: `doc-${i + 1}`, name: d.name, read: 'read', pages: null, chars: part.length, startsAt: text.length, excerpted: false });
      text += part;
    });
    return { text, documents, docs };
  }

  async text(ws: string, id: string, body: { offset?: number; limit?: number; opportunity?: Opportunity }) {
    this.take('text', ws, body);
    const o = this.readable(id, body.opportunity);
    const { text, documents } = this.wholeText(o);
    const offset = Math.max(0, body.offset ?? 0);
    const limit = Math.min(Math.max(body.limit ?? 40_000, 1), 80_000);
    const slice = text.slice(offset, offset + limit);
    const next = offset + slice.length < text.length ? offset + slice.length : null;
    return { data: { noticeId: id, fingerprint: `fp-${id}`, totalChars: text.length, offset, nextOffset: next, documents, text: slice }, costMicro: 0 };
  }

  async quotes(ws: string, id: string, body: { quotes: { quote: string; doc?: string }[]; opportunity?: Opportunity }) {
    this.take('quotes', ws, body);
    const o = this.readable(id, body.opportunity);
    const { docs } = this.wholeText(o);
    const all = [{ name: 'Notice', text: `${o.title}\n${o.description ?? ''}` }, ...docs];
    const results = body.quotes.slice(0, 100).map(({ quote, doc }) => {
      const q = norm(quote);
      if (q.length < 8) return { quote, found: false, doc: null, page: null };
      const order = [...all.filter((d) => d.name === doc), ...all.filter((d) => d.name !== doc)];
      const hit = order.find((d) => norm(d.text).includes(q));
      if (!hit) return { quote, found: false, doc: null, page: null };
      // The page is the last "[Page N]" line before where the words start.
      const before = hit.text.slice(0, Math.max(0, hit.text.toLowerCase().indexOf(quote.toLowerCase().slice(0, 12))));
      const page = [...before.matchAll(/\[Page (\d+)\]/g)].at(-1)?.[1];
      return { quote, found: true, doc: hit.name, page: page ? Number(page) : null };
    });
    return { data: { results }, costMicro: 0 };
  }

  async pricing(ws: string, body: { query: PricingQuery; context?: { agency?: string; state?: string } }) {
    this.take('pricing', ws, body);
    return { data: { ...samplePricing(body.query.keywords ?? []), query: body.query }, costMicro: 0 };
  }

  async subcontractors(ws: string, body: { query: string; location: string }) {
    this.take('subcontractors', ws, body);
    return { data: { results: sampleSubs(body.query, body.location), source: 'sample' as const, notice: 'Sample businesses: Kontract has no business-search key.' }, costMicro: FAKE_COST.subcontractors };
  }

  async website(ws: string, url: string) {
    this.take('websites/read', ws, { url });
    return { data: { facts: sampleSite(url, this.now()) }, costMicro: FAKE_COST.website };
  }

  async permitContractors(ws: string, q: { state: string; city?: string; work?: string }): Promise<Paid<ReturnType<typeof samplePermitContractors>>> {
    this.take('permits/contractors', ws, q);
    return { data: samplePermitContractors(q.state, q.city), costMicro: 0 };
  }
}
