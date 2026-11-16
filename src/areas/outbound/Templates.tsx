/*
 * Templates & offer: the offer Timmy writes from (what you sell, to whom, the
 * pain, the outcome, the proof, the ask, and the ideal customer behind fit
 * scores), and the template library for emails, calls and texts.
 */
import { Braces, Copy, Pencil, Plus, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { Channel, Offer, Template } from '../../data/outbound-types';
import { VARIABLES } from '../../lib/outbound';
import { fill } from '../../state/outbound';
import { useStore } from '../../state/store';
import { Field, Menu, Modal } from '../../components/kit';
import { CHANNEL, ChannelIcon } from './shared';

const KINDS: Record<Template['kind'], string> = { intro: 'First email', 'follow-up': 'Follow-up', 'case-study': 'Case study', 'break-up': 'Break-up', speed: 'Speed to lead', reply: 'Replies', call: 'Call scripts', sms: 'Texts' };

export function TemplatesTab() {
  const { state, dispatch } = useStore();
  const [editing, setEditing] = useState<Template | null>(null);
  const groups = (Object.keys(KINDS) as Template['kind'][]).map((k) => [k, Object.values(state.out.templates).filter((t) => t.kind === k)] as const).filter(([, ts]) => ts.length);
  const blank = (): Template => ({ id: `tpl-${Date.now().toString(36)}`, name: 'New template', channel: 'email', kind: 'intro', subject: '', body: 'Hi {{firstName}},\n\n\n\nBest,\n{{senderFirstName}}' });

  return (
    <>
      <div className="out-head">
        <div>
          <h1 className="page-title">Templates & offer</h1>
          <p className="page-sub">Timmy writes every sequence and reply from your offer. Templates keep what works; {'{{variables}}'} fill in per lead.</p>
        </div>
        <div className="out-head-actions">
          <button className="btn btn-primary" onClick={() => setEditing(blank())}>
            <Plus size={15} />
            New template
          </button>
        </div>
      </div>

      <OfferCard />

      {groups.map(([k, ts]) => (
        <section key={k} className="section" aria-labelledby={`tg-${k}`}>
          <div className="section-head">
            <h2 className="section-title" id={`tg-${k}`}>
              {KINDS[k]}
            </h2>
          </div>
          <ul className="tpl-grid">
            {ts.map((t) => (
              <li key={t.id} className="card tpl-card">
                <header className="tpl-head">
                  <ChannelIcon channel={t.channel} />
                  <strong className="tpl-name">{t.name}</strong>
                  <Menu
                    items={[
                      { label: 'Edit', icon: Pencil, onSelect: () => setEditing(t) },
                      { label: 'Duplicate', icon: Copy, onSelect: () => setEditing({ ...t, id: `tpl-${Date.now().toString(36)}`, name: `${t.name} (copy)`, builtIn: false }) },
                      { label: 'Delete', icon: Trash2, danger: true, onSelect: () => dispatch({ type: 'out', op: { op: 'removeTemplate', id: t.id } }) },
                    ]}
                  />
                </header>
                {t.subject && <p className="tpl-subj">{t.subject}</p>}
                <p className="tpl-body">{t.body}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {editing && <TemplateDialog t={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function OfferCard() {
  const { state, dispatch } = useStore();
  const [o, setO] = useState<Offer>(state.out.offer);
  const dirty = JSON.stringify(o) !== JSON.stringify(state.out.offer);
  const set = (patch: Partial<Offer>) => setO({ ...o, ...patch });
  const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  return (
    <section className="card offer-card" aria-labelledby="offer-title">
      <header className="offer-head">
        <div>
          <h2 className="section-title" id="offer-title">
            Your offer
          </h2>
          <p className="field-hint">What Timmy writes from. Changes apply to new drafts and to fit scores right away.</p>
        </div>
        <button className="btn btn-sm btn-primary" disabled={!dirty} onClick={() => dispatch({ type: 'out', op: { op: 'offer', offer: o } })}>
          <Save size={14} />
          Save offer
        </button>
      </header>
      <div className="offer-grid">
        <Field label="Name">
          <input className="input" value={o.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Price" hint="Optional; used to answer price questions.">
          <input className="input" value={o.price ?? ''} onChange={(e) => set({ price: e.target.value })} />
        </Field>
        <Field label="What you sell">
          <textarea className="input textarea" rows={2} value={o.product} onChange={(e) => set({ product: e.target.value })} />
        </Field>
        <Field label="Who it’s for">
          <textarea className="input textarea" rows={2} value={o.audience} onChange={(e) => set({ audience: e.target.value })} />
        </Field>
        <Field label="The pain, in their words" hint="Finishes “Most teams tell me …”">
          <input className="input" value={o.pain} onChange={(e) => set({ pain: e.target.value })} />
        </Field>
        <Field label="Hook, 2–3 words" hint="For subject lines, like “spreadsheets”.">
          <input className="input" value={o.hook ?? ''} onChange={(e) => set({ hook: e.target.value })} />
        </Field>
        <Field label="The outcome you promise">
          <input className="input" value={o.outcome} onChange={(e) => set({ outcome: e.target.value })} />
        </Field>
        <Field label="Proof" hint="One customer result, with a number.">
          <input className="input" value={o.proof} onChange={(e) => set({ proof: e.target.value })} />
        </Field>
        <Field label="The ask">
          <input className="input" value={o.cta} onChange={(e) => set({ cta: e.target.value })} />
        </Field>
      </div>
      <div className="offer-icp">
        <span className="field-label">Ideal customer (for fit scores)</span>
        <div className="offer-grid">
          <Field label="Job titles" hint="Comma-separated; partial matches count.">
            <input className="input" value={o.icp.titles.join(', ')} onChange={(e) => set({ icp: { ...o.icp, titles: list(e.target.value) } })} />
          </Field>
          <Field label="Industries">
            <input className="input" value={o.icp.industries.join(', ')} onChange={(e) => set({ icp: { ...o.icp, industries: list(e.target.value) } })} />
          </Field>
          <Field label="Employees, from">
            <input className="input num-input" type="number" min={1} value={o.icp.minEmployees} onChange={(e) => set({ icp: { ...o.icp, minEmployees: Number(e.target.value) || 1 } })} />
          </Field>
          <Field label="to">
            <input className="input num-input" type="number" min={1} value={o.icp.maxEmployees} onChange={(e) => set({ icp: { ...o.icp, maxEmployees: Number(e.target.value) || 1 } })} />
          </Field>
        </div>
      </div>
    </section>
  );
}

function TemplateDialog({ t, onClose }: { t: Template; onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [d, setD] = useState<Template>(t);
  const sample = Object.values(state.out.leads).find((l) => l.source === 'import' && l.email) ?? Object.values(state.out.leads)[0];
  const preview = sample ? fill(state, d.body, sample) : null;
  return (
    <Modal
      open
      onClose={onClose}
      title={state.out.templates[t.id] ? 'Edit template' : 'New template'}
      width={680}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!d.name.trim() || !d.body.trim()} onClick={() => (dispatch({ type: 'out', op: { op: 'template', template: { ...d, subject: d.channel === 'email' ? d.subject : undefined } } }), onClose())}>
            Save template
          </button>
        </>
      }
    >
      <div className="msg-form">
        <div className="field-row">
          <Field label="Name">
            <input className="input" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
          </Field>
          <Field label="Channel">
            <select className="input" value={d.channel} onChange={(e) => setD({ ...d, channel: e.target.value as Channel })}>
              {(['email', 'sms', 'call', 'linkedin', 'whatsapp'] as Channel[]).map((c) => (
                <option key={c} value={c}>
                  {CHANNEL[c].label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Used for">
            <select className="input" value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as Template['kind'] })}>
              {(Object.keys(KINDS) as Template['kind'][]).map((k) => (
                <option key={k} value={k}>
                  {KINDS[k]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {d.channel === 'email' && (
          <Field label="Subject">
            <input className="input" value={d.subject ?? ''} onChange={(e) => setD({ ...d, subject: e.target.value })} />
          </Field>
        )}
        <Field label={d.channel === 'call' ? 'Script' : 'Message'}>
          <textarea className="input textarea msg-body" rows={8} value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} />
        </Field>
        <Menu
          label="Insert variable"
          trigger={
            <>
              <Braces size={14} /> Insert variable
            </>
          }
          items={VARIABLES.map((x) => ({ label: x.label, hint: `{{${x.key}}}`, onSelect: () => setD({ ...d, body: `${d.body}{{${x.key}}}` }) }))}
        />
        {preview && sample && (
          <div className="tpl-preview">
            <span className="field-label">
              Preview for {sample.first} {sample.last}, {sample.company}
            </span>
            <p className="tpl-body full">{preview.text}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
