/*
 * Campaigns: every sequence you run, with how it's doing and how much of
 * today's sending limit it uses. New campaign: pick leads, and Timmy writes the
 * sequence from your offer (or start from templates, or blank).
 */
import { Pause, Play, Plus, Rocket, Send, Sparkles } from 'lucide-react';
import { useState } from 'react';
import type { Campaign } from '../../data/outbound-types';
import { fmtDay, plural } from '../../lib/format';
import { campaignCap, fitOf, mailboxCap, pct, project, statsOf, writeSequence } from '../../lib/outbound';
import { ctxOf } from '../../state/outbound';
import { useStore } from '../../state/store';
import { EmptyState, Field, Modal, Segmented } from '../../components/kit';
import { ChannelIcon, Meter } from './shared';

const STATUS_LABEL: Record<Campaign['status'], string> = { draft: 'Draft', review: 'Waiting for your OK', active: 'Active', paused: 'Paused', completed: 'Completed' };

export function CampaignStatus({ c }: { c: Campaign }) {
  return <span className={`cstat cs-${c.status}`}>{STATUS_LABEL[c.status]}</span>;
}

export function CampaignsTab() {
  const { state, dispatch } = useStore();
  const r = state.route.view === 'outbound' ? state.route : null;
  const preset = r?.filter?.startsWith('new:') ? r.filter.slice(4).split(',').filter(Boolean) : null;
  const [creating, setCreating] = useState(!!preset);
  const list = Object.values(state.out.campaigns).sort((a, b) => order(a) - order(b) || b.created.getTime() - a.created.getTime());

  return (
    <>
      <div className="out-head">
        <div>
          <h1 className="page-title">Campaigns</h1>
          <p className="page-sub">Sequences across email, calls and texts. Each one stays inside your sending window and daily limits, and stops for a lead the moment they reply.</p>
        </div>
        <div className="out-head-actions">
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <Plus size={15} />
            New campaign
          </button>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="section">
          <EmptyState icon={Send} title="No campaigns yet" body="Pick leads and Timmy writes a sequence from your offer." action={<button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>New campaign</button>} />
        </div>
      ) : (
        <div className="camp-list">
          {list.map((c) => (
            <CampaignCard key={c.id} c={c} />
          ))}
        </div>
      )}

      {creating && (
        <NewCampaign
          preset={preset ?? undefined}
          onCreated={() => setCreating(false)}
          onClose={() => {
            setCreating(false);
            if (preset) dispatch({ type: 'navigate', route: { view: 'outbound', tab: 'campaigns' } });
          }}
        />
      )}
    </>
  );
}

const order = (c: Campaign) => ({ review: 0, active: 1, paused: 2, draft: 3, completed: 4 })[c.status];

function CampaignCard({ c }: { c: Campaign }) {
  const { state, dispatch } = useStore();
  const st = statsOf(c, state.out.leads, state.out.messages);
  const cap = campaignCap(c, state.out.mailboxes, state.out.limits);
  const plan = c.status === 'active' ? project(c, state.out.leads, ctxOf(state)) : null;
  const today = plan?.days[0] && plan.days[0].day.toDateString() === new Date(2026, 10, 16).toDateString() ? plan.days[0] : undefined;
  const go = (tab: 'analytics' | 'sequence' = 'analytics') => dispatch({ type: 'navigate', route: { view: 'campaign', id: c.id, tab } });
  return (
    <article className="card camp-card">
      <header className="camp-card-head">
        <div className="camp-card-title">
          <button className="camp-name" onClick={() => go(c.status === 'draft' || c.status === 'review' ? 'sequence' : 'analytics')}>
            {c.name}
          </button>
          <span className="camp-meta">
            <CampaignStatus c={c} />
            <span>
              {plural(c.leads.length, 'lead')} · {plural(c.steps.length, 'step')}
            </span>
            <span className="camp-chs" aria-label="Channels">
              {[...new Set(c.steps.map((s) => s.channel))].map((ch) => (
                <ChannelIcon key={ch} channel={ch} size={13} />
              ))}
            </span>
            {c.launched && <span>since {fmtDay(c.launched)}</span>}
          </span>
        </div>
        <div className="camp-card-actions">
          {c.status === 'active' ? (
            <button className="btn btn-sm" onClick={() => dispatch({ type: 'out', op: { op: 'pause', id: c.id } })}>
              <Pause size={14} />
              Pause
            </button>
          ) : c.status === 'paused' ? (
            <button className="btn btn-sm" onClick={() => dispatch({ type: 'out', op: { op: 'launch', id: c.id } })}>
              <Play size={14} />
              Resume
            </button>
          ) : (
            <button className="btn btn-sm btn-primary" onClick={() => go('sequence')}>
              {c.status === 'review' ? <Rocket size={14} /> : null}
              {c.status === 'review' ? 'Review and launch' : 'Finish setting up'}
            </button>
          )}
        </div>
      </header>
      {st.sent > 0 || st.calls > 0 ? (
        <dl className="camp-stats">
          <div>
            <dt>Sent</dt>
            <dd>{st.sent}</dd>
          </div>
          <div>
            <dt>Opened</dt>
            <dd>{pct(st.opened, st.sent - st.bounced)}</dd>
          </div>
          <div>
            <dt>Replied</dt>
            <dd>{pct(st.replied, st.contacted)}</dd>
          </div>
          <div>
            <dt>Interested</dt>
            <dd>{st.interested}</dd>
          </div>
          <div>
            <dt>Meetings</dt>
            <dd>{st.meetings}</dd>
          </div>
          <div>
            <dt>Bounced</dt>
            <dd>{pct(st.bounced, st.sent)}</dd>
          </div>
        </dl>
      ) : (
        <p className="camp-empty">{c.leads.length ? 'Nothing sent yet.' : 'No leads yet: add some from Leads.'}</p>
      )}
      {c.status === 'active' && <Meter used={today?.email ?? 0} cap={cap} label="Planned today" unit="emails" calm />}
    </article>
  );
}

/* ───────────── New campaign ───────────── */

type Source = 'picked' | 'best' | 'list';

function NewCampaign({ onClose, onCreated, preset }: { onClose: () => void; onCreated: () => void; preset?: string[] }) {
  const { state, dispatch } = useStore();
  const lists = Object.values(state.out.lists).filter((l) => l.source !== 'form');
  const free = (id: string) => {
    const l = state.out.leads[id];
    return !!l && l.status === 'new' && !l.campaign && !!l.email;
  };
  const netNew = Object.values(state.out.leads).filter((l) => free(l.id));
  const [nameText, setName] = useState(preset ? 'New outreach' : `${state.out.offer.name[0]!.toUpperCase()}${state.out.offer.name.slice(1)}: new leads`);
  const [source, setSource] = useState<Source>(preset ? 'picked' : 'best');
  const [list, setList] = useState(lists[0]?.id ?? '');
  const [writer, setWriter] = useState<'timmy' | 'blank'>('timmy');
  const [call, setCall] = useState(!!state.out.channels.call?.connected);
  const boxes = Object.values(state.out.mailboxes);
  const [mailboxes, setMailboxes] = useState<string[]>(boxes.filter((m) => !Object.values(state.out.campaigns).some((c) => c.status === 'active' && c.options.mailboxes.includes(m.id))).map((m) => m.id).slice(0, 2));
  const room = boxes.filter((m) => mailboxes.includes(m.id)).reduce((n, m) => n + mailboxCap(m, state.out.limits), 0);
  const [limit, setLimit] = useState(Math.min(state.out.limits.perMailbox, room || state.out.limits.perMailbox));

  const leads =
    source === 'picked'
      ? (preset ?? []).filter(free)
      : source === 'list'
        ? netNew.filter((l) => l.list === list).map((l) => l.id)
        : netNew.filter((l) => fitOf(l, state.out.offer).score >= 70).map((l) => l.id);

  const create = () => {
    const id = `camp-${Date.now().toString(36)}`;
    const c: Campaign = {
      id,
      name: nameText.trim() || 'New campaign',
      status: 'draft',
      created: new Date(2026, 10, 16, 8, 12),
      leads: [],
      steps: writer === 'timmy' ? writeSequence(state.out.offer, { call }) : [{ id: 'st1', channel: 'email', wait: 0, variants: [{ id: 'a', subject: '', body: '' }] }],
      schedule: { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', tz: 'America/New_York' },
      options: { dailyLimit: Math.min(limit, room), mailboxes, stopOnReply: true, trackOpens: false, unsubscribe: true, plainText: true },
    };
    dispatch({ type: 'out', op: { op: 'campaign', campaign: c, quiet: true } });
    if (leads.length) dispatch({ type: 'out', op: { op: 'addToCampaign', id, leads } });
    dispatch({ type: 'navigate', route: { view: 'campaign', id, tab: 'sequence' } });
    onCreated();
  };

  const plan = project(
    {
      id: 'preview',
      name: '',
      status: 'active',
      created: new Date(),
      leads,
      steps: writeSequence(state.out.offer, { call }),
      schedule: { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', tz: '' },
      options: { dailyLimit: Math.min(limit, room), mailboxes, stopOnReply: true, trackOpens: false, unsubscribe: true, plainText: true },
    },
    state.out.leads,
    ctxOf(state),
  );

  return (
    <Modal
      open
      onClose={onClose}
      title="New campaign"
      width={620}
      footer={
        <>
          <span className="modal-foot-note">{leads.length ? `${plural(leads.length, 'lead')}${plan.finish ? ` · last step ${fmtDay(plan.finish)} at this limit` : ''}` : 'No leads match yet'}</span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!mailboxes.length} onClick={create}>
            {writer === 'timmy' ? <Sparkles size={14} /> : null}
            {writer === 'timmy' ? 'Write the sequence' : 'Create campaign'}
          </button>
        </>
      }
    >
      <div className="msg-form">
        <Field label="Name">
          <input className="input" value={nameText} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Leads" hint="Net-new leads with an email address. Best fits are Good and above against your offer; anyone in an active campaign is skipped.">
          <Segmented<Source>
            label="Leads"
            value={source}
            onChange={setSource}
            options={[
              ...(preset ? [{ id: 'picked' as Source, label: `The ${preset.filter(free).length} you picked` }] : []),
              { id: 'best', label: 'Best fits' },
              { id: 'list', label: 'A whole list' },
            ]}
          />
          {source === 'picked' && preset && preset.filter(free).length < preset.length && (
            <p className="seq-hint warn">
              {preset.length - preset.filter(free).length} of the {preset.length} you picked {preset.length - preset.filter(free).length === 1 ? 'is' : 'are'} already in a campaign, contacted, or without an email, so {preset.length - preset.filter(free).length === 1 ? 'it’s' : 'they’re'} left out.
            </p>
          )}
          {source === 'list' && (
            <select className="input" value={list} onChange={(e) => setList(e.target.value)} aria-label="List">
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Sequence">
          <Segmented
            label="Sequence"
            value={writer}
            onChange={setWriter}
            options={[
              { id: 'timmy', label: 'Timmy writes it' },
              { id: 'blank', label: 'Start blank' },
            ]}
          />
          {writer === 'timmy' && (
            <p className="field-hint">
              An A/B first email, a bump, {call ? 'a call, ' : ''}a case study and a break-up, from “{state.out.offer.name}”. You review every step before launch.{' '}
              {state.out.channels.call?.connected && (
                <label className="inline-check">
                  <input type="checkbox" checked={call} onChange={(e) => setCall(e.target.checked)} /> Include a call step
                </label>
              )}
            </p>
          )}
        </Field>
        <Field label="Send from" hint={`Each mailbox sends at most ${state.out.limits.perMailbox} cold emails a day; new ones start lower while they warm up.`}>
          <div className="mb-picks">
            {boxes.map((m) => (
              <label key={m.id} className="mb-pick">
                <input type="checkbox" checked={mailboxes.includes(m.id)} onChange={(e) => setMailboxes(e.target.checked ? [...mailboxes, m.id] : mailboxes.filter((x) => x !== m.id))} />
                <span>{m.address}</span>
                <span className="muted">{mailboxCap(m, state.out.limits)} a day</span>
              </label>
            ))}
          </div>
        </Field>
        <Field label="New emails a day" hint={room ? `Up to ${room} across the mailboxes you picked.` : 'Pick a mailbox first.'}>
          <input className="input sm num-input" type="number" min={1} max={room || 1} value={limit} onChange={(e) => setLimit(Math.max(1, Math.min(room || 1, Number(e.target.value) || 1)))} />
        </Field>
      </div>
    </Modal>
  );
}
