/**
 * Sorting rules a person wrote, applied to mail as it arrives (the rules themselves are in src/state/mail-rules.ts,
 * which the screens share).
 *
 * A rule that files mail away (archive it, Read Through) is also a policy row: kind mail.modify, scope
 * {mailRule: <the rule's id>}, naming the owner or admin who saved it and when. That row is what lets the gateway
 * file mail in the mailbox without asking each time, and only mail whose newest message arrived after it was made:
 * saving a rule never rewrites what is already in Gmail or Outlook. Switching the rule off, or deleting it, switches
 * the row off. "Show it to me" files nothing, so it needs no row.
 */
import type { Rule, Thread } from '../../../src/data/types';
import type { State } from '../../../src/state/store';
import { checkMailRule, describeMailRule, filesAway, newestReceived, ruleSuggestion, rulesFor, sweepRule } from '../../../src/state/mail-rules';
import type { Tx } from '../db/pool';
import { audit, propose, type EffectRow, type Outcome } from '../gateway/gateway';
import { mutate, readState } from '../state/mutate';
import { newId } from '../lib/ids';
import type { Loaded } from '../state/docs';
import { BOX_WORDS, filingProposal } from './labels';
import { byPlainCode } from './sorting';

interface RulePolicy {
  id: string;
  since: Date;
}

/** The policy rows standing behind sorting rules that file mail away, by rule id. */
export async function rulePolicies(tx: Tx, workspaceId: string): Promise<Map<string, RulePolicy>> {
  const { rows } = await tx.query(
    `select id, scope->>'mailRule' as rule, created_at from policy where workspace_id = $1 and kind = 'mail.modify' and enabled and scope ? 'mailRule'`,
    [workspaceId],
  );
  return new Map(rows.map((r) => [r.rule as string, { id: r.id as string, since: new Date(r.created_at as string) }]));
}

/**
 * Checks the sorting rules a command left behind and keeps their policy rows in step. A rule that is new or changed
 * must be one `checkMailRule` accepts, as it would store it. Returns why not, or null.
 */
export async function settleRules(tx: Tx, loaded: Loaded, userId: string, after: State): Promise<string | null> {
  if (after.rules === loaded.state.rules) return null;
  const before = new Map(loaded.state.rules.map((r) => [r.id, r]));
  for (const r of after.rules) {
    const was = before.get(r.id);
    if (was && JSON.stringify(was) === JSON.stringify(r)) continue;
    if (typeof r.text !== 'string' || r.text.length > 300) return 'A rule is at most 300 characters.';
    if (r.mail === undefined) continue;
    // A rule saved before its project was closed stays as it was; only a rule being written now is held to today.
    if (was && JSON.stringify(was.mail) === JSON.stringify(r.mail)) continue;
    const checked = checkMailRule(r.mail, after.ws.projects);
    if ('problem' in checked) return checked.problem;
    if (JSON.stringify(checked.rule) !== JSON.stringify(r.mail)) return 'That rule isn’t in the form Timmy keeps rules in.';
  }
  const want = new Map(after.rules.filter((r) => r.enabled && r.mail && filesAway(r.mail.then.box)).map((r) => [r.id, r]));
  const have = await rulePolicies(tx, loaded.workspace.id);
  for (const [ruleId, p] of have) {
    if (want.has(ruleId)) continue;
    await tx.query('update policy set enabled = false, updated_at = now() where id = $1 and workspace_id = $2', [p.id, loaded.workspace.id]);
    await audit(tx, loaded.workspace.id, { actor: userId, action: 'rule.switched_off', detail: { rule: ruleId, policy: p.id } });
  }
  for (const [ruleId, r] of want) {
    if (have.has(ruleId)) continue;
    const id = newId('pol');
    await tx.query('insert into policy (id, workspace_id, kind, scope, enabled, label, created_by) values ($1, $2, $3, $4::jsonb, true, $5, $6)', [
      id,
      loaded.workspace.id,
      'mail.modify',
      JSON.stringify({ mailRule: ruleId }),
      `Sorting rule: ${r.text}. Mail that arrives from now on is filed in the mailbox too.`,
      userId,
    ]);
    await audit(tx, loaded.workspace.id, { actor: userId, action: 'rule.switched_on', detail: { rule: ruleId, policy: id } });
  }
  return null;
}

/**
 * Applies the rules to threads a batch of mail just touched. A thread goes in a rule's project when it is in none.
 * A thread fresh in Triage (only plain code has looked at it) is filed where its rule says, or, for "show it to me",
 * kept in Triage with the rule as Timmy's suggestion. With `mailbox`, filing reaches the mailbox for mail that
 * arrived after the rule was made.
 */
export async function applyMailRules(tx: Tx, loaded: Loaded, state: State, ids: Set<string>, opts: { mailbox: boolean }): Promise<State> {
  const rules = state.rules.filter((r) => r.enabled && r.mail);
  if (!rules.length) return state;
  const now = new Date();
  const changed = new Map<string, Thread>();
  const placed = new Map<string, string>();
  const hits = new Map<string, number>();
  const toFile: { thread: Thread; rule: Rule }[] = [];
  const hit = (r: Rule) => hits.set(r.id, (hits.get(r.id) ?? 0) + 1);
  for (const t of state.threads) {
    if (!ids.has(t.id)) continue;
    const { box, project } = rulesFor(rules, t);
    let cur = t;
    const pid = project?.mail!.then.project;
    if (project && pid && !t.project && state.ws.projects[pid]?.status === 'active') {
      cur = { ...cur, project: pid, history: [...(cur.history ?? []), { at: now, text: `Put in ${state.ws.projects[pid]!.name} by your rule: ${project.text}` }] };
      placed.set(t.id, pid);
      hit(project);
    }
    if (box && cur.box === 'inbox' && byPlainCode(cur.suggestion)) {
      const where = box.mail!.then.box!;
      if (!filesAway(where)) {
        cur = { ...cur, suggestion: ruleSuggestion(box, cur) };
      } else {
        cur = { ...cur, box: where, unread: false, suggestion: undefined, history: [...(cur.history ?? []), { at: now, text: `Timmy filed this ${BOX_WORDS[where]}, as your rule says: ${box.text}` }] };
        toFile.push({ thread: cur, rule: box });
      }
      if (project?.id !== box.id || !placed.has(t.id)) hit(box);
    }
    if (cur !== t) changed.set(t.id, cur);
  }
  if (!changed.size) return state;
  const moved = Object.values(state.ws.tasks).filter((x) => x.thread && !x.project && placed.has(x.thread));
  let next: State = {
    ...state,
    threads: state.threads.map((t) => changed.get(t.id) ?? t),
    rules: hits.size ? state.rules.map((r) => (hits.has(r.id) ? { ...r, hits: r.hits + hits.get(r.id)! } : r)) : state.rules,
    ws: moved.length ? { ...state.ws, tasks: { ...state.ws.tasks, ...Object.fromEntries(moved.map((x) => [x.id, { ...x, project: placed.get(x.thread!)! }])) } } : state.ws,
  };
  if (!opts.mailbox || !toFile.length) return next;
  const policies = await rulePolicies(tx, loaded.workspace.id);
  for (const { thread, rule } of toFile) {
    const policy = policies.get(rule.id);
    const last = newestReceived(thread);
    if (!policy || !last || new Date(last.at).getTime() < policy.since.getTime()) continue;
    const filing = filingProposal(thread, thread.box);
    if (!filing) continue;
    const p = await propose(tx, loaded, next, null, {
      ...filing,
      why: `Your sorting rule covers it: ${rule.text}`,
      idempotencyKey: `rule:${thread.id}:${last.id}`,
      source: 'rule',
      meta: { mailRule: rule.id },
    });
    if (p.outcome !== 'blocked') next = p.state;
  }
  return next;
}

/* ───────────── A rule Timmy wrote down from the chat ───────────── */

/** The id a rule saved from the chat gets: one per effect, so it can never be saved twice. */
const chatRuleId = (e: EffectRow) => `rule-${e.id}`;

/**
 * Saves the rule an effect carries, once an owner or admin has pressed Save on it. The rule is checked again as it is
 * saved (its project may have been closed since), sorts what is already here the way a rule saved in Rules does, and
 * gets its policy row in the same transaction, naming the person who saved it.
 */
export async function saveRuleEffect(e: EffectRow): Promise<Outcome> {
  const id = chatRuleId(e);
  return mutate<Outcome>(e.workspace_id, 'rule', async (tx, loaded) => {
    if (loaded.state.rules.some((r) => r.id === id)) return { result: { status: 'completed', result: { rule: id } } };
    const checked = checkMailRule((e.payload as { mail?: unknown }).mail, loaded.state.ws.projects);
    if ('problem' in checked) return { result: { status: 'failed', error: checked.problem } };
    const rule: Rule = { id, group: 'triage', text: describeMailRule(checked.rule, loaded.state.ws.projects), enabled: true, hits: 0, mail: checked.rule };
    const rules = [...loaded.state.rules, rule];
    const swept = sweepRule(loaded.state.threads, loaded.state.ws.tasks, rule, rules);
    const next: State = {
      ...loaded.state,
      rules,
      threads: swept.threads,
      ws: swept.tasks === loaded.state.ws.tasks ? loaded.state.ws : { ...loaded.state.ws, tasks: swept.tasks },
      activity: [{ id: newId('act'), at: new Date(), kind: 'triage' as const, text: `Saved a sorting rule from the chat: ${rule.text}` }, ...loaded.state.activity],
    };
    const bad = await settleRules(tx, loaded, e.approved_by ?? 'unknown', next);
    if (bad) return { result: { status: 'failed', error: bad } };
    return { state: next, result: { status: 'completed', result: { rule: id, suggested: swept.suggested, placed: swept.placed } } };
  });
}

/** Whether the rule an effect carries was saved, for an effect whose outcome is unknown. */
export async function ruleSaved(e: EffectRow): Promise<boolean> {
  return (await readState(e.workspace_id)).state.rules.some((r) => r.id === chatRuleId(e));
}
