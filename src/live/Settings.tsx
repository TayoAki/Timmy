import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { api } from './api';
import { useProfile } from './LiveApp';

/**
 * Workspace settings that only exist on a real workspace: the model that powers
 * Timmy, the monthly limit on what it may cost, whether Timmy may file mail on
 * its own when asked, and the account. Renders nothing in the demo.
 */
export function LiveSettings() {
  const live = useProfile();
  const { dispatch } = useStore();
  const [model, setModel] = useState(live?.profile.model ?? '');
  const [mode, setMode] = useState<'ask' | 'auto'>(live?.profile.approvalMode ?? 'ask');
  const [cap, setCap] = useState('');
  const [savedCap, setSavedCap] = useState('');
  const [ceiling, setCeiling] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!live) return;
    void api.settings().then((s) => {
      setModel(s.model);
      setMode(s.approvalMode);
      setCap(String(s.monthlySpendCapUsd));
      setSavedCap(String(s.monthlySpendCapUsd));
      setCeiling(s.limits.monthlySpendCapUsd);
    });
  }, [live]);
  if (!live) return null;
  const { profile, signOut } = live;
  const canChange = profile.can.policy;

  const save = async (patch: { model?: string; approvalMode?: 'ask' | 'auto'; monthlySpendCapUsd?: number }, done: string): Promise<boolean> => {
    setSaving(true);
    try {
      await api.saveSettings(patch);
      dispatch({ type: 'toast', text: done });
      return true;
    } catch (e) {
      dispatch({ type: 'toast', text: (e as Error).message, tone: 'warn' });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveCap = async () => {
    if (cap === savedCap) return;
    const amount = Number(cap);
    // The server checks the same range; saying so here saves a round trip. Either way the field goes back to the
    // limit in force, so it never shows a number that isn't true.
    if (cap.trim() === '' || !Number.isFinite(amount) || amount < 0 || amount > ceiling) {
      dispatch({ type: 'toast', text: `The monthly limit can be anything from $0 to ${dollars(ceiling)}.`, tone: 'warn' });
      setCap(savedCap);
    } else if (await save({ monthlySpendCapUsd: amount }, `The monthly limit is now ${dollars(amount)}.`)) setSavedCap(cap);
    else setCap(savedCap);
  };

  return (
    <section className="section live-settings" aria-label="Timmy’s model and account">
      <label className="field">
        <span className="field-label">The model that powers Timmy</span>
        <select
          className="input"
          name="timmy-model"
          value={model}
          disabled={!canChange || saving}
          onChange={(e) => {
            const id = e.target.value;
            setModel(id);
            void save({ model: id }, `Timmy now runs on ${profile.models.find((m) => m.id === id)?.label ?? id}.`);
          }}
        >
          {profile.models.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <span className="field-hint">
          {profile.models.find((m) => m.id === model)?.note} Only models that pass Timmy’s tests for tool use, drafting and refusals are offered.
          {!canChange && ' An owner or admin can change this.'}
        </span>
      </label>
      <label className="field">
        <span className="field-label">Monthly limit for Timmy’s model, in dollars</span>
        <input
          className="input"
          name="spend-cap"
          type="number"
          min={0}
          max={ceiling}
          step={1}
          value={cap}
          disabled={!canChange || saving}
          onChange={(e) => setCap(e.target.value)}
          onBlur={() => void saveCap()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
        <span className="field-hint">
          When this month’s model cost reaches the limit, Timmy stops reading, drafting and answering until next month or until the limit is raised. The most it can be set to is {dollars(ceiling)}.
          {!canChange && ' An owner or admin can change this.'}
        </span>
      </label>
      <label className="field">
        <span className="field-label">When you ask Timmy in the chat to file or archive mail</span>
        <select
          className="input"
          name="approval-mode"
          value={mode}
          disabled={!canChange || saving}
          onChange={(e) => {
            const next = e.target.value as 'ask' | 'auto';
            setMode(next);
            void save({ approvalMode: next }, next === 'auto' ? 'Timmy will file what you clearly asked for, and ask when unsure.' : 'Timmy will ask before it files anything.');
          }}
        >
          <option value="ask">Show me each change and wait for my OK</option>
          <option value="auto">File it when I clearly asked for it, and ask when unsure</option>
        </select>
        <span className="field-hint">
          This only covers labels and archiving in your own mailbox, which nobody else sees. Whatever you choose, anything that reaches another person (an email, an invite, a post) waits for your OK or a rule you wrote. Timmy never moves money, signs documents or deletes accounts.
          {!canChange && ' An owner or admin can change this.'}
        </span>
      </label>
      <div className="live-account">
        <span className="muted">
          Signed in as {profile.user.name} ({profile.user.email}) · {profile.workspace.name} · {profile.workspace.role}
        </span>
        <button className="btn btn-sm" onClick={signOut}>Sign out</button>
      </div>
    </section>
  );
}

const dollars = (n: number) => `$${n.toLocaleString('en-US')}`;
