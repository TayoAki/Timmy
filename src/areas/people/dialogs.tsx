import { Phone, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AutoTextarea, Field, Modal, Segmented } from '../../components/kit';
import { NOW } from '../../data/mock';
import type { Contact, Interaction } from '../../data/ws-types';
import { useStore, ws } from '../../state/store';
import { isoDay, parseIsoDay, patch, put, uid, type WsOp } from '../../state/ws';
import { lastTouch } from './lib';

const atFor = (iso: string) => (iso === isoDay(NOW) ? NOW : parseIsoDay(iso, 12));

/* ───────────── Log a call or meeting ───────────── */

export function LogDialog({ open, onClose, contact }: { open: boolean; onClose: () => void; contact: Contact }) {
  const { state, dispatch } = useStore();
  const [kind, setKind] = useState<'call' | 'meeting'>('call');
  const [text, setText] = useState('');
  const [date, setDate] = useState(isoDay(NOW));
  const [file, setFile] = useState('');
  const [next, setNext] = useState('');
  const [due, setDue] = useState('');
  const [tried, setTried] = useState(false);
  const first = contact.name.split(' ')[0];
  const docs = Object.values(state.ws.files)
    .filter((f) => f.kind === 'doc' && !f.filing && f.share !== 'pending')
    .sort((a, b) => b.updated.getTime() - a.updated.getTime());

  useEffect(() => {
    if (!open) return;
    setKind('call');
    setText('');
    setDate(isoDay(NOW));
    setFile('');
    setNext('');
    setDue('');
    setTried(false);
  }, [open]);

  const save = () => {
    setTried(true);
    if (!text.trim() || !date) return;
    const at = atFor(date);
    const item: Interaction = { id: uid('int'), contact: contact.id, kind, text: text.trim(), at, by: 'me', file: file || undefined };
    const ops: WsOp[] = [put('interactions', item)];
    const change: Partial<Contact> = {};
    const last = lastTouch(state.ws, contact, state.threads);
    if (at.getTime() <= NOW.getTime() && (!last || at > last)) change.last = at;
    if (next.trim()) Object.assign(change, { next: next.trim(), owner: 'me', due: due ? parseIsoDay(due, 17) : undefined });
    if (Object.keys(change).length) ops.push(patch('contacts', contact.id, change));
    dispatch(ws(ops, { toast: `Logged ${kind === 'call' ? 'a call' : 'a meeting'} with ${first}${next.trim() ? ' · next step updated' : ''}`, undo: true }));
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Log a call or meeting with ${first}`}
      description="Keep the outcome and the next step, and link the meeting note if there is one."
      width={560}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save}>
            Log {kind}
          </button>
        </>
      }
    >
      <Segmented
        label="Kind"
        value={kind}
        onChange={setKind}
        options={[
          { id: 'call', label: 'Call', icon: Phone },
          { id: 'meeting', label: 'Meeting', icon: Users },
        ]}
      />
      <Field label="What happened" hint={tried && !text.trim() ? <span className="pj-error">Write a line about the outcome.</span> : undefined}>
        <AutoTextarea minRows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Agreed the January 1 start; she’ll confirm seats by Friday" />
      </Field>
      <div className="field-row">
        <Field label="Date">
          <input className="input" type="date" value={date} max={isoDay(NOW)} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Meeting note">
          <select className="input" value={file} onChange={(e) => setFile(e.target.value)}>
            <option value="">None</option>
            {docs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="field-row">
        <Field label="Next step" hint="Optional. Replaces the current one, owned by you.">
          <input className="input" value={next} onChange={(e) => setNext(e.target.value)} placeholder={contact.next ?? 'Send the order form'} />
        </Field>
        <Field label="Due">
          <input className="input" type="date" value={due} min={isoDay(NOW)} onChange={(e) => setDue(e.target.value)} disabled={!next.trim()} />
        </Field>
      </div>
    </Modal>
  );
}

/* ───────────── Next step ───────────── */

/** Every important relationship has a next action, its owner and a due date. */
export function NextStepDialog({ open, onClose, contact }: { open: boolean; onClose: () => void; contact: Contact }) {
  const { dispatch } = useStore();
  const [next, setNext] = useState('');
  const [owner, setOwner] = useState('me');
  const [due, setDue] = useState('');
  const first = contact.name.split(' ')[0];

  useEffect(() => {
    if (!open) return;
    setNext(contact.next ?? '');
    setOwner(contact.owner && contact.owner !== 'me' ? contact.id : 'me');
    setDue(contact.due ? isoDay(contact.due) : '');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = () => {
    const text = next.trim();
    const change: Partial<Contact> = text
      ? { next: text, owner: owner === 'me' ? 'me' : contact.id, due: due ? parseIsoDay(due, 17) : undefined }
      : { next: undefined, owner: undefined, due: undefined };
    dispatch(ws([patch('contacts', contact.id, change)], { toast: text ? `Next step for ${first} saved` : `Cleared the next step for ${first}`, undo: true }));
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Next step"
      description={`What happens next with ${first}, who does it and by when.`}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save}>
            Save next step
          </button>
        </>
      }
    >
      <form
        className="crm-form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label="Next step">
          <input className="input" value={next} onChange={(e) => setNext(e.target.value)} placeholder="Send the revised quote" />
        </Field>
        <div className="field-row">
          <Field label="Owner">
            <select className="input" value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="me">You</option>
              <option value={contact.id}>{first}</option>
            </select>
          </Field>
          <Field label="Due">
            <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
