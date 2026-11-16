/*
 * Leads: your lead lists as one table. Import a CSV (or paste from a sheet),
 * see how well each lead fits your offer, have Timmy qualify the account, and
 * add the good ones to a campaign. Click a row for the lead's details.
 */
import { ArrowDownWideNarrow, Briefcase, Download, Check, ChevronDown, Globe, Plus, Radar, Search, Sparkles, Star, Trash2, Upload, Users, Wand2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Lead, LeadStatus } from '../../data/outbound-types';
import { plural } from '../../lib/format';
import { FIELD_LABELS, guessFields, parseCsv, SAMPLE_CSV, type LeadField } from '../../lib/csv';
import { enrichApp, leadOrigin } from '../../state/connect';
import { downloadCsv } from '../../lib/download';
import { useStore } from '../../state/store';
import { Field, Menu, Modal } from '../../components/kit';
import { EmptyState } from '../../components/kit';
import { FitBadge, LeadMark, StatusChip, name, useFit } from './shared';

type Show = 'all' | 'new' | 'saved' | 'campaign' | 'replied';
type Sort = 'fit' | 'name' | 'employees' | 'added';
const SIZE_BANDS: [string, number, number][] = [
  ['1–20', 1, 20],
  ['21–50', 21, 50],
  ['51–100', 51, 100],
  ['101–250', 101, 250],
  ['251+', 251, Infinity],
];

let idSeq = 1;
const newId = () => `lead-${Date.now().toString(36)}-${idSeq++}`;

export function LeadsTab() {
  const { state, dispatch } = useStore();
  const r = state.route.view === 'outbound' ? state.route : null;
  const fitOf = useFit();
  const [show, setShow] = useState<Show>('all');
  const [q, setQ] = useState('');
  const [industry, setIndustry] = useState('');
  const [size, setSize] = useState('');
  const [status, setStatus] = useState<LeadStatus | ''>('');
  const [sort, setSort] = useState<Sort>('fit');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(100);

  const all = Object.values(state.out.leads).filter((l) => !r?.list || l.list === r.list);
  const counts = {
    all: all.length,
    new: all.filter((l) => !l.campaign && l.status === 'new').length,
    saved: all.filter((l) => l.saved).length,
    campaign: all.filter((l) => l.campaign).length,
    replied: all.filter((l) => l.label && l.label !== 'ooo').length,
  };
  const industries = [...new Set(all.map((l) => l.industry).filter(Boolean) as string[])].sort();
  const fits = useMemo(() => new Map(all.map((l) => [l.id, fitOf(l)])), [all, fitOf]);

  const rows = all
    .filter((l) => (show === 'new' ? !l.campaign && l.status === 'new' : show === 'saved' ? l.saved : show === 'campaign' ? !!l.campaign : show === 'replied' ? l.label && l.label !== 'ooo' : true))
    .filter((l) => !industry || l.industry === industry)
    .filter((l) => {
      const band = SIZE_BANDS.find((b) => b[0] === size);
      return !band || (l.employees !== undefined && l.employees >= band[1] && l.employees <= band[2]);
    })
    .filter((l) => !status || l.status === status)
    .filter((l) => !q || `${name(l)} ${l.company} ${l.title} ${l.email} ${l.city} ${(l.keywords ?? []).join(' ')}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) =>
      sort === 'fit' ? fits.get(b.id)!.score - fits.get(a.id)!.score : sort === 'name' ? name(a).localeCompare(name(b)) : sort === 'employees' ? (b.employees ?? 0) - (a.employees ?? 0) : b.added.getTime() - a.added.getTime(),
    );
  const shown = rows.slice(0, limit);
  const sel = [...picked].filter((id) => state.out.leads[id]);
  const allPicked = shown.length > 0 && shown.every((l) => picked.has(l.id));
  const campaigns = Object.values(state.out.campaigns).filter((c) => c.status !== 'completed');

  const toggle = (id: string) => setPicked((p) => (p.has(id) ? new Set([...p].filter((x) => x !== id)) : new Set([...p, id])));
  const runQualify = (ids: string[]) => {
    setRunning(new Set(ids));
    window.setTimeout(() => {
      dispatch({ type: 'out', op: { op: 'qualify', ids } });
      setRunning(new Set());
    }, 650);
  };
  const open = (id: string) => dispatch({ type: 'navigate', route: { view: 'outbound', tab: 'leads', list: r?.list, id } });
  const list = r?.list ? state.out.lists[r.list] : undefined;

  return (
    <>
      <div className="out-head">
        <div>
          <h1 className="page-title">{list ? list.name : 'Leads'}</h1>
          <p className="page-sub">
            {plural(all.length, 'lead')}
            {list ? '' : ` across ${plural(Object.keys(state.out.lists).length, 'list')}`}. Fit is scored against your offer, “{state.out.offer.name}”.
          </p>
        </div>
        <div className="out-head-actions">
          <button
            className="btn btn-ghost"
            disabled={!all.length}
            onClick={() =>
              downloadCsv(`${(list?.name ?? 'leads').replace(/[^\w-]+/g, '-')}.csv`, [
                ['First name', 'Last name', 'Email', 'Phone', 'Title', 'Company', 'Website', 'Employees', 'Industry', 'City', 'Status', 'Campaign', 'Source', 'Enriched by'],
                ...all.map((l) => [l.first, l.last, l.email, l.phone, l.title, l.company, l.website, l.employees, l.industry, l.city, l.status, l.campaign ? state.out.campaigns[l.campaign]?.name : '', l.source, l.enriched?.by]),
              ])
            }
          >
            <Download size={15} />
            Export CSV
          </button>
          <FindLeadsButton />
          <button className="btn" onClick={() => setAdding(true)}>
            <Plus size={15} />
            Add lead
          </button>
          <button className="btn btn-primary" onClick={() => setImporting(true)}>
            <Upload size={15} />
            Import CSV
          </button>
        </div>
      </div>

      <div className="seg-tabs" role="tablist" aria-label="Show">
        {(
          [
            ['all', 'All'],
            ['new', 'Net new'],
            ['saved', 'Saved'],
            ['campaign', 'In campaigns'],
            ['replied', 'Replied'],
          ] as [Show, string][]
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={show === id} className="seg-tab" onClick={() => setShow(id)}>
            <span>{label}</span>
            <span className="seg-n">{counts[id]}</span>
          </button>
        ))}
      </div>

      <div className="lead-tools">
        <label className="lead-search">
          <Search size={15} aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, company, keyword" aria-label="Search leads" />
        </label>
        <select className="input sm" value={industry} onChange={(e) => setIndustry(e.target.value)} aria-label="Industry">
          <option value="">Any industry</option>
          {industries.map((i) => (
            <option key={i}>{i}</option>
          ))}
        </select>
        <select className="input sm" value={size} onChange={(e) => setSize(e.target.value)} aria-label="Employees">
          <option value="">Any size</option>
          {SIZE_BANDS.map(([l]) => (
            <option key={l} value={l}>
              {l} employees
            </option>
          ))}
        </select>
        <select className="input sm" value={status} onChange={(e) => setStatus(e.target.value as LeadStatus | '')} aria-label="Status">
          <option value="">Any status</option>
          {(['new', 'queued', 'contacted', 'interested', 'meeting', 'not-interested', 'bounced', 'unsubscribed'] as LeadStatus[]).map((s) => (
            <option key={s} value={s}>
              {s === 'not-interested' ? 'Not interested' : s === 'meeting' ? 'Meeting booked' : s[0]!.toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
        <label className="lead-sort">
          <ArrowDownWideNarrow size={15} aria-hidden />
          <select className="input sm" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort by">
            <option value="fit">Best fit first</option>
            <option value="name">Name</option>
            <option value="employees">Most employees</option>
            <option value="added">Newest</option>
          </select>
        </label>
      </div>

      {sel.length > 0 && (
        <div className="bulk-bar" role="region" aria-label="Selected leads">
          <strong>{plural(sel.length, 'lead')} selected</strong>
          <button className="btn btn-sm" onClick={() => runQualify(sel)}>
            <Sparkles size={14} />
            Qualify with Timmy
          </button>
          <button
            className="btn btn-sm"
            title={enrichApp(state) ? `Fill empty fields with ${enrichApp(state)!.name}` : 'Connect an enrichment provider in Connections'}
            onClick={() => (enrichApp(state) ? dispatch({ type: 'conn', op: { op: 'enrich', ids: sel } }) : dispatch({ type: 'navigate', route: { view: 'connections' } }))}
          >
            <Wand2 size={14} />
            {enrichApp(state) ? `Enrich · ${sel.length * (enrichApp(state)!.credits ?? 1)} credits` : 'Enrich…'}
          </button>
          <Menu
            label="Add to campaign"
            trigger={
              <>
                Add to campaign
                <ChevronDown size={14} />
              </>
            }
            items={[
              ...campaigns.map((c) => ({ label: `${c.name}${c.status === 'active' ? ' (active)' : ''}`, onSelect: () => (dispatch({ type: 'out', op: { op: 'addToCampaign', id: c.id, leads: sel } }), setPicked(new Set())) })),
              { label: 'New campaign with these leads', onSelect: () => dispatch({ type: 'navigate', route: { view: 'outbound', tab: 'campaigns', filter: `new:${sel.join(',')}` } }) },
            ]}
          />
          <button className="btn btn-sm btn-ghost" onClick={() => dispatch({ type: 'out', op: { op: 'save', ids: sel, saved: true } })}>
            <Star size={14} />
            Save
          </button>
          <button className="btn btn-sm btn-quiet-danger" onClick={() => (dispatch({ type: 'out', op: { op: 'removeLeads', ids: sel } }), setPicked(new Set()))}>
            <Trash2 size={14} />
            Delete
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setPicked(new Set())}>
            Clear
          </button>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="section">
          <EmptyState
            icon={Users}
            title={all.length ? 'No leads match' : 'No leads yet'}
            body={all.length ? 'Try a different filter or search.' : 'Import a CSV from Apollo, Clay, HubSpot or a spreadsheet, or add a lead by hand.'}
            action={
              !all.length ? (
                <button className="btn btn-primary btn-sm" onClick={() => setImporting(true)}>
                  Import CSV
                </button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="lead-table-wrap">
          <table className="lead-table">
            <thead>
              <tr>
                <th className="col-check">
                  <input type="checkbox" aria-label="Select all shown" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(shown.map((l) => l.id)))} />
                </th>
                <th>Name</th>
                <th>Company</th>
                <th className="num">Employees</th>
                <th>Fit</th>
                <th>Qualify account</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {shown.map((l) => (
                <LeadRow
                  key={l.id}
                  l={l}
                  fit={fits.get(l.id)!}
                  picked={picked.has(l.id)}
                  current={r?.id === l.id}
                  running={running.has(l.id)}
                  onPick={() => toggle(l.id)}
                  onOpen={() => open(l.id)}
                  onQualify={() => runQualify([l.id])}
                />
              ))}
            </tbody>
          </table>
          {rows.length > shown.length && (
            <button className="btn btn-sm lead-more" onClick={() => setLimit((n) => n + 100)}>
              Show {Math.min(100, rows.length - shown.length)} more of {rows.length - shown.length}
            </button>
          )}
        </div>
      )}

      {importing && <ImportDialog onClose={() => setImporting(false)} />}
      {adding && <AddLeadDialog onClose={() => setAdding(false)} />}
    </>
  );
}

function LeadRow({ l, fit, picked, current, running, onPick, onOpen, onQualify }: { l: Lead; fit: ReturnType<ReturnType<typeof useFit>>; picked: boolean; current: boolean; running: boolean; onPick: () => void; onOpen: () => void; onQualify: () => void }) {
  const { state, dispatch } = useStore();
  const c = l.campaign ? state.out.campaigns[l.campaign] : undefined;
  return (
    <tr className={`${picked ? 'picked' : ''}${current ? ' current' : ''}`}>
      <td className="col-check">
        <input type="checkbox" aria-label={`Select ${name(l)}`} checked={picked} onChange={onPick} />
      </td>
      <td>
        <button className="lead-name" onClick={onOpen}>
          <LeadMark lead={l} />
          <span>
            <span className="lead-name-text">{name(l)}</span>
            <span className="lead-sub">
              {l.title ?? '—'}
              {leadOrigin(l) && <span className="lead-origin"> · {leadOrigin(l)}</span>}
            </span>
          </span>
        </button>
      </td>
      <td>
        <div className="lead-co">
          <LeadMark lead={l} size={22} company />
          <span className="lead-co-text">
            <span className="lead-co-name">{l.company}</span>
            <span className="lead-sub">{[l.industry, l.city].filter(Boolean).join(' · ') || '—'}</span>
          </span>
          <span className="lead-links">
            {l.website && (
              <a href={l.website} target="_blank" rel="noreferrer" aria-label={`${l.company} website`}>
                <Globe size={14} />
              </a>
            )}
            {l.linkedin && (
              <a href={l.linkedin} target="_blank" rel="noreferrer" aria-label={`${name(l)} on LinkedIn`}>
                <Briefcase size={14} />
              </a>
            )}
          </span>
        </div>
      </td>
      <td className="num">{l.employees ?? '—'}</td>
      <td>
        <FitBadge fit={fit} />
      </td>
      <td>
        {running ? (
          <span className="qual running">
            <Sparkles size={13} /> Checking…
          </span>
        ) : l.qualified ? (
          <span className={`qual q-${l.qualified.verdict}`} title={l.qualified.why}>
            {l.qualified.verdict === 'yes' ? <Check size={13} /> : null}
            {l.qualified.verdict === 'yes' ? 'Fits' : l.qualified.verdict === 'maybe' ? 'Maybe' : 'Skip'}
            <span className="qual-why">{l.qualified.why}</span>
          </span>
        ) : (
          <button className="qual-run" onClick={onQualify}>
            <Sparkles size={13} />
            Run
          </button>
        )}
      </td>
      <td>
        <span className="lead-status">
          <StatusChip status={l.status} />
          {c && <span className="lead-sub">{c.name}</span>}
        </span>
      </td>
      <td className="lead-act">
        <button className={`icon-btn sm${l.saved ? ' on' : ''}`} aria-label={l.saved ? `Unsave ${name(l)}` : `Save ${name(l)}`} aria-pressed={!!l.saved} onClick={() => dispatch({ type: 'out', op: { op: 'save', ids: [l.id], saved: !l.saved } })}>
          <Star size={15} />
        </button>
      </td>
    </tr>
  );
}

/* ───────────── Import ───────────── */

function ImportDialog({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [text, setText] = useState('');
  const [listName, setListName] = useState(`${new Date(2026, 10, 16).toISOString().slice(0, 10)} Import`);
  const [fields, setFields] = useState<LeadField[] | null>(null);
  const rows = useMemo(() => (text.trim() ? parseCsv(text) : []), [text]);
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  const map = fields && fields.length === header.length ? fields : guessFields(header);
  const existing = new Set(Object.values(state.out.leads).map((l) => l.email.toLowerCase()).filter(Boolean));

  const leads: Lead[] = body.map((row) => {
    const get = (f: LeadField) => {
      const i = map.indexOf(f);
      return i >= 0 ? (row[i] ?? '').trim() : '';
    };
    const full = get('name');
    // "Doe, Jane" is last, first.
    const [f0, ...rest] = full.includes(',') ? [full.split(',')[1]!.trim(), full.split(',')[0]!.trim()] : full.split(/\s+/);
    const extra: Record<string, string> = {};
    map.forEach((f, i) => f === 'extra' && row[i] && (extra[header[i]!] = row[i]!));
    const site = get('website');
    // "60-80" or "51–200" is a range: keep the low end, not 6080.
    const emp = parseInt((get('employees').match(/\d[\d,]*/)?.[0] ?? '').replace(/,/g, ''), 10);
    return {
      id: newId(),
      first: get('first') || f0 || '',
      last: get('last') || rest.join(' '),
      email: get('email').trim().toLowerCase(),
      phone: get('phone') || undefined,
      title: get('title') || undefined,
      company: get('company') || (site ? site.replace(/^https?:\/\/(www\.)?/, '').split('.')[0]! : '—'),
      website: site ? (site.startsWith('http') ? site : `https://${site}`) : undefined,
      linkedin: get('linkedin') || undefined,
      employees: Number.isFinite(emp) ? emp : undefined,
      industry: get('industry') || undefined,
      keywords: get('keywords') ? get('keywords').split(/[;,|]/).map((k) => k.trim()).filter(Boolean) : undefined,
      city: get('city') || undefined,
      source: 'import',
      added: new Date(2026, 10, 16, 8, 12),
      status: 'new',
      extra: Object.keys(extra).length ? extra : undefined,
    } satisfies Lead;
  });
  const seen = new Set<string>();
  // Already in Timmy, or the same address twice in this file (any capitalisation).
  const dupes = leads.filter((l) => {
    if (!l.email) return false;
    const k = l.email.toLowerCase();
    if (existing.has(k) || seen.has(k)) return true;
    seen.add(k);
    return false;
  });
  const noEmail = leads.filter((l) => !l.email);
  const bad = leads.filter((l) => l.email && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/i.test(l.email));
  const ok = leads.filter((l) => !dupes.includes(l) && !bad.includes(l) && (l.first || l.company !== '—'));

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setText(await file.text());
    setFields(null);
    if (!listName || /Import$/.test(listName)) setListName(file.name.replace(/\.(csv|tsv|txt)$/i, ''));
  };

  const doImport = () => {
    const id = `list-${Date.now().toString(36)}`;
    dispatch({ type: 'out', op: { op: 'import', list: { id, name: listName.trim() || 'Imported leads', source: 'csv', created: new Date(2026, 10, 16, 8, 12) }, leads: ok.map((l) => ({ ...l, list: id })) } });
    dispatch({ type: 'navigate', route: { view: 'outbound', tab: 'leads', list: id } });
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Import leads"
      description="Paste rows from a spreadsheet or choose a CSV. Timmy matches the columns; check them before you import."
      width={760}
      footer={
        <>
          <span className="modal-foot-note">{rows.length ? `${plural(ok.length, 'lead')} ready${dupes.length ? ` · ${dupes.length} duplicate${dupes.length === 1 ? '' : 's'} skipped` : ''}${bad.length ? ` · ${bad.length} invalid email${bad.length === 1 ? '' : 's'} skipped` : ''}${noEmail.length ? ` · ${noEmail.length} without email` : ''}` : ''}</span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!ok.length} onClick={doImport}>
            Import {ok.length ? plural(ok.length, 'lead') : ''}
          </button>
        </>
      }
    >
      {!rows.length ? (
        <div className="imp-start">
          <label className="imp-drop">
            <Upload size={22} aria-hidden />
            <strong>Choose a CSV file</strong>
            <span>Exports from Apollo, Clay, HubSpot, Sheets or Excel</span>
            <input type="file" accept=".csv,.tsv,.txt,text/csv" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          <Field label="Or paste rows, with a header row">
            <textarea className="input textarea imp-paste" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={'First Name,Last Name,Email,Company,Title\nNora,Castellanos,nora@example.com,Lakeview Dental,Practice Manager'} />
          </Field>
          <button className="link-btn" onClick={() => setText(SAMPLE_CSV)}>
            Use a 5-row sample
          </button>
        </div>
      ) : (
        <div className="imp-map">
          <Field label="List name">
            <input className="input" value={listName} onChange={(e) => setListName(e.target.value)} />
          </Field>
          <div className="imp-table-wrap">
            <table className="imp-table">
              <thead>
                <tr>
                  {header.map((h, i) => (
                    <th key={i}>
                      <span className="imp-col">{h || `Column ${i + 1}`}</span>
                      <select
                        className="input sm"
                        aria-label={`Import “${h}” as`}
                        value={map[i]}
                        onChange={(e) => {
                          const next = [...map];
                          next[i] = e.target.value as LeadField;
                          setFields(next);
                        }}
                      >
                        {(Object.keys(FIELD_LABELS) as LeadField[]).map((f) => (
                          <option key={f} value={f}>
                            {FIELD_LABELS[f]}
                          </option>
                        ))}
                      </select>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.slice(0, 4).map((row, ri) => (
                  <tr key={ri}>
                    {header.map((_, i) => (
                      <td key={i} className={map[i] === 'skip' ? 'skip' : ''}>
                        {row[i] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {body.length > 4 && <p className="muted imp-more">and {plural(body.length - 4, 'more row')}</p>}
          {!map.includes('email') && <p className="imp-warn">No email column matched. Pick one, or these leads can only be called or texted.</p>}
          <button
            className="link-btn"
            onClick={() => {
              setText('');
              setFields(null);
            }}
          >
            Start over
          </button>
        </div>
      )}
    </Modal>
  );
}

function AddLeadDialog({ onClose }: { onClose: () => void }) {
  const { dispatch } = useStore();
  const [f, setF] = useState({ first: '', last: '', email: '', company: '', title: '', phone: '' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const ok = f.first.trim() && (f.email.trim() || f.phone.trim()) && f.company.trim();
  const save = () => {
    dispatch({ type: 'out', op: { op: 'addLead', lead: { id: newId(), first: f.first.trim(), last: f.last.trim(), email: f.email.trim(), company: f.company.trim(), title: f.title.trim() || undefined, phone: f.phone.trim() || undefined, source: 'manual', list: undefined, added: new Date(2026, 10, 16, 8, 12), status: 'new' } } });
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Add a lead"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!ok} onClick={save}>
            Add lead
          </button>
        </>
      }
    >
      <div className="field-row">
        <Field label="First name">
          <input className="input" value={f.first} onChange={set('first')} />
        </Field>
        <Field label="Last name">
          <input className="input" value={f.last} onChange={set('last')} />
        </Field>
        <Field label="Email">
          <input className="input" type="email" value={f.email} onChange={set('email')} />
        </Field>
        <Field label="Phone" hint="Optional. Texts only go to leads who agree to them.">
          <input className="input" value={f.phone} onChange={set('phone')} />
        </Field>
        <Field label="Company">
          <input className="input" value={f.company} onChange={set('company')} />
        </Field>
        <Field label="Job title">
          <input className="input" value={f.title} onChange={set('title')} />
        </Field>
      </div>
    </Modal>
  );
}

/* ───────────── Find leads ───────────── */

/** Timmy finds leads that fit your offer and adds them, enriched, within your daily limit. Nothing is sent. */
function FindLeadsButton() {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const e = state.conn.enrich;
  const app = enrichApp(state);
  const room = Math.max(0, e.perDay - e.foundToday);
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>
        <Radar size={15} />
        Find leads
      </button>
      {open && (
        <Modal
          open
          onClose={() => setOpen(false)}
          title="Find leads that fit your offer"
          description={`Timmy searches for people who match “${state.out.offer.name}” and adds them to “Found by Timmy”${app ? `, enriched with ${app.name}` : ''}. Nothing is sent.`}
          width={520}
          footer={
            <>
              <button className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                className="btn btn-sm btn-primary"
                disabled={!room}
                onClick={() => {
                  dispatch({ type: 'conn', op: { op: 'find', query: q || '10' } });
                  dispatch({ type: 'navigate', route: { view: 'outbound', tab: 'leads', list: 'list-found' } });
                  setOpen(false);
                }}
              >
                <Radar size={14} /> Find and add
              </button>
            </>
          }
        >
          <Field label="What to look for" hint="Optional. For example: 15 dental practices in Austin. Blank uses your offer’s ideal customer.">
            <input className="input" value={q} placeholder="10 leads that fit my offer" onChange={(x) => setQ(x.target.value)} data-autofocus />
          </Field>
          <p className="field-hint">
            {room} of {e.perDay} left today · {e.credits} enrichment credits left this month{app ? '' : ' · no enrichment provider connected'}
          </p>
        </Modal>
      )}
    </>
  );
}
