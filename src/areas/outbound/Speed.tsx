/*
 * Speed to lead: leads from your website and other forms, with a clock on
 * each one. Answer inside the form's target (5 minutes for a demo request),
 * or let Timmy send the first reply itself in under a minute and text them if
 * they asked for it. The numbers show how fast you really answer.
 */
import { Check, Copy, Mail, MessageSquare, Phone, Plus, Timer, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FormSource, Lead } from '../../data/outbound-types';
import { fmtStamp, plural } from '../../lib/format';
import { liveNow } from '../../lib/outbound';
import { canText } from '../../state/outbound';
import { useStore } from '../../state/store';
import { EmptyState } from '../../components/kit';
import { CallDialog, MessageDialog, speed } from './LeadPanel';
import { LeadMark, StatusChip, name } from './shared';

/** Re-renders every second while mounted, for live timers. */
function useTick(on = true) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = window.setInterval(() => set((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [on]);
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}:${String(s % 60).padStart(2, '0')}`;
};

export function SpeedTab() {
  const { state, dispatch } = useStore();
  const forms = Object.values(state.out.forms);
  const leads = Object.values(state.out.leads)
    .filter((l) => l.source === 'form' && l.receivedAt)
    .sort((a, b) => b.receivedAt!.getTime() - a.receivedAt!.getTime());
  const waiting = leads.filter((l) => !l.firstReplyAt && l.status !== 'not-interested');
  useTick(waiting.length > 0);
  const answered = leads.filter((l) => l.firstReplyAt);
  const times = answered.map((l) => l.firstReplyAt!.getTime() - l.receivedAt!.getTime()).sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)]! : 0;
  const inSla = answered.filter((l) => l.firstReplyAt!.getTime() - l.receivedAt!.getTime() <= (state.out.forms[l.form ?? '']?.sla ?? 5) * 60000).length;
  const [reply, setReply] = useState<{ lead: Lead; channel: 'email' | 'sms' } | null>(null);
  const [calling, setCalling] = useState<Lead | null>(null);

  const simulate = () => {
    const f = forms.find((x) => x.connected) ?? forms[0]!;
    const pool = [
      ['Dana', 'Ruiz', 'Lakeside Dental Partners', 'Practice Manager', 'Two offices, all scheduling in spreadsheets. Can we see a demo this week?'],
      ['Marco', 'Bianchi', 'Westfield Home Care', 'Director of Operations', 'Caregiver scheduling is killing us. Pricing?'],
      ['Aisha', 'Bello', 'Crestline Staffing', 'COO', 'Need help with timesheets and onboarding for 120 contractors.'],
      ['Tom', 'Reid', 'Ridgeway Physical Therapy', 'Owner', 'Interested in the pilot. Best time to talk?'],
    ];
    const pick = pool[leads.length % pool.length]!;
    const slug = pick[2]!.toLowerCase().replace(/[^a-z]+/g, '-');
    dispatch({
      type: 'out',
      op: {
        op: 'submit',
        form: f.id,
        lead: {
          id: `form-${Date.now().toString(36)}`,
          first: pick[0]!,
          last: pick[1]!,
          email: `${pick[0]!.toLowerCase()}@${slug}.example`,
          phone: `+1 555 01${String(50 + (leads.length % 40)).padStart(2, '0')}`,
          company: pick[2]!,
          title: pick[3],
          message: pick[4],
          source: 'form',
          added: liveNow(),
          status: 'new',
          extra: { 'Text me': leads.length % 2 ? 'No' : 'Yes' },
        },
      },
    });
  };

  return (
    <>
      <div className="out-head">
        <div>
          <h1 className="page-title">Speed to lead</h1>
          <p className="page-sub">Leads from your forms, with a clock on each one. Answer inside a few minutes and you’re far more likely to reach them; Timmy can send the first reply for you.</p>
        </div>
        <div className="out-head-actions">
          <button className="btn" onClick={simulate}>
            <Zap size={15} />
            Simulate a form lead
          </button>
        </div>
      </div>

      <dl className="stat-tiles four">
        <div className="stat-tile">
          <dt>Waiting now</dt>
          <dd>{waiting.length}</dd>
          <span className="stat-sub">{waiting.length ? 'answer these first' : 'all answered'}</span>
        </div>
        <div className="stat-tile">
          <dt>Median first reply</dt>
          <dd>{times.length ? speed(new Date(0), new Date(median), true) : '—'}</dd>
          <span className="stat-sub">{plural(answered.length, 'lead')}</span>
        </div>
        <div className="stat-tile">
          <dt>Inside target</dt>
          <dd>{answered.length ? `${Math.round((100 * inSla) / answered.length)}%` : '—'}</dd>
          <span className="stat-sub">
            {inSla} of {answered.length}
          </span>
        </div>
        <div className="stat-tile">
          <dt>Booked</dt>
          <dd>{leads.filter((l) => l.status === 'meeting').length}</dd>
          <span className="stat-sub">from {plural(leads.length, 'form lead')}</span>
        </div>
      </dl>

      <section className="section" aria-labelledby="wait-title">
        <div className="section-head">
          <h2 className="section-title" id="wait-title">
            Waiting for a reply
          </h2>
        </div>
        {waiting.length === 0 ? (
          <EmptyState icon={Check} title="Nobody is waiting" body="New form leads show up here with a timer." />
        ) : (
          <ul className="spd-queue">
            {waiting.map((l) => {
              const f = state.out.forms[l.form ?? ''];
              const sla = (f?.sla ?? 5) * 60000;
              const age = liveNow().getTime() - l.receivedAt!.getTime();
              const ratio = Math.min(1, age / sla);
              const late = age > sla;
              return (
                <li key={l.id} className={`card spd-card${late ? ' late' : ratio > 0.6 ? ' soon' : ''}`}>
                  <div className="spd-top">
                    <LeadMark lead={l} size={34} />
                    <div className="spd-who">
                      <strong>{name(l)}</strong>
                      <span className="muted">
                        {l.title ? `${l.title}, ` : ''}
                        {l.company} · {f?.name}
                      </span>
                    </div>
                    <div className="spd-clock" role="timer" aria-label={`${late ? 'Late' : 'Waiting'}: ${clock(age)}`}>
                      <Timer size={14} aria-hidden />
                      <span className="spd-time">{clock(age)}</span>
                      <span className="spd-sla">{late ? `past the ${f?.sla}-minute target` : `of ${f?.sla} min`}</span>
                    </div>
                  </div>
                  <div className="spd-bar" aria-hidden>
                    <span style={{ width: `${ratio * 100}%` }} />
                  </div>
                  {l.message && <blockquote className="lp-quote">{l.message}</blockquote>}
                  <div className="spd-actions">
                    <button className="btn btn-sm btn-primary" onClick={() => setReply({ lead: l, channel: 'email' })}>
                      <Mail size={14} />
                      Reply with times
                    </button>
                    <button className="btn btn-sm" disabled={!canText(state, l)} title={canText(state, l) ? undefined : 'They didn’t ask for texts'} onClick={() => setReply({ lead: l, channel: 'sms' })}>
                      <MessageSquare size={14} />
                      Text
                    </button>
                    <button className="btn btn-sm" disabled={!l.phone} onClick={() => setCalling(l)}>
                      <Phone size={14} />
                      Call
                    </button>
                    <button className="btn btn-sm btn-ghost" onClick={() => dispatch({ type: 'navigate', route: { view: 'outbound', tab: 'unibox', filter: 'forms', id: l.id } })}>
                      Open
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="section" aria-labelledby="recent-title">
        <div className="section-head">
          <h2 className="section-title" id="recent-title">
            Recent form leads
          </h2>
        </div>
        <div className="lead-table-wrap">
          <table className="lead-table">
            <thead>
              <tr>
                <th>Lead</th>
                <th>Form</th>
                <th>Arrived</th>
                <th>First reply</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => {
                const f = state.out.forms[l.form ?? ''];
                const took = l.firstReplyAt ? l.firstReplyAt.getTime() - l.receivedAt!.getTime() : null;
                return (
                  <tr key={l.id}>
                    <td>
                      <button className="lead-name" onClick={() => dispatch({ type: 'navigate', route: { view: 'outbound', tab: 'speed', id: l.id } })}>
                        <LeadMark lead={l} />
                        <span>
                          <span className="lead-name-text">{name(l)}</span>
                          <span className="lead-sub">{l.company}</span>
                        </span>
                      </button>
                    </td>
                    <td className="lead-sub">{f?.name ?? '—'}</td>
                    <td className="lead-sub">{fmtStamp(l.receivedAt!)}</td>
                    <td>{took === null ? <span className="spd-pill late">Not yet</span> : <span className={`spd-pill${took <= (f?.sla ?? 5) * 60000 ? ' ok' : ' late'}`}>{speed(new Date(0), new Date(took))}</span>}</td>
                    <td>
                      <StatusChip status={l.status} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section" aria-labelledby="forms-title">
        <div className="section-head">
          <h2 className="section-title" id="forms-title">
            Forms
          </h2>
        </div>
        <ul className="form-list">
          {forms.map((f) => (
            <FormCard key={f.id} f={f} />
          ))}
        </ul>
      </section>

      {reply && <MessageDialog lead={reply.lead} channel={reply.channel} onClose={() => setReply(null)} />}
      {calling && <CallDialog lead={calling} onClose={() => setCalling(null)} />}
    </>
  );
}

const KIND: Record<FormSource['kind'], string> = { website: 'Website form', typeform: 'Typeform', webflow: 'Webflow', hubspot: 'HubSpot form', facebook: 'Facebook Lead Ads', webhook: 'Webhook', zillow: 'Zillow Premier Agent', realtor: 'Realtor.com Lead Delivery', fub: 'Follow Up Boss' };

function FormCard({ f }: { f: FormSource }) {
  const { state, dispatch } = useStore();
  const [copied, setCopied] = useState(false);
  const set = (patch: Partial<FormSource>) => dispatch({ type: 'out', op: { op: 'form', id: f.id, patch } });
  const hook = `https://hooks.timmy.example/f/${f.id}`;
  const count = Object.values(state.out.leads).filter((l) => l.form === f.id).length;
  const templates = Object.values(state.out.templates).filter((t) => t.channel === 'email');
  return (
    <li className="card form-card">
      <header className="form-head">
        <div>
          <strong>{f.name}</strong>
          <span className="muted">
            {KIND[f.kind]} · {f.connected ? `${plural(count, 'lead')} so far` : 'Not connected'}
          </span>
        </div>
        <button className={`btn btn-sm${f.connected ? ' btn-ghost' : ''}`} onClick={() => set({ connected: !f.connected })}>
          {f.connected ? 'Disconnect' : (
            <>
              <Plus size={14} /> Connect
            </>
          )}
        </button>
      </header>
      {f.connected && (
        <>
          <div className="form-opts">
            <label className="form-opt">
              <span className="field-label">Answer within</span>
              <select className="input sm" value={f.sla} onChange={(e) => set({ sla: Number(e.target.value) })}>
                {[1, 5, 10, 15, 30, 60].map((n) => (
                  <option key={n} value={n}>
                    {n} min
                  </option>
                ))}
              </select>
            </label>
            <label className="form-opt">
              <span className="field-label">First reply</span>
              <select className="input sm" value={f.template} onChange={(e) => set({ template: e.target.value })}>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-switches">
            <label className="inline-check">
              <input type="checkbox" checked={f.autoReply} onChange={(e) => set({ autoReply: e.target.checked })} /> Send the first reply automatically. This skips your approval; off, Timmy drafts it and the lead waits on Today.
            </label>
            <label className="inline-check">
              <input type="checkbox" checked={f.textToo} disabled={!state.out.channels.sms?.connected} onChange={(e) => set({ textToo: e.target.checked })} /> Text them too, if they ticked “text me”
            </label>
            <label className="inline-check">
              <input type="checkbox" checked={f.slack} disabled={!state.out.channels.slack?.connected} onChange={(e) => set({ slack: e.target.checked })} /> Post new leads to Slack
            </label>
          </div>
          <div className="form-hook">
            <code>{hook}</code>
            <button
              className="btn btn-xs btn-ghost"
              onClick={() => {
                void navigator.clipboard?.writeText(hook);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy webhook'}
            </button>
          </div>
        </>
      )}
    </li>
  );
}
