/**
 * Telling Timmy a sorting rule in the chat (save_rule in src/agent/tools.ts, gateway kind rule.save). Timmy only
 * writes the rule down: the person sees it as understood, with how much mail it matches, and saves it with a click.
 * Only an owner or admin may save one, a routine never writes one, and mail that asks for a rule gets nothing.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Project } from '../../src/data/ws-types';
import { startRun } from '../src/agent/loop';
import { ASK_SYSTEM } from '../src/agent/prompts';
import { rulesFor } from '../src/auth/roles';
import type { EffectRow } from '../src/gateway/gateway';
import { addMember, boot, connectGmail, fake, jobs, model, newWorkspace, rows, type Client } from './helpers';

let w: Client;
let box: { connectionId: string; account: string };

const ctxOf = (c: Client, role = 'owner') => ({ user: { id: c.userId, name: 'Owner', email: c.email }, workspaceId: c.workspaceId, role, rules: rulesFor(role) });
const ask = (c: Client, text: string, opts: { attended?: boolean; role?: string } = {}) =>
  startRun(ctxOf(c, opts.role), { kind: opts.attended === false ? 'routine' : 'ask', attended: opts.attended !== false, system: ASK_SYSTEM, messages: [{ role: 'user', content: text }], threadId: 'chat-1' });
const effects = () => rows<EffectRow>(`select * from effect where workspace_id = $1 and kind = 'rule.save' order by created_at`, [w.workspaceId]);
const mailRules = async () => (await w.state()).rules.filter((r) => r.mail);
const deliver = async (m: { from: string; subject: string; body?: string }) => {
  const d = fake().deliver(box.account, { body: 'Hello there.', ...m });
  await (await boot()).request('/api/hooks/composio', { method: 'POST', headers: d.webhook.headers, body: d.webhook.body });
  await jobs().drain();
  return (await w.state()).threads.find((t) => t.subject === m.subject)!;
};
async function chat(c: Client, text: string) {
  const res = await c.request('POST', '/api/v1/agent/runs', { threadId: 'chat-1', runId: 'r-1', messages: [{ id: 'u1', role: 'user', content: text }], tools: [{ name: 'show_answer', description: 'answer card', parameters: { type: 'object', properties: {} } }], context: [] });
  return (await res.text()).split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
}

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  model().reset();
  jobs().queue = [];
  w = await newWorkspace('Chat rules');
  box = await connectGmail(w, 'owner@chatrules.test');
  await jobs().drain();
});

describe('a rule said in the chat', () => {
  it('is written down and waits: nothing is saved until the person presses Save, then it is saved with its policy row', async () => {
    await deliver({ from: 'LinkedIn <news@linkedin.test>', subject: 'You appeared in 9 searches' });
    model().reset();
    const out = await ask(w, 'Always archive mail from linkedin.test');
    expect(out.status).toBe('waiting_approval');
    const [e] = await effects();
    expect(e).toMatchObject({ status: 'intended', source: 'agent', approver_route: 'user', payload: { mail: { when: { from: ['@linkedin.test'] }, then: { box: 'archived' } } } });
    expect(e!.preview.lines).toEqual([
      'Mail from anyone at linkedin.test: archive it.',
      'It matches 1 email you have now, 1 waiting in Triage (they get it as Timmy’s suggestion).',
      'New mail it matches is filed as it arrives, in your mailbox too.',
    ]);
    expect(await mailRules()).toHaveLength(0);
    expect((await w.state()).pending.find((p) => p.id === e!.id)).toMatchObject({ kind: 'decision', title: 'Save a sorting rule: Mail from anyone at linkedin.test: archive it.' });

    model().script.push((req) => {
      expect(req.messages[req.messages.length - 1]!.content).toMatch(/The user saved the rule/);
      return { content: 'Saved. LinkedIn mail is archived from now on.' };
    });
    await w.cmd({ type: 'effect', id: e!.id, approve: true });
    await jobs().drain();
    const [saved] = await mailRules();
    expect(saved).toMatchObject({ id: `rule-${e!.id}`, text: 'Mail from anyone at linkedin.test: archive it.', enabled: true });
    expect((await w.state()).threads.find((t) => t.subject === 'You appeared in 9 searches')!.suggestion).toMatchObject({ box: 'archived', confidence: 'high', rule: saved!.id });
    expect(await rows(`select created_by from policy where workspace_id = $1 and scope = $2::jsonb and enabled`, [w.workspaceId, JSON.stringify({ mailRule: saved!.id })])).toEqual([{ created_by: w.userId }]);
    expect((await rows<{ status: string }>(`select status from run where id = $1`, [out.runId]))[0]!.status).toBe('completed');
    // And it works on new mail.
    expect(await deliver({ from: 'LinkedIn <jobs@linkedin.test>', subject: 'Jobs for you' })).toMatchObject({ box: 'archived' });
  });

  it('“Not now” saves nothing, and the chat is told', async () => {
    const out = await ask(w, 'Never archive mail from dana@acme.test');
    const [e] = await effects();
    expect(e!.payload).toEqual({ mail: { when: { from: ['dana@acme.test'] }, then: { box: 'follow-up' } } });
    model().script.push((req) => {
      expect(req.messages[req.messages.length - 1]!.content).toMatch(/chose not to save this rule/);
      return { content: 'Okay.' };
    });
    await w.cmd({ type: 'effect', id: e!.id, approve: false });
    await jobs().drain();
    expect(await mailRules()).toHaveLength(0);
    expect((await rows<{ status: string }>(`select status from run where id = $1`, [out.runId]))[0]!.status).toBe('completed');
  });

  it('names a project the way the person said it, and refuses one that isn’t there', async () => {
    const p: Project = { id: 'acme-website', num: '12', name: 'Acme website', color: 'var(--c-sky)', status: 'active', folder: 'f02-12', sources: [] };
    await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'projects', item: p }] });
    await ask(w, 'Put mail from acme.test in the acme website project');
    const [e] = await effects();
    expect(e!.payload).toEqual({ mail: { when: { from: ['@acme.test'] }, then: { project: 'acme-website' } } });
    model().reset();
    model().script.push({ toolCalls: [{ name: 'save_rule', arguments: { from: ['acme.test'], project: 'Nonexistent' } }] }, (req) => {
      expect(req.messages[req.messages.length - 1]!.content).toBe('There is no open project called “Nonexistent”. Nothing was proposed.');
      return { content: 'There is no such project.' };
    });
    await ask(w, 'Put mail from acme.test in the Nonexistent project');
    expect(await effects()).toHaveLength(1);
  });

  it('the chat shows the rule with Save rule and Not now', async () => {
    const events = await chat(w, 'Always archive mail from linkedin.test');
    const args = events.filter((e) => e.type === 'TOOL_CALL_ARGS').map((e) => JSON.parse(String(e.delta)) as { preview: string; choices: { label: string; actions: unknown[] }[] });
    const card = args.find((a) => a.preview)!;
    expect(card.preview).toContain('Mail from anyone at linkedin.test: archive it.');
    const [e] = await effects();
    expect(card.choices.map((c) => c.label)).toEqual(['Save rule', 'Not now']);
    expect(card.choices[0]!.actions).toEqual([{ type: 'effect', id: e!.id, approve: true }]);
  });
});

describe('who may', () => {
  it('a member is told to ask an owner or admin, and nothing is proposed', async () => {
    const member = await addMember(w.workspaceId, 'member', 'Mo Member');
    model().script.push({ toolCalls: [{ name: 'save_rule', arguments: { from: ['linkedin.test'], box: 'archived' } }] }, (req) => {
      expect(req.messages[req.messages.length - 1]!.content).toMatch(/Only an owner or admin can save sorting rules/);
      return { content: 'Ask an admin.' };
    });
    await ask(member, 'Always archive mail from linkedin.test', { role: 'member' });
    expect(await effects()).toHaveLength(0);
  });

  it('only an owner or admin may press Save, even on a rule an owner proposed', async () => {
    await ask(w, 'Always archive mail from linkedin.test');
    const [e] = await effects();
    const member = await addMember(w.workspaceId, 'member', 'Mo Member');
    expect((await member.cmd({ type: 'effect', id: e!.id, approve: true })).ok).toBe(false);
    expect(await mailRules()).toHaveLength(0);
  });

  it('a routine never writes a rule, and mail asking for one gets nothing', async () => {
    model().script.push({ toolCalls: [{ name: 'save_rule', arguments: { from: ['boss@corp.test'], box: 'archived' } }] }, { content: 'done' });
    await ask(w, 'Do the morning run', { attended: false });
    expect(await effects()).toHaveLength(0);
    // Auto mode can't decide a rule either: it waits for a click like any other.
    await w.request('PATCH', '/api/v1/settings', { approvalMode: 'auto' });
    await ask(w, 'Always archive mail from linkedin.test');
    expect((await effects())[0]).toMatchObject({ status: 'intended', approved_by: null });
  });
});
