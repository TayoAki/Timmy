import { useEffect, useState } from 'react';
import { Field, Modal } from '../../components/kit';
import { PEOPLE } from '../../data/mock';
import type { Cadence, Contact } from '../../data/ws-types';
import { useStore, ws } from '../../state/store';
import { patch, put, registerPerson, uid } from '../../state/ws';
import { slugify } from '../projects/lib';
import { CADENCES, PRIORITY_LIMIT, cadenceLabel, priorityContacts } from './lib';

interface Form {
  name: string;
  email: string;
  title: string;
  company: string;
  phone: string;
  location: string;
  cadence: Cadence;
  priority: boolean;
  tracked: boolean;
}

const fromContact = (c?: Partial<Contact>): Form => ({
  name: c?.name ?? '',
  email: c?.email ?? '',
  title: c?.title ?? '',
  company: c?.company ?? '',
  phone: c?.phone ?? '',
  location: c?.location ?? '',
  cadence: c?.cadence ?? 'monthly',
  priority: !!c?.priority,
  tracked: c?.tracked ?? true,
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Add or edit a contact. Owned by the People area. */
export function ContactDialog({
  open,
  onClose,
  initial,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  initial?: Partial<Contact>;
  /** Called with the contact's id after saving. */
  onSaved?: (id: string) => void;
}) {
  const { state, dispatch } = useStore();
  const editing = !!initial?.id && !!state.ws.contacts[initial.id];
  const [f, setF] = useState<Form>(() => fromContact(initial));
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (!open) return;
    setF(fromContact(editing ? { ...state.ws.contacts[initial!.id!], ...initial } : initial));
    setTried(false);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  const email = f.email.trim().toLowerCase();
  const dupe = Object.values(state.ws.contacts).find((c) => c.email.toLowerCase() === email && c.id !== initial?.id);
  const errors = {
    name: f.name.trim() ? '' : 'Add their name.',
    email: !email ? 'Add an email address.' : !EMAIL.test(email) ? 'That doesn’t look like an email address.' : dupe ? `Already saved as ${dupe.name}.` : '',
  };
  const valid = !errors.name && !errors.email;

  const save = () => {
    setTried(true);
    if (!valid) return;
    const existing = editing ? state.ws.contacts[initial!.id!] : undefined;
    const others = priorityContacts(state.ws).filter((c) => c.id !== existing?.id);
    const becamePriority = f.priority && f.tracked && !existing?.priority;
    const fields = {
      name: f.name.trim(),
      email,
      title: f.title.trim() || undefined,
      company: f.company.trim() || undefined,
      phone: f.phone.trim() || undefined,
      location: f.location.trim() || undefined,
      cadence: f.cadence,
      priority: f.priority && f.tracked,
      tracked: f.tracked,
    };
    let id: string;
    if (existing) {
      id = existing.id;
      dispatch(ws([patch('contacts', id, fields)], { toast: `Saved ${fields.name}`, undo: true }));
    } else {
      const base = slugify(fields.name.split(' ')[0] ?? '') || 'contact';
      id = state.ws.contacts[base] || PEOPLE[base] ? uid(base) : base;
      const contact: Contact = { id, ...fields, emails: 0 };
      dispatch(ws([put('contacts', contact)], { toast: f.tracked ? `Added ${fields.name} to your CRM` : `Saved ${fields.name}`, undo: true, log: `Added ${fields.name} to People` }));
    }
    registerPerson({ id, name: fields.name, email, title: fields.title, company: fields.company });
    if (becamePriority && others.length >= PRIORITY_LIMIT) {
      dispatch({
        type: 'toast',
        tone: 'warn',
        text: `${others.length + 1} priority contacts now. Keep it to one or two for your current goal.`,
      });
    }
    onClose();
    onSaved?.(id);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? 'Edit contact' : 'Add contact'}
      description={editing ? undefined : 'Record only the details you’ll use. You can add more after your next conversation.'}
      width={560}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save}>
            {editing ? 'Save changes' : 'Add contact'}
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
        <div className="field-row">
          <Field label="Name" hint={tried && errors.name ? <span className="pj-error">{errors.name}</span> : undefined}>
            <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Alex Moreno" aria-invalid={tried && !!errors.name} autoComplete="off" />
          </Field>
          <Field label="Email" hint={tried && errors.email ? <span className="pj-error">{errors.email}</span> : undefined}>
            <input className="input" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} placeholder="alex@company.com" aria-invalid={tried && !!errors.email} autoComplete="off" />
          </Field>
        </div>
        <div className="field-row">
          <Field label="Title">
            <input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="Head of Operations" />
          </Field>
          <Field label="Company">
            <input className="input" value={f.company} onChange={(e) => set('company', e.target.value)} placeholder="Company" />
          </Field>
        </div>
        <div className="field-row">
          <Field label="Phone">
            <input className="input" type="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+1 555 0100" />
          </Field>
          <Field label="Location">
            <input className="input" value={f.location} onChange={(e) => set('location', e.target.value)} placeholder="City, region" />
          </Field>
        </div>
        <Field label="Check-in cadence" hint="How often you want to be in touch. Your weekly review flags anyone past it.">
          <select className="input" value={f.cadence} onChange={(e) => set('cadence', e.target.value as Cadence)}>
            {CADENCES.map((c) => (
              <option key={c} value={c}>
                {cadenceLabel(c)}
              </option>
            ))}
          </select>
        </Field>
        <div className="crm-switches">
          <SwitchRow label="Track in your CRM" hint="Included in the weekly review." on={f.tracked} onChange={(v) => set('tracked', v)} />
          <SwitchRow
            label="Priority contact"
            hint="One or two people who matter most for your current goal."
            on={f.priority && f.tracked}
            disabled={!f.tracked}
            onChange={(v) => set('priority', v)}
          />
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function SwitchRow({ label, hint, on, onChange, disabled }: { label: string; hint: string; on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className={`crm-switch-row${disabled ? ' disabled' : ''}`}>
      <span className="crm-switch-text">
        <span className="crm-switch-label">{label}</span>
        <span className="field-hint">{hint}</span>
      </span>
      <button type="button" className="switch" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} />
    </div>
  );
}
