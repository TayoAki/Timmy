/**
 * Connecting another AI app (Claude, ChatGPT, Claude Code) to Timmy over MCP: the pages the person sees in between.
 *
 *   /connect            sign in (only when they aren't signed in already)
 *   /connect/workspace  pick the workspace the app may use; with one workspace it moves on by itself
 *   /connect/consent    see what the app will be able to do, and say yes or no
 *
 * Each page carries the app's request, signed by Timmy's server, and hands it back with what the person chose. The
 * server checks the signature; nothing here decides anything on its own. See server/src/auth/auth.ts and http/mcp.ts.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, type Me } from './api';

export const isConnectPath = () => typeof window !== 'undefined' && /^\/connect(\/|$)/.test(window.location.pathname);

const query = () => window.location.search.slice(1);
const param = (name: string) => new URLSearchParams(window.location.search).get(name);

/** A step of the flow: the server answers with where to go next, which is followed as is. */
async function step(path: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, oauth_query: query() }) });
  const data = (await res.json().catch(() => ({}))) as { url?: string; message?: string; error_description?: string; error?: string };
  if (!res.ok || !data.url) throw new Error(data.message ?? data.error_description ?? 'That didn’t work. Go back to the app and start connecting again.');
  window.location.assign(data.url);
}

/** The app asking: the name it registered under, and where it sends the person back to. */
function useApp() {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    const id = param('client_id');
    if (!id) return;
    // Asked with the signed request, which works before the person has signed in.
    fetch('/api/auth/oauth2/public-client-prelogin', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: id, oauth_query: query() }) })
      .then((r) => (r.ok ? r.json() : null))
      .then((c: { client_name?: string } | null) => setName(c?.client_name?.slice(0, 80) || null))
      .catch(() => setName(null));
  }, []);
  let back = '';
  try {
    back = new URL(param('redirect_uri') ?? '').host;
  } catch {
    back = '';
  }
  return { name: name ?? 'An app', back };
}

function Page({ children }: { children: ReactNode }) {
  return (
    <main className="live-screen">
      <div className="live-card connect-card">
        <div className="live-brand" aria-hidden="true">Timmy</div>
        {children}
      </div>
    </main>
  );
}

export function ConnectFlow() {
  const path = window.location.pathname.replace(/\/$/, '');
  if (path === '/connect/workspace') return <PickWorkspace />;
  if (path === '/connect/consent') return <Consent />;
  return <SignIn />;
}

function SignIn() {
  const app = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      // Signing in with the app's request attached carries the connection on to its next page.
      await step('/api/auth/sign-in/email', { email: email.trim(), password });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Page>
      <h1 className="live-title">Sign in to connect {app.name}</h1>
      <p className="live-note">{app.name} wants to use Timmy for you. Sign in first; you choose what it may use next.</p>
      <form className="live-form" onSubmit={submit} noValidate>
        <label className="field">
          <span className="field-label">Work email</span>
          <input className="input" name="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Password</span>
          <input className="input" name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="live-error" role="alert">{error}</p>}
        <button className="btn btn-primary live-submit" type="submit" disabled={busy || !email || password.length < 8}>
          {busy ? 'One moment…' : 'Sign in'}
        </button>
      </form>
      <p className="live-fine">
        No password, or no account yet? <a href="/">Open Timmy</a>, sign in or create your account there, then connect {app.name} again.
      </p>
    </Page>
  );
}

function PickWorkspace() {
  const app = useApp();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const choose = async (id: string) => {
    setBusy(true);
    setError('');
    try {
      await api.setActive(id);
      await step('/api/auth/oauth2/continue', { postLogin: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  useEffect(() => {
    api
      .me()
      .then((m) => {
        setMe(m);
        // With one workspace there is nothing to choose.
        if (m && m.workspaces.length === 1) void choose(m.workspaces[0]!.id);
      })
      .catch(() => setMe(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (me === undefined || (me && me.workspaces.length === 1 && !error)) {
    return (
      <Page>
        <p className="live-note" role="status">One moment…</p>
      </Page>
    );
  }
  if (!me) {
    return (
      <Page>
        <h1 className="live-title">Sign in first</h1>
        <p className="live-note">Your Timmy session has ended. <a href="/">Sign in to Timmy</a>, then connect {app.name} again.</p>
      </Page>
    );
  }
  return (
    <Page>
      <h1 className="live-title">Which workspace may {app.name} use?</h1>
      <p className="live-note">It will see and work in that one only. To use another, connect it again.</p>
      {me.workspaces.length === 0 && <p className="live-note">You have no workspace yet. <a href="/">Open Timmy</a> to make one first.</p>}
      <div className="connect-choices" role="group" aria-label="Workspaces">
        {me.workspaces.map((ws) => (
          <button key={ws.id} className="btn connect-choice" disabled={busy} onClick={() => void choose(ws.id)}>
            <strong>{ws.name}</strong>
            <span className="muted">{ws.role}</span>
          </button>
        ))}
      </div>
      {error && <p className="live-error" role="alert">{error}</p>}
    </Page>
  );
}

function Consent() {
  const app = useApp();
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api.me().then(setMe).catch(() => setMe(null));
  }, []);
  const decide = async (accept: boolean) => {
    setBusy(true);
    setError('');
    try {
      await step('/api/auth/oauth2/consent', { accept });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  const workspace = me?.active?.name ?? 'your workspace';
  return (
    <Page>
      <h1 className="live-title">
        Let {app.name} use Timmy in {workspace}?
      </h1>
      <p className="live-note">It works as you{me ? ` (${me.user.email})` : ''}, with your role in {workspace}. It will be able to:</p>
      <ul className="connect-list">
        <li>read your mail, files, pages, projects, to-dos and the people you work with in Timmy;</li>
        <li>save drafts and to-dos, and put emails in projects;</li>
        <li>prepare emails, filing and sorting rules, which wait for your OK in Timmy before anything happens.</li>
      </ul>
      <p className="live-note">It can’t send an email, change your mailbox or save a rule without your OK, and it never sees your passwords or your connected accounts’ keys. You can disconnect it any time in Rules & settings › Approvals.</p>
      {app.back && <p className="live-fine">After you choose, you go back to {app.back}.</p>}
      {error && <p className="live-error" role="alert">{error}</p>}
      <div className="live-actions">
        <button className="btn btn-primary" disabled={busy} onClick={() => void decide(true)}>
          Allow
        </button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => void decide(false)}>
          Don’t allow
        </button>
      </div>
    </Page>
  );
}
