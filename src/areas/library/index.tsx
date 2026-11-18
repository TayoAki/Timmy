import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  Clock,
  Copy,
  Inbox,
  Library,
  ListChecks,
  Mail,
  MessageSquareText,
  Pencil,
  Play,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
  Workflow,
  X,
} from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { ProjectChip, tint } from '../../components/common';
import { Frame } from '../../components/Frame';
import { EmptyState, Field, Menu, SideHead } from '../../components/kit';
import { RULE_GROUPS } from '../../components/Sidebar';
import { NOW } from '../../data/mock';
import type { RuleGroup } from '../../data/types';
import type { LearnedRule, Prompt, Routine } from '../../data/ws-types';
import { fmtDay, plural } from '../../lib/format';
import { ws, useStore, type Route } from '../../state/store';
import { acceptLearned, declineLearned } from '../../state/learned';
import { patch, put, remove, uid } from '../../state/ws';
import { RpSection } from '../files/pickers';
import { PromptDialog, RoutineDialog } from './dialogs';
import { OUTPUTS, capturedPrompts, filedPrompts, linkInfo, outputMeta, slug, useCases, type Output } from './lib';
import { startRoutine } from './Runner';
import { Automations, openAutomation } from '../automations/List';

type Tab = Extract<Route, { view: 'library' }>['tab'];

const useTab = (): Tab => {
  const { state } = useStore();
  return state.route.view === 'library' ? state.route.tab : 'prompts';
};

const scrollTo = (id: string) =>
  window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);

/* ───────────── View ───────────── */

export function LibraryView() {
  const { state, dispatch } = useStore();
  const tab = useTab();
  return (
    <Frame
      tabs={[
        { id: 'prompts', label: 'Prompts' },
        { id: 'captured', label: 'Captured', count: capturedPrompts(state.ws).length || undefined },
        { id: 'routines', label: 'Routines' },
        { id: 'automations', label: 'Automations', count: Object.values(state.ws.automations ?? {}).filter((a) => a.on).length || undefined },
        { id: 'learned', label: 'Learned rules', count: Object.keys(state.ws.learned).length || undefined },
      ]}
      active={tab}
      onTab={(id) => dispatch({ type: 'navigate', route: { view: 'library', tab: id as Tab } })}
      scrollKey={tab}
    >
      {tab === 'prompts' && <Prompts />}
      {tab === 'captured' && <Captured />}
      {tab === 'routines' && <Routines />}
      {tab === 'automations' && <Automations />}
      {tab === 'learned' && <Learned />}
    </Frame>
  );
}

/* ───────────── Prompts ───────────── */

function Prompts() {
  const { state } = useStore();
  const [output, setOutput] = useState<Output | ''>('');
  const [capture, setCapture] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const filed = filedPrompts(state.ws).filter((p) => !output || p.output === output);
  const groups = useCases(state.ws)
    .map((c) => ({ ...c, prompts: filed.filter((p) => (p.useCase ?? 'Other') === c.name).sort((a, b) => a.title.localeCompare(b.title)) }))
    .filter((g) => g.prompts.length > 0);
  const archived = Object.values(state.ws.prompts).filter((p) => p.status === 'discarded');

  return (
    <>
      <div className="lib-page-head">
        <div>
          <h1 className="page-title">Prompts</h1>
          <p className="page-sub">Prompts that earned a place, filed by what you use them for. Give them the source files and they draft from your real material.</p>
        </div>
        <button className="btn" onClick={() => setCapture(true)}>
          <Plus size={15} />
          Capture a prompt
        </button>
      </div>

      <div className="filters" role="group" aria-label="Output">
        <button className="filter" aria-pressed={!output} onClick={() => setOutput('')}>
          All outputs
        </button>
        {OUTPUTS.map((o) => (
          <button key={o.id} className="filter" aria-pressed={output === o.id} onClick={() => setOutput(output === o.id ? '' : o.id)}>
            <o.icon size={14} />
            {o.label}
          </button>
        ))}
      </div>

      {groups.length === 0 ? (
        <EmptyState icon={MessageSquareText} title={output ? `No ${outputMeta(output)!.label.toLowerCase()} prompts yet` : 'No filed prompts yet'} body="File prompts from Captured during your weekly review." />
      ) : (
        groups.map((g) => (
          <section key={g.name} className="lib-group" id={`lib-uc-${slug(g.name)}`} aria-labelledby={`lib-uc-h-${slug(g.name)}`}>
            <div className="section-head">
              <h2 className="section-title" id={`lib-uc-h-${slug(g.name)}`}>
                {g.name}
              </h2>
              <span className="section-sub">{plural(g.prompts.length, 'prompt')}</span>
            </div>
            <div className="lib-grid">
              {g.prompts.map((p) => (
                <PromptCard key={p.id} prompt={p} />
              ))}
            </div>
          </section>
        ))
      )}

      {archived.length > 0 && (
        <section className="section">
          <button className="lib-disclosure" aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)}>
            <ChevronDown size={15} className={showArchived ? '' : 'lib-turned'} />
            Archived prompts ({archived.length})
          </button>
          {showArchived && <ArchivedList prompts={archived} />}
        </section>
      )}

      {capture && <PromptDialog mode="capture" onClose={() => setCapture(false)} />}
    </>
  );
}

function ArchivedList({ prompts }: { prompts: Prompt[] }) {
  const { dispatch } = useStore();
  return (
    <ul className="lib-archived">
      {prompts.map((p) => (
        <li key={p.id}>
          <span className="lib-archived-text">
            <strong>{p.title}</strong>
            <span className="muted">{p.text}</span>
          </span>
          <button className="btn btn-sm" onClick={() => dispatch(ws([patch('prompts', p.id, { status: p.useCase ? 'filed' : 'captured' })], { toast: 'Prompt restored', undo: true }))}>
            <ArchiveRestore size={14} />
            Restore
          </button>
        </li>
      ))}
    </ul>
  );
}

function PromptCard({ prompt: p }: { prompt: Prompt }) {
  const { dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState(false);
  const [long, setLong] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const out = outputMeta(p.output);

  // Offer "Show more" only when the two-line clamp actually hides text.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || open) return;
    const check = () => setLong(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, p.text]);

  const copy = () => {
    navigator.clipboard?.writeText(p.text).catch(() => undefined);
    dispatch({ type: 'toast', text: `Copied “${p.title}”` });
  };
  const useInEmail = () =>
    dispatch({
      type: 'compose',
      draft: { to: [], subject: '', body: `\n\nNote for Timmy (${p.title}): ${p.text}`, project: p.project },
    });

  return (
    <article className="card lib-prompt">
      <header className="lib-prompt-head">
        <h3>{p.title}</h3>
        {out && (
          <span className="chip plain">
            <out.icon size={12} />
            {out.label}
          </span>
        )}
      </header>
      <p ref={textRef} className={`lib-prompt-text${open ? '' : ' clamp'}`}>
        {p.text}
      </p>
      {(long || open) && (
        <button className="lib-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
      <footer className="lib-prompt-foot">
        {p.project ? <ProjectChip id={p.project} /> : <span className="lib-no-project">Any project</span>}
        <div className="lib-actions">
          <button className="btn btn-ghost btn-sm" onClick={copy}>
            <Copy size={14} />
            Copy
          </button>
          <button className="btn btn-ghost btn-sm" onClick={useInEmail}>
            <Mail size={14} />
            Use in an email
          </button>
          <Menu
            label={`More actions for ${p.title}`}
            items={[
              { label: 'Edit', icon: Pencil, onSelect: () => setEdit(true) },
              {
                label: 'Archive',
                icon: Archive,
                onSelect: () => dispatch(ws([patch('prompts', p.id, { status: 'discarded' })], { toast: `Archived “${p.title}”`, undo: true })),
              },
            ]}
          />
        </div>
      </footer>
      {edit && <PromptDialog mode="edit" prompt={p} onClose={() => setEdit(false)} />}
    </article>
  );
}

/* ───────────── Captured ───────────── */

function Captured() {
  const { state, dispatch } = useStore();
  const [capture, setCapture] = useState(false);
  const [adapt, setAdapt] = useState<Prompt | null>(null);
  const items = capturedPrompts(state.ws);
  return (
    <>
      <div className="lib-page-head">
        <div>
          <h1 className="page-title">Captured</h1>
          <p className="page-sub">Prompts you saved on the go. In the weekly review, adapt the useful ones and file them by use case. Discard the rest.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCapture(true)}>
          <Plus size={15} />
          Capture a prompt
        </button>
      </div>

      {items.length === 0 ? (
        <EmptyState icon={Check} title="Review done" body="Nothing captured is waiting. New prompts land here until your next weekly review." />
      ) : (
        <ul className="lib-queue">
          {items.map((p) => (
            <li key={p.id} className="card lib-queue-item">
              <div className="lib-queue-text">
                <h3>{p.title}</h3>
                <p>{p.text}</p>
                <span className="lib-meta">
                  Captured {fmtDay(p.created)}
                  {p.project && ` · ${state.ws.projects[p.project]?.name ?? ''}`}
                </span>
              </div>
              <div className="lib-queue-actions">
                <button className="btn btn-primary btn-sm" onClick={() => setAdapt(p)}>
                  <Pencil size={14} />
                  Adapt and file
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => dispatch(ws([patch('prompts', p.id, { status: 'discarded' })], { toast: `Discarded “${p.title}”`, undo: true }))}
                >
                  <X size={14} />
                  Discard
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {capture && <PromptDialog mode="capture" onClose={() => setCapture(false)} />}
      {adapt && <PromptDialog mode="adapt" prompt={adapt} onClose={() => setAdapt(null)} />}
    </>
  );
}

/* ───────────── Routines ───────────── */

function Routines() {
  const { state, dispatch } = useStore();
  const [editing, setEditing] = useState<Routine | 'new' | null>(null);
  const routines = Object.values(state.ws.routines).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <div className="lib-page-head">
        <div>
          <h1 className="page-title">Routines</h1>
          <p className="page-sub">The set of places a recurring task needs. Start one and Timmy opens the first, with the rest as a checklist you step through.</p>
        </div>
        <button className="btn" onClick={() => setEditing('new')}>
          <Plus size={15} />
          New routine
        </button>
      </div>

      {routines.length === 0 ? (
        <EmptyState icon={ListChecks} title="No routines yet" body="Save the files and sections you open for a weekly report or planning session." />
      ) : (
        <div className="lib-routines">
          {routines.map((r) => (
            <article key={r.id} className="card lib-routine" id={`lib-routine-${r.id}`}>
              <header className="lib-routine-head">
                <div>
                  <h2>{r.name}</h2>
                  {r.when && (
                    <span className="lib-meta">
                      <Clock size={13} aria-hidden />
                      {r.when}
                    </span>
                  )}
                </div>
                <Menu
                  label={`More actions for ${r.name}`}
                  items={[
                    { label: 'Edit routine', icon: Pencil, onSelect: () => setEditing(r) },
                    {
                      label: 'Delete routine',
                      icon: Trash2,
                      danger: true,
                      onSelect: () => dispatch(ws([remove('routines', r.id)], { toast: `Deleted “${r.name}”`, undo: true })),
                    },
                  ]}
                />
              </header>
              <ol className="lib-links">
                {r.links.map((l) => {
                  const info = linkInfo(state.ws, l.href);
                  return (
                    <li key={l.href}>
                      <info.icon size={15} className="lib-link-icon" aria-hidden />
                      <span className="lib-link-text">
                        <span className="lib-link-label">{l.label}</span>
                        <span className="lib-link-where">{info.where}</span>
                      </span>
                    </li>
                  );
                })}
              </ol>
              <footer className="lib-routine-foot">
                <span className="lib-meta">{plural(r.links.length, 'place')}</span>
                <button className="btn btn-primary btn-sm" disabled={!r.links.length} onClick={() => startRoutine(r, state.ws, dispatch)}>
                  <Play size={14} />
                  Start routine
                </button>
              </footer>
            </article>
          ))}
        </div>
      )}

      {editing && <RoutineDialog routine={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

/* ───────────── Learned rules ───────────── */

const groupName = (g: RuleGroup) => RULE_GROUPS.find((x) => x.id === g)?.name ?? g;


function Learned() {
  const { state, dispatch } = useStore();
  const rules = Object.values(state.ws.learned);

  const accept = (r: LearnedRule) => acceptLearned(dispatch, r);
  const decline = (r: LearnedRule) => declineLearned(dispatch, r);

  return (
    <>
      <h1 className="page-title">Learned rules</h1>
      <p className="page-sub">When you correct Timmy’s drafts the same way more than once, it proposes a written rule. Accept it to add it to your rules, or decline.</p>

      {rules.length === 0 ? (
        <EmptyState icon={Sparkles} title="No rules to review" body="Timmy proposes one when it sees the same correction a few times." />
      ) : (
        <ul className="lib-learned">
          {rules.map((r) => (
            <li key={r.id} className="card lib-rule">
              <div className="lib-rule-main">
                <p className="lib-rule-text">{r.text}</p>
                <p className="lib-evidence">
                  <Sparkles size={14} aria-hidden />
                  <span>{r.evidence}</span>
                </p>
              </div>
              <div className="lib-rule-foot">
                <button className="lib-rule-group" onClick={() => dispatch({ type: 'navigate', route: { view: 'rules', tab: r.group } })}>
                  <Settings2 size={13} aria-hidden />
                  {groupName(r.group)} rules
                </button>
                <div className="lib-actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => decline(r)}>
                    <X size={14} />
                    Decline
                  </button>
                  <button className="btn btn-primary btn-sm" onClick={() => accept(r)}>
                    <Check size={14} />
                    Accept rule
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <TeachByExample />
    </>
  );
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const firstSentence = (s: string) => s.trim().split(/(?<=[.!?])\s/)[0] ?? '';

/** Turns one real correction into a proposed rule. */
const proposeRule = (draft: string, edit: string): { text: string; evidence: string } => {
  const a = words(draft);
  const b = words(edit);
  if (b && b < a * 0.75) {
    const cap = Math.max(20, Math.ceil(b / 10) * 10);
    return { text: `Keep these drafts under ${cap} words.`, evidence: `In your example you cut ${a} words to ${b}.` };
  }
  if (/!/.test(draft) && !/!/.test(edit)) return { text: 'No exclamation marks in these drafts.', evidence: 'In your example you removed every exclamation mark.' };
  if (/\$?\d/.test(firstSentence(edit)) && !/\$?\d/.test(firstSentence(draft)))
    return { text: 'Put the key number in the first sentence.', evidence: `Your example opens with “${firstSentence(edit).slice(0, 80)}”.` };
  return { text: `Open the way you did here: “${firstSentence(edit).slice(0, 90)}”`, evidence: `From your example on ${fmtDay(NOW)}.` };
};

function TeachByExample() {
  const { dispatch } = useStore();
  const [draft, setDraft] = useState('');
  const [edit, setEdit] = useState('');
  const [group, setGroup] = useState<LearnedRule['group']>('writing');
  const ok = words(draft) > 2 && words(edit) > 2 && draft.trim() !== edit.trim();
  const submit = () => {
    if (!ok) return;
    const rule = proposeRule(draft, edit);
    dispatch(ws([put('learned', { id: uid('learned'), group, ...rule })], { toast: 'Timmy proposed a rule from your example. Review it above.', undo: true }));
    setDraft('');
    setEdit('');
  };
  return (
    <section className="section" aria-labelledby="lib-teach">
      <div className="section-head">
        <h2 className="section-title" id="lib-teach">
          Correct a draft with a real example
        </h2>
      </div>
      <form
        className="card card-pad lib-teach"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="lib-teach-grid">
          <Field label="Timmy wrote">
            <textarea className="input textarea" rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Paste a draft Timmy wrote" />
          </Field>
          <Field label="You’d write">
            <textarea className="input textarea" rows={4} value={edit} onChange={(e) => setEdit(e.target.value)} placeholder="Paste what you sent instead" />
          </Field>
        </div>
        <div className="lib-teach-foot">
          <label className="lib-inline-field">
            <span>Rule group</span>
            <select className="input" value={group} onChange={(e) => setGroup(e.target.value as LearnedRule['group'])}>
              {RULE_GROUPS.filter((g) => g.id !== 'urgency' && g.id !== 'approvals').map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn-primary" disabled={!ok}>
            <Sparkles size={15} />
            Propose a rule
          </button>
        </div>
      </form>
    </section>
  );
}

/* ───────────── Sidebar ───────────── */

export function LibrarySide() {
  const { state, dispatch } = useStore();
  const tab = useTab();
  const isLib = state.route.view === 'library';
  const [capture, setCapture] = useState(false);
  const [newRoutine, setNewRoutine] = useState(false);
  const cases = useCases(state.ws);
  const routines = Object.values(state.ws.routines).sort((a, b) => a.name.localeCompare(b.name));
  const captured = capturedPrompts(state.ws).length;
  const learned = Object.keys(state.ws.learned).length;
  const go = (t: Tab, anchor?: string) => {
    dispatch({ type: 'navigate', route: { view: 'library', tab: t } });
    if (anchor) scrollTo(anchor);
  };

  return (
    <>
      <SideHead
        icon={<Library size={18} />}
        title="AI library"
        sub={`${plural(filedPrompts(state.ws).length, 'prompt')} · ${plural(routines.length, 'routine')}`}
        action={
          <button className="btn btn-primary" onClick={() => setCapture(true)}>
            <Plus size={15} />
            Capture a prompt
          </button>
        }
      />
      <div className="side-scroll">
        <div className="side-group">
          <div className="side-title">Prompts by use case</div>
          <button className="nav-item compact" aria-current={isLib && tab === 'prompts' ? 'page' : undefined} onClick={() => go('prompts')}>
            <Library size={15} className="lib-side-icon" />
            <span className="nav-name">All filed prompts</span>
            <span className="nav-count">{filedPrompts(state.ws).length}</span>
          </button>
          {cases.map((c) => (
            <button key={c.name} className="nav-item compact" onClick={() => go('prompts', `lib-uc-${slug(c.name)}`)}>
              <MessageSquareText size={15} className="lib-side-icon" />
              <span className="nav-name">{c.name}</span>
              <span className="nav-count">{c.count}</span>
            </button>
          ))}
        </div>
        <div className="side-group">
          <div className="side-title">Weekly review</div>
          <button className="nav-item" style={tint('var(--c-amber)')} aria-current={isLib && tab === 'captured' ? 'page' : undefined} onClick={() => go('captured')}>
            <span className="nav-icon">
              <Inbox size={16} />
            </span>
            <span className="nav-text">
              <span className="nav-name">Captured</span>
              <span className="nav-hint">Adapt and file, or discard</span>
            </span>
            <span className={`nav-count${captured ? ' strong' : ''}`}>{captured || ''}</span>
          </button>
          <button className="nav-item" style={tint('var(--c-violet)')} aria-current={isLib && tab === 'learned' ? 'page' : undefined} onClick={() => go('learned')}>
            <span className="nav-icon">
              <Sparkles size={16} />
            </span>
            <span className="nav-text">
              <span className="nav-name">Learned rules</span>
              <span className="nav-hint">From your edits to drafts</span>
            </span>
            <span className={`nav-count${learned ? ' strong' : ''}`}>{learned || ''}</span>
          </button>
        </div>
        <div className="side-group">
          <div className="side-title">Automations</div>
          <button className="nav-item compact" aria-current={isLib && tab === 'automations' ? 'page' : undefined} onClick={() => go('automations')}>
            <Workflow size={15} className="lib-side-icon" />
            <span className="nav-name">All automations</span>
            <span className="nav-count">{Object.values(state.ws.automations ?? {}).filter((a) => a.on).length || ''}</span>
          </button>
          {Object.values(state.ws.automations ?? {}).map((a) => (
            <button key={a.id} className="nav-item compact" aria-current={state.route.view === 'automation' && state.route.id === a.id ? 'page' : undefined} onClick={() => dispatch(openAutomation(a.id))}>
              <span className={`au-side-dot${a.on ? ' on' : ''}`} aria-hidden />
              <span className="nav-name">{a.name}</span>
            </button>
          ))}
        </div>
        <div className="side-group">
          <div className="side-title">Routines</div>
          {routines.map((r) => (
            <button key={r.id} className="nav-item compact" onClick={() => go('routines', `lib-routine-${r.id}`)}>
              <ListChecks size={15} className="lib-side-icon" />
              <span className="nav-name">{r.name}</span>
              <span className="nav-count">{r.links.length}</span>
            </button>
          ))}
          <button className="nav-item compact" onClick={() => setNewRoutine(true)}>
            <Plus size={15} className="lib-side-icon" />
            <span className="nav-name lib-side-muted">New routine</span>
          </button>
        </div>
      </div>
      {newRoutine && <RoutineDialog onClose={() => setNewRoutine(false)} />}
      {capture && <PromptDialog mode="capture" onClose={() => setCapture(false)} />}
    </>
  );
}

/* ───────────── Context panel ───────────── */

export function LibraryContext() {
  const { state, dispatch } = useStore();
  const tab = useTab();
  const projects = Object.values(state.ws.projects).filter((p) => p.status === 'active');
  const prompts = Object.values(state.ws.prompts);

  return (
    <>
      <RpSection title="How it works">
        <ol className="lib-steps">
          <li>
            <span className="lib-step-n mono">1</span>
            <span>
              <strong>Capture</strong> a prompt the moment it works. It waits in Captured.
            </span>
          </li>
          <li>
            <span className="lib-step-n mono">2</span>
            <span>
              <strong>Weekly review:</strong> adapt the useful ones and discard the rest.
            </span>
          </li>
          <li>
            <span className="lib-step-n mono">3</span>
            <span>
              <strong>File</strong> them by use case and output, so the right one is easy to find.
            </span>
          </li>
        </ol>
      </RpSection>

      {tab === 'routines' && (
        <RpSection title="Routines">
          <p className="rp-text">Keep the tabs a routine needs together. Starting one opens the first place; the checklist stays on screen while you work through the rest.</p>
        </RpSection>
      )}

      {tab === 'learned' && (
        <RpSection
          title="Written rules"
          aside={
            <button className="rp-link" onClick={() => dispatch({ type: 'navigate', route: { view: 'rules', tab: 'writing' } })}>
              Open rules
            </button>
          }
        >
          <ul className="lib-rule-counts">
            {RULE_GROUPS.map((g) => (
              <li key={g.id}>
                <button className="lib-project" onClick={() => dispatch({ type: 'navigate', route: { view: 'rules', tab: g.id } })}>
                  <span className="dot" style={tint(g.color)} />
                  <span className="lib-project-name">{g.name}</span>
                  <span className="lib-project-meta">{plural(state.rules.filter((r) => r.group === g.id && r.enabled).length, 'active rule')}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="rp-note">Correcting a draft with a real example teaches Timmy faster than describing the change.</p>
        </RpSection>
      )}

      <RpSection title="Drafts cite their sources">
        <p className="rp-text">Give drafting tools the source material. When Timmy drafts for a project, it reads that project’s source files and lists them under the draft, so you can check every number.</p>
      </RpSection>

      <RpSection title="Project prompts and sources">
        <ul className="lib-projects">
          {projects.map((p) => {
            const n = prompts.filter((x) => x.project === p.id && x.status === 'filed').length;
            return (
              <li key={p.id}>
                <button className="lib-project" onClick={() => dispatch({ type: 'navigate', route: { view: 'project', id: p.id, tab: 'ai' } })}>
                  <span className="dot" style={tint(p.color)} />
                  <span className="lib-project-name">{p.name}</span>
                  <span className="lib-project-meta">
                    {plural(n, 'prompt')} · {plural(p.sources.length, 'source')}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="rp-note">Each project page shows its prompts and source links too, so a recurring project keeps them together.</p>
      </RpSection>
    </>
  );
}
