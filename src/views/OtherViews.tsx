import { isLive } from '../live/clock';
import { LiveSettings } from '../live/Settings';
import {
  ArrowRight,
  BadgeDollarSign,
  CalendarDays,
  FilePenLine,
  FolderInput,
  Inbox,
  ListChecks,
  MoveRight,
  Plus,
  Lock,
  Send,
  Stamp,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import type { ActivityKind, RuleGroup } from '../data/types';
import { dayDiff, fmtDay, fmtTime } from '../lib/format';
import { useStore } from '../state/store';
import { LAST_RUN, LAST_RUN_COUNT, fmtClock, nextRun, whenLabel } from '../state/schedule';
import { URGENCY, type Urgency } from '../state/urgency';
import { DayPicker, TimePicker } from '../components/TimePicker';
import { Segmented } from '../components/kit';
import { TimmyMark, tint } from '../components/common';
import { Frame } from '../components/Frame';
import { RULE_GROUPS } from '../components/Sidebar';

// ───────────── Activity ─────────────

const KIND_META: Record<ActivityKind, { icon: LucideIcon; color: string; label: string }> = {
  triage: { icon: Inbox, color: 'var(--c-slate)', label: 'Sorted' },
  move: { icon: MoveRight, color: 'var(--c-amber)', label: 'Moved' },
  draft: { icon: FilePenLine, color: 'var(--c-violet)', label: 'Drafted' },
  send: { icon: Send, color: 'var(--accent)', label: 'Sent' },
  file: { icon: FolderInput, color: 'var(--c-sky)', label: 'Filed' },
  task: { icon: ListChecks, color: 'var(--c-red)', label: 'Task' },
  calendar: { icon: CalendarDays, color: 'var(--c-green)', label: 'Calendar' },
  crm: { icon: BadgeDollarSign, color: 'var(--c-teal)', label: 'CRM' },
  approval: { icon: Stamp, color: 'var(--c-violet)', label: 'Decided' },
};

const ACTIVITY_TABS: { id: string; label: string; kinds: ActivityKind[] | null }[] = [
  { id: 'all', label: 'All', kinds: null },
  { id: 'sorting', label: 'Sorting', kinds: ['triage', 'move'] },
  { id: 'drafts', label: 'Drafts & sends', kinds: ['draft', 'send'] },
  { id: 'decisions', label: 'Decisions', kinds: ['approval'] },
  { id: 'files', label: 'Files', kinds: ['file'] },
  { id: 'other', label: 'Tasks, calendar & CRM', kinds: ['task', 'calendar', 'crm'] },
];

export function ActivityView({ tab }: { tab: string }) {
  const { state, dispatch } = useStore();
  const active = ACTIVITY_TABS.find((t) => t.id === tab) ?? ACTIVITY_TABS[0]!;
  const [undone, setUndone] = useState<string[]>([]);
  const items = [...state.activity]
    .filter((a) => !active.kinds || active.kinds.includes(a.kind))
    .sort((a, b) => b.at.getTime() - a.at.getTime());

  const groups = new Map<string, typeof items>();
  for (const a of items) {
    const diff = dayDiff(a.at);
    const key = diff === 0 ? 'Today' : diff === -1 ? 'Yesterday' : fmtDay(a.at);
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }

  return (
    <Frame
      tabs={ACTIVITY_TABS.map((t) => ({
        id: t.id,
        label: t.label,
        count: state.activity.filter((a) => !t.kinds || t.kinds.includes(a.kind)).length,
      }))}
      active={active.id}
      onTab={(id) => dispatch({ type: 'navigate', route: { view: 'activity', tab: id } })}
    >
      <h1 className="page-title">Timmy’s activity</h1>
      <p className="page-sub">Everything Timmy did on your behalf, newest first.{isLive() ? ' Undo is on the notice that follows each change.' : ' Undo anything for 7 days.'}</p>

      {[...groups.entries()].map(([day, list]) => (
        <section key={day} className="section">
          <div className="section-head">
            <h2 className="section-title">{day}</h2>
            <span className="section-sub">{list.length} actions</span>
          </div>
          <ol className="log">
            {list.map((a) => {
              const meta = KIND_META[a.kind];
              const isUndone = undone.includes(a.id);
              return (
                <li key={a.id} className={`log-item${isUndone ? ' undone' : ''}`}>
                  <span className="nav-icon" style={tint(meta.color)}>
                    <meta.icon size={15} />
                  </span>
                  <div className="log-text">
                    <p>{a.text}</p>
                    <span className="muted" style={{ fontSize: 12.5 }}>
                      {meta.label} · {fmtTime(a.at)}
                      {isUndone && ' · undone'}
                    </span>
                  </div>
                  <div className="log-actions">
                    {a.threadId && (
                      <button className="btn btn-xs btn-ghost" onClick={() => dispatch({ type: 'openThread', id: a.threadId!, tab: 'history' })}>
                        Open
                        <ArrowRight size={13} />
                      </button>
                    )}
                    {!isLive() && !a.id.startsWith('live') && !isUndone && (
                      <button
                        className="btn btn-xs"
                        onClick={() => {
                          setUndone((u) => [...u, a.id]);
                          dispatch({ type: 'toast', text: 'Undone. Timmy will ask before doing this again.' });
                        }}
                      >
                        <Undo2 size={13} />
                        Undo
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </Frame>
  );
}

// ───────────── Rules ─────────────

const RULE_INTRO: Record<RuleGroup, string> = {
  triage: 'How Timmy sorts new mail. Every email ends up in Follow Up, Waiting, Read Through or the archive.',
  urgency: 'How Timmy decides what’s urgent, so the morning brief leads with only what needs you today. Each rule is one signal; turn one off and Timmy stops using it.',
  approvals: 'What Timmy prepares but never does without your OK. Approve, edit or turn things down in Approvals.',
  writing: 'How drafts should sound. Timmy also learns from the edits you make before sending.',
  files: 'Where attachments go and what they’re called, so they’re easy to find by search.',
  schedule: 'When the morning run happens and how Timmy uses your calendar.',
};

export function RulesView({ tab }: { tab: RuleGroup }) {
  const { state, dispatch } = useStore();
  const [text, setText] = useState('');
  const group = RULE_GROUPS.find((g) => g.id === tab)!;
  const rules = state.rules.filter((r) => r.group === tab);

  return (
    <Frame
      tabs={RULE_GROUPS.map((g) => ({ id: g.id, label: g.name }))}
      active={tab}
      onTab={(id) => dispatch({ type: 'navigate', route: { view: 'rules', tab: id as RuleGroup } })}
    >
      <h1 className="page-title">{group.name}</h1>
      <p className="page-sub">{RULE_INTRO[tab]}</p>

      {tab === 'approvals' && <LiveSettings />}

      {tab === 'triage' && (
        <div className="loop">
          {[
            { n: 'Capture', d: 'New mail arrives' },
            { n: 'Organize', d: `Timmy sorts it at ${fmtClock(state.schedule.time)}` },
            { n: 'Review', d: 'You confirm in Triage' },
            { n: 'Act', d: 'Drafts, tasks, calendar' },
          ].map((s, i) => (
            <div key={s.n} className="loop-step">
              <span className="loop-n mono">{i + 1}</span>
              <strong>{s.n}</strong>
              <span className="muted">{s.d}</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'schedule' && <ScheduleCard />}

      {tab === 'urgency' && (
        <div className="urg-legend">
          {(['urgent', 'soon', 'later'] as const).map((l) => (
            <div key={l} className="urg-legend-item">
              <span className={`urg urg-${l}`}>
                <span className="urg-dot" aria-hidden />
                {URGENCY[l].label}
              </span>
              <span className="muted">{URGENCY_HELP[l]}</span>
            </div>
          ))}
        </div>
      )}

      <ul className="rules">
        {rules.map((r) => (
          <li key={r.id} className={`card rule${r.enabled ? '' : ' off'}`}>
            {r.locked ? (
              <span className="rule-lock" title="Always on">
                <Lock size={14} aria-label="Always on" />
              </span>
            ) : (
              <button className="switch" role="switch" aria-checked={r.enabled} aria-label={r.enabled ? 'Turn rule off' : 'Turn rule on'} onClick={() => dispatch({ type: 'toggleRule', id: r.id })} />
            )}
            <p className="rule-text">{r.text}</p>
            <span className="rule-hits mono">{r.hits ? `${r.hits}×` : 'new'}</span>
          </li>
        ))}
      </ul>

      <form
        className="add-rule"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          dispatch({ type: 'addRule', group: tab, text: text.trim() });
          setText('');
        }}
      >
        <TimmyMark size={26} muted />
        <input className="input" placeholder="Add a rule in plain language, e.g. “Anything from Acme legal goes to Follow Up”" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn btn-primary" type="submit">
          <Plus size={15} />
          Add rule
        </button>
      </form>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
        {isLive() ? '' : `Last run ${fmtTime(LAST_RUN)} today. `}Rule counts show how often each rule has fired.
      </p>
    </Frame>
  );
}

const URGENCY_HELP: Record<Urgency, string> = {
  urgent: 'Due today or late, or a lot rides on it. The brief lists these first.',
  soon: 'Needs you this week. Shown when you ask for everything open.',
  later: 'No time pressure, or it’s someone else’s move.',
};

/** Settings › Schedule: when the morning run happens and what the brief leads with. */
function ScheduleCard() {
  const { state, dispatch } = useStore();
  const s = state.schedule;
  const next = nextRun(s);
  const set = (schedule: Partial<typeof s>) => dispatch({ type: 'setSchedule', schedule });

  return (
    <section className="card card-pad sched" aria-labelledby="sched-title">
      <div className="sched-head">
        <h2 className="sched-title" id="sched-title">
          Morning run
        </h2>
        <p className="muted">Timmy sorts new mail, ranks what’s urgent, drafts replies and lines up decisions, so your brief is ready when you sit down. Nothing is sent without your approval.</p>
      </div>

      <div className="sched-grid">
        <div className="sched-field">
          <span className="sched-label">Run at</span>
          <TimePicker value={s.time} onChange={(time) => set({ time })} label="Morning run time" />
        </div>
        <div className="sched-field">
          <span className="sched-label">On</span>
          <DayPicker value={s.days} onChange={(days) => set({ days })} label="Days the morning run happens" />
        </div>
        <div className="sched-field">
          <span className="sched-label">The brief leads with</span>
          <Segmented
            label="The brief leads with"
            value={s.brief}
            onChange={(brief) => set({ brief })}
            options={[
              { id: 'urgent', label: 'Urgent only' },
              { id: 'all', label: 'Everything open' },
            ]}
          />
        </div>
      </div>

      <p className="sched-status">
        {next ? (
          <>
            <strong>Next run {whenLabel(next)}</strong> ({fmtDay(next)}).
          </>
        ) : (
          <strong>Paused: pick at least one day.</strong>
        )}{' '}
        {isLive() ? '' : `This morning’s run finished at ${fmtTime(LAST_RUN)} and sorted ${LAST_RUN_COUNT} emails.`}
      </p>
    </section>
  );
}
