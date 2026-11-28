/**
 * Bids: government and public contracts, with Kontract as the engine for the public data (notices, what their
 * documents say, past awards, local businesses) and the workspace keeping its own bids, prices, subs and proposals.
 * On a real workspace the screens ask the server (server/src/http/bids.ts); in the sample demo they use the sample
 * notices in src/data/bids-sample.ts, the same ones the server's stand-in engine answers with.
 */
import { ArrowLeft, Building2, CheckCircle2, ExternalLink, FilePlus2, FileText, Gavel, Landmark, Mail, MapPin, Plus, Search, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Frame } from '../../components/Frame';
import { EmptyState, Menu, SideHead } from '../../components/kit';
import { Folder } from '../../components/common';
import { NOW, PEOPLE } from '../../data/mock';
import { sampleBreakdown, sampleDetails, sampleOpportunities, samplePermitContractors, samplePricing, sampleSite, sampleSubs } from '../../data/bids-sample';
import type { BidDetails, Cited, FoundSub, Opportunity, PermitContractor } from '../../data/kontract-api';
import type { Bid, BidLine, BidProfile, BidStage, BidSub, Contact, WFile } from '../../data/ws-types';
import { api } from '../../live/api';
import { isLive } from '../../live/clock';
import { money } from '../../state/invoices';
import { bidTotals, byDeadline, daysLeft, defaultProfile, dueText, factText, levelText, lineTotal, linesFromBreakdown, placeText, priceFromMarkup, pricingQueryFor, proposalBlocks, quoteRequest, STAGE_LABEL, STAGES, SUB_STATUS, trimDetails } from '../../state/bids';
import { useStore, ws } from '../../state/store';
import { mailId, put, remove, uid } from '../../state/ws';
import { useBidsStatus } from './status';

type Tab = 'find' | 'mine' | 'company';
type BidTab = 'overview' | 'pricing' | 'subs' | 'proposal';

const usd = (dollars: number | null | undefined) => (typeof dollars === 'number' ? dollars.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) : '—');
const day = (iso: string | Date | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const now = () => (isLive() ? new Date() : new Date(NOW));
const STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');

/** The company's details for bids, or defaults made once per name, so the form isn't reset on every render. */
export function useBidProfile(): BidProfile {
  const { state } = useStore();
  const company = PEOPLE.me?.company || 'Your company';
  const email = PEOPLE.me?.email || undefined;
  const fallback = useMemo(() => defaultProfile(company, email), [company, email]);
  return state.ws.bidding?.profile ?? fallback;
}

function DueChip({ deadline }: { deadline: string | null | undefined }) {
  const d = daysLeft(deadline, now());
  const tone = d === null ? '' : d < 0 ? ' bd-closed' : d <= 7 ? ' bd-soon' : '';
  return <span className={`chip bd-due${tone}`}>{dueText(deadline, now())}</span>;
}

function StageChip({ stage }: { stage: BidStage }) {
  return <span className={`chip bd-stage bd-stage-${stage}`}>{STAGE_LABEL[stage]}</span>;
}

/** Tracks a notice: the server starts the bid with Kontract's copy; the demo does it here with the sample. */
function useTrack() {
  const { state, dispatch } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const track = async (o: Opportunity) => {
    const had = Object.values(state.ws.bids ?? {}).find((b) => b.notice.id === o.id);
    if (had) return dispatch({ type: 'navigate', route: { view: 'bid', id: had.id, tab: 'overview' } });
    if (!isLive()) return dispatch({ type: 'trackBid', id: uid('bid'), notice: o, task: uid('tsk') });
    setBusy(o.id);
    try {
      const r = await api.bidTrack(o.id);
      dispatch({ type: 'navigate', route: { view: 'bid', id: r.bid.id, tab: 'overview' } });
      dispatch({ type: 'toast', text: r.bid.created ? (o.responseDeadline ? 'Tracking this bid · its deadline is on your to-do list' : 'Tracking this bid') : 'You were already tracking this one' });
    } catch (e) {
      dispatch({ type: 'toast', text: (e as Error).message, tone: 'warn' });
    } finally {
      setBusy(null);
    }
  };
  return { track, busy };
}

/* ───────────── The section ───────────── */

export function BidsView() {
  const { state, dispatch } = useStore();
  const status = useBidsStatus();
  const r = state.route.view === 'bids' ? state.route : { view: 'bids' as const, tab: 'find' as Tab };
  const mine = Object.values(state.ws.bids ?? {});
  const tabs = [
    { id: 'find', label: 'Find' },
    { id: 'mine', label: 'My bids', count: mine.filter((b) => b.stage !== 'won' && b.stage !== 'lost').length },
    { id: 'company', label: 'Company' },
  ];
  return (
    <Frame tabs={tabs} active={r.tab} onTab={(t) => dispatch({ type: 'navigate', route: { view: 'bids', tab: t as Tab } })} scrollKey={r.tab}>
      {!status.on && status.known ? (
        <EmptyState icon={Landmark} title="Government bids aren’t switched on yet" body="Bids come from Kontract, which finds federal, state and local contracts. The people who run Timmy switch it on for this server." />
      ) : r.tab === 'mine' ? (
        <MyBids />
      ) : r.tab === 'company' ? (
        <CompanyForm />
      ) : (
        <FindBids />
      )}
    </Frame>
  );
}

function FindBids() {
  const { state } = useStore();
  const profile = useBidProfile();
  const { track, busy } = useTrack();
  const [q, setQ] = useState('');
  const [st, setSt] = useState(profile.states?.[0] ?? '');
  const [level, setLevel] = useState<'' | 'federal' | 'sled'>('');
  const [services, setServices] = useState(true);
  const [res, setRes] = useState<{ results: Opportunity[]; total: number; sample: boolean; asOf?: string } | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const tracked = new Map(Object.values(state.ws.bids ?? {}).map((b) => [b.notice.id, b.id]));

  const search = async () => {
    setErr('');
    setLoading(true);
    try {
      if (!isLive()) {
        const words = q.toLowerCase().split(/\s+/).filter(Boolean);
        const all = sampleOpportunities(now()).filter(
          (o) =>
            words.every((w) => `${o.title} ${o.agency} ${o.description}`.toLowerCase().includes(w)) &&
            (!st || o.placeOfPerformance.state === st) &&
            (!services || o.serviceKind !== 'product') &&
            (level === '' || (level === 'federal' ? (o.level ?? 'federal') === 'federal' : o.level !== 'federal')),
        );
        setRes({ results: all, total: all.length, sample: true });
      } else {
        const r = await api.bidSearch({ ...(q.trim() ? { q: q.trim() } : {}), ...(st ? { state: st } : {}), ...(level ? { level } : {}), ...(services ? { servicesOnly: '1' } : {}), limit: '25' });
        setRes({ results: r.results, total: r.total, sample: r.source === 'sample' || r.results.some((o) => o.isSample), asOf: r.dataAsOf });
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  // The first look lists what is open in the company's state.
  useEffect(() => {
    void search();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="bd-find">
      <div className="bd-head">
        <div>
          <h1 className="page-title">Find bids</h1>
          <p className="page-sub">Open federal notices from SAM.gov, and state and local bids. Track one to price it, line up subs and write the proposal.</p>
        </div>
      </div>
      <form
        className="card bd-search"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <label className="bd-search-q">
          <Search size={15} aria-hidden />
          <input className="input" aria-label="What work" placeholder="What work? e.g. janitorial, snow removal, HVAC" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <select className="input" aria-label="State" value={st} onChange={(e) => setSt(e.target.value)}>
          <option value="">Every state</option>
          {STATES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select className="input" aria-label="Level" value={level} onChange={(e) => setLevel(e.target.value as typeof level)}>
          <option value="">Federal, state and local</option>
          <option value="federal">Federal only</option>
          <option value="sled">State and local only</option>
        </select>
        <label className="bd-check">
          <input type="checkbox" checked={services} onChange={(e) => setServices(e.target.checked)} /> Services only
        </label>
        <button className="btn btn-primary" type="submit" disabled={loading}>
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>
      {err && (
        <p className="bd-error" role="alert">
          {err}
        </p>
      )}
      {res && (
        <p className="bd-count" role="status">
          {res.total === 0 ? 'Nothing open matches.' : `${res.total} open ${res.total === 1 ? 'notice' : 'notices'}${res.total > res.results.length ? `, showing ${res.results.length}` : ''}`}
          {res.sample && ' · Sample notices, not real ones'}
          {res.asOf && !res.sample && ` · SAM.gov as of ${day(res.asOf)}`}
        </p>
      )}
      <ul className="bd-results" aria-label="Open notices">
        {res?.results.map((o) => (
          <li key={o.id} className="card bd-result">
            <div className="bd-result-main">
              <strong className="bd-result-title">{o.title}</strong>
              <span className="bd-result-sub">
                {o.agency}
                {o.office ? ` · ${o.office}` : ''}
              </span>
              <span className="bd-chips">
                <span className="chip plain">{levelText(o)}</span>
                {o.setAside && <span className="chip plain">{o.setAside.replace(/\s*\(FAR [^)]*\)/, '')}</span>}
                {o.naicsCode && <span className="chip plain">NAICS {o.naicsCode}</span>}
                {placeText(o) && (
                  <span className="chip plain">
                    <MapPin size={12} aria-hidden /> {placeText(o)}
                  </span>
                )}
                {o.isSample && <span className="chip accent">Sample</span>}
              </span>
            </div>
            <div className="bd-result-side">
              <DueChip deadline={o.responseDeadline} />
              <button className={`btn btn-sm${tracked.has(o.id) ? '' : ' btn-primary'}`} disabled={busy === o.id} onClick={() => void track(o)}>
                {tracked.has(o.id) ? 'Open bid' : busy === o.id ? 'Tracking…' : 'Track'}
              </button>
              {o.samUrl && (
                <a className="btn btn-sm btn-ghost" href={o.samUrl} target="_blank" rel="noreferrer noopener">
                  <ExternalLink size={13} /> {o.level && o.level !== 'federal' ? o.portal || 'Portal' : 'SAM.gov'}
                </a>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MyBids() {
  const { state, dispatch } = useStore();
  const [filter, setFilter] = useState<'all' | BidStage>('all');
  const all = Object.values(state.ws.bids ?? {}).sort(byDeadline);
  const rows = filter === 'all' ? all : all.filter((b) => b.stage === filter);
  const open = all.filter((b) => b.stage !== 'won' && b.stage !== 'lost');
  const week = open.filter((b) => {
    const d = daysLeft(b.notice.responseDeadline, now());
    return d !== null && d >= 0 && d <= 7;
  });
  const won = all.filter((b) => b.stage === 'won');
  const cards = [
    { label: 'Open bids', value: String(open.length), sub: `${open.filter((b) => b.stage === 'submitted').length} submitted, waiting` },
    { label: 'Due this week', value: String(week.length), sub: week.length ? week.map((b) => b.notice.title.split(',')[0]).slice(0, 2).join(', ') : 'nothing due', warn: week.length > 0 },
    { label: 'In the pipeline', value: usd(open.reduce((n, b) => n + bidTotals(b).contractPrice, 0) / 100), sub: 'priced, over each contract' },
    { label: 'Won', value: usd(won.reduce((n, b) => n + bidTotals(b).contractPrice, 0) / 100), sub: `${won.length} won` },
  ];
  return (
    <section className="bd-mine">
      <div className="bd-head">
        <div>
          <h1 className="page-title">My bids</h1>
          <p className="page-sub">Everything you’re bidding on, by deadline.</p>
        </div>
        <button className="btn btn-primary" onClick={() => dispatch({ type: 'navigate', route: { view: 'bids', tab: 'find' } })}>
          <Search size={15} /> Find bids
        </button>
      </div>
      <div className="inv-cards">
        {cards.map((c) => (
          <div key={c.label} className={`card inv-card${c.warn ? ' warn' : ''}`}>
            <span className="inv-card-label">{c.label}</span>
            <strong className="inv-card-value">{c.value}</strong>
            <span className="inv-card-sub">{c.sub}</span>
          </div>
        ))}
      </div>
      <div className="inv-filters" role="group" aria-label="Show">
        <button className="filter" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
          All
        </button>
        {STAGES.map((s) => (
          <button key={s.id} className="filter" aria-pressed={filter === s.id} onClick={() => setFilter(s.id)}>
            {s.label} {all.filter((b) => b.stage === s.id).length || ''}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={Gavel} title={all.length ? 'No bids here' : 'No bids yet'} body={all.length ? 'Pick another stage.' : 'Find an open notice and track it to start a bid.'} />
      ) : (
        <div className="table bd-table" role="table" aria-label="Bids">
          <div className="table-row table-head" role="row">
            <span>Notice</span>
            <span>Stage</span>
            <span>Deadline</span>
            <span>Subs</span>
            <span className="inv-num">Contract price</span>
          </div>
          {rows.map((b) => {
            const t = bidTotals(b);
            return (
              <button key={b.id} role="row" className="table-row bd-row" onClick={() => dispatch({ type: 'navigate', route: { view: 'bid', id: b.id, tab: 'overview' } })}>
                <span className="inv-client">
                  <span>{b.notice.title}</span>
                  <span className="inv-sub">{b.notice.agency}</span>
                </span>
                <span>
                  <StageChip stage={b.stage} />
                </span>
                <span>
                  <DueChip deadline={b.notice.responseDeadline} />
                </span>
                <span>{b.subs.length ? `${b.subs.filter((s) => s.status === 'quoted' || s.status === 'selected').length} of ${b.subs.length} quoted` : '—'}</span>
                <span className="inv-num">{t.contractPrice ? money(t.contractPrice, 'USD') : '—'}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function CompanyForm() {
  const { dispatch } = useStore();
  const current = useBidProfile();
  const [p, setP] = useState(current);
  useEffect(() => setP(current), [current]);
  const set = (x: Partial<BidProfile>) => setP({ ...p, ...x });
  const field = (key: 'companyName' | 'uei' | 'cage' | 'contactName' | 'contactTitle' | 'email' | 'phone' | 'website', label: string, hint?: string) => (
    <label className="field">
      <span className="field-label">{label}</span>
      <input className="input" value={(p[key] as string | undefined) ?? ''} onChange={(e) => set({ [key]: e.target.value })} />
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
  const list = (v: string, re: RegExp) =>
    v
      .split(/[\s,]+/)
      .map((x) => x.trim().toUpperCase())
      .filter((x) => re.test(x));
  return (
    <section className="inv-details">
      <h1 className="page-title">Company</h1>
      <p className="page-sub">What buyers see about you: it goes on proposals and quote requests. Blanks stay [bracketed] in a proposal until you fill them in.</p>
      <div className="card inv-form">
        {field('companyName', 'Company name')}
        <div className="inv-form-row">
          {field('uei', 'UEI', 'Your SAM.gov Unique Entity ID.')}
          {field('cage', 'CAGE code')}
        </div>
        <label className="field">
          <span className="field-label">Address</span>
          <textarea className="input" rows={2} value={p.address ?? ''} onChange={(e) => set({ address: e.target.value })} />
        </label>
        <div className="inv-form-row">
          {field('contactName', 'Point of contact')}
          {field('contactTitle', 'Their title')}
        </div>
        <div className="inv-form-row">
          {field('email', 'Email')}
          {field('phone', 'Phone')}
        </div>
        {field('website', 'Website')}
        <label className="field">
          <span className="field-label">What you do</span>
          <textarea className="input" rows={3} value={p.capabilities ?? ''} placeholder="Two or three sentences for the start of a proposal." onChange={(e) => set({ capabilities: e.target.value })} />
        </label>
        <div className="inv-form-row">
          <label className="field">
            <span className="field-label">NAICS codes</span>
            <input className="input" defaultValue={(p.naics ?? []).join(', ')} onBlur={(e) => set({ naics: list(e.target.value, /^\d{2,6}$/) })} />
            <span className="field-hint">Separated by commas, e.g. 561720, 561730.</span>
          </label>
          <label className="field">
            <span className="field-label">States you work in</span>
            <input className="input" defaultValue={(p.states ?? []).join(', ')} onBlur={(e) => set({ states: list(e.target.value, /^[A-Z]{2}$/) })} />
            <span className="field-hint">Two-letter codes; the first is where Find starts.</span>
          </label>
          <label className="field">
            <span className="field-label">Usual markup (%)</span>
            <input className="input" type="number" min={0} max={1000} value={p.defaultMarkupPct} onChange={(e) => set({ defaultMarkupPct: Math.max(0, Math.min(1000, Number(e.target.value) || 0)) })} />
          </label>
        </div>
        <div>
          <button className="btn btn-primary" onClick={() => dispatch(ws([put('bidding', p)], { toast: 'Company details saved', undo: true }))}>
            Save details
          </button>
        </div>
      </div>
    </section>
  );
}

/* ───────────── One bid ───────────── */

export function BidView() {
  const { state, dispatch } = useStore();
  const r = state.route.view === 'bid' ? state.route : null;
  const bid = r ? state.ws.bids?.[r.id] : undefined;
  if (!r || !bid) {
    return (
      <Frame tabs={[{ id: 'overview', label: 'Bid' }]} active="overview" onTab={() => undefined}>
        <EmptyState
          icon={Gavel}
          title="That bid isn’t here"
          action={
            <button className="btn btn-sm" onClick={() => dispatch({ type: 'navigate', route: { view: 'bids', tab: 'mine' } })}>
              Back to my bids
            </button>
          }
        />
      </Frame>
    );
  }
  const tab = r.tab;
  const go = (t: BidTab) => dispatch({ type: 'navigate', route: { view: 'bid', id: bid.id, tab: t } });
  const save = (next: Bid, toast?: string) => dispatch(ws([put('bids', { ...next, updated: now() })], toast ? { toast, undo: true } : {}));
  const n = bid.notice;
  return (
    <Frame
      tabs={[
        { id: 'overview', label: 'Overview' },
        { id: 'pricing', label: 'Pricing' },
        { id: 'subs', label: 'Subs', count: bid.subs.length },
        { id: 'proposal', label: 'Proposal' },
      ]}
      active={tab}
      onTab={(t) => go(t as BidTab)}
      scrollKey={`${bid.id}-${tab}`}
    >
      <div className="bd-bar">
        <button className="btn btn-sm btn-ghost" onClick={() => dispatch({ type: 'back' })}>
          <ArrowLeft size={14} /> Back
        </button>
        <span className="inv-bar-gap" />
        <label className="bd-stage-pick">
          <span className="muted">Stage</span>
          <select
            className="input"
            aria-label="Stage"
            value={bid.stage}
            onChange={(e) => {
              const stage = e.target.value as BidStage;
              save({ ...bid, stage, ...(stage === 'submitted' && !bid.submittedAt ? { submittedAt: now() } : {}), ...((stage === 'won' || stage === 'lost') && !bid.decidedAt ? { decidedAt: now() } : {}) }, `Moved to ${STAGE_LABEL[stage]}`);
            }}
          >
            {STAGES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="bd-stage-pick">
          <Folder color={(bid.project && state.ws.projects[bid.project]?.color) || 'var(--text-3)'} size={14} />
          <select className="input" aria-label="Project" value={bid.project ?? ''} onChange={(e) => save({ ...bid, project: e.target.value || undefined })}>
            <option value="">No project</option>
            {Object.values(state.ws.projects)
              .filter((p) => p.status !== 'archived' || p.id === bid.project)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  [{p.num}] {p.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      <header className="bd-title">
        <h1 className="page-title">{n.title}</h1>
        <p className="bd-result-sub">
          {n.agency}
          {n.office ? ` · ${n.office}` : ''}
          {n.solicitationNumber ? ` · ${n.solicitationNumber}` : ''}
        </p>
        <span className="bd-chips">
          <StageChip stage={bid.stage} />
          <DueChip deadline={n.responseDeadline} />
          <span className="chip plain">{levelText(n)}</span>
          {n.setAside && <span className="chip plain">{n.setAside.replace(/\s*\(FAR [^)]*\)/, '')}</span>}
          {n.naicsCode && <span className="chip plain">NAICS {n.naicsCode}</span>}
          {placeText(n) && (
            <span className="chip plain">
              <MapPin size={12} aria-hidden /> {placeText(n)}
            </span>
          )}
          {n.isSample && <span className="chip accent">Sample</span>}
          {n.samUrl && (
            <a className="link-btn" href={n.samUrl} target="_blank" rel="noreferrer noopener">
              <ExternalLink size={12} aria-hidden /> Open the notice
            </a>
          )}
        </span>
      </header>
      {tab === 'overview' && <Overview bid={bid} save={save} />}
      {tab === 'pricing' && <Pricing bid={bid} save={save} />}
      {tab === 'subs' && <Subs bid={bid} save={save} />}
      {tab === 'proposal' && <Proposal bid={bid} save={save} />}
    </Frame>
  );
}

type Save = (next: Bid, toast?: string) => void;

function Section({ title, sub, action, children }: { title: string; sub?: ReactNode; action?: ReactNode; children?: ReactNode }) {
  return (
    <section className="card bd-section">
      <div className="bd-section-head">
        <div>
          <h2 className="section-title">{title}</h2>
          {sub && <p className="section-sub">{sub}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A fact from the documents, with the words it came from and which document. */
function Fact({ label, c }: { label: string; c: Cited<unknown> | null | undefined }) {
  if (!c) return null;
  return (
    <div className="bd-fact">
      <span className="inv-label">{label}</span>
      <strong>{factText(c.value)}</strong>
      <q className="bd-quote">{c.quote}</q>
      <span className="bd-doc">
        <FileText size={12} aria-hidden /> {c.doc}
      </span>
    </div>
  );
}

function Overview({ bid, save }: { bid: Bid; save: Save }) {
  const { dispatch } = useStore();
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const d = bid.details;
  const b = bid.breakdown;
  const read = async () => {
    setBusy(true);
    try {
      if (isLive()) {
        const r = await api.bidRead(bid.id);
        dispatch({ type: 'toast', text: `Read ${r.read.documents} document${r.read.documents === 1 ? '' : 's'} · ${r.read.facts} fact${r.read.facts === 1 ? '' : 's'} found` });
      } else {
        const breakdown = sampleBreakdown(bid.notice.id, now());
        const details: BidDetails = trimDetails(sampleDetails(bid.notice.id, now()));
        const lines = bid.pricing.lines.length ? bid.pricing.lines : linesFromBreakdown(breakdown, (i) => `${bid.id}-l${i}`);
        const periods = !bid.pricing.lines.length && breakdown.periods && breakdown.periods > 1 ? breakdown.periods : bid.pricing.periods;
        save({ ...bid, details, breakdown, pricing: { ...bid.pricing, lines, periods, periodLabel: periods > 1 ? 'year' : bid.pricing.periodLabel } }, `Read ${details.documents.length} documents`);
      }
    } catch (e) {
      dispatch({ type: 'toast', text: (e as Error).message, tone: 'warn' });
    } finally {
      setBusy(false);
    }
  };
  const desc = bid.notice.description ?? '';
  return (
    <div className="bd-overview">
      {desc && (
        <Section title="The notice">
          <p className="bd-desc">{all || desc.length <= 900 ? desc : `${desc.slice(0, 900)}…`}</p>
          {desc.length > 900 && (
            <button className="link-btn" onClick={() => setAll(!all)}>
              {all ? 'Show less' : 'Show all of it'}
            </button>
          )}
        </Section>
      )}
      <Section
        title="What the documents say"
        sub={d ? `Read ${day(d.readAt)} from ${d.documents.length} document${d.documents.length === 1 ? '' : 's'}. Each fact shows the words it came from.` : 'Kontract reads the statement of work, the solicitation and the forms, and finds the budget, dates, requirements and what to send back.'}
        action={
          <button className={`btn btn-sm${d ? '' : ' btn-primary'}`} onClick={() => void read()} disabled={busy}>
            {busy ? 'Reading…' : d ? 'Read again' : 'Read the documents'}
          </button>
        }
      >
        {d && (
          <>
            <div className="bd-facts">
              <Fact label="Budget" c={d.budget} />
              <Fact label="How long" c={d.period} />
              <Fact label="Site visit" c={d.siteVisit} />
              <Fact label="Questions due" c={d.questionsDue} />
              <Fact label="How it’s judged" c={d.evaluation} />
              <Fact label="Bonds" c={d.bonds} />
            </div>
            {d.requirements.length > 0 && (
              <>
                <h3 className="bd-h3">Requirements</h3>
                <ul className="bd-list">
                  {d.requirements.map((r, i) => (
                    <li key={i}>
                      <strong>{factText(r.value)}</strong> <q className="bd-quote">{r.quote}</q> <span className="bd-doc">{r.doc}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {d.forms.length > 0 && (
              <>
                <h3 className="bd-h3">To fill in and send back</h3>
                <ul className="bd-list">
                  {d.forms.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </>
            )}
            {d.wageDeterminations.length > 0 && <p className="bd-note">Wage determination: {d.wageDeterminations.join(', ')}. Pay at least these rates.</p>}
            <h3 className="bd-h3">Documents</h3>
            <ul className="bd-docs" aria-label="Documents">
              {d.documents.map((x) => (
                <li key={x.id}>
                  <FileText size={14} aria-hidden /> {x.url ? <a href={x.url} target="_blank" rel="noreferrer noopener">{x.name}</a> : x.name}
                  <span className={`chip plain bd-read-${x.read}`}>{x.read === 'read' ? 'Read' : x.read === 'scanned' ? 'A scan: not readable' : x.read === 'failed' ? 'Couldn’t be read' : 'Skipped'}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>
      {b && (
        <Section title="In plain English" sub={b.source === 'claude' ? 'Read by Claude, through Kontract.' : 'From Kontract’s rules.'}>
          <p className="bd-plain">{b.plainEnglish}</p>
          <dl className="bd-dl">
            <dt>Who does the work</dt>
            <dd>{b.whoDoesTheWork}</dd>
            <dt>How it’s priced</dt>
            <dd>{b.pricingStructure}</dd>
            <dt>How long</dt>
            <dd>{b.contractLength}</dd>
            <dt>Difficulty</dt>
            <dd className="cap">{b.difficulty}</dd>
          </dl>
          {b.keyRequirements.length > 0 && (
            <>
              <h3 className="bd-h3">Key requirements</h3>
              <ul className="bd-list">{b.keyRequirements.map((x) => <li key={x}>{x}</li>)}</ul>
            </>
          )}
          {b.redFlags.length > 0 && (
            <>
              <h3 className="bd-h3">Watch out for</h3>
              <ul className="bd-list bd-flags">{b.redFlags.map((x) => <li key={x}>{x}</li>)}</ul>
            </>
          )}
        </Section>
      )}
    </div>
  );
}

function CentsInput({ cents, label, onChange }: { cents: number; label: string; onChange: (c: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      className="input inv-money"
      inputMode="decimal"
      aria-label={label}
      value={text ?? (cents ? (cents / 100).toFixed(2) : '')}
      placeholder="$0.00"
      onFocus={() => setText(cents ? (cents / 100).toFixed(2) : '')}
      onChange={(e) => {
        setText(e.target.value);
        const v = e.target.value.replace(/[$,\s]/g, '');
        if (/^\d{0,9}(\.\d{0,2})?$/.test(v)) onChange(Math.round(Number(v || 0) * 100));
      }}
      onBlur={() => setText(null)}
    />
  );
}

function Pricing({ bid, save }: { bid: Bid; save: Save }) {
  const { dispatch } = useStore();
  const [busy, setBusy] = useState(false);
  const p = bid.pricing;
  const t = bidTotals(bid);
  const past = bid.pastPricing;
  const per = p.periodLabel === 'year' ? 'year' : 'job';
  const setLines = (lines: BidLine[]) => save({ ...bid, pricing: { ...p, lines } });
  const setLine = (id: string, x: Partial<BidLine>) => setLines(p.lines.map((l) => (l.id === id ? { ...l, ...x } : l)));
  const lookUp = async () => {
    setBusy(true);
    try {
      if (isLive()) {
        const r = await api.bidPricing(bid.id);
        dispatch({ type: 'toast', text: r.pricing.awards ? `Found ${r.pricing.awards} past awards like it` : 'No past awards like it were found' });
      } else {
        const query = pricingQueryFor(bid);
        const r = samplePricing(query.keywords);
        save({ ...bid, pastPricing: { at: now(), query, stats: r.stats, awards: r.awards, recipients: r.recipients } }, `Found ${r.awards.length} past awards like it`);
      }
    } catch (e) {
      dispatch({ type: 'toast', text: (e as Error).message, tone: 'warn' });
    } finally {
      setBusy(false);
    }
  };
  // How the price per year compares with what similar contracts went for.
  const vsPast = past?.stats.medianAnnual && t.price && p.periodLabel === 'year' ? Math.round(((t.price / 100 - past.stats.medianAnnual) / past.stats.medianAnnual) * 100) : null;
  return (
    <div className="bd-pricing">
      <Section
        title="What similar contracts went for"
        sub={past ? `${past.stats.count} past federal awards for ${past.query.keywords.join(', ')}${past.query.state ? ` in ${past.query.state}` : ''}, from USAspending.gov.` : 'Past federal awards for the same kind of work, from USAspending.gov.'}
        action={
          <button className={`btn btn-sm${past ? '' : ' btn-primary'}`} disabled={busy} onClick={() => void lookUp()}>
            {busy ? 'Looking…' : past ? 'Look again' : 'Look up past awards'}
          </button>
        }
      >
        {past && past.stats.count > 0 && (
          <>
            <div className="inv-cards">
              <div className="card inv-card">
                <span className="inv-card-label">Typical per year</span>
                <strong className="inv-card-value">{usd(past.stats.medianAnnual)}</strong>
                <span className="inv-card-sub">
                  {usd(past.stats.lowAnnual)} to {usd(past.stats.highAnnual)}
                </span>
              </div>
              <div className="card inv-card">
                <span className="inv-card-label">Typical total</span>
                <strong className="inv-card-value">{usd(past.stats.medianTotal)}</strong>
                <span className="inv-card-sub">
                  {usd(past.stats.lowTotal)} to {usd(past.stats.highTotal)}
                </span>
              </div>
            </div>
            <div className="table bd-awards" role="table" aria-label="Past awards">
              <div className="table-row table-head" role="row">
                <span>Who won it</span>
                <span>Buyer</span>
                <span>From</span>
                <span className="inv-num">Per year</span>
                <span className="inv-num">Total</span>
              </div>
              {past.awards.map((a) => (
                <div key={a.id} role="row" className="table-row">
                  <span>{a.recipient}</span>
                  <span>{a.subAgency || a.agency}</span>
                  <span>{a.startDate ? new Date(a.startDate).getUTCFullYear() : '—'}</span>
                  <span className="inv-num">{usd(a.annualAmount)}</span>
                  <span className="inv-num">{usd(a.amount)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </Section>
      <Section
        title="Your price"
        sub="What each sub charges you, your markup, and what you charge the buyer. Whole cents; the buyer never sees your costs."
        action={
          <div className="bd-inline">
            <label className="bd-inline">
              <span className="muted">Markup %</span>
              <input className="input bd-narrow" type="number" min={0} max={1000} aria-label="Markup percent" value={p.markupPct} onChange={(e) => save({ ...bid, pricing: { ...p, markupPct: Math.max(0, Math.min(1000, Number(e.target.value) || 0)) } })} />
            </label>
            <button className="btn btn-sm" onClick={() => save({ ...bid, pricing: { ...p, lines: p.lines.map((l) => ({ ...l, price: priceFromMarkup(l.subCost, p.markupPct) })) } }, `Prices set at ${p.markupPct}% over cost`)}>
              Price at markup
            </button>
          </div>
        }
      >
        <div className="bd-inline bd-periods">
          <label className="bd-inline">
            <span className="muted">Runs for</span>
            <input className="input bd-narrow" type="number" min={1} max={50} aria-label="Periods" value={p.periods} onChange={(e) => save({ ...bid, pricing: { ...p, periods: Math.max(1, Math.min(50, Math.round(Number(e.target.value) || 1))) } })} />
          </label>
          <select className="input" aria-label="Period" value={p.periodLabel} onChange={(e) => save({ ...bid, pricing: { ...p, periodLabel: e.target.value as 'year' | 'contract' } })}>
            <option value="year">years (base and options)</option>
            <option value="contract">one-off job</option>
          </select>
        </div>
        <div className="bd-lines" role="table" aria-label="Price lines">
          <div className="bd-line bd-line-head" role="row">
            <span>Item</span>
            <span>Unit</span>
            <span className="inv-num">Per {per}</span>
            <span className="inv-num">Sub cost</span>
            <span className="inv-num">Your price</span>
            <span className="inv-num">Amount</span>
            <span />
          </div>
          {p.lines.map((l, i) => (
            <div key={l.id} className="bd-line" role="row">
              <input className="input" aria-label={`Line ${i + 1} item`} value={l.description} onChange={(e) => setLine(l.id, { description: e.target.value })} />
              <input className="input" aria-label={`Line ${i + 1} unit`} value={l.unit} onChange={(e) => setLine(l.id, { unit: e.target.value.slice(0, 40) })} />
              <input className="input" type="number" min={0} step="any" aria-label={`Line ${i + 1} quantity`} value={l.quantity} onChange={(e) => setLine(l.id, { quantity: Math.max(0, Number(e.target.value) || 0) })} />
              <CentsInput cents={l.subCost} label={`Line ${i + 1} sub cost`} onChange={(c) => setLine(l.id, { subCost: c })} />
              <CentsInput cents={l.price} label={`Line ${i + 1} price`} onChange={(c) => setLine(l.id, { price: c })} />
              <span className="inv-num bd-amount">{money(lineTotal(l), 'USD')}</span>
              <Menu label={`Line ${i + 1} actions`} items={[{ label: 'Remove line', icon: Trash2, danger: true, onSelect: () => setLines(p.lines.filter((x) => x.id !== l.id)) }]} />
            </div>
          ))}
          <button className="btn btn-sm btn-ghost inv-add" onClick={() => setLines([...p.lines, { id: uid('bl'), description: '', unit: 'each', quantity: 1, subCost: 0, price: 0 }])}>
            <Plus size={14} /> Add a line
          </button>
        </div>
        <div className="inv-totals bd-totals" aria-label="Totals">
          <div className="inv-total-row">
            <span>Sub cost per {per}</span>
            <span>{money(t.cost, 'USD')}</span>
          </div>
          <div className="inv-total-row">
            <span>Your profit per {per}</span>
            <span>
              {money(t.profit, 'USD')} {t.price ? `(${Math.round(t.margin * 100)}% margin)` : ''}
            </span>
          </div>
          <div className="inv-total-row inv-grand">
            <span>Price per {per}</span>
            <span>{money(t.price, 'USD')}</span>
          </div>
          {p.periods > 1 && (
            <div className="inv-total-row">
              <span>Over {p.periods} {p.periodLabel === 'year' ? 'years' : 'periods'}</span>
              <span>{money(t.contractPrice, 'USD')}</span>
            </div>
          )}
          {vsPast !== null && (
            <p className={`bd-vs${Math.abs(vsPast) > 25 ? ' warn' : ''}`} role="status">
              {vsPast === 0 ? 'Right at the typical award per year.' : `${Math.abs(vsPast)}% ${vsPast < 0 ? 'below' : 'above'} the typical award per year (${usd(past?.stats.medianAnnual)}).`}
            </p>
          )}
        </div>
      </Section>
    </div>
  );
}

function Subs({ bid, save }: { bid: Bid; save: Save }) {
  const { state, dispatch } = useStore();
  const profile = useBidProfile();
  const [q, setQ] = useState(bid.breakdown?.subcontractorSearchTerms?.[0] ?? bid.notice.title.split(',')[0]!.toLowerCase());
  const [where, setWhere] = useState(placeText(bid.notice));
  const [found, setFound] = useState<{ results: FoundSub[]; notice?: string } | null>(null);
  const [near, setNear] = useState<PermitContractor[] | null>(null);
  const [busy, setBusy] = useState('');
  const [manual, setManual] = useState({ name: '', email: '' });
  const on = new Set(bid.subs.map((s) => s.name.toLowerCase()));
  const setSub = (id: string, x: Partial<BidSub>) => save({ ...bid, subs: bid.subs.map((s) => (s.id === id ? { ...s, ...x } : s)) });
  const add = (s: Omit<BidSub, 'id' | 'status'>) => {
    if (on.has(s.name.toLowerCase())) return;
    save({ ...bid, stage: bid.stage === 'found' ? 'sourcing' : bid.stage, subs: [...bid.subs, { id: uid('bs'), status: 'new', ...s }] }, `Added ${s.name} to this bid`);
  };
  const warn = (e: unknown) => dispatch({ type: 'toast', text: (e as Error).message, tone: 'warn' });

  const search = async () => {
    setBusy('search');
    try {
      setFound(isLive() ? await api.bidSubSearch(bid.id, q, where) : { results: sampleSubs(q, where), notice: 'Sample businesses, not real ones.' });
    } catch (e) {
      warn(e);
    } finally {
      setBusy('');
    }
  };
  useEffect(() => {
    let alive = true;
    (isLive() ? api.bidSubsNearby(bid.id).then((r) => r.contractors) : Promise.resolve(bid.notice.placeOfPerformance.state ? samplePermitContractors(bid.notice.placeOfPerformance.state, bid.notice.placeOfPerformance.city) : []))
      .then((c) => alive && setNear(c))
      .catch(() => alive && setNear([]));
    return () => {
      alive = false;
    };
  }, [bid.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const findEmail = async (s: BidSub) => {
    if (!s.website) return;
    setBusy(s.id);
    try {
      const facts = isLive() ? (await api.bidWebsite(s.website)).facts : sampleSite(s.website, now());
      const email = facts.emails[0];
      setSub(s.id, { ...(email ? { email } : {}), ...(facts.licenses[0] && !s.license ? { license: facts.licenses[0] } : {}) });
      dispatch({ type: 'toast', text: email ? `Found ${email} on their website` : 'Their website shows no email address' });
    } catch (e) {
      warn(e);
    } finally {
      setBusy('');
    }
  };

  const askQuote = (s: BidSub) => {
    const mail = quoteRequest(bid, s, profile, now());
    const to = s.contact && state.ws.contacts[s.contact] ? s.contact : s.email ? mailId(s.email) : '';
    dispatch({
      type: 'compose',
      draft: {
        to: to ? [to] : [],
        subject: mail.subject,
        body: mail.body,
        bidSub: { bid: bid.id, sub: s.id },
        ...(bid.project ? { project: bid.project } : {}),
        ...(to ? { track: { on: to, item: `A price for ${bid.notice.title.slice(0, 80)}` } } : {}),
      },
    });
  };

  const saveContact = (s: BidSub) => {
    if (!s.email) return;
    const id = uid('c');
    const contact: Contact = { id, name: s.name, email: s.email, ...(s.phone ? { phone: s.phone } : {}), company: s.name, about: `Subcontractor${s.category ? `: ${s.category}` : ''}. Added from the bid “${bid.notice.title.slice(0, 100)}”.` };
    dispatch(ws([put('contacts', contact), put('bids', { ...bid, updated: now(), subs: bid.subs.map((x) => (x.id === s.id ? { ...x, contact: id } : x)) })], { toast: `Saved ${s.name} to People`, undo: true }));
  };

  return (
    <div className="bd-subs">
      <Section title="Subs on this bid" sub="Ask each for a price; their quote goes on the bid. A quote request never shows your own price or markup.">
        {bid.subs.length === 0 ? (
          <p className="muted">No subs yet. Find local businesses below, or add one you know.</p>
        ) : (
          <ul className="bd-sublist" aria-label="Subs on this bid">
            {bid.subs.map((s) => (
              <li key={s.id} className="bd-sub">
                <div className="bd-sub-main">
                  <strong>{s.name}</strong>
                  <span className="bd-result-sub">
                    {[s.phone, s.email, s.rating ? `★ ${s.rating}${s.reviewCount ? ` (${s.reviewCount})` : ''}` : '', s.license].filter(Boolean).join(' · ') || 'No contact details yet'}
                  </span>
                  {s.website && (
                    <a className="link-btn" href={s.website} target="_blank" rel="noreferrer noopener">
                      <ExternalLink size={12} aria-hidden /> Website
                    </a>
                  )}
                </div>
                <div className="bd-sub-side">
                  <select className="input" aria-label={`${s.name} status`} value={s.status} onChange={(e) => setSub(s.id, { status: e.target.value as BidSub['status'] })}>
                    {Object.entries(SUB_STATUS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                  <CentsInput cents={s.quote ?? 0} label={`${s.name} quote per ${bid.pricing.periodLabel === 'year' ? 'year' : 'job'}`} onChange={(c) => setSub(s.id, { quote: c || undefined, ...(c && (s.status === 'new' || s.status === 'asked') ? { status: 'quoted' } : {}) })} />
                  <button className="btn btn-sm" onClick={() => askQuote(s)}>
                    <Mail size={13} /> Ask for a quote
                  </button>
                  <Menu
                    label={`More for ${s.name}`}
                    items={[
                      ...(s.website && !s.email ? [{ label: busy === s.id ? 'Reading their website…' : 'Find their email on their website', icon: Search, onSelect: () => void findEmail(s) }] : []),
                      ...(s.email && !s.contact ? [{ label: 'Save to People', icon: UserPlus, onSelect: () => saveContact(s) }] : []),
                      ...(s.thread ? [{ label: 'Open the email', icon: Mail, onSelect: () => dispatch({ type: 'openThread', id: s.thread! }) }] : []),
                      { label: 'Remove from this bid', icon: Trash2, danger: true, onSelect: () => save({ ...bid, subs: bid.subs.filter((x) => x.id !== s.id) }, `Removed ${s.name}`) },
                    ]}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
        <form
          className="bd-inline bd-manual"
          onSubmit={(e) => {
            e.preventDefault();
            if (!manual.name.trim()) return;
            add({ name: manual.name.trim(), ...(manual.email.trim() ? { email: manual.email.trim() } : {}), source: 'manual' });
            setManual({ name: '', email: '' });
          }}
        >
          <input className="input" aria-label="Sub’s name" placeholder="Add one you know: name" value={manual.name} onChange={(e) => setManual({ ...manual, name: e.target.value })} />
          <input className="input" aria-label="Sub’s email" placeholder="Email (optional)" value={manual.email} onChange={(e) => setManual({ ...manual, email: e.target.value })} />
          <button className="btn btn-sm" type="submit" disabled={!manual.name.trim()}>
            <Plus size={13} /> Add
          </button>
        </form>
      </Section>
      <Section title="Find local businesses" sub="From a business search, through Kontract. Each search costs a little and counts toward the monthly limit.">
        <form
          className="bd-inline"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <input className="input" aria-label="Kind of business" value={q} onChange={(e) => setQ(e.target.value)} />
          <input className="input" aria-label="Where" value={where} onChange={(e) => setWhere(e.target.value)} />
          <button className="btn btn-sm btn-primary" type="submit" disabled={busy === 'search' || !q.trim() || !where.trim()}>
            {busy === 'search' ? 'Searching…' : 'Search'}
          </button>
        </form>
        {found?.notice && <p className="bd-note">{found.notice}</p>}
        {found && (
          <ul className="bd-sublist" aria-label="Businesses found">
            {found.results.map((f) => (
              <li key={f.name} className="bd-sub">
                <div className="bd-sub-main">
                  <strong>{f.name}</strong>
                  <span className="bd-result-sub">{[f.phone, f.address, f.rating ? `★ ${f.rating}${f.reviewCount ? ` (${f.reviewCount})` : ''}` : ''].filter(Boolean).join(' · ')}</span>
                </div>
                <button className="btn btn-sm" disabled={on.has(f.name.toLowerCase())} onClick={() => add({ name: f.name, ...(f.phone ? { phone: f.phone } : {}), ...(f.email ? { email: f.email } : {}), ...(f.website ? { website: f.website } : {}), ...(f.address ? { address: f.address } : {}), ...(f.category ? { category: f.category } : {}), ...(f.rating ? { rating: f.rating } : {}), ...(f.reviewCount ? { reviewCount: f.reviewCount } : {}), source: f.source === 'sample' ? 'sample' : 'search' })}>
                  {on.has(f.name.toLowerCase()) ? <CheckCircle2 size={13} /> : <Plus size={13} />} {on.has(f.name.toLowerCase()) ? 'On this bid' : 'Add'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {near && near.length > 0 && (
        <Section title="Pulling permits near the job" sub="Businesses that have recently pulled building permits in this area, from city records. Free.">
          <ul className="bd-sublist" aria-label="Pulling permits nearby">
            {near.map((c) => (
              <li key={c.key} className="bd-sub">
                <div className="bd-sub-main">
                  <strong>{c.name}</strong>
                  <span className="bd-result-sub">{[c.phone, c.license, `${c.permits} permits at ${c.jobs} addresses`, c.types.slice(0, 2).join(', ')].filter(Boolean).join(' · ')}</span>
                </div>
                <button className="btn btn-sm" disabled={on.has(c.name.toLowerCase())} onClick={() => add({ name: c.name, ...(c.phone ? { phone: c.phone } : {}), ...(c.license ? { license: c.license } : {}), source: 'permits' })}>
                  {on.has(c.name.toLowerCase()) ? 'On this bid' : 'Add'}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function Proposal({ bid, save }: { bid: Bid; save: Save }) {
  const { state, dispatch } = useStore();
  const profile = useBidProfile();
  const page = bid.proposal ? state.ws.files[bid.proposal] : undefined;
  const start = () => {
    const id = uid('doc');
    const name = `Proposal — ${bid.notice.title.slice(0, 80)}`;
    const project = bid.project ? state.ws.projects[bid.project] : undefined;
    const file: WFile = { id, name, kind: 'doc', folder: project?.folder ?? 'f02', updated: now(), owner: 'me', ...(bid.project ? { project: bid.project } : {}) };
    const blocks = proposalBlocks(bid, profile, uid);
    dispatch(ws([put('files', file), put('docs', { id, template: 'blank', blocks, icon: '📄' }), put('bids', { ...bid, proposal: id, updated: now() })], { toast: 'Proposal started: fill in the [bracketed] blanks', undo: true, log: `Started the proposal for “${bid.notice.title.slice(0, 100)}”` }));
    dispatch({ type: 'navigate', route: { view: 'file', id } });
  };
  const missing = [!profile.uei && 'UEI', !profile.cage && 'CAGE code', !profile.capabilities && 'what you do', !profile.contactName && 'a point of contact'].filter(Boolean) as string[];
  return (
    <div className="bd-proposal">
      <Section
        title="Proposal"
        sub="A page in Docs, filled in from the bid: the work, the requirements, your price lines and your company. Every blank is [bracketed], and Timmy never makes up licenses, past performance or figures."
        action={
          page ? (
            <button className="btn btn-sm btn-primary" onClick={() => dispatch({ type: 'navigate', route: { view: 'file', id: page.id } })}>
              <FileText size={14} /> Open the proposal
            </button>
          ) : (
            <button className="btn btn-sm btn-primary" onClick={start}>
              <FilePlus2 size={14} /> Start the proposal
            </button>
          )
        }
      >
        {missing.length > 0 && (
          <p className="bd-note">
            Your company details don’t have {missing.join(', ')} yet; they’ll be blanks.{' '}
            <button className="link-btn" onClick={() => dispatch({ type: 'navigate', route: { view: 'bids', tab: 'company' } })}>
              <Building2 size={12} aria-hidden /> Fill them in
            </button>
          </p>
        )}
        {page && <p className="muted">“{page.name}”, last changed {day(page.updated)}.</p>}
      </Section>
      <Section title="Notes" sub="Anything about this bid: questions to ask, who you spoke to.">
        <textarea className="input bd-notes" aria-label="Notes" rows={5} defaultValue={bid.notes ?? ''} onBlur={(e) => e.target.value !== (bid.notes ?? '') && save({ ...bid, notes: e.target.value || undefined })} />
      </Section>
    </div>
  );
}

/* ───────────── Sidebar and context ───────────── */

export function BidsSide() {
  const { state, dispatch } = useStore();
  const r = state.route;
  const tab = r.view === 'bids' ? r.tab : r.view === 'bid' ? 'mine' : null;
  const all = Object.values(state.ws.bids ?? {});
  const open = all.filter((b) => b.stage !== 'won' && b.stage !== 'lost').sort(byDeadline);
  const views: { id: Tab; label: string; hint: string; icon: typeof Search; count?: number }[] = [
    { id: 'find', label: 'Find', hint: 'Open notices to bid on', icon: Search },
    { id: 'mine', label: 'My bids', hint: `${open.length} open`, icon: Gavel, count: open.length },
    { id: 'company', label: 'Company', hint: 'UEI, contact, markup', icon: Building2 },
  ];
  return (
    <>
      <SideHead
        icon={<Landmark size={18} />}
        title="Bids"
        sub="Federal, state and local contracts"
        action={
          <button className="btn btn-primary" onClick={() => dispatch({ type: 'navigate', route: { view: 'bids', tab: 'find' } })}>
            <Search size={15} /> Find bids
          </button>
        }
      />
      <div className="side-scroll">
        <div className="side-group">
          {views.map((v) => (
            <button key={v.id} className="nav-item" aria-current={tab === v.id ? 'page' : undefined} onClick={() => dispatch({ type: 'navigate', route: { view: 'bids', tab: v.id } })}>
              <span className="nav-icon">
                <v.icon size={16} />
              </span>
              <span className="nav-text">
                <span className="nav-name">{v.label}</span>
                <span className="nav-hint">{v.hint}</span>
              </span>
              {v.count ? <span className="nav-count">{v.count}</span> : null}
            </button>
          ))}
        </div>
        {open.length > 0 && (
          <div className="side-group">
            <span className="side-label">Due next</span>
            {open.slice(0, 6).map((b) => (
              <button key={b.id} className="nav-item" aria-current={r.view === 'bid' && r.id === b.id ? 'page' : undefined} onClick={() => dispatch({ type: 'navigate', route: { view: 'bid', id: b.id, tab: 'overview' } })}>
                <span className="nav-icon">
                  <Gavel size={16} />
                </span>
                <span className="nav-text">
                  <span className="nav-name">{b.notice.title}</span>
                  <span className="nav-hint">{dueText(b.notice.responseDeadline, now())}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export function BidsContext() {
  const { state, dispatch } = useStore();
  const soon = Object.values(state.ws.bids ?? {})
    .filter((b) => b.stage !== 'won' && b.stage !== 'lost' && (daysLeft(b.notice.responseDeadline, now()) ?? 99) <= 14 && (daysLeft(b.notice.responseDeadline, now()) ?? -1) >= 0)
    .sort(byDeadline);
  return (
    <div className="rp-section">
      <h2 className="rp-title">Due in the next two weeks</h2>
      {soon.length === 0 ? (
        <p className="rp-text">No bid is due in the next two weeks.</p>
      ) : (
        <ul className="rp-list">
          {soon.map((b) => (
            <li key={b.id}>
              <button className="rp-person" onClick={() => dispatch({ type: 'navigate', route: { view: 'bid', id: b.id, tab: 'overview' } })}>
                <span className="rp-person-text">
                  <span className="rp-person-name">{b.notice.title}</span>
                  <span className="rp-person-sub">
                    {STAGE_LABEL[b.stage]} · {dueText(b.notice.responseDeadline, now())}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Remove is exported for the bid's own menu later; kept here so the screens share one way of deleting. */
export const removeBidOps = (id: string) => [remove('bids', id)];
