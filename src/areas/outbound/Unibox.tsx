/*
 * Unibox: every outbound conversation in one place, across campaigns and
 * channels (email, texts, call logs). Timmy labels each reply and suggests the
 * next message; you send it, book the meeting, or add the lead to People.
 */
import { CalendarCheck, CalendarPlus, Inbox, Mail, MessageSquare, Phone, Send, Sparkles, UserPlus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Channel, Lead, ReplyLabel } from '../../data/outbound-types';
import { fmtListDate, fmtStamp } from '../../lib/format';
import { canText, fill } from '../../state/outbound';
import { otherQuestionsLine, pendingAcceptance, questionsIn, referral, whenWords } from '../../state/leads';
import { useStore } from '../../state/store';
import { EmptyState, Menu } from '../../components/kit';
import { BookDialog, CallDialog } from './LeadPanel';
import { ChannelIcon, LABEL, LabelChip, LeadMark, name } from './shared';

type Filter = 'replies' | 'sent' | 'unread' | 'interested' | 'meetings' | 'other' | 'forms';
const FILTERS: [Filter, string][] = [
  ['replies', 'All replies'],
  ['sent', 'Sent'],
  ['unread', 'Unread'],
  ['interested', 'Interested'],
  ['meetings', 'Meetings'],
  ['forms', 'Form leads'],
  ['other', 'Other'],
];

export function UniboxTab() {
  const { state, dispatch } = useStore();
  const r = state.route.view === 'outbound' ? state.route : null;
  const filter = (FILTERS.find(([f]) => f === r?.filter)?.[0] ?? 'replies') as Filter;
  const last = useMemo(() => {
    const m = new Map<string, (typeof state.out.messages)[number]>();
    for (const x of state.out.messages) if (x.status !== 'scheduled' && x.status !== 'draft' && (!m.get(x.lead) || m.get(x.lead)!.at < x.at)) m.set(x.lead, x);
    return m;
  }, [state.out.messages]);
  const replied = new Set(state.out.messages.filter((m) => m.dir === 'in').map((m) => m.lead));
  const wrote = new Set(state.out.messages.filter((m) => m.dir === 'out' && m.status !== 'draft' && m.status !== 'scheduled').map((m) => m.lead));
  const convos = Object.values(state.out.leads)
    .filter((l) => replied.has(l.id) || wrote.has(l.id) || l.source === 'form')
    .filter((l) =>
      filter === 'sent'
        ? wrote.has(l.id) && !replied.has(l.id)
        : filter === 'unread'
        ? l.unread
        : filter === 'interested'
          ? l.status === 'interested'
          : filter === 'meetings'
            ? l.status === 'meeting'
            : filter === 'forms'
              ? l.source === 'form'
              : filter === 'other'
                ? ['ooo', 'not-interested', 'wrong-person', 'unsubscribe'].includes(l.label ?? '')
                : replied.has(l.id),
    )
    .sort((a, b) => (last.get(b.id)?.at.getTime() ?? 0) - (last.get(a.id)?.at.getTime() ?? 0));
  const selected = r?.id && state.out.leads[r.id] ? state.out.leads[r.id]! : undefined;
  const go = (patch: { filter?: Filter; id?: string }) => dispatch({ type: 'navigate', route: { view: 'outbound', tab: 'unibox', filter: patch.filter ?? filter, id: 'id' in patch ? patch.id : r?.id } });
  const count = (f: Filter) =>
    f === 'unread' ? Object.values(state.out.leads).filter((l) => l.unread).length : f === 'interested' ? Object.values(state.out.leads).filter((l) => l.status === 'interested').length : undefined;

  useEffect(() => {
    if (selected?.unread) dispatch({ type: 'out', op: { op: 'read', lead: selected.id } });
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="out-head">
        <div>
          <h1 className="page-title">Unibox</h1>
          <p className="page-sub">Every conversation with your leads, from every campaign and form, on every channel. Sent shows who you wrote to that hasn’t replied yet. Timmy labels replies and drafts the next message; nothing goes out until you send it.</p>
        </div>
      </div>
      <div className="filters" role="group" aria-label="Show">
        {FILTERS.map(([f, label]) => (
          <button key={f} className="filter" aria-pressed={filter === f} onClick={() => go({ filter: f, id: undefined })}>
            {label}
            {count(f) ? <span className="filter-count">{count(f)}</span> : null}
          </button>
        ))}
      </div>
      <div className={`ubx${selected ? ' has-sel' : ''}`}>
        <ul className="ubx-list" aria-label="Conversations">
          {convos.length === 0 && (
            <li>
              <EmptyState icon={Inbox} title="Nothing here" body={filter === 'sent' ? 'Emails and texts you send to leads show up here, with the whole history, until they reply.' : 'Replies show up as soon as a lead writes back.'} />
            </li>
          )}
          {convos.map((l) => {
            const m = last.get(l.id);
            return (
              <li key={l.id}>
                <button className={`ubx-row${l.unread ? ' unread' : ''}`} aria-current={selected?.id === l.id ? 'true' : undefined} onClick={() => go({ id: l.id })}>
                  <LeadMark lead={l} size={30} />
                  <span className="ubx-row-main">
                    <span className="ubx-row-top">
                      <span className="ubx-name">{name(l)}</span>
                      <span className="ubx-when">{m ? fmtListDate(m.at) : ''}</span>
                    </span>
                    <span className="ubx-co">
                      {l.company}
                      {l.campaign ? ` · ${state.out.campaigns[l.campaign]?.name ?? ''}` : l.form ? ` · ${state.out.forms[l.form]?.name ?? 'Form'}` : ''}
                    </span>
                    <span className="ubx-snip">
                      {m && <ChannelIcon channel={m.channel} size={12} />}
                      {m ? `${m.dir === 'out' ? 'You: ' : ''}${(m.outcome ?? m.body).replace(/\s+/g, ' ').replace(/^Hi \w+, ?/, '')}` : l.message}
                    </span>
                    {l.label && <LabelChip label={l.label} />}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {selected ? <Conversation key={selected.id} lead={selected} onBack={() => go({ id: undefined })} /> : <div className="ubx-empty">Pick a conversation.</div>}
      </div>
    </>
  );
}

const SUGGEST: Partial<Record<ReplyLabel | 'form', { label: string; template?: string; text?: string }>> = {
  interested: { label: 'Offer two times', template: 'tpl-reply-times' },
  question: { label: 'Answer the price question', template: 'tpl-reply-price' },
  meeting: { label: 'Confirm the meeting', text: 'Hi {{firstName}},\n\nYou’re booked. The invite is in your calendar; reply here if anything changes.\n\nBest,\n{{senderFirstName}}' },
  'wrong-person': { label: 'Ask who to talk to', text: 'Thanks, {{firstName}}, and sorry for the miss. Would you be open to pointing me to the right person, or should I reach out to them directly?\n\nBest,\n{{senderFirstName}}' },
  'not-interested': { label: 'Close politely', text: 'Thanks for letting me know, {{firstName}}. I won’t follow up again. If things change, just reply here.\n\nBest,\n{{senderFirstName}}' },
  ooo: { label: 'Wait until they’re back', text: '' },
  form: { label: 'First reply with times', template: 'tpl-speed' },
};

function Conversation({ lead, onBack }: { lead: Lead; onBack: () => void }) {
  const { state, dispatch } = useStore();
  const msgs = state.out.messages.filter((m) => m.lead === lead.id).sort((a, b) => a.at.getTime() - b.at.getTime());
  const textOk = canText(state, lead);
  const lastIn = [...msgs].reverse().find((m) => m.dir === 'in');
  const [channel, setChannel] = useState<Channel>(lastIn?.channel === 'sms' && textOk ? 'sms' : 'email');
  const [body, setBody] = useState('');
  const [calling, setCalling] = useState(false);
  const [booking, setBooking] = useState(false);
  const yes = pendingAcceptance(state, lead);
  const asked = lastIn ? questionsIn(lastIn.body) : { price: false, times: false, other: [] as string[] };
  const pointed = lastIn && lead.label === 'wrong-person' ? referral(lastIn.body) : null;
  const base = SUGGEST[lead.label ?? (lead.source === 'form' && !lead.firstReplyAt ? 'form' : 'interested')];
  // Read the reply before suggesting one: a time they agreed to is booked, not re-offered;
  // a price question uses your offer's price; anything else they asked is acknowledged, not ignored.
  const sugg: typeof base = yes
    ? { label: `Confirm ${whenWords(yes.at)}`, text: `Hi {{firstName}},\n\nYou’re booked for ${whenWords(yes.at)}. The invite is on its way; reply here if anything changes.\n\nBest,\n{{senderFirstName}}` }
    : pointed
      ? { label: `Thank them; contact ${pointed.name ?? pointed.email}`, text: `Thanks, {{firstName}}. I’ll reach out to ${pointed.name ?? pointed.email} directly and mention you pointed me their way.\n\nBest,\n{{senderFirstName}}` }
      : asked.price
        ? { label: asked.other.length ? 'Answer the price and note the rest' : 'Answer the price question', template: 'tpl-reply-price' }
        : asked.other.length && !asked.times
          ? { label: 'Answer honestly', text: `Hi {{firstName}},\n\nThanks for asking.` }
          : base;
  const subject = (() => {
    const s = [...msgs].reverse().find((m) => m.subject)?.subject;
    return s ? (s.startsWith('Re:') ? s : `Re: ${s}`) : `Re: ${lead.company}`;
  })();
  const useSuggestion = () => {
    if (!sugg) return;
    const t = sugg.template ? state.out.templates[sugg.template] : undefined;
    const text = t ? (channel === 'sms' ? state.out.templates['tpl-speed-sms']?.body ?? t.body : t.body) : sugg.text ?? '';
    let filled = fill(state, text, lead).text;
    // Questions the template doesn't answer get an honest line instead of silence.
    const extra = otherQuestionsLine(asked.other);
    if (extra && channel === 'email' && !yes && !pointed) filled = filled.replace(/\n\n(Best,\n|Thanks,\n)?[^\n]*$/, (end) => `${extra}${end}`);
    setBody(filled);
  };
  const send = () => {
    dispatch({ type: 'out', op: { op: 'send', lead: lead.id, channel, subject: channel === 'email' ? subject : undefined, body } });
    setBody('');
  };

  return (
    <section className="ubx-convo" aria-label={`Conversation with ${name(lead)}`}>
      <header className="ubx-head">
        <button className="btn btn-xs btn-ghost ubx-back" onClick={onBack}>
          ← All
        </button>
        <LeadMark lead={lead} size={34} />
        <div className="ubx-head-text">
          <strong>{name(lead)}</strong>
          <span className="muted">
            {lead.title ? `${lead.title}, ` : ''}
            {lead.company}
          </span>
        </div>
        <Menu
          label="Label"
          trigger={<>{lead.label ? LABEL[lead.label].label : 'Label'}</>}
          items={[...(Object.keys(LABEL) as ReplyLabel[]).map((k) => ({ label: LABEL[k].label, onSelect: () => dispatch({ type: 'out', op: { op: 'label', lead: lead.id, label: k } }) })), { label: 'Clear label', onSelect: () => dispatch({ type: 'out', op: { op: 'label', lead: lead.id, label: null } }) }]}
        />
        {yes && (
          <button
            className="btn btn-sm btn-primary ubx-book-yes"
            onClick={() => dispatch({ type: 'out', op: { op: 'book', lead: lead.id, start: yes.at, end: new Date(yes.at.getTime() + 30 * 60000) } })}
            title={`${lead.first} wrote: “${yes.quote}”`}
          >
            <CalendarCheck size={14} />
            Book {whenWords(yes.at)}
          </button>
        )}
        <button className="icon-btn sm" aria-label="Book a meeting" title="Book a meeting" onClick={() => setBooking(true)}>
          <CalendarPlus size={16} />
        </button>
        <button className="icon-btn sm" aria-label="Call" title={lead.phone ? 'Call' : 'No phone number'} disabled={!lead.phone} onClick={() => setCalling(true)}>
          <Phone size={16} />
        </button>
        <button className="icon-btn sm" aria-label="Add to People" title={state.ws.contacts[lead.id] ? 'In People' : 'Add to People'} disabled={!!state.ws.contacts[lead.id]} onClick={() => dispatch({ type: 'out', op: { op: 'toCrm', lead: lead.id } })}>
          <UserPlus size={16} />
        </button>
      </header>

      {yes && (
        <p className="ubx-yes" role="status">
          <CalendarCheck size={14} aria-hidden />
          <span>
            {lead.first} agreed to <strong>{whenWords(yes.at)}</strong> (“{yes.quote}”). It isn’t on your calendar yet.
          </span>
        </p>
      )}
      <ol className="ubx-msgs">
        {lead.message && lead.receivedAt && (
          <li className="ubx-msg in form">
            <span className="ubx-meta">Form · {state.out.forms[lead.form ?? '']?.name ?? 'Form'} · {fmtStamp(lead.receivedAt)}</span>
            <p>{lead.message}</p>
          </li>
        )}
        {msgs.map((m) => (
          <li key={m.id} className={`ubx-msg ${m.dir}${m.channel === 'call' ? ' call' : ''}${m.status === 'scheduled' || m.status === 'draft' ? ' scheduled' : ''}`}>
            <span className="ubx-meta">
              <ChannelIcon channel={m.channel} size={12} /> {m.dir === 'in' ? lead.first : 'You'} · {m.status === 'draft' ? 'draft in your mailbox, not sent' : m.status === 'scheduled' ? `scheduled for ${fmtStamp(m.at)}` : fmtStamp(m.at)}
              {m.status === 'bounced' ? ' · bounced' : m.status === 'opened' && m.dir === 'out' ? ' · opened' : ''}
            </span>
            {m.subject && m.channel === 'email' && <strong className="ubx-subj">{m.subject}</strong>}
            {(m.outcome ? `Call: ${m.outcome}` : m.body).split(/\n\n+/).map((p, k) => (
              <p key={k}>{p}</p>
            ))}
          </li>
        ))}
      </ol>

      {lead.status === 'unsubscribed' ? (
        <p className="ubx-closed">{lead.first} unsubscribed. Timmy won’t contact them again.</p>
      ) : (
        <div className="ubx-compose">
          <div className="ubx-compose-top">
            <div className="seg-mini" role="radiogroup" aria-label="Reply by">
              <button role="radio" aria-checked={channel === 'email'} disabled={!lead.email} onClick={() => setChannel('email')}>
                <Mail size={13} /> Email
              </button>
              <button role="radio" aria-checked={channel === 'sms'} disabled={!textOk} title={textOk ? undefined : 'They haven’t agreed to texts'} onClick={() => setChannel('sms')}>
                <MessageSquare size={13} /> Text
              </button>
            </div>
            {sugg && (sugg.template || sugg.text) && (
              <button className="btn btn-xs" onClick={useSuggestion}>
                <Sparkles size={13} /> {sugg.label}
              </button>
            )}
          </div>
          <textarea className="ubx-input" rows={4} value={body} placeholder={channel === 'sms' ? `Text ${lead.first}…` : `Reply to ${lead.first}…`} aria-label="Reply" onChange={(e) => setBody(e.target.value)} />
          <div className="ubx-compose-foot">
            <span className="muted">{channel === 'email' ? subject : `${body.length} characters`}</span>
            <button className="btn btn-sm btn-primary" disabled={!body.trim()} onClick={send}>
              <Send size={13} />
              Send
            </button>
          </div>
        </div>
      )}
      {calling && <CallDialog lead={lead} onClose={() => setCalling(false)} />}
      {booking && <BookDialog lead={lead} onClose={() => setBooking(false)} />}
    </section>
  );
}
