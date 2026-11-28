/*
 * Invoices and quotes, after PandaDoc: a list that says what you are owed, and each invoice or quote as one page you
 * fill in where it will be read (your business, the client, the lines, the totals, the terms). Every sum comes from
 * totals() in src/state/invoices.ts. Sending goes through the compose window with the PDF attached, so it waits for
 * your Send and its undo window like any email, and Waiting tracks the payment (or the answer, for a quote).
 */
import { ArrowLeft, Building2, CheckCircle2, Download, FilePlus2, FileText, Mail, Plus, Receipt, RotateCcw, Send, Trash2, X, XCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Frame } from '../../components/Frame';
import { AutoTextarea, Menu, SideHead } from '../../components/kit';
import { Folder } from '../../components/common';
import { PEOPLE } from '../../data/mock';
import type { BillingSettings, Invoice, InvoiceKind, LineItem } from '../../data/ws-types';
import { api } from '../../live/api';
import { isLive } from '../../live/clock';
import { centsFrom, defaultBilling, emailFor, money, shownStatus, STATUS_LABEL, totals, type ShownStatus } from '../../state/invoices';
import { useStore, ws } from '../../state/store';
import { isoDay, mailId, put, remove, uid } from '../../state/ws';

type Tab = 'invoices' | 'quotes' | 'details';

const NOUN: Record<InvoiceKind, string> = { invoice: 'Invoice', quote: 'Quote' };
const dayText = (d?: Date | string) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const dateAt5 = (iso: string) => new Date(`${iso}T17:00:00`);

/** The workspace's billing details, or the ones it would start with. */
/**
 * The workspace's billing details, or the defaults until they are first saved. The defaults are made once per name
 * and email, so the same object comes back on every render: the details form resets to it only when it changes.
 */
export function useBilling(): BillingSettings {
  const { state } = useStore();
  const business = PEOPLE.me?.company || 'Your business';
  const email = PEOPLE.me?.email || undefined;
  const fallback = useMemo(() => defaultBilling(business, email), [business, email]);
  return state.ws.billing?.settings ?? fallback;
}

function StatusChip({ inv }: { inv: Invoice }) {
  const s = shownStatus(inv);
  return <span className={`chip inv-status inv-${s}`}>{STATUS_LABEL[s]}</span>;
}

function useNew() {
  const { dispatch } = useStore();
  return (kind: InvoiceKind, fill: { contact?: string; project?: string; thread?: string; fromQuote?: string } = {}) => dispatch({ type: 'newInvoice', kind, id: uid(kind === 'invoice' ? 'inv' : 'quo'), ...fill });
}

/* ───────────── The list ───────────── */

export function InvoicesView() {
  const { state, dispatch } = useStore();
  const r = state.route.view === 'invoices' ? state.route : { view: 'invoices' as const, tab: 'invoices' as Tab };
  const all = Object.values(state.ws.invoices ?? {});
  const tabs = [
    { id: 'invoices', label: 'Invoices', count: all.filter((x) => x.kind === 'invoice').length },
    { id: 'quotes', label: 'Quotes', count: all.filter((x) => x.kind === 'quote').length },
    { id: 'details', label: 'Business details' },
  ];
  return (
    <Frame tabs={tabs} active={r.tab} onTab={(t) => dispatch({ type: 'navigate', route: { view: 'invoices', tab: t as Tab } })} scrollKey={r.tab}>
      {r.tab === 'details' ? <BillingForm /> : <InvoiceList kind={r.tab === 'quotes' ? 'quote' : 'invoice'} />}
    </Frame>
  );
}

const FILTERS: Record<InvoiceKind, { id: 'all' | ShownStatus; label: string }[]> = {
  invoice: [
    { id: 'all', label: 'All' },
    { id: 'draft', label: 'Drafts' },
    { id: 'sent', label: 'Sent' },
    { id: 'overdue', label: 'Overdue' },
    { id: 'paid', label: 'Paid' },
  ],
  quote: [
    { id: 'all', label: 'All' },
    { id: 'draft', label: 'Drafts' },
    { id: 'sent', label: 'Sent' },
    { id: 'accepted', label: 'Accepted' },
    { id: 'declined', label: 'Declined' },
    { id: 'expired', label: 'Expired' },
  ],
};

function InvoiceList({ kind }: { kind: InvoiceKind }) {
  const { state, dispatch } = useStore();
  const make = useNew();
  const [filter, setFilter] = useState<'all' | ShownStatus>('all');
  const mine = Object.values(state.ws.invoices ?? {})
    .filter((x) => x.kind === kind)
    .sort((a, b) => new Date(b.issued).getTime() - new Date(a.issued).getTime() || b.number.localeCompare(a.number));
  const rows = filter === 'all' ? mine : mine.filter((x) => shownStatus(x) === filter);
  const cur = useBilling().currency;
  const sum = (xs: Invoice[]) => xs.reduce((n, x) => n + totals(x).total, 0);
  const monthAgo = Date.now() - 30 * 86400_000;
  const cards =
    kind === 'invoice'
      ? [
          { label: 'Outstanding', value: money(sum(mine.filter((x) => x.status === 'sent')), cur), sub: `${mine.filter((x) => x.status === 'sent').length} sent, not paid` },
          { label: 'Overdue', value: money(sum(mine.filter((x) => shownStatus(x) === 'overdue')), cur), sub: `${mine.filter((x) => shownStatus(x) === 'overdue').length} past their due date`, warn: mine.some((x) => shownStatus(x) === 'overdue') },
          { label: 'Paid, last 30 days', value: money(sum(mine.filter((x) => x.status === 'paid' && x.paidAt && new Date(x.paidAt).getTime() > monthAgo)), cur), sub: `${mine.filter((x) => x.status === 'paid').length} paid in all` },
          { label: 'Drafts', value: String(mine.filter((x) => x.status === 'draft').length), sub: 'not sent yet' },
        ]
      : [
          { label: 'Waiting for an answer', value: money(sum(mine.filter((x) => shownStatus(x) === 'sent')), cur), sub: `${mine.filter((x) => shownStatus(x) === 'sent').length} sent` },
          { label: 'Accepted', value: money(sum(mine.filter((x) => x.status === 'accepted')), cur), sub: `${mine.filter((x) => x.status === 'accepted').length} accepted` },
          { label: 'Expired', value: String(mine.filter((x) => shownStatus(x) === 'expired').length), sub: 'past their date, no answer' },
          { label: 'Drafts', value: String(mine.filter((x) => x.status === 'draft').length), sub: 'not sent yet' },
        ];
  return (
    <section className="inv-list">
      <div className="inv-head">
        <div>
          <h1 className="page-title">{kind === 'invoice' ? 'Invoices' : 'Quotes'}</h1>
          <p className="page-sub">{kind === 'invoice' ? 'What you have billed, what is owed, and what has been paid.' : 'Prices you have offered, and what clients said.'}</p>
        </div>
        <button className="btn btn-primary" onClick={() => make(kind)}>
          <Plus size={15} />
          New {kind}
        </button>
      </div>
      <div className="inv-cards">
        {cards.map((c) => (
          <div key={c.label} className={`card inv-card${'warn' in c && c.warn ? ' warn' : ''}`}>
            <span className="inv-card-label">{c.label}</span>
            <strong className="inv-card-value">{c.value}</strong>
            <span className="inv-card-sub">{c.sub}</span>
          </div>
        ))}
      </div>
      <div className="inv-filters" role="group" aria-label="Show">
        {FILTERS[kind].map((f) => (
          <button key={f.id} className="filter" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <div className="card empty">
          <span className="empty-icon">
            <Receipt size={20} />
          </span>
          <strong>{mine.length ? `No ${kind}s here` : `No ${kind}s yet`}</strong>
          <span>{mine.length ? 'Pick another filter.' : `Start one here, or from an email with “Make ${kind === 'invoice' ? 'an invoice' : 'a quote'}”.`}</span>
        </div>
      ) : (
        <div className="table inv-table" role="table" aria-label={kind === 'invoice' ? 'Invoices' : 'Quotes'}>
          <div className="table-row table-head" role="row">
            <span>Number</span>
            <span>Client</span>
            <span>Issued</span>
            <span>{kind === 'invoice' ? 'Due' : 'Valid until'}</span>
            <span className="inv-num">Amount</span>
            <span>Status</span>
          </div>
          {rows.map((x) => {
            const project = x.project ? state.ws.projects[x.project] : undefined;
            return (
              <button key={x.id} role="row" className="table-row inv-row" onClick={() => dispatch({ type: 'navigate', route: { view: 'invoice', id: x.id } })}>
                <span className="mono">{x.number}</span>
                <span className="inv-client">
                  <span>{x.client.name || x.client.company || 'No client yet'}</span>
                  {project && (
                    <span className="inv-sub">
                      <Folder color={project.color} size={12} /> {project.name}
                    </span>
                  )}
                </span>
                <span>{dayText(x.issued)}</span>
                <span>{dayText(x.due)}</span>
                <span className="inv-num">{money(totals(x).total, x.currency)}</span>
                <span>
                  <StatusChip inv={x} />
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* ───────────── One invoice or quote ───────────── */

export function InvoiceView() {
  const { state, dispatch } = useStore();
  const id = state.route.view === 'invoice' ? state.route.id : '';
  const stored = state.ws.invoices?.[id];
  const s = useBilling();
  // Edits are kept here as they are typed and saved shortly after, so a keystroke isn't a command each.
  const [inv, setInv] = useState<Invoice | undefined>(stored);
  const dirty = useRef(false);
  const latest = useRef(inv);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!dirty.current) setInv(stored);
  }, [stored]);
  const save = () => {
    window.clearTimeout(timer.current);
    if (dirty.current && latest.current) dispatch(ws([put('invoices', latest.current)]));
    dirty.current = false;
  };
  useEffect(() => save, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!inv) {
    return (
      <Frame tabs={[{ id: 'doc', label: 'Invoice' }]} active="doc" onTab={() => undefined}>
        <div className="card empty">
          <strong>That invoice isn’t here</strong>
          <button className="btn btn-sm" onClick={() => dispatch({ type: 'navigate', route: { view: 'invoices', tab: 'invoices' } })}>
            Back to invoices
          </button>
        </div>
      </Frame>
    );
  }
  const editable = inv.status === 'draft';
  const change = (next: Invoice) => {
    setInv(next);
    latest.current = next;
    dirty.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(save, 600);
  };
  return (
    <Frame tabs={[{ id: 'doc', label: `${NOUN[inv.kind]} ${inv.number}` }]} active="doc" onTab={() => undefined} scrollKey={inv.id}>
      <InvoiceBar inv={inv} settings={s} onBeforeAction={save} />
      {!editable && <SentNote inv={inv} />}
      <Paper inv={inv} s={s} editable={editable} onChange={change} />
    </Frame>
  );
}

function SentNote({ inv }: { inv: Invoice }) {
  const { state, dispatch } = useStore();
  const thread = inv.thread ? state.threads.find((t) => t.id === inv.thread) : undefined;
  const st = shownStatus(inv);
  const line =
    st === 'paid'
      ? `Paid ${dayText(inv.paidAt)}.`
      : st === 'accepted'
        ? `Accepted ${dayText(inv.acceptedAt)}.`
        : st === 'declined'
          ? `Declined ${dayText(inv.declinedAt)}.`
          : st === 'void'
            ? `Void since ${dayText(inv.voidedAt)}. It stays here for your records.`
            : `Sent ${dayText(inv.sentAt)}. What was sent is what you see; to change it, void it and start a new one.`;
  return (
    <div className={`inv-note inv-note-${st}`} role="status">
      <span>{line}</span>
      {thread && (
        <button className="link-btn" onClick={() => dispatch({ type: 'openThread', id: thread.id })}>
          <Mail size={13} aria-hidden /> Open the email
        </button>
      )}
    </div>
  );
}

/** What can be done with it now: send, mark paid, accept, turn into an invoice, download, void. */
function InvoiceBar({ inv, settings, onBeforeAction }: { inv: Invoice; settings: BillingSettings; onBeforeAction: () => void }) {
  const { state, dispatch } = useStore();
  const make = useNew();
  const [sending, setSending] = useState(false);
  const st = shownStatus(inv);
  const t = totals(inv);
  const problems = [
    !settings.business.trim() && 'your business name (in Business details)',
    !inv.client.name.trim() && 'who it is for',
    !inv.client.email?.trim() && 'the client’s email address',
    !inv.items.some((l) => l.description.trim()) && 'at least one line',
    t.total <= 0 && 'an amount above zero',
  ].filter(Boolean) as string[];
  const act = (op: 'paid' | 'accepted' | 'declined' | 'void' | 'reopen') => {
    onBeforeAction();
    dispatch({ type: 'invoice', op, id: inv.id });
  };
  const send = async () => {
    onBeforeAction();
    if (problems.length) {
      dispatch({ type: 'toast', text: `Before sending, add ${problems.join(', ')}.`, tone: 'warn' });
      return;
    }
    setSending(true);
    try {
      // On a real workspace the PDF is made by the server and attached; the sample demo sends the email alone.
      const files = isLive() ? [(await api.invoiceAttachment(inv.id)).file] : [];
      const contact = inv.client.contact && PEOPLE[inv.client.contact] ? inv.client.contact : mailId(inv.client.email!);
      const mail = emailFor(inv, settings, PEOPLE.me?.name || settings.business);
      dispatch({
        type: 'compose',
        draft: {
          to: [contact],
          subject: mail.subject,
          body: mail.body,
          files,
          invoice: inv.id,
          ...(inv.project ? { project: inv.project } : {}),
          track: { on: contact, item: inv.kind === 'invoice' ? `Payment of ${inv.number} (${money(t.total, inv.currency)})` : `An answer to quote ${inv.number}`, ...(inv.due ? { due: isoDay(new Date(inv.due)) } : {}) },
        },
      });
    } catch (e) {
      dispatch({ type: 'toast', text: (e as Error).message, tone: 'warn' });
    } finally {
      setSending(false);
    }
  };
  const download = () => {
    onBeforeAction();
    if (isLive()) window.open(`/api/v1/invoices/${encodeURIComponent(inv.id)}/pdf`, '_blank', 'noopener');
    else window.print();
  };
  const more = [
    ...(st !== 'void' && st !== 'paid' ? [{ label: `Void this ${inv.kind}`, icon: XCircle, onSelect: () => act('void') }] : []),
    ...(['paid', 'accepted', 'declined', 'void'].includes(inv.status) ? [{ label: 'Open it again', icon: RotateCcw, onSelect: () => act('reopen') }] : []),
    ...(inv.status === 'draft'
      ? [
          {
            label: 'Delete draft',
            icon: Trash2,
            danger: true,
            onSelect: () => {
              dispatch(ws([remove('invoices', inv.id)], { toast: `Draft ${inv.number} deleted`, undo: true }));
              dispatch({ type: 'navigate', route: { view: 'invoices', tab: inv.kind === 'invoice' ? 'invoices' : 'quotes' } });
            },
          },
        ]
      : []),
  ];
  const invoiceFrom = inv.kind === 'quote' ? Object.values(state.ws.invoices).find((x) => x.fromQuote === inv.id) : undefined;
  return (
    <div className="inv-bar">
      <button className="btn btn-sm btn-ghost" onClick={() => dispatch({ type: 'back' })}>
        <ArrowLeft size={14} />
        Back
      </button>
      <h1 className="inv-title">
        {NOUN[inv.kind]} <span className="mono">{inv.number}</span>
      </h1>
      <StatusChip inv={inv} />
      <span className="inv-bar-gap" />
      {inv.kind === 'invoice' && (st === 'sent' || st === 'overdue') && (
        <button className="btn btn-sm btn-primary" onClick={() => act('paid')}>
          <CheckCircle2 size={14} />
          Mark paid
        </button>
      )}
      {inv.kind === 'quote' && (st === 'sent' || st === 'expired') && (
        <>
          <button className="btn btn-sm btn-primary" onClick={() => act('accepted')}>
            <CheckCircle2 size={14} />
            Mark accepted
          </button>
          <button className="btn btn-sm" onClick={() => act('declined')}>
            <X size={14} />
            Declined
          </button>
        </>
      )}
      {inv.kind === 'quote' && inv.status === 'accepted' && !invoiceFrom && (
        <button className="btn btn-sm btn-primary" onClick={() => make('invoice', { fromQuote: inv.id })}>
          <FilePlus2 size={14} />
          Turn into an invoice
        </button>
      )}
      {invoiceFrom && (
        <button className="btn btn-sm" onClick={() => dispatch({ type: 'navigate', route: { view: 'invoice', id: invoiceFrom.id } })}>
          <FileText size={14} />
          Invoice {invoiceFrom.number}
        </button>
      )}
      {(st === 'draft' || st === 'sent' || st === 'overdue' || st === 'expired') && (
        <button className={`btn btn-sm${st === 'draft' ? ' btn-primary' : ''}`} disabled={sending} onClick={() => void send()} title={problems.length ? `Add ${problems.join(', ')} first` : 'Opens the email with the PDF attached. Nothing goes out until you press Send.'}>
          <Send size={14} />
          {sending ? 'Preparing…' : st === 'draft' ? 'Send' : 'Send again'}
        </button>
      )}
      <button className="btn btn-sm" onClick={download}>
        <Download size={14} />
        {isLive() ? 'PDF' : 'Print or save as PDF'}
      </button>
      {more.length > 0 && <Menu label={`More for ${inv.number}`} items={more} />}
    </div>
  );
}

/** A money field: shows the amount, takes what is typed, and keeps whole cents. */
function MoneyInput({ cents, currency, onChange, label, disabled }: { cents: number; currency: string; onChange: (c: number) => void; label: string; disabled?: boolean }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      className="input inv-money"
      inputMode="decimal"
      aria-label={label}
      disabled={disabled}
      value={text ?? (cents ? (cents / 100).toFixed(2) : '')}
      placeholder={money(0, currency)}
      onFocus={() => setText(cents ? (cents / 100).toFixed(2) : '')}
      onChange={(e) => {
        setText(e.target.value);
        const c = centsFrom(e.target.value);
        if (c !== null) onChange(c);
      }}
      onBlur={() => setText(null)}
    />
  );
}

/** The invoice or quote as it will be read, with what can be changed in place while it is a draft. */
function Paper({ inv, s, editable, onChange }: { inv: Invoice; s: BillingSettings; editable: boolean; onChange: (next: Invoice) => void }) {
  const { state, dispatch } = useStore();
  const t = totals(inv);
  const set = (p: Partial<Invoice>) => onChange({ ...inv, ...p });
  const setClient = (p: Partial<Invoice['client']>) => set({ client: { ...inv.client, ...p } });
  const setLine = (id: string, p: Partial<LineItem>) => set({ items: inv.items.map((l) => (l.id === id ? { ...l, ...p } : l)) });
  const contacts = useMemo(() => Object.values(state.ws.contacts).sort((a, b) => a.name.localeCompare(b.name)), [state.ws.contacts]);
  const field = (value: string | undefined, onSet: (v: string) => void, label: string, opts: { multi?: boolean; placeholder?: string; className?: string } = {}): ReactNode =>
    !editable ? (
      value ? <span className={`inv-ro ${opts.className ?? ''}`}>{value}</span> : null
    ) : opts.multi ? (
      <AutoTextarea className={`input inv-field ${opts.className ?? ''}`} aria-label={label} placeholder={opts.placeholder ?? label} value={value ?? ''} minRows={1} onChange={(e) => onSet(e.target.value)} />
    ) : (
      <input className={`input inv-field ${opts.className ?? ''}`} aria-label={label} placeholder={opts.placeholder ?? label} value={value ?? ''} onChange={(e) => onSet(e.target.value)} />
    );
  return (
    <article className={`inv-paper${editable ? ' editing' : ''}`} aria-label={`${NOUN[inv.kind]} ${inv.number}`}>
      <header className="inv-paper-head">
        <div className="inv-from">
          <strong className="inv-biz">{s.business || 'Your business'}</strong>
          {[s.address, s.email, s.phone, s.taxId].filter(Boolean).map((x) => (
            <span key={x} className="inv-from-line">
              {x}
            </span>
          ))}
          {editable && (
            <button className="link-btn inv-edit-biz" onClick={() => dispatch({ type: 'navigate', route: { view: 'invoices', tab: 'details' } })}>
              <Building2 size={12} aria-hidden /> Edit business details
            </button>
          )}
        </div>
        <div className="inv-meta">
          <span className="inv-kind">{inv.kind === 'invoice' ? 'INVOICE' : 'QUOTE'}</span>
          <span className="mono">{inv.number}</span>
          <label className="inv-meta-row">
            <span>Issued</span>
            {editable ? <input type="date" className="input" aria-label="Issued" value={isoDay(new Date(inv.issued))} onChange={(e) => e.target.value && set({ issued: dateAt5(e.target.value) })} /> : <span>{dayText(inv.issued)}</span>}
          </label>
          <label className="inv-meta-row">
            <span>{inv.kind === 'invoice' ? 'Due' : 'Valid until'}</span>
            {editable ? <input type="date" className="input" aria-label={inv.kind === 'invoice' ? 'Due' : 'Valid until'} value={inv.due ? isoDay(new Date(inv.due)) : ''} onChange={(e) => set({ due: e.target.value ? dateAt5(e.target.value) : undefined })} /> : <span>{dayText(inv.due)}</span>}
          </label>
        </div>
      </header>

      <section className="inv-to">
        <span className="inv-label">{inv.kind === 'invoice' ? 'Bill to' : 'Prepared for'}</span>
        {editable && contacts.length > 0 && (
          <select
            className="input inv-contact"
            aria-label="Choose a contact"
            value={inv.client.contact ?? ''}
            onChange={(e) => {
              const c = state.ws.contacts[e.target.value];
              setClient(c ? { contact: c.id, name: c.name, email: c.email, company: c.company } : { contact: undefined });
            }}
          >
            <option value="">Choose a contact…</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.company ? ` · ${c.company}` : ''}
              </option>
            ))}
          </select>
        )}
        {field(inv.client.name, (v) => setClient({ name: v }), 'Client name', { className: 'inv-strong' })}
        {field(inv.client.company, (v) => setClient({ company: v }), 'Company')}
        {field(inv.client.email, (v) => setClient({ email: v.trim() }), 'Client email', { placeholder: 'Email address' })}
        {field(inv.client.address, (v) => setClient({ address: v }), 'Client address', { multi: true, placeholder: 'Address' })}
      </section>

      {(editable || inv.intro) && <section className="inv-intro">{field(inv.intro, (v) => set({ intro: v }), 'What this is for', { multi: true, placeholder: 'What this is for (optional)' })}</section>}

      <section className="inv-lines" aria-label="Lines">
        <div className="inv-line inv-line-head">
          <span>Description</span>
          <span className="inv-num">Qty</span>
          <span className="inv-num">Price</span>
          <span className="inv-num">Tax %</span>
          <span className="inv-num">Amount</span>
          <span />
        </div>
        {inv.items.map((l, i) => (
          <div key={l.id} className={`inv-line${l.optional && !l.chosen ? ' left-out' : ''}`}>
            <span className="inv-desc">
              {editable ? (
                <AutoTextarea className="input" minRows={1} aria-label={`Line ${i + 1} description`} placeholder="Description" value={l.description} onChange={(e) => setLine(l.id, { description: e.target.value })} />
              ) : (
                <span>{l.description}</span>
              )}
              {l.optional && (
                <label className="inv-optional">
                  <input type="checkbox" checked={!!l.chosen} disabled={!editable} onChange={(e) => setLine(l.id, { chosen: e.target.checked })} />
                  Optional{l.chosen ? ', included' : ', not included'}
                </label>
              )}
            </span>
            <span className="inv-num">
              {editable ? <input className="input" type="number" min={0} step="any" aria-label={`Line ${i + 1} quantity`} value={l.qty} onChange={(e) => setLine(l.id, { qty: Math.max(0, Number(e.target.value) || 0) })} /> : l.qty}
            </span>
            <span className="inv-num">{editable ? <MoneyInput cents={l.unitPrice} currency={inv.currency} label={`Line ${i + 1} price`} onChange={(c) => setLine(l.id, { unitPrice: c })} /> : money(l.unitPrice, inv.currency)}</span>
            <span className="inv-num">
              {editable ? <input className="input" type="number" min={0} max={100} step="any" aria-label={`Line ${i + 1} tax`} value={l.taxRate ?? ''} placeholder="0" onChange={(e) => setLine(l.id, { taxRate: e.target.value === '' ? undefined : Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} /> : l.taxRate ? `${l.taxRate}%` : ''}
            </span>
            <span className="inv-num inv-amount">{money(t.lines[l.id] ?? 0, inv.currency)}</span>
            <span className="inv-line-actions">
              {editable && (
                <Menu
                  label={`Line ${i + 1} actions`}
                  items={[
                    ...(inv.kind === 'quote' ? [{ label: l.optional ? 'Make it required' : 'Make it optional', icon: CheckCircle2, onSelect: () => setLine(l.id, l.optional ? { optional: undefined, chosen: undefined } : { optional: true, chosen: false }) }] : []),
                    { label: 'Remove line', icon: Trash2, danger: true, onSelect: () => set({ items: inv.items.filter((x) => x.id !== l.id) }) },
                  ]}
                />
              )}
            </span>
          </div>
        ))}
        {editable && (
          <button className="btn btn-sm btn-ghost inv-add" onClick={() => set({ items: [...inv.items, { id: `${inv.id}-${Date.now().toString(36)}`, description: '', qty: 1, unitPrice: 0 }] })}>
            <Plus size={14} />
            Add a line
          </button>
        )}
      </section>

      <section className="inv-totals" aria-label="Totals">
        <div className="inv-total-row">
          <span>Subtotal</span>
          <span>{money(t.subtotal, inv.currency)}</span>
        </div>
        {(editable || t.discount > 0) && (
          <div className="inv-total-row">
            <span className="inv-discount">
              Discount
              {editable && (
                <>
                  <select className="input" aria-label="Discount kind" value={inv.discount?.kind ?? ''} onChange={(e) => set({ discount: e.target.value ? { kind: e.target.value as 'percent' | 'amount', value: inv.discount?.value ?? 0 } : undefined })}>
                    <option value="">None</option>
                    <option value="percent">Percent</option>
                    <option value="amount">Amount</option>
                  </select>
                  {inv.discount?.kind === 'percent' && <input className="input" type="number" min={0} max={100} step="any" aria-label="Discount percent" value={inv.discount.value} onChange={(e) => set({ discount: { kind: 'percent', value: Math.min(100, Math.max(0, Number(e.target.value) || 0)) } })} />}
                  {inv.discount?.kind === 'amount' && <MoneyInput cents={inv.discount.value} currency={inv.currency} label="Discount amount" onChange={(c) => set({ discount: { kind: 'amount', value: c } })} />}
                </>
              )}
              {!editable && inv.discount?.kind === 'percent' && ` (${inv.discount.value}%)`}
            </span>
            <span>{t.discount ? `−${money(t.discount, inv.currency)}` : money(0, inv.currency)}</span>
          </div>
        )}
        {(editable || t.tax > 0) && (
          <div className="inv-total-row">
            <span>Tax</span>
            <span>{money(t.tax, inv.currency)}</span>
          </div>
        )}
        <div className="inv-total-row inv-grand">
          <span>{inv.kind === 'invoice' ? 'Amount due' : 'Total'}</span>
          <span>{money(t.total, inv.currency)}</span>
        </div>
      </section>

      <section className="inv-foot">
        {(editable || inv.notes) && (
          <div>
            <span className="inv-label">Notes</span>
            {field(inv.notes, (v) => set({ notes: v }), 'Notes', { multi: true, placeholder: 'Thanks, scope notes (optional)' })}
          </div>
        )}
        <div>
          <span className="inv-label">Terms</span>
          {field(inv.terms, (v) => set({ terms: v }), 'Terms', { multi: true })}
        </div>
        {inv.kind === 'invoice' && (
          <div>
            <span className="inv-label">How to pay</span>
            {s.payment ? <span className="inv-ro">{s.payment}</span> : <span className="inv-ro muted">Add how clients pay you in Business details; it goes on every invoice.</span>}
          </div>
        )}
      </section>
    </article>
  );
}

/* ───────────── Business details ───────────── */

function BillingForm() {
  const { dispatch } = useStore();
  const current = useBilling();
  const [s, setS] = useState(current);
  useEffect(() => setS(current), [current]);
  const set = (p: Partial<BillingSettings>) => setS({ ...s, ...p });
  const text = (key: 'business' | 'email' | 'phone' | 'taxId' | 'currency' | 'invoicePrefix' | 'quotePrefix', label: string, hint?: string) => (
    <label className="field">
      <span className="field-label">{label}</span>
      <input className="input" value={(s[key] as string | undefined) ?? ''} onChange={(e) => set({ [key]: key === 'currency' ? e.target.value.toUpperCase().slice(0, 3) : e.target.value })} />
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
  return (
    <section className="inv-details">
      <h1 className="page-title">Business details</h1>
      <p className="page-sub">What every invoice and quote shows about you, and how they are numbered.</p>
      <div className="card inv-form">
        {text('business', 'Business name')}
        <label className="field">
          <span className="field-label">Address</span>
          <AutoTextarea className="input" minRows={2} value={s.address ?? ''} onChange={(e) => set({ address: e.target.value })} />
        </label>
        {text('email', 'Billing email')}
        {text('phone', 'Phone')}
        {text('taxId', 'Tax or registration number', 'Shown when you have one, e.g. an EIN or VAT number.')}
        <label className="field">
          <span className="field-label">How clients pay you</span>
          <AutoTextarea className="input" minRows={3} value={s.payment ?? ''} placeholder="Bank details, a payment link, or “checks payable to…”" onChange={(e) => set({ payment: e.target.value })} />
          <span className="field-hint">Printed on every invoice and in the email that sends it.</span>
        </label>
        <div className="inv-form-row">
          {text('currency', 'Currency', 'A three-letter code: USD, EUR, GBP…')}
          <label className="field">
            <span className="field-label">Invoices due after (days)</span>
            <input className="input" type="number" min={0} max={365} value={s.termsDays} onChange={(e) => set({ termsDays: Math.max(0, Math.min(365, Math.round(Number(e.target.value) || 0))) })} />
          </label>
          <label className="field">
            <span className="field-label">Quotes valid for (days)</span>
            <input className="input" type="number" min={1} max={365} value={s.quoteDays} onChange={(e) => set({ quoteDays: Math.max(1, Math.min(365, Math.round(Number(e.target.value) || 1))) })} />
          </label>
        </div>
        <div className="inv-form-row">
          {text('invoicePrefix', 'Invoice numbers start with')}
          {text('quotePrefix', 'Quote numbers start with')}
        </div>
        <p className="field-hint">
          The next invoice is {s.invoicePrefix}
          {String(s.nextInvoice).padStart(4, '0')} and the next quote {s.quotePrefix}
          {String(s.nextQuote).padStart(4, '0')}. Numbers are never reused.
        </p>
        <div>
          <button className="btn btn-primary" onClick={() => dispatch(ws([put('billing', s)], { toast: 'Business details saved', undo: true }))}>
            Save details
          </button>
        </div>
      </div>
    </section>
  );
}

/* ───────────── Sidebar and context ───────────── */

export function InvoicesSide() {
  const { state, dispatch } = useStore();
  const make = useNew();
  const r = state.route;
  const tab = r.view === 'invoices' ? r.tab : r.view === 'invoice' ? (state.ws.invoices?.[r.id]?.kind === 'quote' ? 'quotes' : 'invoices') : null;
  const all = Object.values(state.ws.invoices ?? {});
  const owed = all.filter((x) => x.kind === 'invoice' && x.status === 'sent');
  const cur = useBilling().currency;
  const views: { id: Tab; label: string; hint: string; icon: typeof Receipt; count?: number }[] = [
    { id: 'invoices', label: 'Invoices', hint: `${owed.length} waiting for payment`, icon: Receipt, count: all.filter((x) => shownStatus(x) === 'overdue').length },
    { id: 'quotes', label: 'Quotes', hint: `${all.filter((x) => x.kind === 'quote' && shownStatus(x) === 'sent').length} waiting for an answer`, icon: FileText },
    { id: 'details', label: 'Business details', hint: 'Your details, terms and numbers', icon: Building2 },
  ];
  return (
    <>
      <SideHead
        icon={<Receipt size={18} />}
        title="Invoices & quotes"
        sub={`${money(owed.reduce((n, x) => n + totals(x).total, 0), cur)} owed to you`}
        action={
          <div className="tk-side-actions">
            <button className="btn btn-primary" onClick={() => make('invoice')}>
              <Plus size={15} />
              New invoice
            </button>
            <button className="btn" onClick={() => make('quote')}>
              <Plus size={15} />
              New quote
            </button>
          </div>
        }
      />
      <div className="side-scroll">
        <div className="side-group">
          {views.map((v) => (
            <button key={v.id} className="nav-item" aria-current={tab === v.id ? 'page' : undefined} onClick={() => dispatch({ type: 'navigate', route: { view: 'invoices', tab: v.id } })}>
              <span className="nav-icon">
                <v.icon size={16} />
              </span>
              <span className="nav-text">
                <span className="nav-name">{v.label}</span>
                <span className="nav-hint">{v.hint}</span>
              </span>
              {v.count ? <span className="nav-count strong" title="Overdue">{v.count}</span> : null}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

export function InvoicesContext() {
  const { state, dispatch } = useStore();
  const overdue = Object.values(state.ws.invoices ?? {})
    .filter((x) => shownStatus(x) === 'overdue')
    .sort((a, b) => new Date(a.due ?? 0).getTime() - new Date(b.due ?? 0).getTime());
  return (
    <div className="rp-section">
      <h2 className="rp-title">Overdue</h2>
      {overdue.length === 0 ? (
        <p className="rp-text">Nothing is overdue.</p>
      ) : (
        <ul className="rp-list">
          {overdue.map((x) => (
            <li key={x.id}>
              <button className="rp-person" onClick={() => dispatch({ type: 'navigate', route: { view: 'invoice', id: x.id } })}>
                <span className="rp-person-text">
                  <span className="rp-person-name">
                    {x.number} · {x.client.name || x.client.company}
                  </span>
                  <span className="rp-person-sub">
                    {money(totals(x).total, x.currency)} · due {dayText(x.due)}
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
