/*
 * Due today: the steps of sequences that are the person's to send now. On a real workspace a campaign never sends by
 * itself (cold email opens in the person's own mail app), so this is where a sequence is worked: each lead's step is
 * written for them, one click from their mail app, and the lead moves on once the email is in their Sent folder. In
 * the demo it lists the steps of campaigns not launched yet.
 */
import { CalendarClock, Mail, MailCheck, Phone, SkipForward } from 'lucide-react';
import { useState } from 'react';
import type { Channel, Lead } from '../../data/outbound-types';
import { fmtDay, fmtTime, plural } from '../../lib/format';
import { isLive } from '../../live/clock';
import { dueSteps, type DueStep } from '../../state/outbound';
import { useStore } from '../../state/store';
import { EmptyState } from '../../components/kit';
import { CallDialog, MessageDialog } from './LeadPanel';
import { ChannelIcon, LeadMark, name } from './shared';

const whenText = (d: DueStep) => (d.overdue ? `Overdue since ${fmtDay(d.due)}` : d.step === 0 ? 'Ready to send' : 'Due today');

export function DueTab() {
  const { state, dispatch } = useStore();
  const due = dueSteps(state);
  const [writing, setWriting] = useState<{ lead: Lead; channel: Channel } | null>(null);
  const [calling, setCalling] = useState<{ lead: Lead; script: string; progress: string } | null>(null);
  const live = isLive();
  const mailApp = state.conn.apps.gmail?.connected ? 'Gmail' : state.conn.apps.outlook?.connected ? 'Outlook' : 'your mail app';
  const campaigns = new Set(due.map((d) => d.campaign.id)).size;
  return (
    <section className="due-tab">
      <div className="due-head">
        <div>
          <h2 className="section-title">Due today</h2>
          <p className="section-sub">
            {due.length
              ? `${plural(due.length, 'step')} to send across ${plural(campaigns, 'campaign')}. Each is written for the lead from your sequence; ${live ? `it opens in ${mailApp}, and the lead moves on to their next step once it is in your Sent folder` : 'sending it moves the lead on to their next step'}.`
              : 'The steps of your sequences that are yours to send show here, written for each lead.'}
          </p>
        </div>
      </div>
      {due.length === 0 ? (
        <EmptyState icon={CalendarClock} title="Nothing due today" body={Object.values(state.out.campaigns).some((c) => c.leads.length) ? 'Every lead in your campaigns is waiting out the days before their next step, or has finished.' : 'Add leads to a campaign, and their first step shows here.'} />
      ) : (
        <ul className="due-list" aria-label="Steps due">
          {due.map((d) => (
            <li key={`${d.lead.id}-${d.step}`} className={`due-row${d.overdue ? ' overdue' : ''}`}>
              <LeadMark lead={d.lead} />
              <div className="due-main">
                <span className="due-who">
                  <strong>{name(d.lead)}</strong>
                  <span className="muted">
                    {d.lead.title ? `${d.lead.title}, ` : ''}
                    {d.lead.company}
                  </span>
                </span>
                <span className="due-step">
                  <ChannelIcon channel={d.channel} size={12} /> {d.campaign.name} · step {d.step + 1} of {d.campaign.steps.length}
                  {d.channel !== 'email' ? ` (${d.channel})` : ''} · <span className={d.overdue ? 'due-late' : ''}>{whenText(d)}</span>
                </span>
                {d.subject && <span className="due-subject">{d.subject}</span>}
                {d.opened && (
                  <span className="due-opened" role="status">
                    <MailCheck size={12} aria-hidden /> Opened in {mailApp} at {fmtTime(d.opened)}. It moves on once Timmy sees it in your Sent folder.
                  </span>
                )}
              </div>
              <div className="due-actions">
                {d.channel === 'call' ? (
                  <button className="btn btn-sm btn-primary" disabled={!d.lead.phone} title={d.lead.phone ? undefined : 'No phone number for this lead'} onClick={() => setCalling({ lead: d.lead, script: d.body, progress: `Step ${d.step + 1} of ${d.campaign.steps.length} in ${d.campaign.name}` })}>
                    <Phone size={13} /> Log the call
                  </button>
                ) : (
                  <button className={`btn btn-sm${d.opened ? '' : ' btn-primary'}`} onClick={() => setWriting({ lead: d.lead, channel: d.channel })}>
                    <Mail size={13} /> {d.opened ? 'Open again' : 'Write it'}
                  </button>
                )}
                <button className="btn btn-sm btn-ghost" onClick={() => dispatch({ type: 'out', op: { op: 'skipStep', lead: d.lead.id } })} title="Move them past this step without sending it">
                  <SkipForward size={13} /> Skip this step
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {writing && <MessageDialog lead={writing.lead} channel={writing.channel} onClose={() => setWriting(null)} />}
      {calling && <CallDialog lead={calling.lead} script={calling.script} progress={calling.progress} onClose={() => setCalling(null)} />}
    </section>
  );
}
