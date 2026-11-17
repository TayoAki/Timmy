/*
 * Channels & limits: the mailboxes cold email goes out from and how much each
 * may send, the other channels (texts, phone, Slack, LinkedIn, WhatsApp,
 * calendar), and the guardrails that keep you out of spam folders and on the
 * right side of texting rules.
 */
import { CalendarDays, Hash, Briefcase, Mail, MessageCircle, MessageSquare, Phone, Plus, ShieldCheck, Trash2, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import type { ChannelConn, Limits, Mailbox } from '../../data/outbound-types';
import { NOW, PEOPLE } from '../../data/mock';
import { mailboxCap } from '../../lib/outbound';
import { dnsFor, domainOf } from '../../lib/dns';
import { coldToday } from '../../state/outbound';
import { useStore } from '../../state/store';
import { Field, Modal } from '../../components/kit';
import { Meter } from './shared';

const ICONS: Record<string, LucideIcon> = { email: Mail, sms: MessageSquare, call: Phone, slack: Hash, linkedin: Briefcase, whatsapp: MessageCircle, calendar: CalendarDays };

export function ChannelsTab() {
  const { state, dispatch } = useStore();
  const { limits } = state.out;
  const today = coldToday(state);
  const sms = state.out.channels.sms;
  const calls = state.out.channels.call;
  const [addBox, setAddBox] = useState(false);
  const [bulk, setBulk] = useState(false);
  const [connect, setConnect] = useState<ChannelConn | null>(null);
  const setLimits = (patch: Partial<Limits>) => dispatch({ type: 'out', op: { op: 'limits', patch } });
  const setBox = (m: Mailbox, patch: Partial<Mailbox>) => dispatch({ type: 'out', op: { op: 'mailbox', mailbox: { ...m, ...patch } } });

  return (
    <>
      <div className="out-head">
        <div>
          <h1 className="page-title">Channels & limits</h1>
          <p className="page-sub">Where outbound goes out from, and how much. The limits apply to every campaign and every one-off message.</p>
        </div>
      </div>

      <section className="section limits-today" aria-label="Today">
        <Meter used={today.sent} cap={today.cap} label="Cold emails today" />
        {sms && <Meter used={sms.sentToday ?? 0} cap={sms.dailyLimit ?? 0} label="Texts today" />}
        {calls && <Meter used={calls.sentToday ?? 0} cap={calls.dailyLimit ?? 0} label="Calls today" unit="logged" />}
      </section>

      <section className="section" aria-labelledby="mb-title">
        <div className="section-head">
          <h2 className="section-title" id="mb-title">
            Sending mailboxes
          </h2>
          <span className="mb-head-actions">
            <button className="btn btn-sm" onClick={() => setBulk(true)}>
              <Plus size={14} />
              Add in bulk
            </button>
            <button className="btn btn-sm" onClick={() => setAddBox(true)}>
              <Plus size={14} />
              Add mailbox
            </button>
          </span>
        </div>
        <p className="field-hint mb-hint">
          Cold email goes out through the Gmail and Outlook accounts you connect with Composio, your main one included. Timmy keeps each account under its daily limit. Extra accounts, ideally on
          a second domain, spread the volume so a bad week can’t touch the mail your customers rely on.
        </p>
        <ul className="mb-list">
          {Object.values(state.out.mailboxes).map((m) => {
            const cap = mailboxCap(m, limits);
            const age = Math.max(0, Math.floor((NOW.getTime() - m.added.getTime()) / 86_400_000));
            const ramping = m.warmup && cap < Math.min(m.dailyLimit, limits.maxPerMailbox);
            return (
              <li key={m.id} className="card mb-row">
                <div className="mb-main">
                  <strong className="mb-addr">{m.address}</strong>
                  <span className="muted">
                    Health {m.health} · {ramping ? `warming up, day ${age + 1}: ${cap} a day today, +${limits.rampStep} each day` : `sends up to ${cap} a day`}
                  </span>
                  <span className="mb-health" aria-hidden>
                    <span style={{ width: `${m.health}%` }} className={m.health >= 90 ? 'good' : m.health >= 75 ? 'ok' : 'bad'} />
                  </span>
                </div>
                <label className="mb-limit">
                  <span className="field-label">Daily limit</span>
                  <input
                    type="number"
                    className="input sm num-input"
                    min={1}
                    max={limits.maxPerMailbox}
                    value={m.dailyLimit}
                    onChange={(e) => setBox(m, { dailyLimit: Math.max(1, Math.min(limits.maxPerMailbox, Number(e.target.value) || 1)) })}
                  />
                </label>
                <label className="mb-warm">
                  <input type="checkbox" checked={m.warmup} onChange={(e) => setBox(m, { warmup: e.target.checked })} /> Warm-up
                </label>
                <button className="icon-btn sm" aria-label={`Remove ${m.address}`} onClick={() => dispatch({ type: 'out', op: { op: 'removeMailbox', id: m.id } })}>
                  <Trash2 size={14} />
                </button>
                {m.dailyLimit > limits.perMailbox && <p className="seq-hint warn mb-warn">Above {limits.perMailbox} a day, a single mailbox starts to look like bulk mail. Add a mailbox instead.</p>}
              </li>
            );
          })}
        </ul>
        <p className="field-hint mb-hint">
          {Object.keys(state.out.mailboxes).length} mailboxes · Timmy rotates cold email across the ones with room left today, so no single address carries the volume.
        </p>
      </section>

      <DomainChecks />

      <section className="section" aria-labelledby="guard-title">
        <div className="section-head">
          <h2 className="section-title" id="guard-title">
            Guardrails
          </h2>
          <ShieldCheck size={16} aria-hidden className="muted" />
        </div>
        <div className="guard-grid">
          <Field label="Cold emails per mailbox, per day" hint={`Recommended ${limits.perMailbox}; Timmy never goes above ${limits.maxPerMailbox}.`}>
            <input className="input sm num-input" type="number" min={5} max={limits.maxPerMailbox} value={limits.perMailbox} onChange={(e) => setLimits({ perMailbox: Math.max(5, Math.min(limits.maxPerMailbox, Number(e.target.value) || 30)) })} />
          </Field>
          <Field label="New mailboxes start at" hint={`Then +${limits.rampStep} a day until they reach their limit.`}>
            <input className="input sm num-input" type="number" min={1} max={30} value={limits.rampStart} onChange={(e) => setLimits({ rampStart: Math.max(1, Math.min(30, Number(e.target.value) || 10)) })} />
          </Field>
          <Field label="Minutes between sends" hint="Per mailbox, so mail goes out at a human pace.">
            <input className="input sm num-input" type="number" min={1} max={30} value={limits.gapMinutes[0]} onChange={(e) => setLimits({ gapMinutes: [Math.max(1, Math.min(30, Number(e.target.value) || 4)), limits.gapMinutes[1]] })} />
          </Field>
          <Field label="Pause a campaign when bounces reach" hint="Protects the domain if a list goes bad.">
            <select className="input sm" value={limits.bouncePause} onChange={(e) => setLimits({ bouncePause: Number(e.target.value) })}>
              {[0.02, 0.03, 0.05].map((x) => (
                <option key={x} value={x}>
                  {Math.round(x * 100)}% of sends
                </option>
              ))}
            </select>
          </Field>
          <Field label="Texts per day" hint={`Only to leads who agreed, ${limits.sms.quietStart}–${limits.sms.quietEnd} their time, with “Reply STOP”.`}>
            <input className="input sm num-input" type="number" min={1} max={500} value={limits.sms.perDay} onChange={(e) => {
              const n = Math.max(1, Math.min(500, Number(e.target.value) || 100));
              setLimits({ sms: { ...limits.sms, perDay: n } });
              if (sms) dispatch({ type: 'out', op: { op: 'channel', id: 'sms', patch: { dailyLimit: n } } });
            }} />
          </Field>
          <Field label="Calls per day">
            <input className="input sm num-input" type="number" min={1} max={300} value={limits.calls.perDay} onChange={(e) => {
              const n = Math.max(1, Math.min(300, Number(e.target.value) || 60));
              setLimits({ calls: { perDay: n } });
              if (calls) dispatch({ type: 'out', op: { op: 'channel', id: 'call', patch: { dailyLimit: n } } });
            }} />
          </Field>
        </div>
        <ul className="guard-list">
          <li>A reply stops the sequence for that lead; unsubscribes and bounces are never contacted again.</li>
          <li>Leads already in an active campaign are skipped when you add them to another.</li>
          <li>Cold texts aren’t allowed: a text step only reaches leads who opted in, like form leads who ticked “text me”.</li>
          <li>One-off emails count toward the same daily limit; past it, they wait for tomorrow’s window.</li>
        </ul>
      </section>

      <section className="section" aria-labelledby="ch-title">
        <div className="section-head">
          <h2 className="section-title" id="ch-title">
            Channels
          </h2>
        </div>
        <ul className="ch-grid">
          {Object.values(state.out.channels).map((c) => {
            const Icon = ICONS[c.id] ?? Mail;
            return (
              <li key={c.id} className="card ch-card">
                <span className={`ch-badge${c.connected ? ' on' : ''}`}>
                  <Icon size={18} aria-hidden />
                </span>
                <div className="ch-text">
                  <strong>{c.name}</strong>
                  <span className={c.connected ? 'ch-acct' : 'muted'}>{c.connected ? c.account : 'Not connected'}</span>
                  <span className="field-hint">{c.use}</span>
                </div>
                {c.id !== 'email' &&
                  (c.connected ? (
                    <button className="btn btn-sm btn-ghost" onClick={() => dispatch({ type: 'out', op: { op: 'channel', id: c.id, patch: { connected: false } } })}>
                      Disconnect
                    </button>
                  ) : (
                    <button className="btn btn-sm" onClick={() => setConnect(c)}>
                      Connect
                    </button>
                  ))}
              </li>
            );
          })}
        </ul>
      </section>

      {addBox && <AddMailbox onClose={() => setAddBox(false)} />}
      {bulk && <BulkMailboxes onClose={() => setBulk(false)} />}
      {connect && <ConnectDialog c={connect} onClose={() => setConnect(null)} />}
    </>
  );
}

function AddMailbox({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [address, setAddress] = useState('');
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.trim());
  const main = address.trim().endsWith('@northpeak.io');
  return (
    <Modal
      open
      onClose={onClose}
      title="Add a sending mailbox"
      description="Connect a Gmail or Outlook account through Composio. It sends cold email alongside your other accounts."
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!ok}
            onClick={() => {
              dispatch({ type: 'out', op: { op: 'mailbox', mailbox: { id: `mb-${Date.now().toString(36)}`, address: address.trim(), name: PEOPLE.me?.name ?? 'Taylor Morgan', dailyLimit: state.out.limits.perMailbox, warmup: true, health: 80, sentToday: 0, added: NOW } } });
              dispatch({ type: 'toast', text: `Added ${address.trim()}. It warms up from ${state.out.limits.rampStart} a day.` });
              onClose();
            }}
          >
            Add mailbox
          </button>
        </>
      }
    >
      <Field label="Email address" hint={main ? 'That’s your main domain. It works, and Timmy keeps it to its daily limit. A second domain is safer for volume.' : `Starts at ${state.out.limits.rampStart} a day and adds ${state.out.limits.rampStep} a day while it warms up.`}>
        <input className="input" type="email" value={address} placeholder="taylor@trynorthpeak.io" onChange={(e) => setAddress(e.target.value)} />
      </Field>
      <p className="field-hint preview-note">Preview: in this demo the mailbox is added without signing in.</p>
    </Modal>
  );
}

const CONNECT_ASK: Record<string, { label: string; placeholder: string }> = {
  sms: { label: 'Sending number', placeholder: '+1 (555) 010-2048' },
  call: { label: 'Caller ID', placeholder: '+1 (555) 010-2048' },
  slack: { label: 'Workspace and channel', placeholder: 'Northpeak · #new-leads' },
  linkedin: { label: 'Your LinkedIn profile', placeholder: 'linkedin.com/in/taylor-morgan' },
  whatsapp: { label: 'WhatsApp Business number', placeholder: '+1 (555) 010-2048' },
  calendar: { label: 'Calendar account', placeholder: 'taylor@northpeak.io' },
};

function ConnectDialog({ c, onClose }: { c: ChannelConn; onClose: () => void }) {
  const { dispatch } = useStore();
  const ask = CONNECT_ASK[c.id] ?? { label: 'Account', placeholder: '' };
  const [account, setAccount] = useState('');
  return (
    <Modal
      open
      onClose={onClose}
      title={`Connect ${c.name}`}
      description={c.use}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!account.trim()} onClick={() => (dispatch({ type: 'out', op: { op: 'channel', id: c.id, patch: { connected: true, account: account.trim() } } }), onClose())}>
            Connect
          </button>
        </>
      }
    >
      <Field label={ask.label}>
        <input className="input" value={account} placeholder={ask.placeholder} onChange={(e) => setAccount(e.target.value)} />
      </Field>
      <p className="field-hint preview-note">Preview: in this demo the channel connects without signing in, and nothing is actually sent.</p>
    </Modal>
  );
}

/* ───────────── Sending domains ───────────── */

/** SPF, DKIM and DMARC for every domain you send from, with the fix for anything missing. */
function DomainChecks() {
  const { state } = useStore();
  const domains = [...new Set(Object.values(state.out.mailboxes).map((m) => domainOf(m.address)))].filter(Boolean);
  if (!domains.length) return null;
  return (
    <section className="section" aria-labelledby="dns-title">
      <div className="section-head">
        <h2 className="section-title" id="dns-title">
          Sending domains
        </h2>
        <span className="section-sub">Gmail and Yahoo reject bulk mail without SPF, DKIM and DMARC. Timmy adds one-click unsubscribe to every cold email.</span>
      </div>
      <ul className="dns-list">
        {domains.map((d) => {
          const checks = dnsFor(d);
          const bad = checks.filter((c) => !c.ok);
          return (
            <li key={d} className="card dns-row">
              <strong className="dns-domain">{d}</strong>
              <span className="dns-checks">
                {checks.map((c) => (
                  <span key={c.key} className={`dns-chip ${c.ok ? 'ok' : 'bad'}`}>
                    {c.ok ? '✓' : '✕'} {c.label}
                  </span>
                ))}
              </span>
              {bad.length > 0 ? (
                <ul className="dns-fixes">
                  {bad.map((c) => (
                    <li key={c.key}>{c.fix}</li>
                  ))}
                </ul>
              ) : (
                <span className="muted dns-ok">Ready to send</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ───────────── Many mailboxes at once ───────────── */

function BulkMailboxes({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [text, setText] = useState('');
  const have = new Set(Object.values(state.out.mailboxes).map((m) => m.address.toLowerCase()));
  const rows = text
    .split(/\n+/)
    .map((line) => line.split(/[,;\t]/).map((x) => x.trim()))
    .filter((r) => r[0]);
  const parsed = rows.map(([address, ...rest]) => ({ address: address!.toLowerCase(), name: rest.join(' ').trim() }));
  const good = parsed.filter((r) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(r.address) && !have.has(r.address));
  const main = good.filter((r) => r.address.endsWith('@northpeak.io'));
  const add = () => {
    good.forEach((r, i) =>
      dispatch({
        type: 'out',
        op: { op: 'mailbox', mailbox: { id: `mb-${Date.now().toString(36)}-${i}`, address: r.address, name: r.name || state.out.mailboxes['mb-1']?.name || 'Sender', dailyLimit: state.out.limits.perMailbox, warmup: true, health: 80, sentToday: 0, added: NOW } },
      }),
    );
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Add mailboxes in bulk"
      description="One per line: address, then the sender name. Each starts warming up at a low daily limit."
      width={560}
      footer={
        <>
          <span className="modal-foot-note">
            {good.length} ready{parsed.length - good.length ? ` · ${parsed.length - good.length} skipped (invalid or already added)` : ''}
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!good.length} onClick={add}>
            Add {good.length || ''} mailbox{good.length === 1 ? '' : 'es'}
          </button>
        </>
      }
    >
      <textarea className="input mono" rows={8} value={text} placeholder={'alex@trynorthpeak.io, Alex Rivera\nsam@getnorthpeak.io, Sam Lee'} aria-label="Mailboxes" onChange={(e) => setText(e.target.value)} data-autofocus />
      {main.length > 0 && <p className="seq-hint warn">{main.length} on your main domain. That works; keep its daily limit low.</p>}
      <p className="field-hint">In the product each account connects through Composio with its own Gmail or Outlook sign-in.</p>
    </Modal>
  );
}
