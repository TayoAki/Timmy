/*
 * Calls: today's call list, built from form leads still waiting, callbacks you
 * set, and call steps due in running campaigns. Start calling and Timmy opens
 * each call in turn with the right script; log how it went (notes, a
 * callback, a yes to texts) and it moves to the next one. Logged calls tick
 * the campaign step, so the sequence moves on.
 */
import { PhoneCall, PhoneForwarded } from 'lucide-react';
import { useState } from 'react';
import { fmtDay, fmtTime, plural } from '../../lib/format';
import { callQueue, type CallItem } from '../../state/leads';
import { useStore } from '../../state/store';
import { EmptyState } from '../../components/kit';
import { CallDialog } from './LeadPanel';
import { LeadMark, Meter, name } from './shared';

const KIND: Record<CallItem['kind'], string> = { form: 'Form lead', callback: 'Callback', step: 'Campaign step' };

export function CallsTab() {
  const { state } = useStore();
  const q = callQueue(state);
  const calls = state.out.channels.call;
  // The power-dialer flow: one call after another until the list is done or you stop.
  const [run, setRun] = useState<{ ids: string[]; i: number } | null>(null);
  const [one, setOne] = useState<CallItem | null>(null);
  const current = run ? q.find((x) => x.lead.id === run.ids[run.i]) ?? null : one;
  const next = () => {
    if (!run) return setOne(null);
    const i = run.i + 1;
    setRun(i < run.ids.length ? { ...run, i } : null);
  };

  return (
    <>
      <div className="out-head">
        <div>
          <h1 className="page-title">Calls</h1>
          <p className="page-sub">
            {q.length ? `${plural(q.length, 'call')} today, most urgent first.` : 'No calls due today.'} Timmy shows the script, you dial, and the outcome is logged on the lead
            {state.conn.crm.activity ? ' and as CRM activity once a CRM is connected' : ''}.
          </p>
        </div>
        <div className="out-head-actions">
          <button className="btn btn-primary" disabled={!q.length} onClick={() => setRun({ ids: q.map((x) => x.lead.id), i: 0 })}>
            <PhoneForwarded size={15} />
            Start calling
          </button>
        </div>
      </div>
      {calls && <Meter used={calls.sentToday ?? 0} cap={calls.dailyLimit ?? 0} label="Calls logged today" unit="calls" />}

      {q.length ? (
        <ol className="card call-list">
          {q.map((x, i) => (
            <li key={x.lead.id} className="call-row">
              <span className="urg-rank" aria-hidden>
                {i + 1}
              </span>
              <LeadMark lead={x.lead} size={32} />
              <div className="call-text">
                <strong>{name(x.lead)}</strong>
                <span className="muted">
                  {x.lead.title ? `${x.lead.title}, ` : ''}
                  {x.lead.company}
                </span>
                <span className="call-why">
                  <span className={`call-kind ${x.kind}`}>{KIND[x.kind]}</span> {x.why}
                  {x.kind === 'callback' ? ` · ${fmtDay(x.due)} ${fmtTime(x.due)}` : ''}
                </span>
              </div>
              <span className="call-phone">{x.lead.phone}</span>
              <button className="btn btn-sm" onClick={() => setOne(x)}>
                <PhoneCall size={14} />
                Call
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <EmptyState icon={PhoneCall} title="No calls due today" body="Form leads with a phone number, callbacks you set and call steps in running campaigns show up here on the day." />
      )}

      {current && (
        <CallDialog
          lead={current.lead}
          script={current.script}
          progress={run ? `Call ${run.i + 1} of ${run.ids.length}` : undefined}
          onClose={() => (setRun(null), setOne(null))}
          onLogged={next}
        />
      )}
    </>
  );
}
