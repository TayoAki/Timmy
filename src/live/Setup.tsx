/**
 * Setting up a real workspace. First the core, in order: connect one mailbox, connect one Drive, let Timmy find the
 * projects in them and keep the ones that fit, then try Timmy on that mail and those files (SetupSteps.tsx). Then the
 * rest: whether Timmy sorts junk by itself, the calendar, and when the morning run happens. It opens by itself right
 * after a workspace is created, from the "Set up Timmy" button on the brief at any time after that, and again when the
 * person comes back from an app's sign-in page they went to from here.
 *
 * Whether a step is done is read from the workspace itself (which apps are connected, whether the rule to sort
 * mail automatically is on), so it is the same on every device. Only small choices are kept in this browser: that
 * the person skipped files for now, chose to sort everything themselves, or looked at the morning run time. Losing
 * them just shows those steps again.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, Calendar, Check, FolderKanban, FolderOpen, Mail, Plug, Sparkles, Sunrise, Wand2 } from 'lucide-react';
import { activeProjects } from '../areas/projects/lib';
import { ProjectsStep, TourStep, type TourPart } from './SetupSteps';
import { Modal } from '../components/kit';
import { TimePicker } from '../components/TimePicker';
import { APPS } from '../data/connections';
import { daysLabel, fmtClock } from '../state/schedule';
import { useStore, type State } from '../state/store';
import { api } from './api';
import { useProfile } from './LiveApp';
import { sortedNotice } from './Settings';

type StepId = 'mail' | 'files' | 'projects' | 'tour' | 'sorting' | 'calendar' | 'morning';

interface Saved {
  skipped: StepId[];
  morning: boolean;
  /** The person chose to sort everything in Triage themselves. */
  sortsThemselves: boolean;
  /** The tour is finished, and which of its three parts the person tried. */
  tour: boolean;
  tried: TourPart[];
}

/* ───────────── What this browser remembers ───────────── */

const savedKey = (workspaceId: string) => `timmy-setup-${workspaceId}`;
const SAVED_EVENT = 'timmy:setup-saved';
const OPEN_EVENT = 'timmy:setup-open';
/** Set when a workspace has just been created: the setup opens once the app has loaded. */
const FIRST_RUN = 'timmy-setup-first-run';
/** Set when an app's sign-in page was opened from the setup, so the setup opens again on the way back. */
const RESUME = 'timmy-setup-resume';
const RESUME_FOR_MS = 30 * 60_000;

function readSaved(workspaceId: string): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(savedKey(workspaceId)) ?? 'null') as Partial<Saved> | null;
    return {
      skipped: Array.isArray(v?.skipped) ? v.skipped.filter((s): s is StepId => s === 'files' || s === 'projects') : [],
      morning: v?.morning === true,
      sortsThemselves: v?.sortsThemselves === true,
      tour: v?.tour === true,
      tried: Array.isArray(v?.tried) ? v.tried.filter((s): s is TourPart => s === 'email' || s === 'todo' || s === 'doc') : [],
    };
  } catch {
    return { skipped: [], morning: false, sortsThemselves: false, tour: false, tried: [] };
  }
}

function writeSaved(workspaceId: string, saved: Saved) {
  try {
    localStorage.setItem(savedKey(workspaceId), JSON.stringify(saved));
  } catch {
    // Storage can be off (a private window); the step simply shows again next time.
  }
  window.dispatchEvent(new CustomEvent(SAVED_EVENT));
}

function session(op: 'get' | 'set' | 'remove', key: string, value = ''): string | null {
  try {
    if (op === 'get') return sessionStorage.getItem(key);
    if (op === 'set') sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    // Without session storage the setup just doesn't reopen by itself.
  }
  return null;
}

/** Whether the rule to sort mail automatically is on, per workspace: asked of the server once, then kept here. */
const sortingOn = new Map<string, boolean>();
const askedSorting = new Set<string>();
function loadSorting(workspaceId: string) {
  if (askedSorting.has(workspaceId)) return;
  askedSorting.add(workspaceId);
  void api
    .settings()
    .then((s) => {
      sortingOn.set(workspaceId, s.autoSort.on);
      window.dispatchEvent(new CustomEvent(SAVED_EVENT));
    })
    .catch(() => askedSorting.delete(workspaceId));
}

/** What the tour's parts tried so far are, as this browser has them now (two may be marked one after the other). */
let triedWorkspace = '';
const readSavedTried = () => readSaved(triedWorkspace).tried;

/** Called when a workspace has just been created, before the app loads it. */
export const markFirstRun = () => session('set', FIRST_RUN, '1');

/** Opens the setup from anywhere in the app. */
export const openSetup = () => window.dispatchEvent(new CustomEvent(OPEN_EVENT));

/* ───────────── Where each step stands ───────────── */

interface Progress {
  mail: 'gmail' | 'outlook' | null;
  done: Record<StepId, boolean>;
  count: number;
  complete: boolean;
  next: StepId | null;
}

const ORDER: StepId[] = ['mail', 'files', 'projects', 'tour', 'sorting', 'calendar', 'morning'];

function progressOf(state: State, saved: Saved, setsSchedule: boolean, sorts: boolean | undefined): Progress {
  const apps = state.conn.apps;
  const mail = apps.gmail?.connected ? 'gmail' : apps.outlook?.connected ? 'outlook' : null;
  const done: Record<StepId, boolean> = {
    mail: !!mail,
    // Only an owner or admin sets the rule; for anyone else there is nothing to choose.
    sorting: sorts === true || saved.sortsThemselves || !setsSchedule,
    // An Outlook account brings its calendar with it, unless Microsoft was told not to share it.
    calendar: !!apps.gcal?.connected || (!!apps.outlook?.connected && !apps.outlook.calendarRefused),
    files: !!apps.gdrive?.connected || !!apps.onedrive?.connected || saved.skipped.includes('files'),
    projects: activeProjects(state.ws).length > 0 || saved.skipped.includes('projects'),
    tour: saved.tour,
    // Only an owner or admin sets the morning run; for anyone else there is nothing to choose.
    morning: saved.morning || !setsSchedule,
  };
  const count = ORDER.filter((s) => done[s]).length;
  return { mail, done, count, complete: count === ORDER.length, next: ORDER.find((s) => !done[s]) ?? null };
}

function useSetup() {
  const { state } = useStore();
  const live = useProfile();
  const workspaceId = live?.profile.workspace.id ?? '';
  triedWorkspace = workspaceId;
  const [saved, setSaved] = useState<Saved>(() => readSaved(workspaceId));
  const [sorts, setSorts] = useState<boolean | undefined>(() => sortingOn.get(workspaceId));
  const can = live?.profile.can;
  useEffect(() => {
    const again = () => {
      setSaved(readSaved(workspaceId));
      setSorts(sortingOn.get(workspaceId));
    };
    again();
    if (workspaceId && can?.policy) loadSorting(workspaceId);
    window.addEventListener(SAVED_EVENT, again);
    return () => window.removeEventListener(SAVED_EVENT, again);
  }, [workspaceId, can?.policy]);
  const progress = progressOf(state, saved, !!can?.policy, sorts);
  const update = useCallback((change: Partial<Saved>) => writeSaved(workspaceId, { ...readSaved(workspaceId), ...change }), [workspaceId]);
  /** Switches the rule on; it files what is already waiting, inside Timmy only, and says how many. */
  const sortAutomatically = useCallback(async (): Promise<string> => {
    const r = await api.saveSettings({ autoSort: true });
    sortingOn.set(workspaceId, true);
    window.dispatchEvent(new CustomEvent(SAVED_EVENT));
    return sortedNotice(r.sorted);
  }, [workspaceId]);
  return { progress, saved, update, sorts, sortAutomatically, canConnect: !!can?.connect, canSchedule: !!can?.policy };
}

/* ───────────── The button and the card on the brief ───────────── */

/** On the brief, where the demo has "Watch the story": opens the setup until every step is done. */
export function SetupButton() {
  const { progress, canConnect } = useSetup();
  if (!canConnect || progress.complete) return null;
  return (
    <button className="btn btn-sm setup-btn" onClick={openSetup} title="Connect your email, calendar and files, and choose when Timmy works">
      <Plug size={14} />
      Set up Timmy
      <span className="setup-btn-count" aria-label={`${progress.count} of ${ORDER.length} steps done`}>
        {progress.count}/{ORDER.length}
      </span>
    </button>
  );
}

/** On an empty brief: the one thing to do first. */
export function SetupCard() {
  const { progress, canConnect } = useSetup();
  if (!canConnect || progress.done.mail) return null;
  return (
    <section className="card setup-card" aria-label="Get started">
      <span className="setup-card-icon" aria-hidden>
        <Mail size={18} />
      </span>
      <div className="setup-card-text">
        <strong>Connect your email to get started</strong>
        <span>Timmy sorts your inbox, drafts replies and keeps track of what people promised. Nothing is sent without your OK.</span>
      </div>
      <button className="btn btn-primary btn-sm" onClick={openSetup}>
        Set up Timmy
        <ArrowRight size={14} />
      </button>
    </section>
  );
}

/* ───────────── The setup itself ───────────── */

interface Flash {
  step: StepId;
  text: string;
  tone: 'ok' | 'warn';
}

const appName = (id: string) => APPS.find((a) => a.id === id)?.name ?? id;
const stepOfApp = (id: string): StepId | null => (id === 'gmail' || id === 'outlook' ? 'mail' : id === 'gcal' ? 'calendar' : id === 'gdrive' || id === 'onedrive' ? 'files' : null);

/** Mounted once on a real workspace. Opens on the events above and on the way back from an app's sign-in page. */
export function SetupDialog() {
  const { state, dispatch } = useStore();
  const { progress, saved, update, sorts, sortAutomatically, canConnect, canSchedule } = useSetup();
  const [sorting, setSorting] = useState(false);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<StepId | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);

  useEffect(() => {
    const show = () => {
      setFlash(null);
      setShown(null);
      setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, show);
    return () => window.removeEventListener(OPEN_EVENT, show);
  }, []);

  // Once, when the app has loaded: a workspace that was just created, or the way back from an app's sign-in page.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('connect');
    const app = params.get('app') ?? '';
    if (outcome) {
      params.delete('connect');
      params.delete('app');
      const rest = params.toString();
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
    }
    const resumeAt = Number(session('get', RESUME) ?? 0);
    session('remove', RESUME);
    const fromSetup = resumeAt > 0 && Date.now() - resumeAt < RESUME_FOR_MS;
    const name = app && APPS.some((a) => a.id === app) ? appName(app) : '';
    const connected = `${name || 'The app'} is connected.`;
    const failed = `Connecting${name ? ` ${name}` : ''} didn’t finish, so nothing was connected.`;
    if (outcome && fromSetup) {
      const step = stepOfApp(app) ?? 'mail';
      setFlash(outcome === 'ok' ? { step, text: connected, tone: 'ok' } : { step, text: `${failed} Try again.`, tone: 'warn' });
      setShown(step);
      setOpen(true);
    } else if (outcome === 'ok') dispatch({ type: 'toast', text: `${connected}${stepOfApp(app) === 'mail' ? ' Timmy is bringing in your mail.' : ''}` });
    else if (outcome) dispatch({ type: 'toast', text: `${failed} Try again from Connections.`, tone: 'warn' });
    if (session('get', FIRST_RUN)) {
      session('remove', FIRST_RUN);
      if (canConnect) setOpen(true);
    }
    // Runs once per page load on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!open) return null;

  const connect = (id: string) => {
    session('set', RESUME, String(Date.now()));
    dispatch({ type: 'conn', op: { op: 'connect', id } });
  };
  const close = () => setOpen(false);
  const current = shown && !progress.done[shown] ? shown : flash && flash.tone === 'warn' ? flash.step : progress.next;
  const apps = state.conn.apps;

  return (
    <Modal
      open
      onClose={close}
      width={680}
      title={progress.complete ? 'Timmy is set up' : 'Set up Timmy'}
      description={progress.complete ? undefined : 'A few minutes. Connect your email and Drive, and Timmy sorts them into your projects. It never sends, deletes or changes anything without your OK.'}
      footer={
        progress.complete ? (
          <>
            <button className="btn btn-sm btn-ghost" onClick={close}>
              Close
            </button>
            <button
              className="btn btn-sm btn-primary"
              data-autofocus
              onClick={() => {
                dispatch({ type: 'navigate', route: { view: 'today', tab: 'triage' } });
                close();
              }}
            >
              Open Triage
              <ArrowRight size={14} />
            </button>
          </>
        ) : (
          <>
            <span className="setup-foot-note">You can come back to this from the brief.</span>
            <button className="btn btn-sm btn-ghost" onClick={close}>
              Finish later
            </button>
          </>
        )
      }
    >
      {flash && (
        <p className={`setup-flash setup-flash-${flash.tone}`} role="status">
          {flash.text}
        </p>
      )}
      <div className="setup-progress" aria-hidden>
        <span style={{ width: `${(progress.count / ORDER.length) * 100}%` }} />
      </div>
      <p className="setup-count">
        {progress.count} of {ORDER.length} done
      </p>

      {progress.done.mail && <MailStatus app={progress.mail!} />}

      {progress.complete && (
        <p className="setup-done-note">
          New mail lands in Triage with Timmy’s suggestion and goes into its project; accept one and Timmy files it in {progress.mail === 'outlook' ? 'Outlook' : 'Gmail'} too. New files join their projects, and to-dos come from what emails ask. Drafts, sends and calendar changes always wait for you.
        </p>
      )}

      <ol className="setup-steps">
        <Step
          id="mail"
          n={1}
          icon={<Mail size={16} />}
          title="Connect your email"
          done={progress.done.mail}
          summary={progress.mail ? `${appName(progress.mail)} · ${apps[progress.mail]?.account ?? 'connected'}` : undefined}
          open={current === 'mail'}
          onOpen={() => setShown('mail')}
        >
          <p className="setup-text">Timmy sorts your inbox, drafts replies and keeps track of what people promised. It brings in the last 30 days first, then the rest of the last 90.</p>
          <div className="setup-choices">
            <Choice app="gmail" line="Gmail or Google Workspace" onConnect={() => connect('gmail')} />
            <Choice app="outlook" line="Outlook or Microsoft 365" onConnect={() => connect('outlook')} />
          </div>
          <p className="setup-fine">
            You sign in on Google’s or Microsoft’s own page, through Composio, the service Timmy uses to connect apps; Google’s page may name Composio. Timmy never sees your password. A workspace reads one mailbox.
          </p>
        </Step>

        <Step
          id="files"
          n={2}
          icon={<FolderOpen size={16} />}
          title="Connect your files"
          done={progress.done.files}
          summary={apps.gdrive?.connected ? `Google Drive · ${apps.gdrive.account ?? 'connected'}` : apps.onedrive?.connected ? `OneDrive · ${apps.onedrive.account ?? 'connected'}` : progress.done.files ? 'Skipped for now' : undefined}
          open={current === 'files'}
          onOpen={() => setShown('files')}
        >
          <p className="setup-text">Timmy puts your documents in their projects, finds one by what it says, and opens it in its own editor. It keeps a list of your files and the words in recent documents, spreadsheets and slides, and changes a file only when you edit it in Timmy and press Save.</p>
          <div className="setup-choices">
            {(progress.mail === 'outlook' ? ['onedrive', 'gdrive'] : ['gdrive', 'onedrive']).map((id) => (
              <Choice key={id} app={id} line={id === 'gdrive' ? 'Docs, Sheets and Slides' : 'Word, Excel and PowerPoint'} onConnect={() => connect(id)} />
            ))}
          </div>
          <div className="setup-row-end">
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setShown(null);
                setFlash(null);
                update({ skipped: [...new Set([...saved.skipped, 'files' as StepId])] });
              }}
            >
              Skip for now
            </button>
          </div>
        </Step>

        <Step
          id="projects"
          n={3}
          icon={<FolderKanban size={16} />}
          title="Find your projects"
          done={progress.done.projects}
          summary={activeProjects(state.ws).length ? `${activeProjects(state.ws).length} project${activeProjects(state.ws).length === 1 ? '' : 's'}` : progress.done.projects ? 'Skipped for now' : undefined}
          open={current === 'projects'}
          onOpen={() => setShown('projects')}
        >
          <ProjectsStep
            mailIn={!!progress.mail}
            onSkip={() => {
              setShown(null);
              setFlash(null);
              update({ skipped: [...new Set([...saved.skipped, 'projects' as StepId])] });
            }}
          />
        </Step>

        <Step
          id="tour"
          n={4}
          icon={<Sparkles size={16} />}
          title="See Timmy at work"
          done={progress.done.tour}
          summary={progress.done.tour ? `${saved.tried.length} of 3 tried` : undefined}
          open={current === 'tour'}
          onOpen={() => setShown('tour')}
        >
          <TourStep
            tried={saved.tried}
            hasFiles={!!apps.gdrive?.connected || !!apps.onedrive?.connected}
            onTried={(part) => update({ tried: [...new Set([...readSavedTried(), part])] })}
            onFinish={() => {
              setShown(null);
              update({ tour: true });
            }}
          />
        </Step>

        <Step
          id="sorting"
          n={5}
          icon={<Wand2 size={16} />}
          title="Choose how Timmy sorts"
          done={progress.done.sorting}
          summary={sorts ? 'Junk is sorted automatically' : progress.done.sorting ? (canSchedule ? 'You sort everything in Triage' : 'Set by an owner or admin') : undefined}
          open={current === 'sorting'}
          onOpen={() => setShown('sorting')}
        >
          <p className="setup-text">
            Timmy can file what it is sure is junk as it arrives: promotions, receipts, system notices, calendar replies and newsletters. Mail a person wrote always waits for you in Triage. Turning it on also sorts what is already there, inside Timmy only; your mailbox is changed only for mail that arrives from then on.
          </p>
          {canSchedule ? (
            <div className="setup-row-end setup-row-gap">
              <button
                className="btn btn-sm btn-ghost"
                disabled={sorting}
                onClick={() => {
                  setShown(null);
                  update({ sortsThemselves: true });
                }}
              >
                Leave everything in Triage
              </button>
              <button
                className="btn btn-sm btn-primary"
                disabled={sorting}
                onClick={() => {
                  setSorting(true);
                  sortAutomatically()
                    .then((text) => {
                      setShown(null);
                      setFlash(null);
                      dispatch({ type: 'toast', text });
                    })
                    .catch((e: Error) => dispatch({ type: 'toast', text: e.message, tone: 'warn' }))
                    .finally(() => setSorting(false));
                }}
              >
                <Wand2 size={14} />
                {sorting ? 'Sorting…' : 'Sort junk automatically'}
              </button>
            </div>
          ) : (
            <p className="setup-fine">An owner or admin of this workspace chooses this.</p>
          )}
        </Step>

        <Step
          id="calendar"
          n={6}
          icon={<Calendar size={16} />}
          title="Connect your calendar"
          done={progress.done.calendar}
          summary={apps.gcal?.connected ? `Google Calendar · ${apps.gcal.account ?? 'connected'}` : apps.outlook?.connected ? 'Comes with Outlook' : undefined}
          open={current === 'calendar'}
          onOpen={() => setShown('calendar')}
        >
          <p className="setup-text">Today’s meetings go on your brief, and Timmy can find times that work and prepare invites for you to approve.</p>
          {apps.outlook?.connected && apps.outlook.calendarRefused ? (
            <p className="setup-flash setup-flash-warn">
              Outlook was connected without permission to read your calendar. Disconnect it in Connections and connect it again, and allow the calendar when Microsoft asks.
            </p>
          ) : (
            <>
              <div className="setup-choices">
                <Choice app="gcal" line="Your Google calendars" onConnect={() => connect('gcal')} />
              </div>
              {!progress.mail && <p className="setup-fine">Using Outlook? Its calendar comes with it in step 1.</p>}
            </>
          )}
        </Step>

        <Step
          id="morning"
          n={7}
          icon={<Sunrise size={16} />}
          title="Choose your morning run"
          done={progress.done.morning}
          summary={`${fmtClock(state.schedule.time)} · ${daysLabel(state.schedule.days)}`}
          open={current === 'morning'}
          onOpen={() => setShown('morning')}
        >
          <p className="setup-text">Each morning Timmy reads what came in overnight, drafts replies and nudges, and puts what needs you at the top of your brief. Drafts wait for you; nothing is sent.</p>
          {canSchedule ? (
            <>
              <div className="setup-run">
                <span className="setup-run-label">Ready by</span>
                <TimePicker value={state.schedule.time} onChange={(time) => dispatch({ type: 'setSchedule', schedule: { time } })} label="Morning run time" />
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    dispatch({ type: 'navigate', route: { view: 'rules', tab: 'schedule' } });
                    close();
                  }}
                  title="Choose the days in Settings › Schedule"
                >
                  {daysLabel(state.schedule.days)}
                </button>
              </div>
              <div className="setup-row-end">
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => {
                    setShown(null);
                    update({ morning: true });
                  }}
                >
                  <Check size={14} />
                  Use {fmtClock(state.schedule.time)}
                </button>
              </div>
            </>
          ) : (
            <p className="setup-fine">An owner or admin of this workspace sets the time.</p>
          )}
        </Step>
      </ol>
    </Modal>
  );
}

function Step({ id, n, icon, title, optional, done, summary, open, onOpen, children }: { id: StepId; n: number; icon: ReactNode; title: string; optional?: boolean; done: boolean; summary?: string; open: boolean; onOpen: () => void; children: ReactNode }) {
  const state = open ? 'open' : done ? 'done' : 'todo';
  return (
    <li className="setup-step" data-state={state} data-step={id}>
      <button className="setup-step-head" aria-expanded={open} onClick={onOpen} disabled={open}>
        <span className="setup-step-mark" aria-hidden>
          {done && !open ? <Check size={14} strokeWidth={2.5} /> : n}
        </span>
        <span className="setup-step-icon" aria-hidden>
          {icon}
        </span>
        <span className="setup-step-title">
          {title}
          {optional && <span className="setup-optional">Optional</span>}
        </span>
        {summary && (done || id === 'morning') && !open && <span className="setup-step-summary">{summary}</span>}
        <span className="sr-only">{done ? ' (done)' : ''}</span>
      </button>
      {open && <div className="setup-step-body">{children}</div>}
    </li>
  );
}

function Choice({ app, line, onConnect }: { app: string; line: string; onConnect: () => void }) {
  const { state } = useStore();
  const def = APPS.find((a) => a.id === app);
  const c = state.conn.apps[app];
  // A workspace reads one mailbox: the other one waits until this one is disconnected.
  const otherMail = (app === 'gmail' && state.conn.apps.outlook?.connected) || (app === 'outlook' && state.conn.apps.gmail?.connected);
  return (
    <div className="setup-choice" data-connected={c?.connected ? 'true' : undefined}>
      <span className="conn-mark" style={{ color: def?.color }} aria-hidden>
        {def?.mark}
      </span>
      <span className="setup-choice-name">
        <strong>{def?.name ?? app}</strong>
        <span>{c?.connected ? `Connected · ${c.account ?? ''}` : line}</span>
      </span>
      {c?.connected ? (
        <span className="setup-choice-ok">
          <Check size={14} /> Connected
        </span>
      ) : (
        <button className="btn btn-sm btn-primary" onClick={onConnect} disabled={!!otherMail} title={otherMail ? 'A workspace reads one mailbox. Disconnect the other one in Connections first.' : undefined}>
          Connect {SHORT_NAMES[app] ?? def?.name ?? app}
        </button>
      )}
    </div>
  );
}

const SHORT_NAMES: Record<string, string> = { gmail: 'Gmail', outlook: 'Outlook', gcal: 'Google Calendar', gdrive: 'Google Drive', onedrive: 'OneDrive' };

/** What has come in so far, while the mailbox fills. */
function MailStatus({ app }: { app: 'gmail' | 'outlook' }) {
  const { state } = useStore();
  const total = state.threads.length;
  const triage = state.threads.filter((t) => t.box === 'inbox').length;
  return (
    <p className="setup-status" role="status" data-filling={total === 0 ? 'true' : undefined}>
      <span className="setup-status-dot" aria-hidden />
      {total === 0
        ? `Timmy is bringing in your ${app === 'outlook' ? 'Outlook' : 'Gmail'} mail. The first conversations show up within a few minutes.`
        : `${total.toLocaleString()} conversation${total === 1 ? '' : 's'} in so far, ${triage.toLocaleString()} waiting in Triage for your call.`}
    </p>
  );
}
