/**
 * Bids: the sums and the words, in plain code shared by the screens and the server. Money is whole cents. The
 * public data (the notice, what its documents say, past awards) comes from Kontract; what the workspace decides
 * (its price lines, its subs, its markup, its stage) is its own.
 */
import type { BidDetails, Breakdown, Opportunity, PricingQuery } from '../data/kontract-api';
import type { Bid, BidLine, BidProfile, BidStage, BidSub, Block } from '../data/ws-types';

export const STAGES: { id: BidStage; label: string; hint: string }[] = [
  { id: 'found', label: 'Found', hint: 'Tracked, not worked yet' },
  { id: 'sourcing', label: 'Sourcing', hint: 'Finding subs and prices' },
  { id: 'quoted', label: 'Quoted', hint: 'Subs have priced it' },
  { id: 'submitted', label: 'Submitted', hint: 'Sent to the buyer' },
  { id: 'won', label: 'Won', hint: '' },
  { id: 'lost', label: 'Lost', hint: '' },
];
export const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.id, s.label])) as Record<BidStage, string>;
export const isStage = (v: unknown): v is BidStage => STAGES.some((s) => s.id === v);
export const SUB_STATUS: Record<BidSub['status'], string> = { new: 'Not asked', asked: 'Asked for a quote', quoted: 'Quoted', selected: 'Selected', declined: 'Declined' };

/** Whole cents for one line each period. */
export const lineTotal = (l: Pick<BidLine, 'quantity' | 'price'>) => Math.round(l.quantity * l.price);
export const lineCost = (l: Pick<BidLine, 'quantity' | 'subCost'>) => Math.round(l.quantity * l.subCost);

/** What the bid comes to each period and over the whole contract, what the subs cost, and the margin. */
export function bidTotals(b: Pick<Bid, 'pricing'>) {
  const price = b.pricing.lines.reduce((n, l) => n + lineTotal(l), 0);
  const cost = b.pricing.lines.reduce((n, l) => n + lineCost(l), 0);
  const periods = Math.max(1, b.pricing.periods);
  return { price, cost, profit: price - cost, margin: price > 0 ? (price - cost) / price : 0, contractPrice: price * periods, contractCost: cost * periods, contractProfit: (price - cost) * periods };
}

/** A price from what the sub charges and the markup, in whole cents. */
export const priceFromMarkup = (subCost: number, markupPct: number) => Math.round(subCost * (1 + markupPct / 100));

/** Whole days until the deadline (negative once passed), or null with no deadline. */
export function daysLeft(deadline: string | null | undefined, now: Date): number | null {
  if (!deadline) return null;
  const t = new Date(deadline).getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - now.getTime()) / 86_400_000);
}

export function dueText(deadline: string | null | undefined, now: Date): string {
  const d = daysLeft(deadline, now);
  if (d === null) return 'No deadline given';
  if (d < 0) return 'Closed';
  if (d === 0) return 'Due today';
  if (d === 1) return 'Due tomorrow';
  return `${d} days left`;
}

export const placeText = (o: Pick<Opportunity, 'placeOfPerformance'>) => [o.placeOfPerformance.city, o.placeOfPerformance.state].filter(Boolean).join(', ');
export const levelText = (o: Pick<Opportunity, 'level'>) => (o.level === 'state' ? 'State' : o.level === 'local' ? 'Local' : 'Federal');

export function defaultProfile(companyName: string, email?: string): BidProfile {
  return { id: 'profile', companyName, ...(email ? { email } : {}), defaultMarkupPct: 20 };
}

/** A new bid for a notice, priced from nothing yet, with the workspace's usual markup. */
export function newBid(id: string, notice: Opportunity, now: Date, markupPct: number, task?: string): Bid {
  return { id, notice: trimNotice(notice), stage: 'found', created: now, ...(task ? { task } : {}), pricing: { periods: 1, periodLabel: 'contract', markupPct, lines: [] }, subs: [] };
}

/* ───────────── What is kept, and how much ───────────── */

export const LIMITS = { description: 20_000, quote: 300, documents: 60, cited: 20, lines: 60, subs: 60, awards: 8, recipients: 5, text: 2_000 };

const cut = (s: string | null | undefined, n: number) => (s ?? '').slice(0, n);

/** The notice as kept with a bid: Kontract's copy, with the description cut to a size a workspace keeps. */
export function trimNotice(o: Opportunity): Opportunity {
  return { ...o, title: cut(o.title, 500), description: cut(o.description, LIMITS.description), contacts: (o.contacts ?? []).slice(0, 5), attachments: o.attachments ? o.attachments.slice(0, LIMITS.documents) : null };
}

/** What the documents say, as kept with a bid: every fact keeps its words, cut to a short quote. */
export function trimDetails(d: BidDetails): BidDetails {
  const cite = <T,>(c: { value: T; quote: string; doc: string } | null) => (c ? { value: c.value, quote: cut(c.quote, LIMITS.quote), doc: cut(c.doc, 300) } : null);
  return {
    noticeId: d.noticeId,
    readAt: d.readAt,
    fingerprint: cut(d.fingerprint, 200),
    documents: d.documents.slice(0, LIMITS.documents).map((x) => ({ id: cut(x.id, 200), name: cut(x.name, 300), url: cut(x.url, 1000), size: x.size, postedDate: x.postedDate, read: x.read, ...(x.pages ? { pages: x.pages } : {}), ...(x.chars ? { chars: x.chars } : {}), ...(x.note ? { note: cut(x.note, 300) } : {}) })),
    budget: cite(d.budget),
    bonds: cite(d.bonds),
    siteVisit: cite(d.siteVisit),
    questionsDue: cite(d.questionsDue),
    period: cite(d.period),
    wageDeterminations: d.wageDeterminations.slice(0, LIMITS.cited).map((x) => cut(x, 200)),
    evaluation: cite(d.evaluation),
    sizes: d.sizes.slice(0, LIMITS.cited).map((c) => cite(c)!),
    requirements: d.requirements.slice(0, LIMITS.cited).map((c) => cite(c)!),
    forms: d.forms.slice(0, LIMITS.cited).map((x) => cut(x, 300)),
    priceForm: d.priceForm ? { doc: cut(d.priceForm.doc, 300), rows: d.priceForm.rows.slice(0, LIMITS.lines).map((x) => cut(x, 300)) } : null,
  };
}

/** Price lines from the breakdown's suggested ones, before anyone has priced them. */
export function linesFromBreakdown(b: Breakdown, idOf: (n: number) => string): BidLine[] {
  return b.suggestedLines.slice(0, LIMITS.lines).map((l, i) => ({ id: idOf(i + 1), description: cut(l.description, 300), unit: cut(l.unit, 40) || 'each', quantity: Math.max(0, Math.min(1e6, l.quantityPerPeriod || 1)), subCost: 0, price: 0 }));
}

const STOP = new Set(['and', 'the', 'for', 'of', 'to', 'a', 'an', 'in', 'at', 'on', 'services', 'service', 'with', 'by', 'or']);

/** What to ask USAspending for: the breakdown's search words (else the title's), the NAICS code and the state. */
export function pricingQueryFor(b: Pick<Bid, 'notice' | 'breakdown'>): PricingQuery {
  const words = b.breakdown?.subcontractorSearchTerms?.length
    ? b.breakdown.subcontractorSearchTerms.slice(0, 3)
    : b.notice.title
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2 && !STOP.has(w))
        .slice(0, 3);
  return { keywords: words, ...(b.notice.naicsCode ? { naics: b.notice.naicsCode } : {}), ...(b.notice.placeOfPerformance.state ? { state: b.notice.placeOfPerformance.state } : {}), yearsBack: 5, servicesOnly: b.notice.serviceKind !== 'product' };
}

const money = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const dayOf = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');

/**
 * The email asking a sub to price the work: what it is, where, when the price is needed (two days before the bid is
 * due), the lines to price, and the questions the breakdown says to ask. Nothing about the bid's own price or markup.
 */
export function quoteRequest(b: Bid, sub: Pick<BidSub, 'name'>, profile: Pick<BidProfile, 'companyName' | 'contactName' | 'phone'>, now: Date): { subject: string; body: string } {
  const due = b.notice.responseDeadline ? new Date(Math.max(now.getTime() + 86_400_000, new Date(b.notice.responseDeadline).getTime() - 2 * 86_400_000)) : null;
  const what = b.breakdown?.plainEnglish || b.notice.title;
  const lines = b.pricing.lines.length ? b.pricing.lines.map((l) => `- ${l.description}: ${l.quantity} per ${l.unit} each ${b.pricing.periodLabel === 'year' ? 'year' : 'job'}`) : [];
  const questions = (b.breakdown?.questionsForSubs ?? []).slice(0, 5).map((q) => `- ${q}`);
  const greeting = sub.name.replace(/\s*\(sample\)$/, '');
  const body = [
    `Hi ${greeting} team,`,
    '',
    `We’re bidding on “${b.notice.title}” for ${b.notice.agency}${placeText(b.notice) ? `, in ${placeText(b.notice)}` : ''}, and we’d like your price for the work.`,
    '',
    `What it is: ${what}`,
    ...(b.breakdown?.contractLength ? [`How long: ${b.breakdown.contractLength}`] : []),
    ...(lines.length ? ['', 'Please price:', ...lines] : []),
    ...(questions.length ? ['', 'A few questions:', ...questions] : []),
    '',
    due ? `Could you send your price by ${dayOf(due.toISOString())}?` : 'Could you send your price when you can?',
    '',
    'Thanks,',
    profile.contactName || profile.companyName,
    ...(profile.contactName ? [profile.companyName] : []),
    ...(profile.phone ? [profile.phone] : []),
  ];
  return { subject: `Quote request: ${b.notice.title}`, body: body.join('\n') };
}

/**
 * The proposal as a page to finish: what is known is filled in, and every blank is written [like this] so it is
 * seen before submitting. Nothing is invented: no licenses, no past performance, no figures that aren't the bid's.
 */
export function proposalBlocks(b: Bid, p: BidProfile, uid: (prefix: string) => string): Block[] {
  const t = bidTotals(b);
  const blank = (s: string | undefined, what: string) => (s && s.trim() ? s : `[${what}]`);
  const block = (x: Record<string, unknown>) => ({ id: uid('b'), ...x }) as unknown as Block;
  const out: Block[] = [
    block({ type: 'h1', text: `Proposal: ${b.notice.title}` }),
    block({ type: 'p', text: `Solicitation ${b.notice.solicitationNumber || '[solicitation number]'} · ${b.notice.agency}${b.notice.office ? `, ${b.notice.office}` : ''}` }),
    block({ type: 'callout', icon: '📝', text: 'Fill in every [bracketed] blank before submitting. Timmy doesn’t make up licenses, past performance or figures.' }),
    block({ type: 'h2', text: 'About us' }),
    block({ type: 'p', text: `${blank(p.companyName, 'company name')} · UEI ${blank(p.uei, 'UEI')} · CAGE ${blank(p.cage, 'CAGE code')}` }),
    block({ type: 'p', text: blank(p.capabilities, 'what your company does, in two or three sentences') }),
    block({ type: 'h2', text: 'Our understanding of the work' }),
    block({ type: 'p', text: b.breakdown?.plainEnglish || '[what the buyer needs, in your words]' }),
    block({ type: 'h2', text: 'How we will do it' }),
    block({ type: 'p', text: '[staffing, schedule, supervision and quality control]' }),
  ];
  const reqs = [...(b.breakdown?.keyRequirements ?? []), ...(b.details?.requirements ?? []).map((r) => String(r.value))].filter((x, i, a) => a.indexOf(x) === i).slice(0, 10);
  if (reqs.length) {
    out.push(block({ type: 'h2', text: 'Requirements we meet' }));
    for (const r of reqs) out.push(block({ type: 'bullet', text: `${r}: [how you meet it]` }));
  }
  out.push(block({ type: 'h2', text: 'Price' }));
  if (b.pricing.lines.length) {
    out.push(
      block({
        type: 'table',
        columns: ['Item', 'Unit', `Quantity per ${b.pricing.periodLabel === 'year' ? 'year' : 'job'}`, 'Unit price', 'Amount'],
        rows: b.pricing.lines.map((l) => [l.description, l.unit, String(l.quantity), l.price ? money(l.price) : '[unit price]', l.price ? money(lineTotal(l)) : '[amount]']),
      }),
    );
    out.push(block({ type: 'p', text: t.price ? `Total ${b.pricing.periodLabel === 'year' ? 'per year' : 'for the job'}: ${money(t.price)}${b.pricing.periods > 1 ? `; ${money(t.contractPrice)} over ${b.pricing.periods} ${b.pricing.periodLabel === 'year' ? 'years' : 'periods'}` : ''}.` : 'Total: [total price]' }));
  } else out.push(block({ type: 'p', text: '[the price schedule]' }));
  out.push(block({ type: 'h2', text: 'Past performance' }), block({ type: 'p', text: '[similar contracts you have done: buyer, value, dates, and a reference]' }));
  out.push(block({ type: 'h2', text: 'Point of contact' }), block({ type: 'p', text: `${blank(p.contactName, 'name')}${p.contactTitle ? `, ${p.contactTitle}` : ''} · ${blank(p.email, 'email')} · ${blank(p.phone, 'phone')}` }));
  return out;
}

/** Plain text for one cited fact's value. */
export function factText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('low' in o || 'high' in o) {
      const lo = typeof o.low === 'number' ? `$${o.low.toLocaleString('en-US')}` : '';
      const hi = typeof o.high === 'number' ? `$${o.high.toLocaleString('en-US')}` : '';
      const kind = o.kind === 'ceiling' ? 'not to exceed' : o.kind === 'magnitude' ? 'magnitude' : 'estimate';
      return `${lo && hi && lo !== hi ? `${lo} to ${hi}` : lo || hi} (${kind})`;
    }
    if ('date' in o) return `${o.date ?? 'Date not given'}${o.mandatory ? ', mandatory' : ', not mandatory'}`;
  }
  return String(v);
}
