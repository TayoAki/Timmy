import { X } from 'lucide-react';
import { useEffect } from 'react';
import { ApprovalsView } from './areas/approvals';
import { CalendarView } from './areas/calendar';
import { DocsView, FileView } from './areas/docs';
import { FilesView } from './areas/files';
import { LibraryView } from './areas/library';
import { ContactView, PeopleView } from './areas/people';
import { ProjectsView, ProjectView } from './areas/projects';
import { TasksView } from './areas/tasks';
import { CampaignView, OutboundView } from './areas/outbound';
import { SocialView } from './areas/outbound/Social';
import { ConnectionsView } from './areas/connections';
import { Assistant } from './agent/Assistant';
import { BottomBar } from './components/BottomBar';
import { Compose } from './components/Compose';
import { PushToTalk } from './components/Dictation';
import { LeftRail } from './components/LeftRail';
import { QuickCapture } from './components/QuickCapture';
import { RightPanel } from './components/RightPanel';
import { SearchPalette } from './components/SearchPalette';
import { Sidebar } from './components/Sidebar';
import { StoreProvider, useStore, type Toast } from './state/store';
import { StoryPlayer } from './story/StoryPlayer';
import { Intro } from './intro/Intro';
import { Outro } from './intro/Outro';
import { Film } from './film/Film';
import { ThemeProvider } from './state/theme';
import { AppearanceView } from './views/AppearanceView';
import { MailboxView } from './views/MailboxView';
import { ActivityView, RulesView } from './views/OtherViews';
import { ThreadView } from './views/ThreadView';
import { TodayView } from './views/TodayView';
import { VoiceView } from './views/VoiceView';

/** ?intro and ?outro play the cinematic films: the real app, filmed in 3D, on demo data that isn't saved. */
const PARAMS = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
const INTRO = PARAMS.has('intro');
const OUTRO = !INTRO && PARAMS.has('outro');
const FILM = !INTRO && !OUTRO && PARAMS.has('film');

export default function App() {
  return (
    <ThemeProvider>
      <StoreProvider ephemeral={INTRO || OUTRO || FILM}>
        {INTRO ? (
          <Intro>
            <Shell />
          </Intro>
        ) : OUTRO ? (
          <Outro>
            <Shell />
          </Outro>
        ) : FILM ? (
          <Film>
            <Shell />
          </Film>
        ) : (
          <Shell />
        )}
      </StoreProvider>
    </ThemeProvider>
  );
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);

function Shell() {
  const { state, dispatch } = useStore();
  const r = state.route;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = isTyping(e.target);
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        dispatch({ type: 'search', open: !state.searchOpen });
      } else if (mod && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        dispatch({ type: 'capture', open: !state.capture });
      } else if (e.key === '/' && !typing && !state.searchOpen) {
        e.preventDefault();
        dispatch({ type: 'search', open: true });
      } else if (e.key.toLowerCase() === 'c' && !typing && !mod && !e.altKey && !state.compose && !state.searchOpen) {
        e.preventDefault();
        dispatch({ type: 'compose', draft: { to: [], subject: '', body: '' } });
      } else if (mod && e.key === '.') {
        e.preventDefault();
        dispatch({ type: 'setFocus' });
      } else if (e.key === 'Escape' && state.drawer) {
        dispatch({ type: 'drawer', drawer: state.drawer });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch, state.searchOpen, state.drawer, state.capture, state.compose]);

  return (
    <div className="app" data-drawer={state.drawer ?? undefined} data-focus={state.focus ? '' : undefined} data-calm={state.calm ? '' : undefined}>
      <LeftRail />
      <Sidebar />
      {r.view === 'today' && <TodayView tab={r.tab} />}
      {r.view === 'box' && <MailboxView key={r.box} box={r.box} tab={r.tab} />}
      {r.view === 'thread' && <ThreadView key={r.id} id={r.id} tab={r.tab} />}
      {r.view === 'activity' && <ActivityView tab={r.tab} />}
      {r.view === 'rules' && <RulesView tab={r.tab} />}
      {r.view === 'appearance' && <AppearanceView />}
      {r.view === 'voice' && <VoiceView />}
      {r.view === 'tasks' && <TasksView />}
      {r.view === 'calendar' && <CalendarView />}
      {r.view === 'docs' && <DocsView />}
      {r.view === 'file' && <FileView key={r.id} />}
      {r.view === 'projects' && <ProjectsView />}
      {r.view === 'project' && <ProjectView key={r.id} />}
      {r.view === 'people' && <PeopleView />}
      {r.view === 'contact' && <ContactView key={r.id} />}
      {r.view === 'files' && <FilesView />}
      {r.view === 'library' && <LibraryView />}
      {r.view === 'approvals' && <ApprovalsView />}
      {r.view === 'outbound' && <OutboundView />}
      {r.view === 'campaign' && <CampaignView key={r.id} />}
      {r.view === 'social' && <SocialView />}
      {r.view === 'connections' && <ConnectionsView />}
      <RightPanel />
      <BottomBar />
      <div className="scrim" onClick={() => state.drawer && dispatch({ type: 'drawer', drawer: state.drawer })} />
      {state.searchOpen && <SearchPalette />}
      {state.compose && <Compose />}
      <QuickCapture />
      <Assistant />
      <PushToTalk />
      <Toasts />
      <StoryPlayer />
    </div>
  );
}

function Toasts() {
  const { state } = useStore();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {state.toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const { dispatch } = useStore();
  useEffect(() => {
    const timer = window.setTimeout(() => dispatch({ type: 'dismissToast', id: toast.id }), 5200);
    return () => window.clearTimeout(timer);
  }, [toast.id, dispatch]);
  return (
    <div className={`toast${toast.tone === 'warn' ? ' warn' : ''}`}>
      <span>{toast.text}</span>
      {toast.undo && <button onClick={() => dispatch({ type: 'restore', toast: toast.id })}>Undo</button>}
      <button className="toast-x" aria-label="Dismiss" onClick={() => dispatch({ type: 'dismissToast', id: toast.id })}>
        <X size={14} />
      </button>
    </div>
  );
}
