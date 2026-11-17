/**
 * Safety properties:
 *   - no outside write without an approved effect record or a rule the user set;
 *   - no action runs twice;
 *   - unattended runs send only what a rule covers.
 */
import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { draftHash } from '../../src/live/hash';
import { executeEffect, propose, reconcileEffect, type EffectRow } from '../src/gateway/gateway';
import { rulesFor } from '../src/auth/roles';
import { fileStore, setFileStoreForTests } from '../src/files/store';
import type { MemoryStore } from '../src/testing/file-store';
import { mutate } from '../src/state/mutate';
import { addMember, boot, connectGmail, fake, jobs, newWorkspace, releaseHolds, rows, samples, sysPool, uploadFile, withWorkspace, type Client } from './helpers';

let w: Client;
let mailbox: { connectionId: string; account: string };

const sent = () => fake().sent(mailbox.account);
const effects = (c: Client = w) => rows<EffectRow>('select * from effect where workspace_id = $1 order by created_at', [c.workspaceId]);
const audit = (c: Client = w) => rows<{ action: string; actor: string; effect_id: string | null; detail: Record<string, unknown> }>('select action, actor, effect_id, detail from audit_log where workspace_id = $1 order by id', [c.workspaceId]);
const send = (c: Client, to = 'mail:dana@client.test', subject = 'Quote', body = 'Here is the quote.') => c.cmd({ type: 'sendNew', draft: { to: [to], subject, body } });

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  w = await newWorkspace('Gate');
  mailbox = await connectGmail(w, 'owner@gate.test');
  await jobs().drain();
});

describe('a person presses Send', () => {
  it('nothing leaves before the hold ends, then it is sent exactly once', async () => {
    const out = await send(w);
    expect(out.ok).toBe(true);
    expect(out.holding?.seconds).toBe(30);
    const [e] = await effects();
    expect(e).toMatchObject({ kind: 'email.send', status: 'approved', approved_by: w.userId, approved_via: 'click', source: 'user' });
    expect(new Date(e!.hold_until!).getTime()).toBeGreaterThan(Date.now() + 20_000);

    // The job fires early (or twice, or on two workers at once): still nothing goes out during the hold.
    await jobs().drain();
    await Promise.all([executeEffect(w.workspaceId, e!.id), executeEffect(w.workspaceId, e!.id)]);
    expect(sent()).toHaveLength(0);
    expect((await w.state()).pending.map((p) => p.status)).toEqual(['holding']);

    expect(await releaseHolds(w)).toBe(1);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ to: ['dana@client.test'], subject: 'Quote', body: 'Here is the quote.' });

    // Running it again, any number of times, sends nothing more.
    await Promise.all([executeEffect(w.workspaceId, e!.id), executeEffect(w.workspaceId, e!.id), executeEffect(w.workspaceId, e!.id)]);
    await releaseHolds(w);
    await jobs().drain();
    expect(sent()).toHaveLength(1);
    const [done] = await effects();
    expect(done).toMatchObject({ status: 'completed', attempt: 1 });
    expect(done!.external_id).toBe(sent()[0]!.id);
    expect((await w.state()).pending).toEqual([]);
  });

  it('two workers racing for the same effect: one wins', async () => {
    await send(w);
    const [e] = await effects();
    await sysPool.query('update effect set hold_until = now() where id = $1', [e!.id]);
    const results = await Promise.all(Array.from({ length: 8 }, () => executeEffect(w.workspaceId, e!.id)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(sent()).toHaveLength(1);
  });

  it('the same command sent twice makes one effect and one email', async () => {
    const action = { type: 'sendNew', draft: { to: ['mail:dana@client.test'], subject: 'Once', body: 'Only once.' } };
    const first = await w.cmd(action, 'retry-me');
    const again = await w.cmd(action, 'retry-me');
    expect(again.rev).toBe(first.rev);
    expect(await effects()).toHaveLength(1);
    await releaseHolds(w);
    expect(sent()).toHaveLength(1);
    expect((await w.state()).threads.filter((t) => t.subject === 'Once')).toHaveLength(1);
  });

  it('Undo during the hold cancels it: nothing is sent and the screen goes back', async () => {
    const before = await w.state();
    const out = await send(w, 'mail:dana@client.test', 'Undo me');
    expect((await w.state()).threads.some((t) => t.subject === 'Undo me')).toBe(true);
    const undone = await w.cmd({ type: 'undo', command: out.id });
    expect(undone.ok).toBe(true);
    const [e] = await effects();
    expect(e!.status).toBe('cancelled');
    await sysPool.query('update effect set hold_until = now() where id = $1', [e!.id]).catch(() => {});
    await releaseHolds(w);
    await executeEffect(w.workspaceId, e!.id);
    expect(sent()).toHaveLength(0);
    const after = await w.state();
    expect(after.threads.map((t) => t.id)).toEqual(before.threads.map((t) => t.id));
    expect(after.pending).toEqual([]);
    expect((await audit()).map((x) => x.action)).toContain('effect.cancelled');
  });

  it('Undo after it left says so, and changes nothing', async () => {
    const out = await send(w, 'mail:dana@client.test', 'Too late');
    await releaseHolds(w);
    const undone = await w.cmd({ type: 'undo', command: out.id });
    expect(undone.ok).toBe(false);
    expect(undone.error).toMatch(/already sent/);
    expect(sent()).toHaveLength(1);
    expect((await w.state()).threads.some((t) => t.subject === 'Too late')).toBe(true);
  });

  it('the kill switch stops an approved send from leaving', async () => {
    await send(w);
    await w.request('PATCH', '/api/v1/settings', { killSwitch: true });
    await releaseHolds(w);
    expect(sent()).toHaveLength(0);
    expect((await send(w, 'mail:x@y.test', 'Blocked')).ok).toBe(false);
    await w.request('PATCH', '/api/v1/settings', { killSwitch: false });
    await releaseHolds(w);
    expect(sent()).toHaveLength(1);
  });

  it('without a connected mailbox nothing is recorded as sent', async () => {
    const lone = await newWorkspace('NoMail');
    const out = await send(lone);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Connect Gmail or Outlook first/);
    expect(await effects(lone)).toHaveLength(0);
    expect((await lone.state()).threads).toHaveLength(0);
  });

  it('a reply on a synced thread goes out as a reply in that thread', async () => {
    await w.post('/api/test/fake', { op: 'deliver', message: { from: 'Dana <dana@client.test>', subject: 'Pricing?', body: 'What is the price?' } });
    const thread = (await w.state()).threads.find((t) => t.subject === 'Pricing?')!;
    const out = await w.cmd({ type: 'reply', id: thread.id, body: 'It is $58 per seat.' });
    expect(out.ok).toBe(true);
    // Replying also files the thread in the mailbox, which is its own record; this test is about the reply.
    const e = (await effects()).find((x) => x.kind === 'email.reply');
    expect(e).toMatchObject({ kind: 'email.reply', target: 'dana@client.test' });
    await releaseHolds(w);
    const [m] = sent();
    expect(m).toMatchObject({ threadId: thread.ext!.threadKey, to: ['dana@client.test'], body: 'It is $58 per seat.' });
    // The sent copy carries the provider's id, so sync recognises it instead of adding a second one.
    const after = (await w.state()).threads.find((t) => t.id === thread.id)!;
    expect(after.messages.map((x) => x.id)).toContain(m!.id);
    await w.post('/api/test/fake', { op: 'deliver', message: { from: 'Dana <dana@client.test>', subject: 'Re: Pricing?', body: 'Great, thanks.', threadId: thread.ext!.threadKey } });
    const synced = (await w.state()).threads.find((t) => t.id === thread.id)!;
    expect(synced.messages.filter((x) => x.from === 'me')).toHaveLength(1);
    expect(synced.messages).toHaveLength(3);
    expect(synced.box).toBe('inbox');
  });
});

describe('when the provider fails', () => {
  it('a clean refusal is recorded as failed, and nothing was sent', async () => {
    await send(w, 'mail:dana@client.test', 'Refused');
    fake().failNext.set('GMAIL_SEND_EMAIL', 'error');
    await releaseHolds(w);
    const [e] = await effects();
    expect(e).toMatchObject({ status: 'failed' });
    expect(sent()).toHaveLength(0);
    const t = (await w.state()).threads.find((x) => x.subject === 'Refused')!;
    expect(t.history!.some((h) => /Not sent/.test(h.text))).toBe(true);
    // A failed effect is final: it can never be run again, and its hold can no longer be touched.
    await expect(sysPool.query('update effect set hold_until = now() where id = $1', [e!.id])).rejects.toThrow(/hold cannot change/);
    expect(await executeEffect(w.workspaceId, e!.id)).toBeNull();
    expect(sent()).toHaveLength(0);
  });

  it('a timeout after the message left is found in Sent and never re-sent', async () => {
    await send(w, 'mail:dana@client.test', 'Lost answer', 'Body that did go out.');
    fake().failNext.set('GMAIL_SEND_EMAIL', 'sent-then-timeout');
    await releaseHolds(w);
    let [e] = await effects();
    expect(e!.status).toBe('uncertain');
    expect(sent()).toHaveLength(1);
    expect(await executeEffect(w.workspaceId, e!.id)).toBeNull();
    await reconcileEffect(w.workspaceId, e!.id);
    [e] = await effects();
    expect(e).toMatchObject({ status: 'completed', external_id: sent()[0]!.id });
    expect(sent()).toHaveLength(1);
  });

  it('a timeout with no trace in Sent stays unconfirmed: it is never called "not sent", and never sent again', async () => {
    await send(w, 'mail:dana@client.test', 'Never left');
    fake().failNext.set('GMAIL_SEND_EMAIL', 'timeout');
    await releaseHolds(w);
    let [e] = await effects();
    expect(e!.status).toBe('uncertain');
    // Not finding it in Sent proves nothing (Sent can lag, the copy can differ), so Timmy does not claim it was not sent:
    // that claim would invite a second send. It stays unconfirmed for a person to check.
    await reconcileEffect(w.workspaceId, e!.id);
    await sysPool.query(`update effect set executing_at = now() - interval '5 minutes' where id = $1`, [e!.id]);
    await reconcileEffect(w.workspaceId, e!.id);
    [e] = await effects();
    expect(e!.status).toBe('uncertain');
    expect(await executeEffect(w.workspaceId, e!.id)).toBeNull();
    await releaseHolds(w);
    expect(sent()).toHaveLength(0);
    const t = (await w.state()).threads.find((x) => x.subject === 'Never left')!;
    expect(t.history!.some((h) => /Check your Sent folder/.test(h.text))).toBe(true);
    // While it is unconfirmed, the same thread cannot be sent again by pressing Send.
    const again = await w.cmd({ type: 'reply', id: t.id, body: 'Second try' });
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/already has an email waiting/);
  });

  it('the copy in Sent is recognised even when its line endings and spacing differ', async () => {
    await send(w, 'mail:dana@client.test', 'Spacing', 'Hi Dana,\n\nHere is the  quote.\n\nBest');
    fake().failNext.set('GMAIL_SEND_EMAIL', 'sent-then-timeout');
    await releaseHolds(w);
    const box = fake().accounts.get(mailbox.account)!;
    const copy = box.messages.find((m) => m.subject === 'Spacing')!;
    copy.body = 'Hi Dana,\r\n\r\nHere is the quote.\r\n\r\nBest\r\n';
    const [e] = await effects();
    await reconcileEffect(w.workspaceId, e!.id);
    expect((await effects())[0]).toMatchObject({ status: 'completed', external_id: copy.id });
    expect(sent()).toHaveLength(1);
  });
});

describe('the database enforces the order', () => {
  it('an effect cannot skip approval, change after approval, or be created already running', async () => {
    await send(w);
    const [e] = await effects();
    const q = (sql: string, p: unknown[] = []) => sysPool.query(sql, p);
    await expect(q(`insert into effect (id, workspace_id, kind, payload, payload_hash, idempotency_key, status, source, requested_by) values ('eff_x1', $1, 'email.send', '{}', 'h', 'k-x1', 'executing', 'agent', 'agent')`, [w.workspaceId])).rejects.toThrow(/cannot be created as executing/);
    await expect(q(`insert into effect (id, workspace_id, kind, payload, payload_hash, idempotency_key, status, source, requested_by) values ('eff_x2', $1, 'email.send', '{}', 'h', 'k-x2', 'approved', 'agent', 'agent')`, [w.workspaceId])).rejects.toThrow(/approved without an approver/);
    await expect(q(`insert into effect (id, workspace_id, kind, payload, payload_hash, idempotency_key, status, source, requested_by, approved_by, approved_via) values ('eff_x3', $1, 'email.send', '{}', 'h', 'k-x3', 'approved', 'rule', 'system', 'rule:none', 'rule')`, [w.workspaceId])).rejects.toThrow(/rule approval without a rule/);
    await q(`insert into effect (id, workspace_id, kind, payload, payload_hash, idempotency_key, status, source, requested_by) values ('eff_x4', $1, 'email.send', '{}', 'h', 'k-x4', 'intended', 'agent', 'agent')`, [w.workspaceId]);
    await expect(q(`update effect set status = 'executing' where id = 'eff_x4'`)).rejects.toThrow(/intended cannot become executing/);
    await expect(q(`update effect set status = 'completed' where id = 'eff_x4'`)).rejects.toThrow(/intended cannot become completed/);
    await expect(q(`update effect set status = 'approved' where id = 'eff_x4'`)).rejects.toThrow(/approved without an approver/);
    await expect(q(`update effect set payload = '{"to":["evil@x.test"]}'::jsonb where id = $1`, [e!.id])).rejects.toThrow(/cannot change/);
    await expect(q(`update effect set approved_by = 'someone-else' where id = $1`, [e!.id])).rejects.toThrow(/approval cannot change/);
    await expect(q(`insert into effect (id, workspace_id, kind, payload, payload_hash, idempotency_key, status, source, requested_by) values ('eff_x5', $1, 'email.send', '{}', 'h', $2, 'intended', 'agent', 'agent')`, [w.workspaceId, e!.idempotency_key])).rejects.toThrow(/duplicate key/);
    await releaseHolds(w);
    await expect(q(`update effect set status = 'approved' where id = $1`, [e!.id])).rejects.toThrow(/completed cannot become approved/);
    await expect(q(`update effect set status = 'executing' where id = $1`, [e!.id])).rejects.toThrow(/completed cannot become executing/);
  });

  it('the audit log records each step and cannot be edited or erased, even by the owner', async () => {
    const out = await send(w);
    await releaseHolds(w);
    const [e] = await effects();
    const log = (await audit()).filter((x) => x.effect_id === e!.id);
    expect(log.map((x) => x.action)).toEqual(['effect.proposed', 'effect.approved', 'effect.executing', 'effect.completed']);
    expect(log[1]).toMatchObject({ actor: w.userId, detail: { via: 'click' } });
    expect(out.ok).toBe(true);
    await expect(sysPool.query('update audit_log set actor = $1 where workspace_id = $2', ['nobody', w.workspaceId])).rejects.toThrow(/append-only/);
    await expect(sysPool.query('delete from audit_log where workspace_id = $1', [w.workspaceId])).rejects.toThrow(/append-only/);
    await expect(sysPool.query('truncate audit_log')).rejects.toThrow(/append-only/);
    await expect(withWorkspace({ workspaceId: w.workspaceId }, (tx) => tx.query('delete from audit_log'))).rejects.toThrow(/permission denied|append-only/);
    await expect(withWorkspace({ workspaceId: w.workspaceId }, (tx) => tx.query('delete from effect'))).rejects.toThrow(/permission denied/);
    const api = await w.json<{ entries: { action: string }[] }>('GET', '/api/v1/audit');
    expect(api.entries.map((x) => x.action)).toContain('effect.completed');
  });
});

describe('who may approve', () => {
  const proposal = (key: string, extra: Record<string, unknown> = {}) => ({
    kind: 'email.send',
    payload: { connectionId: mailbox.connectionId, to: ['lead@client.test'], cc: [], subject: 'Hello', body: 'Hi there' },
    preview: { to: ['lead@client.test'], subject: 'Hello', body: 'Hi there' },
    title: 'Send “Hello”',
    why: 'test',
    target: 'lead@client.test',
    idempotencyKey: key,
    ...extra,
  });
  const actorOf = (c: Client, role: string) => ({ userId: c.userId, name: role, role, rules: rulesFor(role) });
  const run = <T>(fn: Parameters<typeof mutate<T>>[2]) => mutate<T>(w.workspaceId, 'test', fn);

  it('what the agent proposes waits for a person, and a decline means it never runs', async () => {
    const p = await run(async (tx, l) => {
      const r = await propose(tx, l, l.state, actorOf(w, 'owner'), { ...proposal('agent-1'), source: 'agent' });
      return { state: r.state, result: r };
    });
    expect(p.outcome).toBe('waiting');
    expect(p.effect).toMatchObject({ status: 'intended', approved_by: null });
    await sysPool.query('update effect set hold_until = now() where id = $1', [p.effect!.id]);
    expect(await executeEffect(w.workspaceId, p.effect!.id)).toBeNull();
    await releaseHolds(w);
    expect(sent()).toHaveLength(0);
    expect((await w.state()).pending).toMatchObject([{ id: p.effect!.id, status: 'waiting', waitingOn: 'you' }]);

    expect((await w.cmd({ type: 'effect', id: p.effect!.id, approve: false })).ok).toBe(true);
    await releaseHolds(w);
    expect(sent()).toHaveLength(0);
    expect((await effects())[0]!.status).toBe('declined');
    // Declined is final, and the answer says so instead of claiming it was approved.
    const late = await w.cmd({ type: 'effect', id: p.effect!.id, approve: true });
    expect(late.ok).toBe(false);
    expect(late.error).toMatch(/already turned down/);
    await releaseHolds(w);
    expect(sent()).toHaveLength(0);
    expect((await effects())[0]!.status).toBe('declined');
  });

  it('an approval puts it on hold, then it is sent once', async () => {
    const p = await run(async (tx, l) => {
      const r = await propose(tx, l, l.state, actorOf(w, 'owner'), { ...proposal('agent-2'), source: 'agent' });
      return { state: r.state, result: r };
    });
    expect((await w.cmd({ type: 'effect', id: p.effect!.id, approve: true })).ok).toBe(true);
    expect((await w.cmd({ type: 'effect', id: p.effect!.id, approve: true })).error).toMatch(/already approved/);
    expect(sent()).toHaveLength(0);
    expect((await w.state()).pending[0]).toMatchObject({ status: 'holding' });
    await releaseHolds(w);
    await releaseHolds(w);
    expect(sent()).toHaveLength(1);
    expect((await audit()).filter((x) => x.action === 'effect.approved')).toHaveLength(1);
  });

  it('Auto mode cannot approve a send, whatever the judge says', async () => {
    await w.request('PATCH', '/api/v1/settings', { approvalMode: 'auto' });
    const p = await run(async (tx, l) => {
      const r = await propose(tx, l, l.state, actorOf(w, 'owner'), { ...proposal('agent-auto'), source: 'agent', auto: { verdict: 'approve', reason: 'the judge was fooled' } });
      return { state: r.state, result: r };
    });
    expect(p.outcome).toBe('waiting');
    expect(p.effect!.status).toBe('intended');
    await releaseHolds(w);
    expect(sent()).toHaveLength(0);
  });

  it('a delegate’s send goes to the exec; the delegate cannot approve it, the owner can', async () => {
    const ea = await addMember(w.workspaceId, 'assistant', 'Jess EA');
    const out = await send(ea, 'mail:external@client.test', 'From the EA');
    expect(out.ok).toBe(true);
    const [e] = await effects();
    expect(e).toMatchObject({ status: 'intended', approver_route: 'exec', requested_by: ea.userId, approved_by: null });
    await releaseHolds(w);
    expect(sent()).toHaveLength(0);
    // The draft is still a draft for everyone until the exec decides.
    expect((await w.state()).threads.some((t) => t.subject === 'From the EA')).toBe(false);
    expect((await w.state()).pending[0]).toMatchObject({ waitingOn: 'exec', status: 'waiting' });
    const tried = await ea.cmd({ type: 'effect', id: e!.id, approve: true });
    expect(tried.ok).toBe(false);
    expect(tried.error).toMatch(/isn’t yours to approve/);
    await releaseHolds(w);
    expect(sent()).toHaveLength(0);
    expect((await w.cmd({ type: 'effect', id: e!.id, approve: true })).ok).toBe(true);
    await releaseHolds(w);
    expect(sent()).toHaveLength(1);
    const log = (await audit()).filter((x) => x.effect_id === e!.id);
    expect(log.find((x) => x.action === 'effect.proposed')!.actor).toBe(ea.userId);
    expect(log.find((x) => x.action === 'effect.approved')).toMatchObject({ actor: w.userId, detail: { requestedBy: ea.userId } });
  });

  it('a member cannot approve another member’s request; RevOps and clients cannot approve sends', async () => {
    const m1 = await addMember(w.workspaceId, 'member', 'Member One');
    const m2 = await addMember(w.workspaceId, 'member', 'Member Two');
    const revops = await addMember(w.workspaceId, 'revops');
    const p = await run(async (tx, l) => {
      const r = await propose(tx, l, l.state, actorOf(m1, 'member'), { ...proposal('agent-m1'), source: 'agent' });
      return { state: r.state, result: r };
    });
    // The mailbox is the owner's. Since the security audit, a send from it by anyone else is the owner's to approve,
    // so the member who asked can't approve it either (see audit.test.ts for a mailbox the member connected).
    expect(p.effect).toMatchObject({ approver_route: 'exec', on_behalf_of: w.userId });
    for (const other of [m1, m2, revops]) expect((await other.cmd({ type: 'effect', id: p.effect!.id, approve: true })).ok).toBe(false);
    await releaseHolds(w);
    expect(sent()).toHaveLength(0);
    expect((await w.cmd({ type: 'effect', id: p.effect!.id, approve: true })).ok).toBe(true);
    await releaseHolds(w);
    expect(sent()).toHaveLength(1);
  });

  it('a CRM change asked for by a member waits for RevOps: the member cannot approve it, RevOps can', async () => {
    const member = await addMember(w.workspaceId, 'member', 'Sales Rep');
    const revops = await addMember(w.workspaceId, 'revops', 'Rev Ops');
    expect((await w.cmd({ type: 'conn', op: { op: 'crm', patch: { approver: 'revops' } } })).ok).toBe(true);
    const crm = (key: string) => ({ kind: 'crm.write', payload: { record: 'deal-1', set: { stage: 'Won' } }, preview: { lines: ['Deal “Acme”: stage → Won'] }, title: 'Move Acme to Won', why: 'test', target: 'deal-1', idempotencyKey: key, source: 'agent' as const });
    const p = await run(async (tx, l) => {
      const r = await propose(tx, l, l.state, actorOf(member, 'member'), crm('crm-1'));
      return { state: r.state, result: r };
    });
    expect(p.outcome).toBe('waiting');
    expect(p.effect).toMatchObject({ status: 'intended', approver_route: 'revops', requested_by: member.userId, approved_by: null });
    expect((await revops.state()).pending[0]).toMatchObject({ id: p.effect!.id, kind: 'crm', waitingOn: 'revops', status: 'waiting' });

    // The person who asked, and a colleague with no CRM say, are both refused; the record does not move.
    const assistant = await addMember(w.workspaceId, 'assistant', 'Jess EA');
    for (const other of [member, assistant]) {
      const tried = await other.cmd({ type: 'effect', id: p.effect!.id, approve: true });
      expect(tried.ok).toBe(false);
      expect(tried.error).toMatch(/isn’t yours to approve/);
    }
    expect((await effects())[0]).toMatchObject({ status: 'intended', approved_by: null });

    // RevOps cannot change the workspace's work, but this decision is theirs.
    expect((await revops.cmd({ type: 'ws', ops: [{ op: 'put', col: 'notes', item: { id: 'n1', text: 'x' } }] })).ok).toBe(false);
    expect((await revops.cmd({ type: 'effect', id: p.effect!.id, approve: true })).ok).toBe(true);
    expect((await effects())[0]).toMatchObject({ approved_by: revops.userId });
    expect((await audit()).find((x) => x.action === 'effect.approved')).toMatchObject({ actor: revops.userId, effect_id: p.effect!.id });
  });

  it('an action can be approved or declined by its id over the API, with the same checks and the same answer on a retry', async () => {
    const member = await addMember(w.workspaceId, 'member', 'Member One');
    const mk = (key: string) =>
      run(async (tx, l) => {
        const r = await propose(tx, l, l.state, actorOf(w, 'owner'), { ...proposal(key), source: 'agent' });
        return { state: r.state, result: r };
      });
    const first = await mk('api-approve');
    // Someone it doesn't belong to is refused, and so is a request from another site.
    expect((await member.post(`/api/v1/actions/${first.effect!.id}/approve`)).status).toBe(409);
    expect((await w.request('POST', `/api/v1/actions/${first.effect!.id}/approve`, {}, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await effects())[0]!.status).toBe('intended');

    const ok = await w.post(`/api/v1/actions/${first.effect!.id}/approve`);
    expect(ok.status).toBe(200);
    // The retry is answered from the record: it does not approve twice or send twice.
    expect((await w.post(`/api/v1/actions/${first.effect!.id}/approve`)).status).toBe(200);
    expect((await audit()).filter((x) => x.action === 'effect.approved')).toHaveLength(1);
    await releaseHolds(w);
    await releaseHolds(w);
    expect(sent()).toHaveLength(1);

    const second = await mk('api-decline');
    expect((await w.post(`/api/v1/actions/${second.effect!.id}/decline`)).status).toBe(200);
    expect((await effects()).find((e) => e.id === second.effect!.id)!.status).toBe('declined');
    await releaseHolds(w);
    expect(sent()).toHaveLength(1);
    // An id that isn't an action in this workspace changes nothing.
    expect((await w.post('/api/v1/actions/eff_nope/approve')).status).toBe(409);
    const other = await newWorkspace('Elsewhere');
    const third = await mk('api-cross');
    expect((await other.post(`/api/v1/actions/${third.effect!.id}/approve`)).status).toBe(409);
    expect((await effects()).find((e) => e.id === third.effect!.id)!.status).toBe('intended');
  });

  it('never-list actions are refused outright and leave no effect to approve', async () => {
    for (const [i, bad] of [{ kind: 'money.transfer' }, { kind: 'sign.document' }, { kind: 'account.delete' }, { kind: 'email.send', payload: { tool: 'STRIPE_CREATE_PAYOUT' } }, { kind: 'shell.exec' }].entries()) {
      const p = await run(async (tx, l) => {
        const r = await propose(tx, l, l.state, actorOf(w, 'owner'), { ...proposal(`never-${i}`), ...bad, source: 'user' } as never);
        return { state: r.state, result: r };
      });
      expect(p.outcome).toBe('blocked');
      expect(p.effect).toBeNull();
    }
    expect(await effects()).toHaveLength(0);
    expect((await audit()).filter((x) => x.action === 'effect.blocked')).toHaveLength(5);
  });
});

describe('unattended runs', () => {
  const proposal = (key: string, meta?: Record<string, unknown>) => ({
    kind: 'email.send',
    payload: { connectionId: mailbox.connectionId, to: ['lead@client.test'], cc: [], subject: 'Thanks for your interest', body: 'Auto reply' },
    preview: { to: ['lead@client.test'], subject: 'Thanks for your interest', body: 'Auto reply' },
    title: 'Auto-reply',
    why: 'A routine',
    target: 'lead@client.test',
    idempotencyKey: key,
    source: 'routine' as const,
    meta,
  });
  const unattended = (key: string, meta?: Record<string, unknown>) =>
    mutate(w.workspaceId, 'test', async (tx, l) => {
      const r = await propose(tx, l, l.state, null, proposal(key, meta));
      return { state: r.state, result: r };
    });

  it('with no rule, an unattended send waits for a person', async () => {
    const p = await unattended('routine-1', { reason: 'speed_to_lead', form: 'form-1' });
    expect(p.outcome).toBe('waiting');
    await releaseHolds(w);
    expect(sent()).toHaveLength(0);
  });

  it('sends only what an enabled rule covers', async () => {
    await withWorkspace({ workspaceId: w.workspaceId }, (tx) => tx.query(`insert into policy (id, workspace_id, kind, scope, label, created_by) values ('pol_1', $1, 'email.send', '{"reason":"speed_to_lead","form":"form-1"}', 'Auto-reply to the demo form', $2)`, [w.workspaceId, w.userId]));
    const other = await unattended('routine-other-form', { reason: 'speed_to_lead', form: 'form-2' });
    const none = await unattended('routine-no-meta');
    expect([other.outcome, none.outcome]).toEqual(['waiting', 'waiting']);
    const covered = await unattended('routine-covered', { reason: 'speed_to_lead', form: 'form-1' });
    expect(covered.outcome).toBe('approved');
    expect(covered.effect).toMatchObject({ approved_via: 'rule', policy_id: 'pol_1', approved_by: 'rule:pol_1' });
    await releaseHolds(w);
    expect(sent()).toHaveLength(1);

    // Switching the rule off stops the next one.
    await withWorkspace({ workspaceId: w.workspaceId }, (tx) => tx.query(`update policy set enabled = false where id = 'pol_1'`));
    expect((await unattended('routine-after-off', { reason: 'speed_to_lead', form: 'form-1' })).outcome).toBe('waiting');
    await releaseHolds(w);
    expect(sent()).toHaveLength(1);
  });

  it('a rule from another workspace covers nothing here', async () => {
    const other = await newWorkspace('Other');
    await withWorkspace({ workspaceId: other.workspaceId }, (tx) => tx.query(`insert into policy (id, workspace_id, kind, scope, label, created_by) values ($3, $1, 'email.send', '{"reason":"speed_to_lead","form":"form-1"}', 'theirs', $2)`, [other.workspaceId, other.userId, `pol_other_${other.workspaceId.slice(0, 6)}`]));
    expect((await unattended('routine-foreign-rule', { reason: 'speed_to_lead', form: 'form-1' })).outcome).toBe('waiting');
  });
});

describe('the demo’s pretend sends are refused on a real workspace', () => {
  it('outbound sends, launches and fake connections fail closed', async () => {
    const lead = { id: 'lead-x', first: 'Lee', last: 'Lead', email: 'lee@lead.test', company: 'LeadCo', title: 'VP', status: 'new', source: 'csv', fit: 50, added: new Date() };
    expect((await w.cmd({ type: 'out', op: { op: 'addLead', lead } })).ok).toBe(true);
    // A cold email is accepted but sends nothing (it opens in the person's mail app; see coldmail.test.ts). It leaves no trace here either.
    expect((await w.cmd({ type: 'out', op: { op: 'send', lead: 'lead-x', channel: 'email', subject: 'Hi', body: 'Cold' } })).ok).toBe(true);
    for (const op of [{ op: 'send', lead: 'lead-x', channel: 'sms', body: 'Text' }, { op: 'launch', id: 'camp-1' }, { op: 'channel', id: 'sms', patch: { connected: true } }, { op: 'mailbox', mailbox: { id: 'mb-x', address: 'x@y.test' } }, { op: 'book', lead: 'lead-x', start: new Date(), end: new Date() }]) {
      const out = await w.cmd({ type: 'out', op });
      expect(out.ok, JSON.stringify(op)).toBe(false);
    }
    for (const action of [{ type: 'simulateReply', id: 'x' }, { type: 'reset' }, { type: 'release', id: 'x', approve: true }, { type: 'conn', op: { op: 'connect', id: 'twilio' } }, { type: 'conn', op: { op: 'enrich', ids: ['lead-x'] } }, { type: 'makeDraft', id: 'no-such-thread' }]) {
      expect((await w.cmd(action)).ok, JSON.stringify(action)).toBe(false);
    }
    const s = await w.state();
    expect(s.out.messages).toEqual([]);
    expect(await effects()).toHaveLength(0);
    expect(sent()).toHaveLength(0);
  });
});

/**
 * Files sent with an email. The file is uploaded first; the email's effect record names it by asset, name,
 * type, size and the hash of its bytes, and that is what the approver sees and what goes out.
 */
describe('an email with a file attached', () => {
  const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  const attach = async (c: Client, name = 'Quote.pdf', bytes = samples.pdf('Quote: $58 per seat.'), type = 'application/pdf') => {
    const up = await uploadFile(c, { purpose: 'attachment', type, bytes, name });
    expect(up.status).toBe(200);
    return { file: { id: up.assetId, name, type, size: bytes.length }, bytes, key: `${c.workspaceId}/${up.assetId}` };
  };
  const sendWith = (c: Client, files: unknown[], subject = 'Quote attached') => c.cmd({ type: 'sendNew', draft: { to: ['mail:dana@client.test'], subject, body: 'The quote is attached.', files } });
  // The stand-in keeps every call it ever got; each test looks only at the ones made since it began.
  let mark = 0;
  beforeEach(() => {
    mark = fake().calls.length;
  });
  const calls = (slug: RegExp) => fake().calls.slice(mark).filter((c) => slug.test(c.slug));
  const sendCalls = () => calls(/^GMAIL_(SEND_EMAIL|REPLY_TO_THREAD)$/);
  const handovers = () => calls(/^FILES_UPLOAD$/);
  const store = () => fileStore() as MemoryStore;

  it('waits out the hold, then goes out once, carrying exactly the approved file', async () => {
    const a = await attach(w);
    const out = await sendWith(w, [a.file]);
    expect(out.ok).toBe(true);
    expect(out.holding?.seconds).toBe(30);
    const [e] = await effects();
    // What was approved: the asset, its name, type and size, and the hash its bytes must have.
    expect(e).toMatchObject({ kind: 'email.send', status: 'approved', approved_by: w.userId });
    expect(e!.payload.attachments).toEqual([{ assetId: a.file.id, name: 'Quote.pdf', type: 'application/pdf', size: a.bytes.length, sha256: hash(a.bytes) }]);
    // What the approver is shown, in the queue and on the thread.
    expect((await w.state()).pending[0]!.preview.attachments).toEqual([{ name: 'Quote.pdf', type: 'application/pdf', size: a.bytes.length }]);
    expect((await w.state()).threads.find((t) => t.subject === 'Quote attached')!.messages[0]!.files).toEqual([a.file]);

    // Nothing leaves during the hold, however often the job fires. Not the email, and not the file either.
    await jobs().drain();
    await Promise.all([executeEffect(w.workspaceId, e!.id), executeEffect(w.workspaceId, e!.id)]);
    expect(sent()).toHaveLength(0);
    expect(handovers()).toHaveLength(0);

    expect(await releaseHolds(w)).toBe(1);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ to: ['dana@client.test'], subject: 'Quote attached', body: 'The quote is attached.' });
    expect(sent()[0]!.attachments).toEqual([{ name: 'Quote.pdf', mimetype: 'application/pdf', size: a.bytes.length, sha256: hash(a.bytes) }]);
    // Handed over the way Composio's client does it: staged for the tool that sends it, then passed by reference.
    expect(handovers().map((c) => c.args)).toEqual([{ toolSlug: 'GMAIL_SEND_EMAIL', toolkit: 'gmail', name: 'Quote.pdf', type: 'application/pdf', size: a.bytes.length }]);
    const arg = sendCalls()[0]!.args.attachment as { name: string; mimetype: string; s3key: string }[];
    expect(arg).toEqual([{ name: 'Quote.pdf', mimetype: 'application/pdf', s3key: expect.stringContaining('gmail/GMAIL_SEND_EMAIL/') }]);

    // Running it again, any number of times, sends nothing more.
    await Promise.all([executeEffect(w.workspaceId, e!.id), executeEffect(w.workspaceId, e!.id)]);
    await releaseHolds(w);
    await jobs().drain();
    expect(sent()).toHaveLength(1);
    expect(sendCalls()).toHaveLength(1);
    expect((await effects())[0]).toMatchObject({ status: 'completed', attempt: 1 });
  });

  it('a reply carries its files too, and several files keep their order', async () => {
    await w.post('/api/test/fake', { op: 'deliver', message: { from: 'Dana <dana@client.test>', subject: 'Send the papers?', body: 'Could you send both?' } });
    const thread = (await w.state()).threads.find((t) => t.subject === 'Send the papers?')!;
    const a = await attach(w, 'Terms.pdf', samples.pdf('Terms'));
    const b = await attach(w, 'site photo.jpeg', samples.jpeg('photo'), 'image/jpeg');
    const out = await w.cmd({ type: 'reply', id: thread.id, body: 'Both attached.', files: [a.file, b.file] });
    expect(out.ok).toBe(true);
    const e = (await effects()).find((x) => x.kind === 'email.reply')!;
    expect((e.payload.attachments as { name: string }[]).map((f) => f.name)).toEqual(['Terms.pdf', 'site photo.jpeg']);
    await releaseHolds(w);
    const [m] = sent();
    expect(m).toMatchObject({ threadId: thread.ext!.threadKey, body: 'Both attached.' });
    expect(m!.attachments).toEqual([
      { name: 'Terms.pdf', mimetype: 'application/pdf', size: a.bytes.length, sha256: hash(a.bytes) },
      { name: 'site photo.jpeg', mimetype: 'image/jpeg', size: b.bytes.length, sha256: hash(b.bytes) },
    ]);
    expect(handovers().map((c) => c.args.toolSlug)).toEqual(['GMAIL_REPLY_TO_THREAD', 'GMAIL_REPLY_TO_THREAD']);
    // When the mailbox's own copy of the reply comes back through sync it is the same message, still with its files, shown once.
    await w.post('/api/test/fake', { op: 'deliver', message: { from: 'Dana <dana@client.test>', subject: 'Re: Send the papers?', body: 'Got them.', threadId: thread.ext!.threadKey } });
    const mine = (await w.state()).threads.find((t) => t.id === thread.id)!.messages.filter((x) => x.from === 'me');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: m!.id, files: [a.file, b.file] });
    expect(mine[0]!.attachments).toBeUndefined();
    // An email with no files is sent as it always was: no file argument at all.
    await send(w, 'mail:dana@client.test', 'Plain');
    await releaseHolds(w);
    expect(Object.hasOwn(sendCalls().at(-1)!.args, 'attachment')).toBe(false);
  });

  it('if the file changed after approval, or is gone, the email fails cleanly and nothing goes out', async () => {
    const cases: [string, (a: Awaited<ReturnType<typeof attach>>) => Promise<unknown>, RegExp][] = [
      ['its bytes were changed in the store', async (a) => store().files.set(a.key, samples.pdf('Quote: $1 per seat.!')), /changed after the email was approved/],
      ['its bytes are gone from the store', async (a) => store().files.delete(a.key), /no longer in Timmy/],
      ['its record is gone', (a) => sysPool.query('delete from asset where id = $1', [a.file.id]), /no longer in Timmy/],
      ['its record says something else', (a) => sysPool.query(`update asset set sha256 = $2 where id = $1`, [a.file.id, 'f'.repeat(64)]), /changed after the email was approved/],
      ['the store can’t be read', async () => (store().get = async () => Promise.reject(new Error('down'))), /could not be read/],
    ];
    for (const [what, damage, why] of cases) {
      setFileStoreForTests(null);
      const before = { sent: sent().length, calls: sendCalls().length, staged: handovers().length };
      const a = await attach(w, 'Quote.pdf', samples.pdf('Quote: $58 per seat.'));
      expect(store().files.get(a.key)!.length).toBe(samples.pdf('Quote: $1 per seat.!').length);
      const subject = `Tampered: ${what}`;
      expect((await sendWith(w, [a.file], subject)).ok).toBe(true);
      await damage(a);
      await releaseHolds(w);
      const e = (await effects()).find((x) => (x.payload as { subject: string }).subject === subject)!;
      expect([what, e.status]).toEqual([what, 'failed']);
      expect(e.error).toMatch(why);
      // Failed before anything was asked of the mail provider: no send, and not even the file was handed over.
      expect([what, sent().length, sendCalls().length, handovers().length]).toEqual([what, before.sent, before.calls, before.staged]);
      const t = (await w.state()).threads.find((x) => x.subject === subject)!;
      expect(t.history!.some((h) => /Not sent/.test(h.text))).toBe(true);
      // A failed effect is final: it is never run again.
      expect(await executeEffect(w.workspaceId, e.id)).toBeNull();
    }
    setFileStoreForTests(null);
  });

  it('if the file can’t be handed to the provider, or the provider won’t take it, nothing is sent', async () => {
    const a = await attach(w);
    await sendWith(w, [a.file], 'Not handed over');
    fake().failNext.set('FILES_UPLOAD', 'error');
    await releaseHolds(w);
    expect((await effects())[0]).toMatchObject({ status: 'failed' });
    expect((await effects())[0]!.error).toMatch(/could not be handed to the mail provider/);
    expect(sent()).toHaveLength(0);
    expect(sendCalls()).toHaveLength(0);

    // The stand-in takes a file argument only the way the real tools do: a reference that was handed over for that very tool.
    const who = { userId: (await rows<{ composio_user_id: string }>('select composio_user_id from connection where id = $1', [mailbox.connectionId]))[0]!.composio_user_id, connectedAccountId: mailbox.account };
    const args = { recipient_email: 'dana@client.test', subject: 's', body: 'b' };
    const forReply = await fake().stageFile({ toolSlug: 'GMAIL_REPLY_TO_THREAD', toolkit: 'gmail', name: 'a.pdf', type: 'application/pdf', bytes: a.bytes });
    const forSend = await fake().stageFile({ toolSlug: 'GMAIL_SEND_EMAIL', toolkit: 'gmail', name: 'a.pdf', type: 'application/pdf', bytes: a.bytes });
    for (const attachment of [{ name: 'a.pdf', mimetype: 'application/pdf', s3key: 'never/uploaded' }, forReply, { ...forSend, mimetype: 'pdf' }, { name: 'a.pdf', s3key: forSend.s3key }, '/etc/passwd', [forSend, 'https://example.test/a.pdf']]) {
      const res = await fake().execute('GMAIL_SEND_EMAIL', { ...args, attachment }, who);
      expect([JSON.stringify(attachment), res.successful]).toEqual([JSON.stringify(attachment), false]);
      expect(res.error).toMatch(/attachment/);
    }
    expect(sent()).toHaveLength(0);
    expect((await fake().execute('GMAIL_SEND_EMAIL', { ...args, attachment: forSend }, who)).successful).toBe(true);
    expect(sent()[0]!.attachments).toEqual([{ name: 'a.pdf', mimetype: 'application/pdf', size: a.bytes.length, sha256: hash(a.bytes) }]);
  });

  it('only this workspace’s own uploaded attachments can be sent, described as they were uploaded', async () => {
    const other = await newWorkspace('Next door');
    const theirs = await attach(other, 'Their payroll.pdf', samples.pdf('salaries'));
    const mine = await attach(w);
    const pending = await w.json<{ assetId: string }>('POST', '/api/v1/uploads', { purpose: 'attachment', type: 'application/pdf', size: 100, name: 'never.pdf' });
    const picture = await uploadFile(w, { purpose: 'page-image', type: 'image/png', bytes: samples.png() });
    const refused: [string, unknown[], RegExp][] = [
      ['another workspace’s file', [theirs.file], /isn’t in Timmy any more/],
      ['another workspace’s file beside one of ours', [mine.file, theirs.file], /isn’t in Timmy any more/],
      ['a file whose bytes never arrived', [{ id: pending.assetId, name: 'never.pdf', type: 'application/pdf', size: 100 }], /isn’t in Timmy any more/],
      ['a page’s picture', [{ id: picture.assetId, name: 'x.png', type: 'image/png', size: samples.png().length }], /isn’t in Timmy any more/],
      ['an id that was made up', [{ id: 'ast_madeup', name: 'x.pdf', type: 'application/pdf', size: 10 }], /isn’t in Timmy any more/],
      ['our file under another name', [{ ...mine.file, name: 'Harmless.pdf' }], /isn’t the file that was uploaded/],
      ['our file with another type', [{ ...mine.file, type: 'text/plain' }], /isn’t the file that was uploaded/],
      ['our file with another size', [{ ...mine.file, size: 1 }], /isn’t the file that was uploaded/],
      ['the same file twice', [mine.file, mine.file], /attached twice/],
      ['something that is not a file', ['asset:whatever'], /isn’t in a form/],
      ['a path', [{ id: '../../etc/passwd', name: 'passwd', type: 'text/plain', size: 1 }], /isn’t in a form/],
      ['more files than an email may carry', Array.from({ length: 11 }, () => mine.file), /up to 10 files/],
    ];
    for (const [what, files, why] of refused) {
      const out = await sendWith(w, files, `Refused: ${what}`);
      expect([what, out.ok]).toEqual([what, false]);
      expect(out.error).toMatch(why);
    }
    // Nothing was recorded, nothing is on the screen, nothing was sent.
    expect(await effects()).toHaveLength(0);
    expect((await w.state()).threads.filter((t) => t.subject.startsWith('Refused'))).toEqual([]);
    await releaseHolds(w);
    expect(sent()).toHaveLength(0);
    // The file from next door was never read on this workspace's behalf.
    expect(handovers()).toHaveLength(0);
  });

  it('files that are too heavy together are refused before anything is recorded', async () => {
    const heavy = async (name: string) => {
      const bytes = new Uint8Array(9_800_000);
      bytes.set(samples.pdf(name));
      return attach(w, name, bytes);
    };
    const out = await sendWith(w, [(await heavy('a.pdf')).file, (await heavy('b.pdf')).file], 'Too heavy');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/An email can carry up to 18 MB/);
    expect(await effects()).toHaveLength(0);
  });

  it('a role that cannot send cannot attach, and an assistant’s attachment waits for the exec with the email', async () => {
    for (const role of ['revops', 'client']) {
      const c = await addMember(w.workspaceId, role);
      const up = await uploadFile(c, { purpose: 'attachment', type: 'application/pdf', bytes: samples.pdf(), name: 'x.pdf' });
      expect([role, up.status]).toEqual([role, 403]);
      // Nor can they send a file someone else uploaded.
      const a = await attach(w, `${role}.pdf`);
      const out = await sendWith(c, [a.file], `From ${role}`);
      expect([role, out.ok]).toEqual([role, false]);
      expect(out.error).toMatch(/role can’t/);
    }
    expect(await effects()).toHaveLength(0);

    const ea = await addMember(w.workspaceId, 'assistant', 'Jess EA');
    const a = await attach(ea, 'Agenda.pdf', samples.pdf('Agenda'));
    expect((await sendWith(ea, [a.file], 'From the EA, with a file')).ok).toBe(true);
    const [e] = await effects();
    expect(e).toMatchObject({ status: 'intended', approver_route: 'exec', requested_by: ea.userId });
    // The exec is shown the file, by name and size, before deciding.
    expect((await w.state()).pending[0]).toMatchObject({ waitingOn: 'exec', status: 'waiting', preview: { attachments: [{ name: 'Agenda.pdf', type: 'application/pdf', size: a.bytes.length }] } });
    await releaseHolds(w);
    expect(sent()).toHaveLength(0);
    expect((await ea.cmd({ type: 'effect', id: e!.id, approve: true })).ok).toBe(false);
    expect((await w.cmd({ type: 'effect', id: e!.id, approve: true })).ok).toBe(true);
    await releaseHolds(w);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.attachments).toEqual([{ name: 'Agenda.pdf', mimetype: 'application/pdf', size: a.bytes.length, sha256: hash(a.bytes) }]);
    // Once it has gone out, the thread shows the email with its file.
    const t = (await w.state()).threads.find((x) => x.subject === 'From the EA, with a file')!;
    expect(t.messages.find((m) => m.from === 'me')!.files).toEqual([a.file]);
  });

  it('what was approved cannot be swapped: the file list is part of the record the database keeps fixed', async () => {
    const a = await attach(w);
    const b = await attach(w, 'Other.pdf', samples.pdf('Something else'));
    await sendWith(w, [a.file]);
    const [e] = await effects();
    const swapped = { ...e!.payload, attachments: [{ assetId: b.file.id, name: 'Other.pdf', type: 'application/pdf', size: b.bytes.length, sha256: hash(b.bytes) }] };
    await expect(sysPool.query('update effect set payload = $2::jsonb where id = $1', [e!.id, JSON.stringify(swapped)])).rejects.toThrow(/what was approved cannot change/);
    await releaseHolds(w);
    expect(sent()[0]!.attachments!.map((f) => f.name)).toEqual(['Quote.pdf']);
  });

  it('a file can be added to a reply Timmy drafted: it is kept with the draft, checked as it is added, and sent with it', async () => {
    await w.post('/api/test/fake', { op: 'deliver', message: { from: 'Dana <dana@client.test>', subject: 'Contract?', body: 'Could you send the contract?' } });
    const thread = (await w.state()).threads.find((t) => t.subject === 'Contract?')!;
    const draftNow = async () => (await w.state()).threads.find((t) => t.id === thread.id)!.draft!;
    expect((await w.cmd({ type: 'makeDraft', id: thread.id })).ok).toBe(true);
    await jobs().drain();
    const drafted = await draftNow();
    const seenBefore = draftHash(drafted);
    const a = await attach(w, 'Contract.pdf', samples.pdf('Contract'));
    // What can't be sent can't be put on the draft either: another workspace's file, or something that isn't a file.
    const theirs = await attach(await newWorkspace('Next door'), 'Theirs.pdf', samples.pdf('theirs'));
    for (const files of [[theirs.file], 'nope', [{ id: a.file.id, name: 'Renamed.pdf', type: 'application/pdf', size: a.bytes.length }]]) {
      expect([JSON.stringify(files), (await w.cmd({ type: 'updateDraft', id: thread.id, body: drafted.body, files })).ok]).toEqual([JSON.stringify(files), false]);
    }
    expect((await draftNow()).files).toBeUndefined();

    expect((await w.cmd({ type: 'updateDraft', id: thread.id, body: drafted.body, files: [a.file] })).ok).toBe(true);
    // Typing in the draft afterwards leaves its files where they are.
    expect((await w.cmd({ type: 'updateDraft', id: thread.id, body: `${drafted.body}\n\nThe contract is attached.` })).ok).toBe(true);
    const withFile = await draftNow();
    expect(withFile.files).toEqual([a.file]);
    // Someone who read the draft before the file was added has to look again before sending.
    const stale = await w.cmd({ type: 'sendDraft', id: thread.id, track: false, seen: seenBefore });
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatch(/changed after you opened it/);
    const changedOnlyByFile = draftHash({ ...withFile, files: undefined });
    expect((await w.cmd({ type: 'sendDraft', id: thread.id, track: false, seen: changedOnlyByFile })).ok).toBe(false);
    expect(await effects().then((list) => list.filter((x) => x.kind === 'email.reply'))).toHaveLength(0);

    expect((await w.cmd({ type: 'sendDraft', id: thread.id, track: false, seen: draftHash(withFile) })).ok).toBe(true);
    const e = (await effects()).find((x) => x.kind === 'email.reply')!;
    expect(e.payload.attachments).toEqual([{ assetId: a.file.id, name: 'Contract.pdf', type: 'application/pdf', size: a.bytes.length, sha256: hash(a.bytes) }]);
    expect(e.preview.attachments).toEqual([{ name: 'Contract.pdf', type: 'application/pdf', size: a.bytes.length }]);
    await releaseHolds(w);
    const m = sent().find((x) => x.threadId === thread.ext!.threadKey)!;
    expect(m.body).toMatch(/The contract is attached\.$/);
    expect(m.attachments).toEqual([{ name: 'Contract.pdf', mimetype: 'application/pdf', size: a.bytes.length, sha256: hash(a.bytes) }]);
    // Taking the last file off a draft leaves it with none.
    await w.post('/api/test/fake', { op: 'deliver', message: { from: 'Dana <dana@client.test>', subject: 'One more?', body: 'And the other one?' } });
    const second = (await w.state()).threads.find((t) => t.subject === 'One more?')!;
    await w.cmd({ type: 'makeDraft', id: second.id });
    await jobs().drain();
    const body = (await w.state()).threads.find((t) => t.id === second.id)!.draft!.body;
    await w.cmd({ type: 'updateDraft', id: second.id, body, files: [a.file] });
    expect((await w.cmd({ type: 'updateDraft', id: second.id, body, files: [] })).ok).toBe(true);
    expect((await w.state()).threads.find((t) => t.id === second.id)!.draft!.files).toBeUndefined();
  });

  it('a file from Timmy’s own Files still can’t be sent, and says so', async () => {
    await w.post('/api/test/fake', { op: 'deliver', message: { from: 'Dana <dana@client.test>', subject: 'Proposal?', body: 'Please send it.' } });
    const thread = (await w.state()).threads.find((t) => t.subject === 'Proposal?')!;
    await mutate(w.workspaceId, 'test', async (_tx, loaded) => ({ state: { ...loaded.state, threads: loaded.state.threads.map((t) => (t.id === thread.id ? { ...t, draft: { to: ['mail:dana@client.test'], subject: 'Re: Proposal?', body: 'Attached.', sources: [], attachments: ['proposal-v3'] } } : t)) }, result: null }));
    const out = await w.cmd({ type: 'sendDraft', id: thread.id, track: false });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/from Timmy’s Files isn’t available yet/);
    expect((await effects()).filter((x) => x.kind !== 'mail.modify')).toHaveLength(0);
  });
});
