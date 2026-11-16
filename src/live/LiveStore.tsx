import { composeLink } from './compose-link';
import { draftHash } from './hash';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NOW, PEOPLE, PROJECTS, setUnknownPerson } from '../data/mock';
import { ALL_LABELS, StoreCtx, reducer, type Action, type State } from '../state/store';
import { personFromMail, registerPerson } from '../state/ws';
import { api, type Snapshot } from './api';
import { blankState } from './blank';
import { scopeConversations } from '../agent/conversations';
import { enterLive } from './clock';
import { applyPatches, fromWire, pickSlices, withSlices, type Patch } from './patches';
import type { LiveProfile } from './types';

/** Things that only change what this browser shows. They never go to the server. */
const LOCAL = new Set(['navigate', 'back', 'search', 'drawer', 'compose', 'capture', 'toast', 'dismissToast', 'setFocus', 'setScope', 'server', 'restore', 'reset', 'simulateReply']);

/**
 * Switches the shared code from the demo's world to the signed-in person's:
 * real time, no sample people or projects, and "me" is them.
 */
export function enterLiveWorld(profile: LiveProfile, me: Snapshot['me']) {
  enterLive();
  NOW.setTime(Date.now());
  for (const k of Object.keys(PEOPLE)) delete PEOPLE[k];
  PEOPLE.me = { id: 'me', name: profile.user.name, email: me.email ?? profile.user.email, company: profile.workspace.name, internal: true };
  // Screens look people up by id; someone Timmy only knows from an address still gets a name.
  setUnknownPerson((id) => personFromMail(id) ?? { id, name: id, email: '' });
  PROJECTS.length = 0;
  ALL_LABELS.splice(0, ALL_LABELS.length, ...ALL_LABELS.filter((l) => /^(inbox|follow-up|waiting|read-through|archived)$/.test(l.id)));
  document.documentElement.dataset.live = '';
  scopeConversations(profile.user.id, profile.workspace.id);
}

/** Names from the mailbox, so threads show "Dana Whitfield" and not an address. */
function learnPeople(state: State) {
  for (const t of state.threads) for (const [id, p] of Object.entries(t.ext?.people ?? {})) if (!(id in PEOPLE)) registerPerson({ id, name: p.name, email: p.email });
  for (const c of Object.values(state.ws.contacts)) if (!(c.id in PEOPLE)) registerPerson({ id: c.id, name: c.name, email: c.email, title: c.title, company: c.company });
}

let seq = 0;
const commandId = () => `c-${Date.now().toString(36)}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * The store for a real workspace. The screen shows the server's confirmed
 * state with the person's not-yet-confirmed actions replayed on top, so the app
 * answers instantly and the server still has the last word.
 */
export function LiveStoreProvider({ profile, snapshot, children }: { profile: LiveProfile; snapshot: Snapshot; children: ReactNode }) {
  const initial = useMemo(() => {
    const first = profile.user.name.trim().split(/\s+/)[0] || 'me';
    const s = withSlices(blankState({ first, company: profile.workspace.name }), snapshot.slices);
    learnPeople(s);
    return s;
  }, [profile, snapshot]);
  const [state, setState] = useState<State>(initial);
  const shown = useRef(initial);
  const confirmed = useRef(initial);
  const rev = useRef(snapshot.rev);
  const waiting = useRef<{ id: string; action: Action }[]>([]);

  // The morning run happens on the workspace's own clock. Until someone sets it, that is the clock of the
  // owner or admin who first opens the workspace; it is not changed again when they travel.
  useEffect(() => {
    if (!profile.can.policy) return;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!zone || zone === 'UTC') return;
    void api
      .settings()
      .then((s) => (s.timezone === 'UTC' ? api.saveSettings({ timezone: zone }) : undefined))
      .catch(() => {});
  }, [profile]);

  const show = useCallback((next: State) => {
    shown.current = next;
    setState(next);
  }, []);

  /** Lays the confirmed state under what is on screen and replays whatever the server hasn't answered yet. */
  const rebase = useCallback(
    (toast?: { text: string; tone?: 'warn'; command?: string; ms?: number }) => {
      let next = withSlices(shown.current, pickSlices(confirmed.current));
      for (const w of waiting.current) {
        const r = reducer(next, w.action);
        if (r) next = withSlices(next, pickSlices(r));
      }
      learnPeople(next);
      show(toast ? reducer(next, { type: 'server', state: {}, toast }) : next);
    },
    [show],
  );

  const accept = useCallback((r: number, patches: Patch[]) => {
    if (r <= rev.current) return false;
    confirmed.current = applyPatches(confirmed.current, patches);
    rev.current = r;
    return true;
  }, []);

  const reload = useCallback(async () => {
    const snap = await api.state();
    confirmed.current = withSlices(confirmed.current, snap.slices);
    rev.current = snap.rev;
    rebase();
  }, [rebase]);

  const send = useCallback(
    async (id: string, action: Action) => {
      try {
        const res = await api.command(id, action);
        waiting.current = waiting.current.filter((w) => w.id !== id);
        accept(res.rev, res.patches);
        if (res.redirect) window.location.assign(res.redirect);
        const toast = res.toast ? { ...res.toast, ...(res.holding ? { command: id, ms: res.holding.seconds * 1000 } : {}) } : undefined;
        rebase(toast);
      } catch (e) {
        waiting.current = waiting.current.filter((w) => w.id !== id);
        rebase({ text: (e as Error).message || 'That didn’t save. Check your connection and try again.', tone: 'warn' });
      }
    },
    [accept, rebase],
  );

  const dispatch = useCallback(
    (action: Action) => {
      // Connecting an app happens on the provider's own page, not in the reducer.
      if (action.type === 'conn' && (action.op.op === 'connect' || action.op.op === 'disconnect' || action.op.op === 'adminConsent')) {
        const { op, id } = action.op;
        if (op === 'connect') api.connect(id).then((r) => window.location.assign(r.redirectUrl)).catch((e: Error) => rebase({ text: e.message, tone: 'warn' }));
        if (op === 'disconnect') api.disconnect(id).catch((e: Error) => rebase({ text: e.message, tone: 'warn' }));
        return;
      }
      if (action.type === 'reset' || action.type === 'simulateReply' || action.type === 'release') return;
      // Cold email is sent by hand: this opens the mail app's own compose window, filled in, while the click is still
      // the browser's "user gesture" (so the new tab isn't blocked). Nothing is shown as sent; the server only logs it,
      // and the lead becomes "contacted" when sync sees the email in the Sent folder.
      if (action.type === 'out' && action.op.op === 'send' && action.op.channel === 'email') {
        const lead = shown.current.out.leads[action.op.lead];
        if (!lead) return;
        const apps = shown.current.conn.apps;
        const app = apps.gmail?.connected ? 'gmail' : apps.outlook?.connected ? 'outlook' : 'mailto';
        const link = composeLink(app, { to: lead.email, subject: action.op.subject ?? '', body: action.op.body, from: app === 'mailto' ? undefined : apps[app]?.account });
        if (!link.bodyFits) void navigator.clipboard?.writeText(action.op.body).catch(() => {});
        window.open(link.url, '_blank', 'noopener');
        void send(commandId(), action).then(() => {
          if (!link.bodyFits) rebase({ text: 'The email was too long for a link, so the text is on your clipboard. Paste it into the message.' });
        });
        return;
      }
      // The demo writes a canned draft on the spot. Here the model writes it on the server, so nothing is shown until it has.
      if (action.type === 'makeDraft') {
        void send(commandId(), action);
        return;
      }
      // A send says which draft the person was looking at; the server refuses if it has changed since.
      if (action.type === 'sendDraft' || action.type === 'runStep' || (action.type === 'resolve' && action.key.startsWith('draft:'))) {
        const threadId = action.type === 'resolve' ? action.key.slice(6) : action.id;
        action = { ...action, seen: draftHash(shown.current.threads.find((t) => t.id === threadId)?.draft) };
      }
      const id = commandId();
      let next = reducer(shown.current, action);
      if (!next) return;
      if (!LOCAL.has(action.type)) {
        // Undo on this notice asks the server to take the command back.
        const [toast] = next.toasts;
        if (toast && toast !== shown.current.toasts[0] && toast.undo) next = { ...next, toasts: [{ ...toast, undo: undefined, command: id }] };
        waiting.current = [...waiting.current, { id, action }];
        void send(id, action);
      }
      show(next);
    },
    [rebase, send, show],
  );

  // Changes made elsewhere (another tab, a teammate, new mail, a send going out) arrive on the stream.
  useEffect(() => {
    const es = new EventSource(`/api/v1/stream?rev=${rev.current}`);
    es.addEventListener('patch', (e) => {
      const d = fromWire<{ rev: number; patches: Patch[]; command?: string }>((e as MessageEvent).data);
      // This tab's own change can come back on the stream before the answer to its request does. It is confirmed
      // from that moment, so it is no longer replayed on top (which would show it twice until the answer arrived).
      if (d.command) waiting.current = waiting.current.filter((w) => w.id !== d.command);
      if (accept(d.rev, d.patches)) rebase();
    });
    es.addEventListener('reload', () => void reload());
    const clock = window.setInterval(() => NOW.setTime(Date.now()), 30_000);
    return () => {
      es.close();
      window.clearInterval(clock);
    };
  }, [accept, rebase, reload]);

  const value = useMemo(() => ({ state, dispatch }), [state, dispatch]);
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}
