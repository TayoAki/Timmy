/**
 * Rules › Triage: the sorting rules plain code applies to mail (src/state/mail-rules.ts), and a form to write one.
 * Before it is saved, the form says how many emails the rule would match today, so the person can see what it does.
 */
import { Filter, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { MailRuleBox } from '../data/types';
import { activeProjects } from '../areas/projects/lib';
import { Field } from '../components/kit';
import { useProfile } from '../live/LiveApp';
import { checkMailRule, describeMailRule, filesAway, RULE_BOX_WORDS, ruleMatches } from '../state/mail-rules';
import { useStore } from '../state/store';

const split = (v: string) =>
  v
    .split(/[,;\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);

const BOX_CHOICES: { id: MailRuleBox | ''; label: string }[] = [
  { id: 'archived', label: 'Archive it' },
  { id: 'read-through', label: 'Move it to Read Through' },
  { id: 'follow-up', label: 'Always show it to me (never archive it)' },
  { id: '', label: 'Leave it where Timmy puts it' },
];

export function SortingRules() {
  const { state, dispatch } = useStore();
  const live = useProfile();
  const mayChange = !live || live.profile.can.policy;
  const rules = state.rules.filter((r) => r.mail);
  const projects = activeProjects(state.ws);
  const [from, setFrom] = useState('');
  const [subject, setSubject] = useState('');
  const [words, setWords] = useState('');
  const [box, setBox] = useState<MailRuleBox | ''>('archived');
  const [project, setProject] = useState('');
  const [tried, setTried] = useState(false);

  const draft = useMemo(
    () =>
      checkMailRule(
        { when: { from: split(from), subject: split(subject), words: split(words) }, then: { ...(box ? { box } : {}), ...(project ? { project } : {}) } },
        state.ws.projects,
      ),
    [from, subject, words, box, project, state.ws.projects],
  );
  const matches = useMemo(() => ('rule' in draft ? state.threads.filter((t) => ruleMatches(draft.rule, t)) : []), [draft, state.threads]);
  const waiting = matches.filter((t) => t.box === 'inbox').length;
  const typed = !!(from.trim() || subject.trim() || words.trim());

  const save = () => {
    setTried(true);
    if (!('rule' in draft)) return;
    dispatch({ type: 'addRule', group: 'triage', text: '', mail: draft.rule });
    setFrom('');
    setSubject('');
    setWords('');
    setProject('');
    setTried(false);
  };

  return (
    <section className="sr" aria-labelledby="sr-title">
      <h2 id="sr-title" className="sr-title">
        <Filter size={16} aria-hidden /> Sorting rules
      </h2>
      <p className="muted sr-sub">
        Timmy applies these to mail as it arrives, exactly as written. Archive and Read Through rules file new mail in your mailbox too; mail already here is only suggested, for you to accept in
        Triage. “Always show it to me” wins over any rule or sort that would file the mail away. You can also tell Timmy in Ask, for example “always archive mail from linkedin.com”.
      </p>

      {rules.length > 0 && (
        <ul className="rules sr-list">
          {rules.map((r) => (
            <li key={r.id} className={`card rule${r.enabled ? '' : ' off'}`}>
              <button
                className="switch"
                role="switch"
                aria-checked={r.enabled}
                aria-label={r.enabled ? `Turn off: ${r.text}` : `Turn on: ${r.text}`}
                disabled={!mayChange}
                onClick={() => dispatch({ type: 'toggleRule', id: r.id })}
              />
              <p className="rule-text">
                {r.text}
                {r.enabled && filesAway(r.mail!.then.box) && <span className="sr-note"> Files new mail in your mailbox too.</span>}
              </p>
              <span className="rule-hits mono">{r.hits ? `${r.hits}×` : 'new'}</span>
              {mayChange && (
                <button className="icon-btn sm" aria-label={`Delete rule: ${r.text}`} title="Delete rule" onClick={() => dispatch({ type: 'removeRule', id: r.id })}>
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {mayChange ? (
        <form
          className="card sr-form"
          aria-label="New sorting rule"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <p className="sr-form-head">
            <strong>New sorting rule</strong> <span className="muted">Fill in what you know; all of it has to match.</span>
          </p>
          <div className="sr-grid">
            <Field label="From" hint="Addresses or whole domains, separated by commas">
              <input className="input" placeholder="linkedin.com, dana@acme.com" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="Subject has">
              <input className="input" placeholder="invoice, receipt" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </Field>
            <Field label="Mentions anywhere">
              <input className="input" placeholder="webinar" value={words} onChange={(e) => setWords(e.target.value)} />
            </Field>
            <Field label="Then">
              <select className="input" value={box} onChange={(e) => setBox(e.target.value as MailRuleBox | '')}>
                {BOX_CHOICES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="And put it in">
              <select className="input" value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    [{p.num}] {p.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="sr-foot">
            <p className="sr-preview" role="status">
              {'rule' in draft
                ? `${describeMailRule(draft.rule, state.ws.projects)} It matches ${matches.length} ${matches.length === 1 ? 'email' : 'emails'} you have now${waiting ? `, ${waiting} waiting in Triage` : ''}.`
                : typed || tried
                  ? draft.problem
                  : `For example: from linkedin.com → ${RULE_BOX_WORDS.archived}.`}
            </p>
            <button className="btn btn-primary" type="submit" disabled={!('rule' in draft)}>
              Save rule
            </button>
          </div>
        </form>
      ) : (
        <p className="muted sr-sub">Only an owner or admin can add or change sorting rules.</p>
      )}

      <h2 className="sr-title sr-written">Written rules</h2>
      <p className="muted sr-sub">Guidance in your own words. Timmy follows the ones you add when it reads each email.</p>
    </section>
  );
}
