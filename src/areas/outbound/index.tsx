/*
 * Outbound: find and reach new customers. Leads, Campaigns, Unibox, Speed to
 * lead, Templates & offer, and Channels & limits, with the sidebar listing
 * your lists and campaigns and the right panel showing the lead you picked
 * (or what needs you today).
 */
import { FilePen, Gauge, Inbox, LayoutTemplate, List, Mail, MessagesSquare, PhoneCall, Plus, Rocket, Send, Timer, Users } from 'lucide-react';
import { ChatTab } from './Chat';
import { fmtListDate, plural } from '../../lib/format';
import { campaignCap, liveNow, project } from '../../lib/outbound';
import { coldToday, ctxOf, draftsOf } from '../../state/outbound';
import { useStore, type OutboundTab } from '../../state/store';
import { Frame } from '../../components/Frame';
import { Field, Modal, SideHead } from '../../components/kit';
import { useState } from 'react';
import { tint } from '../../components/common';
import { RpSection } from '../files/pickers';
import { CampaignView } from './Campaign';
import { CampaignsTab } from './Campaigns';
import { CallsTab } from './Calls';
import { DraftsTab } from './Drafts';
import { callQueue } from '../../state/leads';
import { ChannelsTab } from './Channels';
import { LeadPanel } from './LeadPanel';
import { LeadsTab } from './Leads';
import { SpeedTab } from './Speed';
import { TemplatesTab } from './Templates';
import { UniboxTab } from './Unibox';
import { LeadMark, Meter, name } from './shared';
import '../../styles/outbound.css';

export { CampaignView };

/** Counts for tab badges and the rail. */
export function useOutboundCounts() {
  const { state } = useStore();
  const leads = Object.values(state.out.leads);
  return {
    unread: leads.filter((l) => l.unread).length,
    waiting: leads.filter((l) => l.source === 'form' && !l.firstReplyAt && l.status !== 'not-interested').length,
    review: Object.values(state.out.campaigns).filter((c) => c.status === 'review').length,
    drafts: draftsOf(state).length,
  };
}

export function OutboundView() {
  const { state, dispatch } = useStore();
  const r = state.route.view === 'outbound' ? state.route : null;
  const tab: OutboundTab = r?.tab ?? 'leads';
  const n = useOutboundCounts();
  return (
    <Frame
      tabs={[
        { id: 'leads', label: 'Leads', count: Object.keys(state.out.leads).length },
        { id: 'campaigns', label: 'Campaigns', count: n.review || undefined },
        { id: 'drafts', label: 'Drafts', count: n.drafts || undefined },
        { id: 'unibox', label: 'Unibox', count: n.unread || undefined },
        { id: 'speed', label: 'Speed to lead', count: n.waiting || undefined },
        { id: 'chat', label: 'Website chat', count: Object.values(state.ws.chats).filter((c) => c.unread).length || undefined },
        { id: 'calls', label: 'Calls', count: callQueue(state).length || undefined },
        { id: 'templates', label: 'Templates & offer' },
        { id: 'channels', label: 'Channels & limits' },
      ]}
      active={tab}
      onTab={(id) => dispatch({ type: 'navigate', route: { view: 'outbound', tab: id as OutboundTab } })}
      wide
      scrollKey={`out-${tab}-${r?.list ?? ''}`}
    >
      <ClientBar />
      {tab === 'leads' && <LeadsTab />}
      {tab === 'campaigns' && <CampaignsTab />}
      {tab === 'drafts' && <DraftsTab />}
      {tab === 'unibox' && <UniboxTab />}
      {tab === 'speed' && <SpeedTab />}
      {tab === 'chat' && <ChatTab />}
      {tab === 'calls' && <CallsTab />}
      {tab === 'templates' && <TemplatesTab />}
      {tab === 'channels' && <ChannelsTab />}
    </Frame>
  );
}

/* ───────────── Sidebar ───────────── */

const NAV: { tab: OutboundTab; label: string; icon: typeof Users; hint: string; color: string }[] = [
  { tab: 'leads', label: 'Leads', icon: Users, hint: 'Lists, fit and qualification', color: 'var(--c-sky)' },
  { tab: 'campaigns', label: 'Campaigns', icon: Send, hint: 'Sequences across channels', color: 'var(--c-violet)' },
  { tab: 'drafts', label: 'Drafts', icon: FilePen, hint: 'Cold emails waiting for you', color: 'var(--c-indigo)' },
  { tab: 'unibox', label: 'Unibox', icon: Inbox, hint: 'Every reply in one place', color: 'var(--c-green)' },
  { tab: 'speed', label: 'Speed to lead', icon: Timer, hint: 'Form leads, on the clock', color: 'var(--c-amber)' },
  { tab: 'chat', label: 'Website chat', icon: MessagesSquare, hint: 'Timmy answers visitors on your site', color: 'var(--c-teal)' },
  { tab: 'calls', label: 'Calls', icon: PhoneCall, hint: 'Today’s call list', color: 'var(--c-red)' },
  { tab: 'templates', label: 'Templates & offer', icon: LayoutTemplate, hint: 'What Timmy writes from', color: 'var(--c-teal)' },
  { tab: 'channels', label: 'Channels & limits', icon: Gauge, hint: '30 cold emails a mailbox', color: 'var(--c-slate)' },
];

export function OutboundSide() {
  const { state, dispatch } = useStore();
  const r = state.route;
  const n = useOutboundCounts();
  const today = coldToday(state);
  const lists = Object.values(state.out.lists);
  const campaigns = Object.values(state.out.campaigns);
  const countFor: Partial<Record<OutboundTab, number>> = { unibox: n.unread, speed: n.waiting, campaigns: n.review, drafts: n.drafts, chat: Object.values(state.ws.chats).filter((c) => c.unread).length };
  return (
    <>
      <SideHead
        icon={
          <span className="nav-icon" style={tint('var(--c-violet)')}>
            <Rocket size={16} />
          </span>
        }
        title="Outbound"
        sub={`${plural(Object.keys(state.out.leads).length, 'lead')} · ${campaigns.filter((c) => c.status === 'active').length} active`}
        action={
          <button className="btn btn-primary" onClick={() => dispatch({ type: 'navigate', route: { view: 'outbound', tab: 'leads' } })}>
            <Plus size={15} />
            Import leads
          </button>
        }
      />
      <div className="side-scroll">
        <div className="side-group">
          {NAV.map((x) => (
            <button
              key={x.tab}
              className="nav-item"
              style={tint(x.color)}
              aria-current={r.view === 'outbound' && r.tab === x.tab && !r.list ? 'page' : undefined}
              onClick={() => dispatch({ type: 'navigate', route: { view: 'outbound', tab: x.tab } })}
            >
              <span className="nav-icon">
                <x.icon size={16} />
              </span>
              <span className="nav-text">
                <span className="nav-name">{x.label}</span>
                <span className="nav-hint">{x.hint}</span>
              </span>
              <span className={`nav-count${countFor[x.tab] ? ' strong' : ''}`}>{countFor[x.tab] || ''}</span>
            </button>
          ))}
        </div>
        <div className="side-group">
          <div className="side-title">Lead lists</div>
          {lists.map((l) => (
            <button
              key={l.id}
              className="nav-item compact"
              aria-current={r.view === 'outbound' && r.tab === 'leads' && r.list === l.id ? 'page' : undefined}
              onClick={() => dispatch({ type: 'navigate', route: { view: 'outbound', tab: 'leads', list: l.id } })}
            >
              <List size={15} className="ap-nav-glyph" aria-hidden />
              <span className="nav-name">{l.name}</span>
              <span className="nav-count">{Object.values(state.out.leads).filter((x) => x.list === l.id).length}</span>
            </button>
          ))}
        </div>
        <div className="side-group">
          <div className="side-title">Campaigns</div>
          {campaigns.map((c) => (
            <button key={c.id} className="nav-item compact" aria-current={r.view === 'campaign' && r.id === c.id ? 'page' : undefined} onClick={() => dispatch({ type: 'navigate', route: { view: 'campaign', id: c.id, tab: c.status === 'active' ? 'analytics' : 'sequence' } })}>
              <span className={`cdot cs-${c.status}`} aria-label={c.status} />
              <span className="nav-name">{c.name}</span>
              <span className="nav-count">{c.leads.length}</span>
            </button>
          ))}
        </div>
        <div className="side-group side-meter">
          <Meter used={today.sent} cap={today.cap} label="Cold emails today" />
        </div>
      </div>
    </>
  );
}

/* ───────────── Right panel ───────────── */

export function OutboundContext() {
  const { state, dispatch } = useStore();
  const r = state.route;
  const lead = r.view === 'outbound' && r.id ? state.out.leads[r.id] : undefined;
  if (lead) return <LeadPanel lead={lead} />;

  if (r.view === 'campaign') {
    const c = state.out.campaigns[r.id];
    if (!c) return null;
    const plan = c.status === 'active' ? project(c, state.out.leads, ctxOf(state)) : null;
    const today = plan?.days[0];
    const replies = c.leads.map((id) => state.out.leads[id]).filter((l) => l && (l.status === 'interested' || l.unread));
    return (
      <>
        <RpSection title="Today">
          {c.status === 'active' && today ? (
            <>
              <Meter used={today.email} cap={campaignCap(c, state.out.mailboxes, state.out.limits)} label="Emails planned" unit="" calm />
              <p className="rp-text">
                {today.calls ? `${plural(today.calls, 'call')} on the call list. ` : ''}Sends start at {c.schedule.start.replace(/^0/, '')}, spread across the window.
              </p>
            </>
          ) : (
            <p className="rp-text">{c.status === 'paused' ? 'Paused: nothing goes out.' : 'Not launched yet.'}</p>
          )}
        </RpSection>
        <RpSection title="Needs a reply" aside={<span className="rp-aside">{replies.length}</span>}>
          {replies.length === 0 ? (
            <p className="rp-text">No open replies from this campaign.</p>
          ) : (
            <ul className="rp-leads">
              {replies.map((l) => (
                <li key={l!.id}>
                  <button className="rp-lead" onClick={() => dispatch({ type: 'navigate', route: { view: 'outbound', tab: 'unibox', id: l!.id } })}>
                    <LeadMark lead={l!} size={24} />
                    <span>
                      {name(l!)}
                      <span className="lead-sub">{l!.company}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </RpSection>
        <SendingRules />
      </>
    );
  }

  const unread = Object.values(state.out.leads).filter((l) => l.unread);
  const waiting = Object.values(state.out.leads).filter((l) => l.source === 'form' && !l.firstReplyAt && l.status !== 'not-interested');
  const today = coldToday(state);
  return (
    <>
      <RpSection title="Needs you" aside={<span className="rp-aside">{unread.length + waiting.length}</span>}>
        {unread.length + waiting.length === 0 ? (
          <p className="rp-text">No unread replies and no form leads waiting.</p>
        ) : (
          <ul className="rp-leads">
            {waiting.map((l) => (
              <li key={l.id}>
                <button className="rp-lead" onClick={() => dispatch({ type: 'navigate', route: { view: 'outbound', tab: 'speed' } })}>
                  <LeadMark lead={l} size={24} />
                  <span>
                    {name(l)}
                    <span className="lead-sub">Form lead · waiting {Math.max(1, Math.round((liveNow().getTime() - l.receivedAt!.getTime()) / 60000))} min</span>
                  </span>
                </button>
              </li>
            ))}
            {unread.map((l) => (
              <li key={l.id}>
                <button className="rp-lead" onClick={() => dispatch({ type: 'navigate', route: { view: 'outbound', tab: 'unibox', id: l.id } })}>
                  <LeadMark lead={l} size={24} />
                  <span>
                    {name(l)}
                    <span className="lead-sub">
                      Replied ·{' '}
                      {fmtListDate(
                        state.out.messages
                          .filter((m) => m.lead === l.id && m.dir === 'in')
                          .sort((a, b) => b.at.getTime() - a.at.getTime())[0]?.at ?? l.added,
                      )}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </RpSection>
      <RpSection title="Today’s limits">
        <Meter used={today.sent} cap={today.cap} label="Cold emails" />
        {state.out.channels.sms && <Meter used={state.out.channels.sms.sentToday ?? 0} cap={state.out.channels.sms.dailyLimit ?? 0} label="Texts" />}
        <button className="btn btn-xs btn-ghost" onClick={() => dispatch({ type: 'navigate', route: { view: 'outbound', tab: 'channels' } })}>
          <Mail size={13} /> Mailboxes and limits
        </button>
      </RpSection>
      <SendingRules />
    </>
  );
}

function SendingRules() {
  const { state } = useStore();
  return (
    <RpSection title="How Timmy keeps you out of spam">
      <ul className="rp-rules">
        <li>At most {state.out.limits.perMailbox} cold emails an account a day, spread across the accounts you connect, with new ones warming up.</li>
        <li>Sends spread through the day, at least {state.out.limits.gapMinutes[0]} minutes apart.</li>
        <li>A reply stops the sequence; bounces over {Math.round(state.out.limits.bouncePause * 100)}% pause it.</li>
        <li>Texts only to people who agreed to them.</li>
      </ul>
    </RpSection>
  );
}

/* ───────────── Client workspaces ───────────── */

/** Agencies run each client in its own workspace: offer, mailboxes, leads, campaigns and Unibox. */
function ClientBar() {
  const { state, dispatch } = useStore();
  const [naming, setNaming] = useState(false);
  const [nameText, setNameText] = useState('');
  const cl = state.clients;
  return (
    <div className="client-bar">
      <label className="client-pick">
        <span className="field-label">Workspace</span>
        <select className="input sm" value={cl.active} onChange={(e) => dispatch({ type: 'client', to: e.target.value })} aria-label="Client workspace">
          {Object.entries(cl.names).map(([id, n]) => (
            <option key={id} value={id}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <button className="btn btn-sm btn-ghost" onClick={() => setNaming(true)}>
        <Plus size={14} />
        New client workspace
      </button>
      {naming && (
        <Modal
          open
          onClose={() => setNaming(false)}
          title="New client workspace"
          description="For agencies: the client gets their own offer, mailboxes, leads, campaigns, Unibox and reports. Your sending limits carry over."
          width={460}
          footer={
            <>
              <button className="btn btn-sm btn-ghost" onClick={() => setNaming(false)}>
                Cancel
              </button>
              <button
                className="btn btn-sm btn-primary"
                disabled={!nameText.trim()}
                onClick={() => {
                  dispatch({ type: 'client', create: nameText.trim() });
                  setNaming(false);
                  setNameText('');
                }}
              >
                Create
              </button>
            </>
          }
        >
          <Field label="Client name">
            <input className="input" value={nameText} placeholder="Acme Dental Group" onChange={(e) => setNameText(e.target.value)} data-autofocus />
          </Field>
        </Modal>
      )}
    </div>
  );
}
