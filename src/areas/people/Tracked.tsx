/*
 * "What Timmy tracks": the one place to review the kinds of thing Timmy keeps a record of from the mail,
 * beyond people and companies (deals, properties, candidates…). Real workspaces only; the demo never shows it.
 *
 * The parts: what Timmy suggests tracking (accept, accept under another name, or dismiss), what is tracked
 * (rename, remove a field, stop) with how the look back through recent mail went, and for a tracked kind the
 * things themselves, each with the sentence and the email it came from. Two things that may be the same one are
 * asked about ("Same thing?"), and kinds that were turned down or stopped can be brought back.
 *
 * Every kind name, field name, value and sentence on this screen was read out of other people's mail by a
 * model. They are only ever rendered as text.
 */
import { ChevronDown, ChevronRight, CircleSlash, Pencil, Quote, RotateCcw, Shapes, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { EmptyState, Field, Menu, Modal } from '../../components/kit';
import { fmtDate } from '../../lib/format';
import { api } from '../../live/api';
import { useProfile } from '../../live/LiveApp';
import { listed, plural, withArticle, type SameThing, type TrackedKind, type TrackedOverview, type TrackedProposal, type TrackedReread, type TrackedSource, type TrackedThing, type TurnedDown } from '../../live/tracked';
import { useStore } from '../../state/store';
import { SectionHead } from '../projects/ui';
import '../../styles/tracked.css';

/**
 * Text from the mail, as text. A value that happens to be written like a timestamp arrives as a date
 * (the app's wire format turns those into dates), so it is put back into words here instead of breaking the page.
 */
const text = (v: unknown): string => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : '');
const lower = (name: string) => plural(text(name)).toLowerCase();
const fieldWords = (fields: { label: string }[]) => listed(fields.map((f) => withArticle(text(f.label))));

type Naming = { title: string; action: string; start: string; save: (name: string) => Promise<unknown> };

export function Tracked() {
  const live = useProfile();
  const { state, dispatch } = useStore();
  const [data, setData] = useState<TrackedOverview | null>(null);
  const [failed, setFailed] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [naming, setNaming] = useState<Naming | null>(null);
  const [stopping, setStopping] = useState<TrackedKind | null>(null);
  /** Goes up whenever what is tracked may have changed, so an open list of things loads again. */
  const [version, setVersion] = useState(0);
  const can = !!live?.profile.can.policy;

  const load = useCallback(async () => {
    try {
      setData(await api.tracked());
      setFailed('');
      setVersion((v) => v + 1);
    } catch (e) {
      setFailed((e as Error).message);
    }
  }, []);

  // Loads at once when the screen opens. After that, new mail can bring new things and new suggestions, so it
  // looks again a moment after the mail on screen changes.
  const opened = useRef(false);
  useEffect(() => {
    if (!opened.current) {
      opened.current = true;
      void load();
      return;
    }
    const soon = window.setTimeout(() => void load(), 600);
    return () => window.clearTimeout(soon);
  }, [load, state.threads]);

  // While Timmy reads recent mail for a kind just accepted, the screen looks again every few seconds until it is done.
  const reading = !!data?.tracked.some((k) => k.reread?.status === 'reading');
  useEffect(() => {
    if (!reading) return;
    const again = window.setTimeout(() => void load(), 2500);
    return () => window.clearTimeout(again);
  }, [reading, data, load]);

  /** Runs one change, says what happened, and shows the list as the server now has it. */
  const act = async (change: () => Promise<unknown>, done: string): Promise<boolean> => {
    setBusy(true);
    try {
      await change();
      dispatch({ type: 'toast', text: done });
      return true;
    } catch (e) {
      dispatch({ type: 'toast', text: (e as Error).message, tone: 'warn' });
      return false;
    } finally {
      await load();
      setBusy(false);
    }
  };

  const openEmail = (thread?: string) => {
    const t = thread ? state.threads.find((x) => x.ext?.threadKey === thread) : undefined;
    if (t) dispatch({ type: 'openThread', id: t.id });
  };
  const canOpen = (thread?: string) => !!thread && state.threads.some((x) => x.ext?.threadKey === thread);

  return (
    <>
      <div className="pj-title-row">
        <div>
          <h1 className="page-title">What Timmy tracks</h1>
          <p className="page-sub">
            Beyond people and companies, Timmy can keep a record of the things your work is about, such as deals or properties. It only reads your mail for a kind of thing after an owner or admin accepts it here,
            and every record shows the sentence it came from.
          </p>
        </div>
      </div>

      {!data && !failed && <p className="pj-none trk-loading">Loading…</p>}
      {failed && !data && <EmptyState icon={Shapes} title="This couldn’t be loaded" body={failed} action={<button className="btn btn-sm" onClick={() => void load()}>Try again</button>} />}

      {data && (
        <>
          <section className="section" aria-label="Suggested">
            <SectionHead title="Suggested" sub={can ? 'Nothing is read out of your mail for these until you accept one.' : 'Nothing is read out of your mail for these until an owner or admin accepts one.'} />
            {data.proposals.length === 0 ? (
              <p className="pj-none">Nothing to suggest right now. When Timmy sees the same kind of thing in three different threads, it asks here.</p>
            ) : (
              <div className="trk-list">
                {data.proposals.map((p) => (
                  <Proposal
                    key={p.key}
                    p={p}
                    can={can}
                    busy={busy}
                    canOpen={canOpen}
                    openEmail={openEmail}
                    onAccept={() => void act(() => api.acceptTracking(p.key), `Timmy now tracks ${lower(p.name)}. It is reading your recent mail for them.`)}
                    onRename={() =>
                      setNaming({
                        title: `Track ${lower(p.name)} under another name`,
                        action: 'Track',
                        start: text(p.name),
                        save: (name) => act(() => api.acceptTracking(p.key, name), `Timmy now tracks ${plural(name).toLowerCase()}. It is reading your recent mail for them.`),
                      })
                    }
                    onDismiss={() => void act(() => api.dismissTracking(p.key), `Timmy won’t suggest ${lower(p.name)} again.`)}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="section" aria-label="Tracked">
            <SectionHead title="Tracked" sub="Timmy reads each new email for these. Open one to see what it knows and why." />
            {data.tracked.length === 0 ? (
              <EmptyState icon={Shapes} title="Nothing is tracked yet" body="Accept a suggestion and Timmy keeps a record from the next email on." />
            ) : (
              <div className="trk-list">
                {data.tracked.map((k) => (
                  <Kind
                    key={k.id}
                    k={k}
                    can={can}
                    busy={busy}
                    open={open === k.id}
                    version={version}
                    canOpen={canOpen}
                    openEmail={openEmail}
                    onToggle={() => setOpen(open === k.id ? null : k.id)}
                    onRename={() =>
                      setNaming({
                        title: `Rename ${lower(k.name)}`,
                        action: 'Rename',
                        start: text(k.name),
                        save: (name) => act(() => api.changeTracked(k.id, { name }), `Renamed to ${name}.`),
                      })
                    }
                    onRemoveField={(key, label) => void act(() => api.changeTracked(k.id, { removeField: key }), `“${label}” is no longer kept for ${lower(k.name)}.`)}
                    onStop={() => setStopping(k)}
                  />
                ))}
              </div>
            )}
          </section>

          {data.sameThing && data.sameThing.length > 0 && (
            <section className="section" aria-label="Same thing?">
              <SectionHead title="Same thing?" sub={can ? 'These names look like one thing written two ways. Nothing is merged unless you say so.' : 'These names look like one thing written two ways. An owner or admin can merge them.'} />
              <div className="trk-list">
                {data.sameThing.map((pair) => (
                  <SamePair
                    key={`${pair.a.id} ${pair.b.id}`}
                    pair={pair}
                    can={can}
                    busy={busy}
                    onMerge={(keep, merge) => void act(() => api.mergeThings(pair.kind.id, keep.id, merge.id), `Merged “${text(merge.name)}” into “${text(keep.name)}”. Everything it rested on is kept.`)}
                    onApart={() => void act(() => api.keepThingsApart(pair.kind.id, pair.a.id, pair.b.id), `Kept “${text(pair.a.name)}” and “${text(pair.b.name)}” apart. Timmy won’t ask again.`)}
                  />
                ))}
              </div>
            </section>
          )}

          {data.turnedDown && data.turnedDown.length > 0 && (
            <section className="section" aria-label="Turned down">
              <SectionHead title="Turned down" sub="Kinds you said no to, or stopped tracking. Bring one back to see it as a suggestion again." />
              <ul className="trk-down">
                {data.turnedDown.map((k) => (
                  <Down key={k.key} k={k} can={can} busy={busy} onBringBack={() => void act(() => api.bringBackTracking(k.key), `${text(k.name)} is suggested again. Nothing is read for it until it is accepted.`)} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <NameDialog naming={naming} onClose={() => setNaming(null)} />
      <Modal
        open={!!stopping}
        onClose={() => setStopping(null)}
        title={stopping ? `Stop tracking ${lower(stopping.name)}?` : ''}
        width={440}
        footer={
          <>
            <button className="btn" data-autofocus onClick={() => setStopping(null)}>Keep tracking</button>
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={() => {
                const k = stopping!;
                setStopping(null);
                if (open === k.id) setOpen(null);
                void act(() => api.stopTracking(k.id), `Timmy stopped tracking ${lower(k.name)}${k.known ? ` and forgot the ${k.known} it knew` : ''}.`);
              }}
            >
              Stop tracking
            </button>
          </>
        }
      >
        {stopping && (
          <p className="trk-confirm">
            {stopping.known === 0 ? 'Timmy stops' : `Timmy forgets the ${stopping.known === 1 ? `1 ${text(stopping.name).toLowerCase()}` : `${stopping.known} ${lower(stopping.name)}`} it knows, stops`} reading your mail for {lower(stopping.name)} and
            won’t suggest them again. Your mail itself is not touched.
          </p>
        )}
      </Modal>
    </>
  );
}

/* ───────────── A suggestion ───────────── */

function Proposal({ p, can, busy, canOpen, openEmail, onAccept, onRename, onDismiss }: { p: TrackedProposal; can: boolean; busy: boolean; canOpen: (thread?: string) => boolean; openEmail: (thread?: string) => void; onAccept: () => void; onRename: () => void; onDismiss: () => void }) {
  const kinds = lower(p.name);
  // A kind Timmy noticed is put as a question about what it saw. A kind that comes with the trade has not been
  // seen anywhere yet, so it is a plain offer with the fields it would keep.
  const question = p.why === 'seen' ? `You seem to track ${kinds}, with ${fieldWords(p.fields)}. Track them?` : `Track ${kinds}?`;
  const seen = p.threads === 0 ? '' : p.threads === 1 ? ' Seen in 1 thread so far.' : ` Seen in ${p.threads} threads${p.why === 'seen' ? '' : ' so far'}.`;
  return (
    <article className="card ap-card" aria-label={`Suggestion: ${kinds}`}>
      <div className="ap-head">
        <h3 className="ap-title">{question}</h3>
        <p className="ap-why">
          {p.why === 'seen' ? 'Timmy noticed these in your mail.' : `Suggested for the kind of work this workspace was set up for. For each one Timmy would keep: ${p.fields.map((f) => text(f.label)).join(', ')}.`}
          {seen}
        </p>
      </div>
      {p.examples.length > 0 && (
        <ul className="trk-things" aria-label={`Examples of ${kinds}`}>
          {p.examples.map((e, i) => (
            <li key={i} className="trk-thing">
              <div className="trk-thing-main">
                <strong>{text(e.name)}</strong>
                <span className="chips">
                  {e.fields
                    .filter(([, value]) => text(value) !== text(e.name))
                    .map(([label, value]) => (
                      <span key={text(label)} className="chip">
                        {text(label)}: {text(value)}
                      </span>
                    ))}
                </span>
              </div>
              <Source s={e.source} canOpen={canOpen} openEmail={openEmail} />
            </li>
          ))}
        </ul>
      )}
      <div className="trk-actions">
        {can ? (
          <>
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={onAccept}>
              Track {kinds}
            </button>
            <button className="btn btn-sm" disabled={busy} onClick={onRename}>
              Track under another name
            </button>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onDismiss}>
              Dismiss
            </button>
          </>
        ) : (
          <span className="field-hint">An owner or admin can accept or dismiss this.</span>
        )}
      </div>
    </article>
  );
}

/* ───────────── A tracked kind, and the things Timmy knows of it ───────────── */

function Kind({
  k,
  can,
  busy,
  open,
  version,
  canOpen,
  openEmail,
  onToggle,
  onRename,
  onRemoveField,
  onStop,
}: {
  k: TrackedKind;
  can: boolean;
  busy: boolean;
  open: boolean;
  version: number;
  canOpen: (thread?: string) => boolean;
  openEmail: (thread?: string) => void;
  onToggle: () => void;
  onRename: () => void;
  onRemoveField: (key: string, label: string) => void;
  onStop: () => void;
}) {
  const kinds = lower(k.name);
  const [things, setThings] = useState<TrackedThing[] | null>(null);
  const [failed, setFailed] = useState('');
  useEffect(() => {
    if (!open) return;
    let current = true;
    api.trackedThings(k.id).then(
      (r) => current && (setThings(r.things), setFailed('')),
      (e: Error) => current && setFailed(e.message),
    );
    return () => {
      current = false;
    };
  }, [open, k.id, version]);

  return (
    <article className="card trk-kind" aria-label={text(k.name)}>
      <div className="trk-kind-head">
        <button type="button" className="trk-kind-toggle" aria-expanded={open} onClick={onToggle}>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <strong>{text(k.name)}</strong>
          <span className="muted mono">{k.known === 0 ? 'None known yet' : `${k.known} known`}</span>
        </button>
        <span className="chips" aria-label={`Fields kept for ${kinds}`}>
          {k.fields.map((f, i) => (
            <span key={f.key} className="chip">
              {text(f.label)}
              {can && i > 0 && (
                <button type="button" className="recip-x" disabled={busy} aria-label={`Remove the field ${text(f.label)} from ${kinds}`} title="Remove this field" onClick={() => onRemoveField(f.key, text(f.label))}>
                  <X size={12} />
                </button>
              )}
            </span>
          ))}
        </span>
        {can && (
          <Menu
            label={`More actions for ${kinds}`}
            items={[
              { label: 'Rename', icon: Pencil, onSelect: onRename },
              { label: 'Stop tracking', icon: CircleSlash, danger: true, onSelect: onStop },
            ]}
          />
        )}
      </div>
      {k.reread && <RereadNote r={k.reread} kinds={kinds} />}
      {open && (
        <div className="trk-kind-body">
          {failed ? (
            <p className="pj-none">{failed}</p>
          ) : !things ? (
            <p className="pj-none">Loading…</p>
          ) : things.length === 0 ? (
            <p className="pj-none">Timmy hasn’t read about any {kinds} yet. It looks at each new email as it arrives.</p>
          ) : (
            <ul className="trk-things" aria-label={`The ${kinds} Timmy knows`}>
              {things.map((t) => (
                <li key={t.id} className="trk-thing">
                  <div className="trk-thing-main">
                    <strong>{text(t.name)}</strong>
                    <dl className="trk-fields">
                      {k.fields.slice(1).map((f) => {
                        const value = text(t.fields[f.key]);
                        return value ? (
                          <div key={f.key}>
                            <dt>{text(f.label)}</dt>
                            <dd>{value}</dd>
                          </div>
                        ) : null;
                      })}
                    </dl>
                  </div>
                  {t.sources.map((s, i) => (
                    <Source key={i} s={s} canOpen={canOpen} openEmail={openEmail} />
                  ))}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

/** How the look back through recent mail went, in a line. */
function RereadNote({ r, kinds }: { r: TrackedReread; kinds: string }) {
  const threads = r.threads === 1 ? '1 thread' : `${r.threads} threads`;
  const found = r.found === 0 ? `found no ${kinds}` : r.found === 1 ? 'found 1' : `found ${r.found}`;
  const line =
    r.status === 'reading'
      ? `Reading your mail from the last ${r.days} days for ${kinds}…`
      : r.status === 'done'
        ? r.threads === 0
          ? `Looked through your mail from the last ${r.days} days: no thread needed reading again.`
          : `Read ${threads} from the last ${r.days} days and ${found}.`
        : `${r.threads ? `Read ${threads} and ${found}. ` : ''}${text(r.note) || 'Timmy stopped reading early.'}`;
  return (
    <p className="trk-reread" role="status">
      {line}
    </p>
  );
}

/** Two things that may be one: keep either name, or say they differ. */
function SamePair({ pair, can, busy, onMerge, onApart }: { pair: SameThing; can: boolean; busy: boolean; onMerge: (keep: { id: string; name: string }, merge: { id: string; name: string }) => void; onApart: () => void }) {
  const a = text(pair.a.name);
  const b = text(pair.b.name);
  const kind = text(pair.kind.name).toLowerCase();
  return (
    <article className="card ap-card" aria-label={`Same thing: ${a} and ${b}`}>
      <div className="ap-head">
        <h3 className="ap-title">
          Are “{a}” and “{b}” the same {kind}?
        </h3>
        <p className="ap-why">One name has every word of the other. Merging keeps one name and every sentence behind both; mail that uses the other name adds to it from then on.</p>
      </div>
      <div className="trk-actions">
        {can ? (
          <>
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => onMerge(pair.b, pair.a)}>
              Same: keep “{b}”
            </button>
            <button className="btn btn-sm" disabled={busy} onClick={() => onMerge(pair.a, pair.b)}>
              Same: keep “{a}”
            </button>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onApart}>
              Different
            </button>
          </>
        ) : (
          <span className="field-hint">An owner or admin can merge these.</span>
        )}
      </div>
    </article>
  );
}

/** A kind that was turned down or stopped. */
function Down({ k, can, busy, onBringBack }: { k: TurnedDown; can: boolean; busy: boolean; onBringBack: () => void }) {
  return (
    <li className="trk-down-row">
      <span>
        <strong>{text(k.name)}</strong>
        <span className="muted"> · {k.stopped ? 'Tracking was stopped' : 'Turned down'}</span>
      </span>
      {can && (
        <button className="btn btn-sm" disabled={busy} aria-label={`Bring back ${lower(k.name)}`} onClick={onBringBack}>
          <RotateCcw size={13} /> Bring back
        </button>
      )}
    </li>
  );
}

/** The sentence something rests on, and the email it was read from. */
function Source({ s, canOpen, openEmail }: { s: TrackedSource; canOpen: (thread?: string) => boolean; openEmail: (thread?: string) => void }) {
  const at = s.at instanceof Date ? fmtDate(s.at) : '';
  return (
    <p className="trk-source">
      <Quote size={13} aria-hidden />
      <span>
        <q>{text(s.quote)}</q>
        <span className="trk-source-from">
          {[text(s.from), text(s.subject) && `“${text(s.subject)}”`, at].filter(Boolean).join(' · ')}
          {canOpen(s.thread) && (
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => openEmail(s.thread)}>
              Open email
            </button>
          )}
        </span>
      </span>
    </p>
  );
}

/* ───────────── Naming a kind ───────────── */

function NameDialog({ naming, onClose }: { naming: Naming | null; onClose: () => void }) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => setName(naming?.start ?? ''), [naming]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!naming || !name.trim()) return;
    setSaving(true);
    const ok = await naming.save(name.trim());
    setSaving(false);
    if (ok) onClose();
  };
  return (
    <Modal
      open={!!naming}
      onClose={onClose}
      title={naming?.title ?? ''}
      width={440}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="trk-name-form" disabled={saving || !name.trim()}>
            {naming?.action ?? 'Save'}
          </button>
        </>
      }
    >
      <form id="trk-name-form" onSubmit={submit}>
        <Field label="Name, for one of them" hint="Up to four plain words, such as “Opportunity” or “Purchase order”.">
          <input className="input" name="kind-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}
