/*
 * Drafts: cold emails Timmy wrote and saved in the Drafts folder of the
 * Gmail or Outlook account each one sends from. Nothing goes out until you
 * send it, here or from your mailbox. In this preview, nothing leaves the
 * browser.
 */
import { FilePen, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { OutMessage } from '../../data/outbound-types';
import { plural } from '../../lib/format';
import { isLive } from '../../live/clock';
import { coldToday, draftsOf } from '../../state/outbound';
import { useStore } from '../../state/store';
import { EmptyState } from '../../components/kit';
import { LeadMark, name } from './shared';

export function DraftsTab() {
  const { state, dispatch } = useStore();
  const drafts = draftsOf(state);
  const [sel, setSel] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const today = coldToday(state);
  const picked = sel.filter((id) => drafts.some((d) => d.id === id));
  // On a real workspace Timmy never sends cold email itself: each draft opens in the person's own mail app, filled in.
  const live = isLive();
  const mailApp = state.conn.apps.gmail?.connected ? 'Gmail' : state.conn.apps.outlook?.connected ? 'Outlook' : 'your mail app';
  const send = (ids: string[]) => {
    if (live) {
      const d = drafts.find((x) => x.id === ids[0]);
      if (d) dispatch({ type: 'out', op: { op: 'send', lead: d.lead, channel: 'email', subject: d.subject, body: d.body } });
      return;
    }
    dispatch({ type: 'out', op: { op: 'sendDrafts', ids } });
    setSel([]);
  };

  return (
    <>
      <div className="out-head">
        <div>
          <h1 className="page-title">Drafts</h1>
          <p className="page-sub">
            {live
              ? `Cold emails Timmy wrote. Edit them here, then open each one in ${mailApp} and send it from there. Timmy never sends cold email itself, and a draft leaves this list once Timmy sees it in your Sent folder.`
              : 'Cold emails Timmy wrote, saved as drafts in the Gmail or Outlook account each one sends from. Edit them here or in your mailbox. Nothing goes out until you send it.'}
          </p>
        </div>
        {drafts.length > 0 && !live && (
          <div className="out-head-actions">
            <span className="muted odr-room">{plural(today.left, 'cold email')} left today</span>
            <button className="btn btn-primary" onClick={() => send(drafts.map((d) => d.id))}>
              <Send size={15} />
              Send all {drafts.length}
            </button>
          </div>
        )}
      </div>

      {picked.length > 0 && (
        <div className="bulk-bar" role="toolbar" aria-label="Selected drafts">
          <span>{plural(picked.length, 'draft')} selected</span>
          {!live && (
            <button className="btn btn-sm btn-primary" onClick={() => send(picked)}>
              <Send size={14} />
              Send {picked.length}
            </button>
          )}
          <button className="btn btn-sm btn-ghost" onClick={() => (dispatch({ type: 'out', op: { op: 'removeDrafts', ids: picked } }), setSel([]))}>
            <Trash2 size={14} />
            Delete
          </button>
        </div>
      )}

      {drafts.length === 0 ? (
        <EmptyState icon={FilePen} title="No drafts waiting" body={live ? 'Write a campaign and its first emails land here, ready for you to open in your mail app and send.' : 'Ask Timmy to write a campaign. Each email lands here and in your mailbox’s Drafts folder, ready for you to send.'} />
      ) : (
        <ul className="odr-list" aria-label="Drafts">
          {drafts.map((d) => (
            <DraftRow
              key={d.id}
              d={d}
              checked={picked.includes(d.id)}
              onCheck={(on) => setSel((x) => (on ? [...x, d.id] : x.filter((y) => y !== d.id)))}
              editing={editing === d.id}
              onEdit={(on) => setEditing(on ? d.id : null)}
              onSend={() => send([d.id])}
              sendLabel={live ? `Open in ${mailApp}` : 'Send'}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function DraftRow({ d, checked, onCheck, editing, onEdit, onSend, sendLabel }: { d: OutMessage; checked: boolean; onCheck: (on: boolean) => void; editing: boolean; onEdit: (on: boolean) => void; onSend: () => void; sendLabel: string }) {
  const { state, dispatch } = useStore();
  const lead = state.out.leads[d.lead];
  const [subject, setSubject] = useState(d.subject ?? '');
  const [body, setBody] = useState(d.body);
  if (!lead) return null;
  const box = d.mailbox ? state.out.mailboxes[d.mailbox] : undefined;
  const camp = d.campaign ? state.out.campaigns[d.campaign] : undefined;
  return (
    <li className="card odr-row">
      <div className="odr-head">
        <input type="checkbox" checked={checked} aria-label={`Select the draft to ${name(lead)}`} onChange={(e) => onCheck(e.target.checked)} />
        <LeadMark lead={lead} size={30} />
        <span className="odr-who">
          <strong>{name(lead)}</strong>
          <span className="muted">
            {lead.title ? `${lead.title}, ` : ''}
            {lead.company}
          </span>
        </span>
        <span className="odr-where muted">
          {isLive() ? 'Draft in Timmy' : `Draft in ${box?.address ?? 'your mailbox'}`}
          {camp ? ` · ${camp.name}, step ${(d.step ?? 0) + 1}` : ''}
        </span>
      </div>
      {editing ? (
        <div className="odr-edit">
          <input className="input" value={subject} aria-label="Subject" onChange={(e) => setSubject(e.target.value)} />
          <textarea className="input" rows={8} value={body} aria-label="Email" onChange={(e) => setBody(e.target.value)} />
          <div className="odr-actions">
            <button className="btn btn-sm btn-ghost" onClick={() => (setSubject(d.subject ?? ''), setBody(d.body), onEdit(false))}>
              Cancel
            </button>
            <button className="btn btn-sm" onClick={() => (dispatch({ type: 'out', op: { op: 'editDraft', id: d.id, subject, body } }), onEdit(false))}>
              Save draft
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="odr-subject">{d.subject}</p>
          <p className="odr-body">{d.body}</p>
          <div className="odr-actions">
            <button className="btn btn-sm btn-ghost" onClick={() => onEdit(true)}>
              Edit
            </button>
            <button className="btn btn-sm btn-primary" onClick={onSend}>
              <Send size={14} />
              {sendLabel}
            </button>
          </div>
        </>
      )}
    </li>
  );
}
