import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { api } from './api';
import { useProfile } from './LiveApp';

/**
 * Workspace settings that only exist on a real workspace: the model that powers
 * Timmy, how approvals work, and the account. Renders nothing in the demo.
 */
export function LiveSettings() {
  const live = useProfile();
  const { dispatch } = useStore();
  const [model, setModel] = useState(live?.profile.model ?? '');
  const [mode, setMode] = useState(live?.profile.approvalMode ?? 'ask');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!live) return;
    void api.settings().then((s) => {
      setModel(s.model);
      setMode(s.approvalMode);
    });
  }, [live]);
  if (!live) return null;
  const { profile, signOut } = live;
  const canChange = profile.can.policy;

  const save = async (patch: { model?: string; approvalMode?: 'ask' | 'auto' }, done: string) => {
    setSaving(true);
    try {
      await api.saveSettings(patch);
      dispatch({ type: 'toast', text: done });
    } catch (e) {
      dispatch({ type: 'toast', text: (e as Error).message, tone: 'warn' });
    } finally {
      setSaving(false);
    }
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
        <span className="field-label">Routine changes to your own mailbox</span>
        <select
          className="input"
          name="approval-mode"
          value={mode}
          disabled={!canChange || saving}
          onChange={(e) => {
            const next = e.target.value as 'ask' | 'auto';
            setMode(next);
            void save({ approvalMode: next }, next === 'auto' ? 'Timmy will decide routine filing itself and ask when unsure.' : 'Timmy will ask before every change.');
          }}
        >
          <option value="ask">Ask me every time</option>
          <option value="auto">Let Timmy decide routine filing, and ask when unsure</option>
        </select>
        <span className="field-hint">Whatever you choose, anything that reaches another person (an email, an invite, a post) waits for your OK or a rule you wrote. Timmy never moves money, signs documents or deletes accounts.</span>
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
