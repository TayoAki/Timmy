/*
 * One lead, in the right panel: who they are, why they fit, where they are in
 * a campaign, everything sent and received on every channel, and the next
 * move (email, text, call, book a meeting, add to People). Sending goes
 * through the same limits as campaigns.
 */
import { CalendarPlus, Check, Globe, Briefcase, Mail, MessageSquare, Phone, Sparkles, UserPlus } from 'lucide-react';
import { Fragment, useState } from 'react';
import type { Channel, Lead } from '../../data/outbound-types';
import { fmtDay, fmtStamp, fmtTime, plural } from '../../lib/format';
import { fitOf, liveNow } from '../../lib/outbound';
import { canText, coldToday, fill, freeTimes } from '../../state/outbound';
import { pendingAcceptance, whenWords } from '../../state/leads';
import { useStore } from '../../state/store';
import { Field, Modal } from '../../components/kit';
import { RpSection } from '../files/pickers';
import { ChannelIcon, FitBadge, LabelChip, LeadMark, Meter, StatusChip, name } from './shared';

export function LeadPanel({ lead }: { lead: Lead }) {
  const { state, dispatch } = useStore();
  const [composer, setComposer] = useState<Channel | null>(null);
  const [calling, setCalling] = useState(false);
  const [booking, setBooking] = useState(false);
  const fit = fitOf(lead, state.out.offer);
  const c = lead.campaign ? state.out.campaigns[lead.campaign] : undefined;
  const msgs = state.out.messages.filter((m) => m.lead === lead.id).sort((a, b) => b.at.getTime() - a.at.getTime());
  const form = lead.form ? state.out.forms[lead.form] : undefined;
  const textOk = canText(state, lead);
  const inPeople = !!state.ws.contacts[lead.id];

  return (
    <>
      <div className="lp-head">
        <LeadMark lead={lead} size={40} />
        <div className="lp-head-text">
          <h2 className="lp-name">{name(lead)}</h2>
          <p className="lp-sub">
            {lead.title ? `${lead.title}, ` : ''}
            {lead.company}
          </p>
          <div className="lp-chips">
            <StatusChip status={lead.status} />
            {lead.label && lead.label !== 'meeting' && lead.label !== 'interested' && <LabelChip label={lead.label} />}
            <FitBadge fit={fit} />
          </div>
        </div>
      </div>

      <div className="lp-actions">
        <button className="btn btn-sm btn-primary" disabled={!lead.email || lead.status === 'unsubscribed'} onClick={() => setComposer('email')}>
          <Mail size={14} />
          Email
        </button>
        <button className="btn btn-sm" disabled={!textOk} title={textOk ? undefined : lead.phone ? 'They haven’t agreed to texts' : 'No phone number'} onClick={() => setComposer('sms')}>
          <MessageSquare size={14} />
          Text
        </button>
        <button className="btn btn-sm" disabled={!lead.phone} onClick={() => setCalling(true)}>
          <Phone size={14} />
          Call
        </button>
        <button className="btn btn-sm" onClick={() => setBooking(true)}>
          <CalendarPlus size={14} />
          Book
        </button>
      </div>
      {!textOk && lead.phone && <p className="lp-note">No texts: {lead.first} hasn’t agreed to them. Ask on a call or by email first.</p>}

      {form && (
        <RpSection title="From a form">
          <p className="rp-text">
            {form.name}, {fmtStamp(lead.receivedAt!)}.{' '}
            {lead.firstReplyAt ? `First reply ${speed(lead.receivedAt!, lead.firstReplyAt)} later.` : 'Not answered yet.'}
          </p>
          {lead.message && <blockquote className="lp-quote">{lead.message}</blockquote>}
        </RpSection>
      )}

      <RpSection title="Contact">
        <dl className="kv">
          {lead.email && (
            <>
              <dt>Email</dt>
              <dd className="lp-break">{lead.email}</dd>
            </>
          )}
          {lead.phone && (
            <>
              <dt>Phone</dt>
              <dd>{lead.phone}</dd>
            </>
          )}
          {lead.city && (
            <>
              <dt>Location</dt>
              <dd>{lead.city}</dd>
            </>
          )}
          {lead.employees !== undefined && (
            <>
              <dt>Company size</dt>
              <dd>{lead.employees} employees</dd>
            </>
          )}
          {lead.industry && (
            <>
              <dt>Industry</dt>
              <dd>{lead.industry}</dd>
            </>
          )}
          {Object.entries(lead.extra ?? {}).map(([k, v]) => (
            <Fragment key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </Fragment>
          ))}
        </dl>
        <div className="lp-links">
          {lead.website && (
            <a className="btn btn-xs btn-ghost" href={lead.website} target="_blank" rel="noreferrer">
              <Globe size={13} /> Website
            </a>
          )}
          {lead.linkedin && (
            <a className="btn btn-xs btn-ghost" href={lead.linkedin} target="_blank" rel="noreferrer">
              <Briefcase size={13} /> LinkedIn
            </a>
          )}
          <button className="btn btn-xs btn-ghost" disabled={inPeople} onClick={() => dispatch({ type: 'out', op: { op: 'toCrm', lead: lead.id } })}>
            {inPeople ? <Check size={13} /> : <UserPlus size={13} />} {inPeople ? 'In People' : 'Add to People'}
          </button>
        </div>
      </RpSection>

      <RpSection title="Fit with your offer" aside={<span className="rp-aside mono">{fit.score}</span>}>
        <ul className="lp-why">
          {fit.why.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
        {lead.qualified ? (
          <p className={`lp-qual q-${lead.qualified.verdict}`}>
            <Sparkles size={13} aria-hidden />
            <span>
              <strong>{lead.qualified.verdict === 'yes' ? 'Fits' : lead.qualified.verdict === 'maybe' ? 'Maybe' : 'Skip'}:</strong> {lead.qualified.why}
            </span>
          </p>
        ) : (
          <button className="btn btn-xs" onClick={() => dispatch({ type: 'out', op: { op: 'qualify', ids: [lead.id] } })}>
            <Sparkles size={13} /> Qualify with Timmy
          </button>
        )}
      </RpSection>

      <RpSection title="Campaign">
        {c ? (
          <p className="rp-text">
            <button className="link-btn" onClick={() => dispatch({ type: 'navigate', route: { view: 'campaign', id: c.id, tab: 'leads' } })}>
              {c.name}
            </button>
            {lead.nextAt && (lead.step ?? 0) < c.steps.length && !['interested', 'meeting', 'not-interested', 'unsubscribed', 'bounced'].includes(lead.status)
              ? `. Step ${(lead.step ?? 0) + 1} of ${c.steps.length} (${c.steps[lead.step ?? 0]!.channel}) ${c.status === 'active' ? `goes ${fmtDay(lead.nextAt)}` : 'waits until the campaign launches'}.`
              : (lead.step ?? 0) >= c.steps.length
                ? '. Sequence finished.'
                : '. Sequence stopped: they replied or opted out.'}
          </p>
        ) : (
          <AddToCampaign lead={lead} />
        )}
      </RpSection>

      <RpSection title="Conversation" aside={<span className="rp-aside">{msgs.length}</span>}>
        {msgs.length === 0 ? (
          <p className="rp-text">Nothing sent yet.</p>
        ) : (
          <ol className="lp-timeline">
            {msgs.slice(0, 12).map((m) => (
              <li key={m.id} className={`lp-msg ${m.dir}${m.status === 'scheduled' || m.status === 'draft' ? ' scheduled' : ''}`}>
                <ChannelIcon channel={m.channel} size={13} />
                <div>
                  <span className="lp-msg-head">
                    {m.dir === 'in' ? lead.first : 'You'} · {m.status === 'draft' ? 'draft, not sent' : m.status === 'scheduled' ? `scheduled ${fmtDay(m.at)}, ${fmtTime(m.at)}` : fmtStamp(m.at)}
                    {m.status === 'bounced' ? ' · bounced' : m.status === 'opened' ? ' · opened' : ''}
                  </span>
                  <span className="lp-msg-body">{m.outcome ?? m.subject ?? m.body.split('\n').find((x) => x.trim() && !/^hi\b/i.test(x)) ?? m.body}</span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </RpSection>

      {composer && <MessageDialog lead={lead} channel={composer} onClose={() => setComposer(null)} />}
      {calling && <CallDialog lead={lead} onClose={() => setCalling(false)} />}
      {booking && <BookDialog lead={lead} onClose={() => setBooking(false)} />}
    </>
  );
}

export const speed = (from: Date, to: Date, short = false) => {
  const s = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
  if (short) return s < 60 ? `${s} sec` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 360) / 10} hr`;
  if (s < 60) return `${s} seconds`;
  const m = Math.round(s / 60);
  if (m < 60) return plural(m, 'minute');
  const h = Math.round(m / 6) / 10;
  return `${h} hours`;
};

function AddToCampaign({ lead }: { lead: Lead }) {
  const { state, dispatch } = useStore();
  const options = Object.values(state.out.campaigns).filter((c) => c.status !== 'completed');
  const [id, setId] = useState(options[0]?.id ?? '');
  if (!options.length) return <p className="rp-text">No campaigns yet.</p>;
  return (
    <div className="lp-add">
      <select className="input sm" value={id} onChange={(e) => setId(e.target.value)} aria-label="Campaign">
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <button className="btn btn-sm" disabled={['unsubscribed', 'bounced'].includes(lead.status)} onClick={() => dispatch({ type: 'out', op: { op: 'addToCampaign', id, leads: [lead.id] } })}>
        Add
      </button>
    </div>
  );
}

/* ───────────── Write one email or text ───────────── */

export function MessageDialog({ lead, channel, onClose, initial }: { lead: Lead; channel: Channel; onClose: () => void; initial?: { subject?: string; body: string } }) {
  const { state, dispatch } = useStore();
  const templates = Object.values(state.out.templates).filter((t) => t.channel === channel);
  const replied = state.out.messages.some((m) => m.lead === lead.id && m.dir === 'in');
  const pick = templates.find((t) => (replied ? t.kind === 'reply' : lead.source === 'form' ? t.kind === 'speed' || t.kind === 'sms' : t.kind === 'intro')) ?? templates[0];
  const start = initial ?? (pick ? { subject: pick.subject ? fill(state, pick.subject, lead).text : '', body: fill(state, pick.body, lead).text } : { subject: '', body: `Hi ${lead.first},\n\n\n\nBest,\nTaylor` });
  const [tpl, setTpl] = useState(initial ? '' : pick?.id ?? '');
  const [subject, setSubject] = useState(start.subject ?? '');
  const [body, setBody] = useState(start.body);
  const cold = channel === 'email' && lead.source !== 'form' && !state.out.messages.some((m) => m.lead === lead.id && (m.dir === 'in' || m.channel === 'email'));
  const today = coldToday(state);
  const sms = state.out.channels.sms;
  const choose = (id: string) => {
    setTpl(id);
    const t = state.out.templates[id];
    if (!t) return;
    setSubject(t.subject ? fill(state, t.subject, lead).text : '');
    setBody(fill(state, t.body, lead).text);
  };
  const left = /\{\{\w+\}\}/.test(subject + body);
  const send = () => {
    dispatch({ type: 'out', op: { op: 'send', lead: lead.id, channel, subject: channel === 'email' ? subject : undefined, body } });
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={channel === 'sms' ? `Text ${lead.first}` : `Email ${lead.first}`}
      description={channel === 'sms' ? `To ${lead.phone}. They agreed to texts.` : `To ${lead.email}`}
      width={600}
      footer={
        <>
          <span className="modal-foot-note">
            {channel === 'sms' ? `${body.length} characters${body.length > 160 ? ` · ${Math.ceil(body.length / 153)} texts` : ''}` : cold ? 'Counts toward today’s cold-email limit' : 'A reply, so it doesn’t count toward the cold limit'}
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!body.trim() || left || (channel === 'email' && !subject.trim())} onClick={send}>
            {cold && today.left === 0 ? 'Queue for tomorrow' : 'Send'}
          </button>
        </>
      }
    >
      <div className="msg-form">
        {templates.length > 0 && (
          <Field label="Start from a template">
            <select className="input" value={tpl} onChange={(e) => choose(e.target.value)}>
              <option value="">None</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {channel === 'email' && (
          <Field label="Subject">
            <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
        )}
        <Field label={channel === 'sms' ? 'Text' : 'Message'}>
          <textarea className="input textarea msg-body" rows={channel === 'sms' ? 4 : 10} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
        {left && <p className="imp-warn">Some {'{{variables}}'} have no value for {lead.first}. Fill them in before sending.</p>}
        {cold && <Meter used={today.sent} cap={today.cap} label="Cold emails today" />}
        {channel === 'sms' && sms && <Meter used={sms.sentToday ?? 0} cap={sms.dailyLimit ?? 0} label="Texts today" />}
      </div>
    </Modal>
  );
}

/* ───────────── Call ───────────── */

const OUTCOMES = ['Connected: interested', 'Connected: not now', 'Asked me to call back', 'Gatekeeper: left a message', 'No answer, left a voicemail', 'No answer', 'Wrong number'];

/**
 * One call: dial, follow the script (the campaign step's own, if this call is
 * a sequence step), take notes, set a callback, record a yes to texts, and log
 * how it went. In a call run, logging moves on to the next call.
 */
export function CallDialog({ lead, onClose, script, progress, onLogged }: { lead: Lead; onClose: () => void; script?: string; progress?: string; onLogged?: () => void }) {
  const { state, dispatch } = useStore();
  const c = lead.campaign ? state.out.campaigns[lead.campaign] : undefined;
  const step = c && lead.step !== undefined ? c.steps[lead.step] : undefined;
  const text = script ?? (step?.channel === 'call' ? step.variants[0]?.body : undefined) ?? state.out.templates['tpl-call']?.body ?? '';
  const [notes, setNotes] = useState('');
  const [later, setLater] = useState(false);
  const [when, setWhen] = useState(() => {
    const d = new Date(liveNow().getTime() + 24 * 3_600_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T10:00`;
  });
  const [consent, setConsent] = useState(false);
  const log = (o: string) => {
    const callback = later || o === 'Asked me to call back' ? new Date(when) : undefined;
    if (consent && !/^y/i.test(lead.extra?.['Text me'] ?? '')) dispatch({ type: 'out', op: { op: 'patchLead', id: lead.id, patch: { extra: { ...lead.extra, 'Text me': 'Yes' } } } });
    dispatch({ type: 'out', op: { op: 'logCall', lead: lead.id, outcome: o, notes: notes.trim() || undefined, callbackAt: callback && !isNaN(callback.getTime()) ? callback : undefined, callbackNote: callback ? notes.trim() || o : undefined } });
    if (o === 'Connected: interested') dispatch({ type: 'out', op: { op: 'label', lead: lead.id, label: 'interested' } });
    setNotes('');
    setLater(false);
    setConsent(false);
    if (onLogged) onLogged();
    else onClose();
  };
  return (
    <Modal open onClose={onClose} title={`Call ${lead.first} ${lead.last}`} description={`${progress ? `${progress} · ` : ''}${lead.phone} · ${lead.company}${step?.channel === 'call' && c ? ` · ${c.name}, step ${lead.step! + 1}` : ''}`} width={600}>
      <div className="call-box">
        <a className="btn btn-primary call-dial" href={`tel:${lead.phone?.replace(/\s/g, '')}`}>
          <Phone size={15} />
          Call {lead.phone}
        </a>
        {text && (
          <div className="call-script">
            <span className="field-label">Script{step?.channel === 'call' ? ' (from the campaign)' : ''}</span>
            {fill(state, text, lead).text.split('\n').map((line, i) => (line.trim() ? <p key={i}>{line}</p> : null))}
          </div>
        )}
        {lead.notes && (
          <div className="call-prev">
            <span className="field-label">Earlier notes</span>
            <p>{lead.notes.split('\n').slice(-2).join(' · ')}</p>
          </div>
        )}
        <Field label="Notes">
          <textarea className="input" rows={3} value={notes} placeholder="What they said, what’s next" onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="call-extras">
          <label className="inline-check">
            <input type="checkbox" checked={later} onChange={(e) => setLater(e.target.checked)} /> Set a callback
          </label>
          {later && <input className="input sm" type="datetime-local" aria-label="Callback time" value={when} onChange={(e) => setWhen(e.target.value)} />}
          {!canText(state, lead) && lead.phone && (
            <label className="inline-check">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> They said yes to texts
            </label>
          )}
        </div>
        <div>
          <span className="field-label">How did it go?</span>
          <div className="call-outcomes">
            {OUTCOMES.map((o) => (
              <button key={o} className="btn btn-sm" onClick={() => log(o)}>
                {o}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ───────────── Book a meeting ───────────── */

export function BookDialog({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const yes = pendingAcceptance(state, lead);
  const today = freeTimes(state.ws, 3, 30, 3, true).filter((t) => t.start.getDate() === liveNow().getDate());
  const times = freeTimes(state.ws, 6, 30, 2);
  const [date, setDate] = useState(() => isoDay(yes?.at ?? liveNow()));
  const [time, setTime] = useState(() => (yes ? `${String(yes.at.getHours()).padStart(2, '0')}:${String(yes.at.getMinutes()).padStart(2, '0')}` : '10:00'));
  const [mins, setMins] = useState(30);
  // Real estate: a showing at a property instead of a call.
  const [showing, setShowing] = useState(false);
  const [address, setAddress] = useState(lead.extra?.['Property'] ?? lead.extra?.['Address'] ?? '');
  const book = (start: Date, length = showing ? 45 : 30) => {
    dispatch({ type: 'out', op: { op: 'book', lead: lead.id, start, end: new Date(start.getTime() + length * 60000), showing: showing && address.trim() ? address.trim() : undefined } });
    onClose();
  };
  const custom = (() => {
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = time.split(':').map(Number);
    return y && m && d && hh !== undefined && mm !== undefined ? new Date(y, m - 1, d, hh, mm) : null;
  })();
  const clash = custom ? Object.values(state.ws.events).find((e) => e.start < new Date(custom.getTime() + mins * 60000) && e.end > custom) : undefined;
  return (
    <Modal open onClose={onClose} title={`Book ${showing ? 'a showing' : 'a call'} with ${lead.first}`} description="Timmy sends the invite and moves the lead to Meeting booked." width={500}>
      <div className="book-kind">
        <div className="seg-control" role="radiogroup" aria-label="Meeting type">
          <button role="radio" aria-checked={!showing} onClick={() => setShowing(false)}>
            Call
          </button>
          <button role="radio" aria-checked={showing} onClick={() => setShowing(true)}>
            Showing
          </button>
        </div>
        {showing && <input className="input" value={address} placeholder="Property address" aria-label="Property address" onChange={(e) => setAddress(e.target.value)} />}
      </div>
      {yes && (
        <button className="book-yes" onClick={() => book(yes.at)}>
          <strong>Book {whenWords(yes.at)}</strong>
          <span>
            {lead.first} wrote: “{yes.quote}”
          </span>
        </button>
      )}
      {today.length > 0 && (
        <>
          <span className="field-label">Today</span>
          <div className="book-times">
            {today.map((t) => (
              <button key={t.start.toISOString()} className="book-time" onClick={() => book(t.start)}>
                <strong>Today</strong>
                <span>
                  {fmtTime(t.start)}–{fmtTime(t.end)}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      <span className="field-label">Next free half hours</span>
      <div className="book-times">
        {times.map((t) => (
          <button
            key={t.start.toISOString()}
            className="book-time"
            onClick={() => {
              dispatch({ type: 'out', op: { op: 'book', lead: lead.id, start: t.start, end: t.end } });
              onClose();
            }}
          >
            <strong>{fmtDay(t.start)}</strong>
            <span>
              {fmtTime(t.start)}–{fmtTime(t.end)}
            </span>
          </button>
        ))}
      </div>
      <fieldset className="book-custom">
        <legend className="field-label">Or pick any time</legend>
        <input className="input" type="date" aria-label="Date" value={date} onChange={(e) => setDate(e.target.value)} />
        <input className="input" type="time" aria-label="Time" step={300} value={time} onChange={(e) => setTime(e.target.value)} />
        <select className="input" aria-label="Length" value={mins} onChange={(e) => setMins(Number(e.target.value))}>
          {[15, 30, 45, 60, 90].map((m) => (
            <option key={m} value={m}>
              {m} min
            </option>
          ))}
        </select>
        <button className="btn btn-sm btn-primary" disabled={!custom} onClick={() => custom && book(custom, mins)}>
          Book
        </button>
        {clash && <span className="book-clash">Overlaps “{clash.title}”. You can still book it.</span>}
      </fieldset>
    </Modal>
  );
}

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
