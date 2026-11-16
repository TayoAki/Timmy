/**
 * Safety properties:
 *   - no outside write without an approved effect record or a rule the user set;
 *   - no action runs twice;
 *   - unattended runs send only what a rule covers.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeEffect, propose, reconcileEffect, type EffectRow } from '../src/gateway/gateway';
import { rulesFor } from '../src/auth/roles';
import { mutate } from '../src/state/mutate';
import { addMember, boot, connectGmail, fake, jobs, newWorkspace, releaseHolds, rows, sysPool, withWorkspace, type Client } from './helpers';

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
    expect(out.error).toMatch(/Connect Gmail first/);
    expect(await effects(lone)).toHaveLength(0);
    expect((await lone.state()).threads).toHaveLength(0);
  });

  it('a reply on a synced thread goes out as a reply in that thread', async () => {
    await w.post('/api/test/fake', { op: 'deliver', message: { from: 'Dana <dana@client.test>', subject: 'Pricing?', body: 'What is the price?' } });
    const thread = (await w.state()).threads.find((t) => t.subject === 'Pricing?')!;
    const out = await w.cmd({ type: 'reply', id: thread.id, body: 'It is $58 per seat.' });
    expect(out.ok).toBe(true);
    const [e] = await effects();
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
    for (const other of [m2, revops]) expect((await other.cmd({ type: 'effect', id: p.effect!.id, approve: true })).ok).toBe(false);
    await releaseHolds(w);
    expect(sent()).toHaveLength(0);
    expect((await m1.cmd({ type: 'effect', id: p.effect!.id, approve: true })).ok).toBe(true);
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
