import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, type Me, type Snapshot } from './api';
import { LiveStoreProvider, enterLiveWorld } from './LiveStore';
import type { LiveProfile } from './types';
import './live.css';

const ProfileCtx = createContext<{ profile: LiveProfile; signOut: () => void; refresh: () => void } | null>(null);
/** Who is signed in. Null in the demo. */
export const useProfile = () => useContext(ProfileCtx);

const TRADES: [string, string][] = [
  ['sales', 'Sales'],
  ['recruiting', 'Recruiting'],
  ['real-estate', 'Real estate'],
  ['home-services', 'Home services'],
  ['consulting', 'Consulting'],
  ['agency', 'Agency'],
  ['other', 'Something else'],
];

type Stage = { at: 'loading' } | { at: 'auth' } | { at: 'onboarding'; me: Me } | { at: 'ready'; me: Me; snapshot: Snapshot } | { at: 'error'; message: string };

/** Signs the person in, gets them a workspace, loads its state, and only then shows the app. */
export function LiveApp({ children }: { children: ReactNode }) {
  const [stage, setStage] = useState<Stage>({ at: 'loading' });

  const load = useCallback(async () => {
    try {
      let me = await api.me();
      if (!me) return setStage({ at: 'auth' });
      // Arriving from an invitation link: join that workspace and open it.
      const invite = new URLSearchParams(window.location.search).get('invite');
      if (invite) {
        const joined = await api.acceptInvitation(invite).catch(() => null);
        window.history.replaceState(null, '', '/');
        if (joined?.invitation?.organizationId) await api.setActive(joined.invitation.organizationId).catch(() => {});
        me = (await api.me())!;
      }
      // A new session starts with no workspace chosen: pick the person's first one.
      if (!me.active && me.workspaces[0]) {
        await api.setActive(me.workspaces[0].id);
        me = (await api.me())!;
      }
      if (!me.active) return setStage({ at: 'onboarding', me });
      if (!me.active.can.read) return setStage({ at: 'error', message: 'Your role in this workspace only includes reports, which aren’t available yet.' });
      const snapshot = await api.state();
      const profile = profileOf(me);
      enterLiveWorld(profile, snapshot.me);
      setStage({ at: 'ready', me, snapshot });
    } catch (e) {
      setStage({ at: 'error', message: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const signOut = useCallback(() => {
    void api.signOut().finally(() => window.location.assign('/'));
  }, []);

  if (stage.at === 'loading') return <Centered><p className="live-note" role="status">Opening your workspace…</p></Centered>;
  if (stage.at === 'error')
    return (
      <Centered>
        <h1 className="live-title">Timmy couldn’t open your workspace</h1>
        <p className="live-note">{stage.message}</p>
        <div className="live-actions">
          <button className="btn btn-primary" onClick={() => void load()}>Try again</button>
          <button className="btn btn-ghost" onClick={signOut}>Sign out</button>
        </div>
      </Centered>
    );
  if (stage.at === 'auth') return <AuthScreen onDone={() => void load()} />;
  if (stage.at === 'onboarding') return <Onboarding me={stage.me} onDone={() => void load()} onSignOut={signOut} />;

  const profile = profileOf(stage.me);
  return (
    <ProfileCtx.Provider value={{ profile, signOut, refresh: () => void load() }}>
      <LiveStoreProvider profile={profile} snapshot={stage.snapshot}>
        {children}
      </LiveStoreProvider>
    </ProfileCtx.Provider>
  );
}

function profileOf(me: Me): LiveProfile {
  const a = me.active!;
  return { user: me.user, workspace: { id: a.id, name: a.name, trade: a.trade, role: a.role }, can: a.can, models: a.models, model: a.model, approvalMode: a.approvalMode };
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <main className="live-screen">
      <div className="live-card">
        <div className="live-brand" aria-hidden="true">Timmy</div>
        {children}
      </div>
    </main>
  );
}

function AuthScreen({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'in' | 'up' | 'link'>('in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'up') await api.signUp(name.trim(), email.trim(), password);
      else if (mode === 'in') await api.signIn(email.trim(), password);
      else {
        await api.magicLink(email.trim());
        setSent(true);
        return;
      }
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Centered>
      <h1 className="live-title">{mode === 'up' ? 'Create your account' : mode === 'in' ? 'Sign in to Timmy' : 'Sign in with an email link'}</h1>
      {sent ? (
        <p className="live-note" role="status">If {email} has an account, a sign-in link is on its way. It works once and expires in 10 minutes.</p>
      ) : (
        <form className="live-form" onSubmit={submit} noValidate>
          {mode === 'up' && (
            <label className="field">
              <span className="field-label">Your name</span>
              <input className="input" name="name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          )}
          <label className="field">
            <span className="field-label">Work email</span>
            <input className="input" name="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          {mode !== 'link' && (
            <label className="field">
              <span className="field-label">Password</span>
              <input className="input" name="password" type="password" autoComplete={mode === 'up' ? 'new-password' : 'current-password'} required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
              {mode === 'up' && <span className="field-hint">At least 8 characters.</span>}
            </label>
          )}
          {error && <p className="live-error" role="alert">{error}</p>}
          <button className="btn btn-primary live-submit" type="submit" disabled={busy || !email || (mode !== 'link' && password.length < 8) || (mode === 'up' && !name.trim())}>
            {busy ? 'One moment…' : mode === 'up' ? 'Create account' : mode === 'in' ? 'Sign in' : 'Email me a link'}
          </button>
        </form>
      )}
      <div className="live-switch">
        {mode !== 'in' && <button className="btn btn-ghost btn-sm" onClick={() => { setMode('in'); setSent(false); setError(''); }}>Sign in with a password</button>}
        {mode !== 'up' && <button className="btn btn-ghost btn-sm" onClick={() => { setMode('up'); setSent(false); setError(''); }}>Create an account</button>}
        {mode !== 'link' && <button className="btn btn-ghost btn-sm" onClick={() => { setMode('link'); setError(''); }}>Email me a sign-in link</button>}
      </div>
      <p className="live-fine">Signing in only proves who you are. Timmy can’t see your mail or calendar until you connect them, one button each.</p>
    </Centered>
  );
}

function Onboarding({ me, onDone, onSignOut }: { me: Me; onDone: () => void; onSignOut: () => void }) {
  const [name, setName] = useState('');
  const [trade, setTrade] = useState('sales');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.createWorkspace(name.trim(), trade);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Centered>
      <h1 className="live-title">Name your workspace</h1>
      <p className="live-note">Welcome, {me.user.name.split(' ')[0]}. A workspace holds your mail, your rules and your assistant. You can invite people later.</p>
      <form className="live-form" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Workspace name</span>
          <input className="input" name="workspace" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Your company or team" />
        </label>
        <label className="field">
          <span className="field-label">What kind of work is it?</span>
          <select className="input" name="trade" value={trade} onChange={(e) => setTrade(e.target.value)}>
            {TRADES.map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
          <span className="field-hint">This sets up the fields and templates you start with.</span>
        </label>
        {error && <p className="live-error" role="alert">{error}</p>}
        <button className="btn btn-primary live-submit" type="submit" disabled={busy || !name.trim()}>{busy ? 'Setting up…' : 'Create workspace'}</button>
      </form>
      <div className="live-switch">
        <button className="btn btn-ghost btn-sm" onClick={onSignOut}>Sign out</button>
      </div>
    </Centered>
  );
}
