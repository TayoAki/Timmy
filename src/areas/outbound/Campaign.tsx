/*
 * One campaign: Analytics, Leads, Sequence, Schedule and Options. The
 * sequence editor lists the steps on the left (each with its channel, A/B
 * variants and the wait before it) and edits the chosen one on the right, with
 * variables, a preview for any lead, Timmy's rewrite and deliverability checks.
 */
import { ArrowLeft, Braces, Copy, Eye, Pause, Play, Plus, Rocket, Sparkles, Trash2, TriangleAlert, Wand2 } from 'lucide-react';
import { useState } from 'react';
import type { Campaign, Channel, SeqStep } from '../../data/outbound-types';
import { NOW } from '../../data/mock';
import { fmtDay, fmtTime, plural } from '../../lib/format';
import { campaignCap, lint, mailboxCap, pct, project, rewrite, statsOf, VARIABLES } from '../../lib/outbound';
import { canText, ctxOf, fill, launchProblem } from '../../state/outbound';
import { useStore } from '../../state/store';
import { Frame } from '../../components/Frame';
import { Field, Menu, Modal } from '../../components/kit';
import { CampaignStatus } from './Campaigns';
import { CHANNEL, ChannelIcon, LeadMark, Meter, StatusChip, name } from './shared';

type Tab = 'analytics' | 'leads' | 'sequence' | 'schedule' | 'options';

export function CampaignView() {
  const { state, dispatch } = useStore();
  const r = state.route.view === 'campaign' ? state.route : null;
  const c = r ? state.out.campaigns[r.id] : undefined;
  const [launching, setLaunching] = useState(false);
  if (!r || !c) return <Frame tabs={[]} active="" onTab={() => undefined}><p className="page-sub">That campaign was deleted.</p></Frame>;
  const nav = (tab: Tab) => dispatch({ type: 'navigate', route: { view: 'campaign', id: c.id, tab } });
  const set = (patch: Partial<Campaign>) => dispatch({ type: 'out', op: { op: 'patchCampaign', id: c.id, patch } });
  const problem = launchProblem(state, c);

  return (
    <Frame
      tabs={[
        { id: 'analytics', label: 'Analytics' },
        { id: 'leads', label: 'Leads', count: c.leads.length },
        { id: 'sequence', label: 'Sequence', count: c.steps.length },
        { id: 'schedule', label: 'Schedule' },
        { id: 'options', label: 'Options' },
      ]}
      active={r.tab}
      onTab={(id) => nav(id as Tab)}
      wide
      scrollKey={`camp-${c.id}-${r.tab}`}
    >
      <div className="camp-top">
        <button className="btn btn-xs btn-ghost" onClick={() => dispatch({ type: 'navigate', route: { view: 'outbound', tab: 'campaigns' } })}>
          <ArrowLeft size={13} />
          Campaigns
        </button>
        <div className="camp-title-row">
          <input className="camp-title" value={c.name} aria-label="Campaign name" onChange={(e) => set({ name: e.target.value })} />
          <CampaignStatus c={c} />
          <span className="camp-title-actions">
            {c.status === 'active' ? (
              <button className="btn btn-sm" onClick={() => dispatch({ type: 'out', op: { op: 'pause', id: c.id } })}>
                <Pause size={14} />
                Pause
              </button>
            ) : (
              <button className="btn btn-sm btn-primary" onClick={() => setLaunching(true)}>
                {c.status === 'paused' ? <Play size={14} /> : <Rocket size={14} />}
                {c.status === 'paused' ? 'Resume campaign' : 'Launch'}
              </button>
            )}
            <Menu
              items={[
                {
                  label: 'Duplicate',
                  icon: Copy,
                  onSelect: () => {
                    const id = `camp-${Date.now().toString(36)}`;
                    dispatch({ type: 'out', op: { op: 'campaign', campaign: { ...c, id, name: `${c.name} (copy)`, status: 'draft', leads: [], launched: undefined, created: NOW } } });
                    dispatch({ type: 'navigate', route: { view: 'campaign', id, tab: 'sequence' } });
                  },
                },
                { label: 'Delete campaign', icon: Trash2, danger: true, onSelect: () => (dispatch({ type: 'out', op: { op: 'removeCampaign', id: c.id } }), dispatch({ type: 'navigate', route: { view: 'outbound', tab: 'campaigns' } })) },
              ]}
            />
          </span>
        </div>
        {c.status === 'review' && <p className="camp-banner">Timmy prepared this campaign. It waits in Approvals until you launch it; review each step first.</p>}
        {c.status !== 'active' && c.status !== 'completed' && problem && (
          <p className="camp-banner warn">
            <TriangleAlert size={14} aria-hidden /> Before launch: {problem}
          </p>
        )}
      </div>

      {r.tab === 'analytics' && <Analytics c={c} />}
      {r.tab === 'leads' && <CampaignLeads c={c} />}
      {r.tab === 'sequence' && <Sequence c={c} />}
      {r.tab === 'schedule' && <Schedule c={c} />}
      {r.tab === 'options' && <Options c={c} />}
      {launching && <LaunchDialog c={c} onClose={() => setLaunching(false)} />}
    </Frame>
  );
}

/* ───────────── Analytics ───────────── */

function Analytics({ c }: { c: Campaign }) {
  const { state } = useStore();
  const st = statsOf(c, state.out.leads, state.out.messages);
  const cap = campaignCap(c, state.out.mailboxes, state.out.limits);
  const plan = c.status === 'active' ? project(c, state.out.leads, ctxOf(state)) : null;
  const today = plan?.days.find((d) => d.day.toDateString() === NOW.toDateString());
  const tiles: [string, string, string?][] = [
    ['Leads', String(st.leads)],
    ['Contacted', String(st.contacted), pct(st.contacted, st.leads)],
    ['Emails sent', String(st.sent)],
    ['Opened', pct(st.opened, st.sent - st.bounced), `${st.opened} opens`],
    ['Replied', pct(st.replied, st.contacted), plural(st.replied, 'reply', 'replies')],
    ['Interested', String(st.interested), `${st.meetings} booked`],
    ['Calls', String(st.calls)],
    ['Bounced', pct(st.bounced, st.sent), st.bounced > 0 && st.bounced / Math.max(st.sent, 1) >= state.out.limits.bouncePause ? 'Paused at this rate' : `pauses at ${Math.round(state.out.limits.bouncePause * 100)}%`],
  ];
  // The last 10 sending days, then today's plan.
  const days = st.byDay.slice(-10);
  // Headroom above the limit line so it never meets the title.
  const max = Math.max(cap, ...days.map((d) => d.sent), today?.email ?? 0, 1) * 1.18;
  return (
    <>
      {st.sent === 0 && st.calls === 0 ? (
        <p className="page-sub">Nothing has gone out yet. Numbers show up here after launch.</p>
      ) : (
        <dl className="stat-tiles">
          {tiles.map(([k, v, sub]) => (
            <div key={k} className="stat-tile">
              <dt>{k}</dt>
              <dd>{v}</dd>
              {sub && <span className="stat-sub">{sub}</span>}
            </div>
          ))}
        </dl>
      )}

      {(days.length > 0 || today) && (
        <section className="section" aria-labelledby="sends-title">
          <div className="section-head">
            <h2 className="section-title" id="sends-title">
              Cold emails a day
            </h2>
            <span className="section-sub">Never more than {cap} a day: the campaign’s limit, inside each mailbox’s cap</span>
          </div>
          <div className="sends-chart" role="list" aria-label="Emails sent per sending day">
            <div className="sends-limit" style={{ bottom: `${(cap / max) * 100}%` }}>
              <span>Limit {cap}</span>
            </div>
            {days.map((d) => (
              <div key={d.day.toISOString()} className="sends-col" role="listitem" tabIndex={0} aria-label={`${fmtDay(d.day)}: ${d.sent} sent`}>
                <span className="sends-tip">
                  {fmtDay(d.day)}: {d.sent} sent
                </span>
                <span className="sends-bar" style={{ height: `${(d.sent / max) * 100}%` }} />
                <span className="sends-day">{d.day.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}</span>
              </div>
            ))}
            {today && (
              <div className="sends-col" role="listitem" tabIndex={0} aria-label={`Today: ${today.email} planned from ${c.schedule.start}`}>
                <span className="sends-tip">
                  Today: {today.email} planned from {c.schedule.start.replace(/^0/, '')}
                </span>
                <span className="sends-bar planned" style={{ height: `${(today.email / max) * 100}%` }} />
                <span className="sends-day">Today</span>
              </div>
            )}
          </div>
          {today && (
            <p className="chart-legend">
              <span className="lg lg-sent" /> Sent <span className="lg lg-planned" /> Planned today
            </p>
          )}
        </section>
      )}

      <section className="section" aria-labelledby="steps-title">
        <div className="section-head">
          <h2 className="section-title" id="steps-title">
            By step
          </h2>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Step</th>
              <th className="num">Sent</th>
              <th className="num">Opened</th>
              <th className="num">Replies</th>
            </tr>
          </thead>
          <tbody>
            {c.steps.map((s, i) => (
              <tr key={s.id}>
                <td>
                  <span className="step-cell">
                    <ChannelIcon channel={s.channel} />
                    Step {i + 1}: {CHANNEL[s.channel].label}
                    {s.channel === 'email' && <span className="muted"> · {s.variants[0]!.subject || 'no subject'}</span>}
                  </span>
                </td>
                <td className="num">{st.byStep[i]?.sent ?? 0}</td>
                <td className="num">{s.channel === 'email' ? pct(st.byStep[i]?.opened ?? 0, st.byStep[i]?.sent ?? 0) : '—'}</td>
                <td className="num">{st.byStep[i]?.replied ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {plan?.finish && (
        <p className="page-sub">
          At {cap} a day, the last step goes out {fmtDay(plan.finish)}. Follow-ups go first each day; new leads fill what’s left of the limit.
        </p>
      )}
    </>
  );
}

/* ───────────── Leads in the campaign ───────────── */

function CampaignLeads({ c }: { c: Campaign }) {
  const { state, dispatch } = useStore();
  const [adding, setAdding] = useState(false);
  const leads = c.leads.map((id) => state.out.leads[id]).filter(Boolean) as NonNullable<(typeof state.out.leads)[string]>[];
  return (
    <>
      <div className="section-head">
        <p className="page-sub">{plural(leads.length, 'lead')}. A reply stops the sequence for that lead; unsubscribes and bounces are never contacted again.</p>
        <button className="btn btn-sm" onClick={() => setAdding(true)}>
          <Plus size={14} />
          Add leads
        </button>
      </div>
      <div className="lead-table-wrap">
        <table className="lead-table">
          <thead>
            <tr>
              <th>Lead</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Next</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => {
              const step = l.step ?? 0;
              const stopped = ['interested', 'meeting', 'not-interested', 'unsubscribed', 'bounced'].includes(l.status);
              return (
                <tr key={l.id}>
                  <td>
                    <button className="lead-name" onClick={() => dispatch({ type: 'navigate', route: { view: 'outbound', tab: 'leads', id: l.id } })}>
                      <LeadMark lead={l} />
                      <span>
                        <span className="lead-name-text">{name(l)}</span>
                        <span className="lead-sub">{l.company}</span>
                      </span>
                    </button>
                  </td>
                  <td>
                    <StatusChip status={l.status} />
                  </td>
                  <td>
                    <span className="progress-dots" aria-label={`Step ${Math.min(step, c.steps.length)} of ${c.steps.length} done`}>
                      {c.steps.map((s, i) => (
                        <span key={s.id} className={`pdot${i < step ? ' done' : ''}`} />
                      ))}
                    </span>
                  </td>
                  <td className="lead-sub">{stopped ? 'Stopped' : step >= c.steps.length ? 'Finished' : l.nextAt && c.status === 'active' ? `${CHANNEL[c.steps[step]!.channel].label}, ${fmtDay(l.nextAt)}` : 'After launch'}</td>
                  <td className="lead-act">
                    <button className="icon-btn sm" aria-label={`Remove ${name(l)}`} onClick={() => dispatch({ type: 'out', op: { op: 'removeFromCampaign', id: c.id, leads: [l.id] } })}>
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {adding && <AddLeadsDialog c={c} onClose={() => setAdding(false)} />}
    </>
  );
}

function AddLeadsDialog({ c, onClose }: { c: Campaign; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const pool = Object.values(state.out.leads).filter((l) => !c.leads.includes(l.id) && l.status === 'new' && !l.campaign && l.email);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  return (
    <Modal
      open
      onClose={onClose}
      title="Add leads"
      description="Net-new leads with an email address."
      width={560}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!picked.size} onClick={() => (dispatch({ type: 'out', op: { op: 'addToCampaign', id: c.id, leads: [...picked] } }), onClose())}>
            Add {picked.size ? plural(picked.size, 'lead') : ''}
          </button>
        </>
      }
    >
      {pool.length === 0 ? (
        <p className="page-sub">Every lead with an email is already in a campaign. Import more from Leads.</p>
      ) : (
        <ul className="pick-list">
          {pool.map((l) => (
            <li key={l.id}>
              <label className="pick-row">
                <input type="checkbox" checked={picked.has(l.id)} onChange={(e) => setPicked(new Set(e.target.checked ? [...picked, l.id] : [...picked].filter((x) => x !== l.id)))} />
                <LeadMark lead={l} size={24} />
                <span>
                  {name(l)} <span className="muted">· {l.title}, {l.company}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/* ───────────── Sequence ───────────── */

function Sequence({ c }: { c: Campaign }) {
  const { state, dispatch } = useStore();
  const [sel, setSel] = useState(0);
  const [variant, setVariant] = useState(0);
  const [preview, setPreview] = useState(false);
  const [tries, setTries] = useState(0);
  const i = Math.min(sel, c.steps.length - 1);
  const step = c.steps[i]!;
  const v = step.variants[Math.min(variant, step.variants.length - 1)]!;
  const vi = step.variants.indexOf(v);
  const steps = (next: SeqStep[]) => dispatch({ type: 'out', op: { op: 'patchCampaign', id: c.id, patch: { steps: next } } });
  const setStep = (patch: Partial<SeqStep>, at = i) => steps(c.steps.map((s, k) => (k === at ? { ...s, ...patch } : s)));
  const setVar = (patch: Partial<typeof v>) => setStep({ variants: step.variants.map((x, k) => (k === vi ? { ...x, ...patch } : x)) });
  const insert = (key: string) => setVar({ body: `${v.body}{{${key}}}` });
  const addStep = (channel: Channel) => {
    const next: SeqStep = { id: `st-${Date.now().toString(36)}`, channel, wait: c.steps.length ? 2 : 0, variants: [{ id: 'a', subject: channel === 'email' ? 'Re: {{companyName}}' : '', body: rewrite(state.out.offer, { id: '', channel, wait: 0, variants: [] }, 0).body }] };
    steps([...c.steps, next]);
    setSel(c.steps.length);
    setVariant(0);
  };
  const leads = c.leads.map((id) => state.out.leads[id]).filter(Boolean);
  const missing = new Set<string>();
  for (const l of leads) for (const k of [...`${v.subject} ${v.body}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!)) if (fill(state, `{{${k}}}`, l!).missing.length) missing.add(k);
  const warnings = step.channel === 'email' ? lint(v.subject, v.body, i === 0) : [];
  const textBlocked = step.channel === 'sms' ? leads.filter((l) => !canText(state, l!)).length : 0;

  return (
    <div className="seq">
      <ol className="seq-steps" aria-label="Steps">
        {c.steps.map((s, k) => (
          <li key={s.id} className="seq-step-wrap">
            {k > 0 && (
              <label className="seq-wait">
                Wait
                <input type="number" min={0} max={30} className="input sm num-input" value={s.wait} aria-label={`Days before step ${k + 1}`} onChange={(e) => setStep({ wait: Math.max(0, Math.min(30, Number(e.target.value) || 0)) }, k)} />
                days, then
              </label>
            )}
            <div className={`seq-step${k === i ? ' on' : ''}`}>
              <button className="seq-step-main" aria-current={k === i ? 'step' : undefined} onClick={() => (setSel(k), setVariant(0), setPreview(false))}>
                <span className="seq-step-head">
                  <ChannelIcon channel={s.channel} />
                  Step {k + 1}: {CHANNEL[s.channel].label}
                </span>
                {s.variants.map((x, j) => (
                  <span key={x.id} className="seq-step-var">
                    {s.variants.length > 1 && <span className="seq-var-tag">{String.fromCharCode(65 + j)}</span>}
                    {s.channel === 'email' ? x.subject || '<Empty subject>' : x.body.split('\n')[0] || '<Empty>'}
                  </span>
                ))}
              </button>
              {c.steps.length > 1 && (
                <button className="icon-btn sm seq-del" aria-label={`Delete step ${k + 1}`} onClick={() => (steps(c.steps.filter((_, x) => x !== k)), setSel(Math.max(0, k - 1)))}>
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          </li>
        ))}
        <li>
          <Menu
            label="Add step"
            trigger={
              <>
                <Plus size={14} />
                Add step
              </>
            }
            items={(['email', 'call', 'sms', 'linkedin', 'whatsapp'] as Channel[]).map((ch) => ({
              label: CHANNEL[ch].label,
              icon: CHANNEL[ch].icon,
              hint: ch === 'email' ? undefined : !state.out.channels[ch]?.connected ? 'Not connected' : ch === 'sms' ? 'Opted-in leads only' : undefined,
              disabled: ch !== 'email' && !state.out.channels[ch]?.connected,
              onSelect: () => addStep(ch),
            }))}
          />
        </li>
      </ol>

      <section className="seq-editor card" aria-label={`Step ${i + 1}`}>
        <header className="seq-ed-head">
          <div className="seq-var-tabs" role="tablist" aria-label="Variants">
            {step.variants.map((x, j) => (
              <button key={x.id} role="tab" aria-selected={j === vi} className="seq-var-tab" onClick={() => setVariant(j)}>
                Variant {String.fromCharCode(65 + j)}
              </button>
            ))}
            {step.channel === 'email' && step.variants.length < 3 && (
              <button className="seq-var-tab add" onClick={() => (setStep({ variants: [...step.variants, { id: `v${Date.now().toString(36)}`, ...rewrite(state.out.offer, step, step.variants.length) }] }), setVariant(step.variants.length))}>
                <Plus size={13} /> Add variant
              </button>
            )}
          </div>
          <div className="seq-ed-tools">
            <Menu
              label="Insert variable"
              trigger={
                <>
                  <Braces size={14} />
                  Variable
                </>
              }
              items={VARIABLES.map((x) => ({ label: x.label, hint: `{{${x.key}}}`, onSelect: () => insert(x.key) }))}
            />
            <button className="btn btn-sm" onClick={() => (setVar(rewrite(state.out.offer, step, tries + 1)), setTries(tries + 1))} title="Write this step again from your offer">
              <Wand2 size={14} />
              Rewrite
            </button>
            <button className="btn btn-sm" aria-pressed={preview} onClick={() => setPreview((p) => !p)}>
              <Eye size={14} />
              {preview ? 'Edit' : 'Preview'}
            </button>
            {step.variants.length > 1 && (
              <button className="icon-btn sm" aria-label={`Delete variant ${String.fromCharCode(65 + vi)}`} onClick={() => (setStep({ variants: step.variants.filter((_, j) => j !== vi) }), setVariant(0))}>
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </header>

        {preview ? (
          <Preview c={c} subject={v.subject} body={v.body} channel={step.channel} />
        ) : (
          <div className="seq-fields">
            {step.channel === 'email' && (
              <label className="seq-subject">
                <span className="field-label">Subject</span>
                <input className="seq-subject-input" value={v.subject} placeholder="Your subject" onChange={(e) => setVar({ subject: e.target.value })} />
              </label>
            )}
            <textarea
              className="seq-body"
              value={v.body}
              placeholder={step.channel === 'call' ? 'Talking points for the call…' : 'Start typing here…'}
              aria-label={step.channel === 'call' ? 'Call script' : 'Message'}
              onChange={(e) => setVar({ body: e.target.value })}
            />
          </div>
        )}

        <footer className="seq-ed-foot">
          {step.channel === 'call' && <p className="seq-hint">Call steps become a call list on the day, with this script. Log each outcome; a connect stops the sequence.</p>}
          {step.channel === 'sms' && (
            <p className={`seq-hint${textBlocked ? ' warn' : ''}`}>
              Texts only go to leads who agreed to them{textBlocked ? `. ${plural(textBlocked, 'lead')} in this campaign haven’t, so launch is blocked until you remove the step or them.` : '.'} Quiet hours {state.out.limits.sms.quietStart}–{state.out.limits.sms.quietEnd}; “Reply STOP to opt out” is required.
            </p>
          )}
          {missing.size > 0 && (
            <p className="seq-hint warn">
              <TriangleAlert size={13} aria-hidden /> {[...missing].map((k) => `{{${k}}}`).join(', ')} {missing.size === 1 ? 'is' : 'are'} empty for some leads in this campaign.
            </p>
          )}
          {warnings.map((w) => (
            <p key={w} className="seq-hint warn">
              <TriangleAlert size={13} aria-hidden /> {w}
            </p>
          ))}
          {!missing.size && !warnings.length && step.channel === 'email' && (
            <p className="seq-hint ok">
              <Sparkles size={13} aria-hidden /> {v.body.split(/\s+/).filter(Boolean).length} words, no spam-filter words{i === 0 ? ', no links' : ''}.
            </p>
          )}
        </footer>
      </section>
    </div>
  );
}

function Preview({ c, subject, body, channel }: { c: Campaign; subject: string; body: string; channel: Channel }) {
  const { state } = useStore();
  const leads = c.leads.map((id) => state.out.leads[id]).filter(Boolean);
  const [who, setWho] = useState(leads[0]?.id ?? '');
  const lead = state.out.leads[who] ?? leads[0];
  if (!lead) return <p className="seq-hint">Add leads to preview this step for one of them.</p>;
  const s = fill(state, subject, lead);
  const b = fill(state, body, lead);
  return (
    <div className="seq-preview">
      <label className="seq-preview-who">
        <span className="field-label">Preview for</span>
        <select className="input sm" value={lead.id} onChange={(e) => setWho(e.target.value)}>
          {leads.map((l) => (
            <option key={l!.id} value={l!.id}>
              {name(l!)}, {l!.company}
            </option>
          ))}
        </select>
      </label>
      {channel === 'email' && (
        <p className="seq-preview-subj">
          <span className="muted">Subject</span> {s.text}
        </p>
      )}
      <div className="seq-preview-body">
        {b.text.split(/\n/).map((line, k) => (
          <p key={k}>{line || ' '}</p>
        ))}
      </div>
      {[...s.missing, ...b.missing].length > 0 && <p className="seq-hint warn">Missing for {lead.first}: {[...new Set([...s.missing, ...b.missing])].join(', ')}</p>}
    </div>
  );
}

/* ───────────── Schedule ───────────── */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOURS = Array.from({ length: 29 }, (_, k) => `${String(6 + Math.floor(k / 2)).padStart(2, '0')}:${k % 2 ? '30' : '00'}`);
const label = (hhmm: string) => fmtTime(new Date(2026, 0, 1, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3))));

function Schedule({ c }: { c: Campaign }) {
  const { state, dispatch } = useStore();
  const set = (schedule: Partial<Campaign['schedule']>) => dispatch({ type: 'out', op: { op: 'patchCampaign', id: c.id, patch: { schedule: { ...c.schedule, ...schedule } } } });
  const plan = project({ ...c, status: 'active' }, state.out.leads, ctxOf(state));
  const upcoming = plan.days.filter((d) => d.email + d.calls + d.other > 0).slice(0, 8);
  const max = Math.max(1, ...upcoming.map((d) => d.email));
  return (
    <>
      <section className="section">
        <Field label="Sending days">
          <div className="day-toggles" role="group" aria-label="Sending days">
            {DAYS.map((d, k) => (
              <button key={d} className="day-toggle" aria-pressed={c.schedule.days.includes(k)} onClick={() => set({ days: c.schedule.days.includes(k) ? c.schedule.days.filter((x) => x !== k) : [...c.schedule.days, k].sort() })}>
                {d}
              </button>
            ))}
          </div>
        </Field>
        <div className="field-row">
          <Field label="From">
            <select className="input" value={c.schedule.start} onChange={(e) => set({ start: e.target.value })}>
              {HOURS.filter((h) => h < c.schedule.end).map((h) => (
                <option key={h} value={h}>
                  {label(h)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Until">
            <select className="input" value={c.schedule.end} onChange={(e) => set({ end: e.target.value })}>
              {HOURS.filter((h) => h > c.schedule.start).map((h) => (
                <option key={h} value={h}>
                  {label(h)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Time zone">
            <select className="input" value={c.schedule.tz} onChange={(e) => set({ tz: e.target.value })}>
              {['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Australia/Sydney'].map((z) => (
                <option key={z}>{z}</option>
              ))}
            </select>
          </Field>
        </div>
        <p className="field-hint">Sends spread out across the window, at least {state.out.limits.gapMinutes[0]} minutes apart per mailbox, so they read like one person writing.</p>
      </section>
      <section className="section" aria-labelledby="fc-title">
        <div className="section-head">
          <h2 className="section-title" id="fc-title">
            What goes out when
          </h2>
          <span className="section-sub">{plan.finish ? `Last step ${fmtDay(plan.finish)}` : 'Nothing to send'}</span>
        </div>
        {upcoming.length === 0 ? (
          <p className="page-sub">Add leads and at least one sending day to see the plan.</p>
        ) : (
          <ul className="fc-list">
            {upcoming.map((d) => (
              <li key={d.day.toISOString()} className="fc-row">
                <span className="fc-day">{d.day.toDateString() === NOW.toDateString() ? 'Today' : fmtDay(d.day)}</span>
                <span className="fc-track">
                  <span className="fc-bar" style={{ width: `${(d.email / max) * 100}%` }} />
                </span>
                <span className="fc-n">
                  {plural(d.email, 'email')}
                  {d.calls ? ` · ${plural(d.calls, 'call')}` : ''}
                  {d.other ? ` · ${d.other} other` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/* ───────────── Options ───────────── */

function Options({ c }: { c: Campaign }) {
  const { state, dispatch } = useStore();
  const set = (options: Partial<Campaign['options']>) => dispatch({ type: 'out', op: { op: 'patchCampaign', id: c.id, patch: { options: { ...c.options, ...options } } } });
  const boxes = Object.values(state.out.mailboxes);
  const room = boxes.filter((m) => c.options.mailboxes.includes(m.id)).reduce((n, m) => n + mailboxCap(m, state.out.limits), 0);
  const Toggle = ({ k, label: text, hint }: { k: 'stopOnReply' | 'trackOpens' | 'unsubscribe' | 'plainText'; label: string; hint: string }) => (
    <div className="opt-row">
      <div>
        <span className="opt-label">{text}</span>
        <span className="field-hint">{hint}</span>
      </div>
      <button className="switch" role="switch" aria-checked={c.options[k]} aria-label={text} onClick={() => set({ [k]: !c.options[k] })} />
    </div>
  );
  return (
    <>
      <section className="section">
        <Field label="Send from" hint={`Each mailbox sends at most ${state.out.limits.perMailbox} cold emails a day (change it in Channels & limits). New mailboxes warm up from ${state.out.limits.rampStart} a day.`}>
          <div className="mb-picks">
            {boxes.map((m) => (
              <label key={m.id} className="mb-pick">
                <input type="checkbox" checked={c.options.mailboxes.includes(m.id)} onChange={(e) => set({ mailboxes: e.target.checked ? [...c.options.mailboxes, m.id] : c.options.mailboxes.filter((x) => x !== m.id) })} />
                <span>{m.address}</span>
                <span className="muted">
                  {mailboxCap(m, state.out.limits)} a day · health {m.health}
                </span>
              </label>
            ))}
          </div>
        </Field>
        <Field label="New cold emails a day" hint={`Up to ${room} with the mailboxes above. Follow-ups count too.`}>
          <input className="input sm num-input" type="number" min={1} max={Math.max(1, room)} value={c.options.dailyLimit} onChange={(e) => set({ dailyLimit: Math.max(1, Math.min(Math.max(1, room), Number(e.target.value) || 1)) })} />
        </Field>
        {c.options.dailyLimit > room && <p className="seq-hint warn">The mailboxes you picked can only send {room} a day, so that’s the real limit.</p>}
        <Meter used={Math.min(c.options.dailyLimit, room)} cap={room} label="This campaign’s share of the mailboxes" unit="a day" calm />
      </section>
      <section className="section">
        <Toggle k="stopOnReply" label="Stop for a lead when they reply" hint="Out-of-office replies don’t stop it. Recommended." />
        <Toggle k="plainText" label="Plain text, no links in the first email" hint="Lands in the inbox more often than HTML with links." />
        <Toggle k="trackOpens" label="Track opens" hint="Adds a tracking pixel. Some filters treat it as a spam signal; replies are the better number." />
        <Toggle k="unsubscribe" label="Unsubscribe line" hint="“Not the right fit? Reply ‘no’ and I won’t write again.” Required for cold email in many places." />
      </section>
    </>
  );
}

/* ───────────── Launch ───────────── */

function LaunchDialog({ c, onClose }: { c: Campaign; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const problem = launchProblem(state, c);
  const plan = project({ ...c, status: 'active' }, state.out.leads, ctxOf(state));
  const first = plan.days.find((d) => d.email + d.calls > 0);
  const cap = campaignCap(c, state.out.mailboxes, state.out.limits);
  return (
    <Modal
      open
      onClose={onClose}
      title={c.status === 'paused' ? `Resume “${c.name}”?` : `Launch “${c.name}”?`}
      width={520}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!!problem} onClick={() => (dispatch({ type: 'out', op: { op: 'launch', id: c.id } }), onClose())}>
            <Rocket size={14} />
            {c.status === 'paused' ? 'Resume' : 'Launch'}
          </button>
        </>
      }
    >
      {problem ? (
        <p className="seq-hint warn">
          <TriangleAlert size={14} aria-hidden /> {problem}
        </p>
      ) : (
        <dl className="launch-facts">
          <div>
            <dt>Leads</dt>
            <dd>{c.leads.length}</dd>
          </div>
          <div>
            <dt>Steps</dt>
            <dd>{c.steps.map((s) => CHANNEL[s.channel].label).join(' → ')}</dd>
          </div>
          <div>
            <dt>Daily limit</dt>
            <dd>{cap} new emails, {c.schedule.days.map((d) => DAYS[d]).join(', ')}, {label(c.schedule.start)}–{label(c.schedule.end)}</dd>
          </div>
          <div>
            <dt>First sends</dt>
            <dd>{first ? `${first.day.toDateString() === NOW.toDateString() ? 'Today' : fmtDay(first.day)}: ${plural(first.email, 'email')}` : 'Nothing due'}</dd>
          </div>
          <div>
            <dt>Last step</dt>
            <dd>{plan.finish ? fmtDay(plan.finish) : '—'}</dd>
          </div>
        </dl>
      )}
      <p className="field-hint">You can pause any time. Replies land in the unibox, and a reply stops the sequence for that lead.</p>
    </Modal>
  );
}
