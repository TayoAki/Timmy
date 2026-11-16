/**
 * Filing: where a thread sits in Timmy is written back to the mailbox as a label, or as archived.
 * It is a write to the person's own mailbox, so it goes through the gateway like every write.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EffectRow } from '../src/gateway/gateway';
import { executeEffect, reconcileEffect } from '../src/gateway/gateway';
import { LABEL_NAMES, labelPlan } from '../src/sync/labels';
import { addMember, boot, connectGmail, fake, jobs, model, newWorkspace, rows, sysPool, type Client } from './helpers';

let w: Client;
let box: { connectionId: string; account: string };
const filings = () => rows<EffectRow>(`select * from effect where workspace_id = $1 and kind = 'mail.modify' order by created_at, id`, [w.workspaceId]);
const mailbox = () => fake().accounts.get(box.account)!;
/** The labels on a thread in the mailbox, by name. */
const labelsOf = (threadKey: string) => {
  const names = new Map([...mailbox().labels].map(([name, id]) => [id, name]));
  const all = new Set(mailbox().messages.filter((m) => m.threadId === threadKey).flatMap((m) => m.labels));
  return [...all].map((id) => names.get(id) ?? id).sort();
};
const deliver = async (subject: string, from = 'Dana Whitfield <dana@acme.test>') => {
  await w.post('/api/test/fake', { op: 'deliver', message: { from, subject, body: 'Could you take a look?' } });
  await jobs().drain();
  return (await w.state()).threads.find((t) => t.subject === subject)!;
};
const writes = () => fake().calls.filter((c) => c.connectedAccountId === box.account && c.slug === 'GMAIL_MODIFY_THREAD_LABELS');

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  model().reset();
  jobs().queue = [];
  w = await newWorkspace('Filing');
  box = await connectGmail(w, 'owner@filing.test');
  await jobs().drain();
});

describe('the plan for each place', () => {
  const ids = { 'follow-up': 'L1', waiting: 'L2', 'read-through': 'L3' };
  it('labels keep the thread in the inbox, the archive takes it out, and the inbox clears Timmy’s labels', () => {
    expect(labelPlan('follow-up', ids)).toEqual({ add: ['INBOX', 'L1'], remove: ['L2', 'L3'] });
    expect(labelPlan('waiting', ids)).toEqual({ add: ['INBOX', 'L2'], remove: ['L1', 'L3'] });
    expect(labelPlan('read-through', ids)).toEqual({ add: ['INBOX', 'L3'], remove: ['L1', 'L2'] });
    expect(labelPlan('archived', ids)).toEqual({ add: [], remove: ['INBOX', 'L1', 'L2', 'L3'] });
    expect(labelPlan('inbox', ids)).toEqual({ add: ['INBOX'], remove: ['L1', 'L2', 'L3'] });
  });
});

describe('moving a thread in Timmy', () => {
  it('labels it in Gmail, through an effect record approved by the person’s own action', async () => {
    const t = await deliver('Needs an answer');
    expect(labelsOf(t.ext!.threadKey!)).toEqual(['INBOX', 'UNREAD']);
    expect((await w.cmd({ type: 'move', id: t.id, box: 'follow-up' })).ok).toBe(true);
    // Nothing is written until the job runs: the record comes first.
    expect(writes()).toHaveLength(0);
    const [e] = await filings();
    expect(e).toMatchObject({ kind: 'mail.modify', status: 'approved', source: 'user', requested_by: w.userId, approved_by: w.userId, approved_via: 'click', hold_until: null });
    expect(e!.payload).toMatchObject({ connectionId: box.connectionId, threadKey: t.ext!.threadKey, box: 'follow-up' });
    await jobs().drain();
    expect((await filings())[0]!.status).toBe('completed');
    expect(labelsOf(t.ext!.threadKey!)).toEqual(['INBOX', LABEL_NAMES['follow-up'], 'UNREAD'].sort());
    // Filing is not a send: it never shows in Approvals and nothing was sent.
    expect((await w.state()).pending).toHaveLength(0);
    expect(fake().sent(box.account)).toHaveLength(0);
    const log = await rows<{ action: string }>('select action from audit_log where workspace_id = $1 and effect_id = $2 order by id', [w.workspaceId, e!.id]);
    expect(log.map((x) => x.action)).toEqual(['effect.proposed', 'effect.approved', 'effect.executing', 'effect.completed']);
  });

  it('makes Timmy’s three labels once and reuses them', async () => {
    const a = await deliver('First');
    const b = await deliver('Second', 'Sam Rivera <sam@acme.test>');
    await w.cmd({ type: 'move', id: a.id, box: 'waiting' });
    await jobs().drain();
    await w.cmd({ type: 'move', id: b.id, box: 'read-through' });
    await jobs().drain();
    expect([...mailbox().labels.keys()].sort()).toEqual(Object.values(LABEL_NAMES).sort());
    expect(fake().calls.filter((c) => c.connectedAccountId === box.account && c.slug === 'GMAIL_CREATE_LABEL')).toHaveLength(3);
    expect(fake().calls.filter((c) => c.connectedAccountId === box.account && c.slug === 'GMAIL_LIST_LABELS')).toHaveLength(1);
    expect(labelsOf(a.ext!.threadKey!)).toContain(LABEL_NAMES.waiting);
    expect(labelsOf(b.ext!.threadKey!)).toContain(LABEL_NAMES['read-through']);
  });

  it('archiving takes it out of Gmail’s inbox, moving it on swaps the label, and Undo files it back', async () => {
    const t = await deliver('Round trip');
    const key = t.ext!.threadKey!;
    await w.cmd({ type: 'move', id: t.id, box: 'follow-up' });
    await jobs().drain();
    await w.cmd({ type: 'move', id: t.id, box: 'waiting' });
    await jobs().drain();
    expect(labelsOf(key)).toEqual(['INBOX', LABEL_NAMES.waiting, 'UNREAD'].sort());

    const archived = await w.cmd({ type: 'move', id: t.id, box: 'archived' });
    await jobs().drain();
    expect(labelsOf(key)).toEqual(['UNREAD']);

    expect((await w.cmd({ type: 'undo', command: archived.id })).ok).toBe(true);
    await jobs().drain();
    expect((await w.state()).threads.find((x) => x.id === t.id)!.box).toBe('waiting');
    expect(labelsOf(key)).toEqual(['INBOX', LABEL_NAMES.waiting, 'UNREAD'].sort());
    expect((await filings()).every((e) => e.status === 'completed')).toBe(true);
  });

  it('accepting Timmy’s suggestion files it too, and each move is written once even if the command is retried', async () => {
    const t = await deliver('Suggested');
    expect(t.suggestion).toMatchObject({ box: 'follow-up' });
    const first = await w.cmd({ type: 'acceptSuggestion', id: t.id }, 'accept-once');
    expect(first.ok).toBe(true);
    await w.cmd({ type: 'acceptSuggestion', id: t.id }, 'accept-once');
    await jobs().drain();
    await jobs().drain();
    expect(await filings()).toHaveLength(1);
    expect(writes()).toHaveLength(1);
    expect(labelsOf(t.ext!.threadKey!)).toContain(LABEL_NAMES['follow-up']);
    // Running the same effect again changes nothing and calls nothing.
    expect(await executeEffect(w.workspaceId, (await filings())[0]!.id)).toBeNull();
    expect(writes()).toHaveLength(1);
  });

  it('“Accept all” files every thread it sorts', async () => {
    const a = await deliver('One of two');
    const b = await deliver('Two of two', 'Sam Rivera <sam@acme.test>');
    expect((await w.cmd({ type: 'acceptAll', ids: [a.id, b.id] })).ok).toBe(true);
    await jobs().drain();
    expect((await filings()).map((e) => e.status)).toEqual(['completed', 'completed']);
    for (const t of [a, b]) expect(labelsOf(t.ext!.threadKey!)).toContain(LABEL_NAMES['follow-up']);
  });

  it('a thread that is not in a mailbox, and a change that is not a move, write nothing', async () => {
    const t = await deliver('Stays put');
    await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'notes', item: { id: 'n1', text: 'x' } }] });
    await w.cmd({ type: 'setUrgency', id: t.id, level: 'urgent' });
    await jobs().drain();
    expect(await filings()).toHaveLength(0);
    expect(writes()).toHaveLength(0);
  });
});

describe('who may file, and when it can’t be written', () => {
  it('an assistant files on their own say; RevOps and clients cannot move mail at all', async () => {
    const t = await deliver('For the EA');
    const assistant = await addMember(w.workspaceId, 'assistant', 'Jess EA');
    expect((await assistant.cmd({ type: 'move', id: t.id, box: 'read-through' })).ok).toBe(true);
    const [e] = await filings();
    expect(e).toMatchObject({ status: 'approved', requested_by: assistant.userId, approved_by: assistant.userId, approver_route: 'user' });
    await jobs().drain();
    expect(labelsOf(t.ext!.threadKey!)).toContain(LABEL_NAMES['read-through']);

    for (const role of ['revops', 'client']) {
      const other = await addMember(w.workspaceId, role);
      expect((await other.cmd({ type: 'move', id: t.id, box: 'archived' })).ok).toBe(false);
    }
    await jobs().drain();
    expect(await filings()).toHaveLength(1);
    expect(labelsOf(t.ext!.threadKey!)).toContain('INBOX');
  });

  it('with sending switched off the thread still moves in Timmy, and nothing is written to the mailbox', async () => {
    const t = await deliver('Kill switch');
    await w.request('PATCH', '/api/v1/settings', { killSwitch: true });
    expect((await w.cmd({ type: 'move', id: t.id, box: 'archived' })).ok).toBe(true);
    await jobs().drain();
    expect((await w.state()).threads.find((x) => x.id === t.id)!.box).toBe('archived');
    expect(await filings()).toHaveLength(0);
    expect(labelsOf(t.ext!.threadKey!)).toContain('INBOX');
  });

  it('a refusal by Gmail is recorded as failed; a label deleted in Gmail is made again', async () => {
    const t = await deliver('Refused once');
    fake().failNext.set('GMAIL_LIST_LABELS', 'error');
    await w.cmd({ type: 'move', id: t.id, box: 'follow-up' });
    await jobs().drain();
    expect((await filings())[0]).toMatchObject({ status: 'uncertain' });
    // The first attempt could not even list the labels, so its outcome is unknown; the next move works.
    await w.cmd({ type: 'move', id: t.id, box: 'waiting' });
    await jobs().drain();
    expect(labelsOf(t.ext!.threadKey!)).toContain(LABEL_NAMES.waiting);

    // The person deletes Timmy's label in Gmail. The remembered id is refused once, then the label is made again.
    mailbox().labels.delete(LABEL_NAMES['follow-up']);
    for (const m of mailbox().messages) m.labels = m.labels.filter((l) => [...mailbox().labels.values(), 'INBOX', 'UNREAD', 'SENT'].includes(l));
    await w.cmd({ type: 'move', id: t.id, box: 'follow-up' });
    await jobs().drain();
    expect(mailbox().labels.has(LABEL_NAMES['follow-up'])).toBe(true);
    expect(labelsOf(t.ext!.threadKey!)).toContain(LABEL_NAMES['follow-up']);
    expect((await filings()).at(-1)).toMatchObject({ status: 'completed' });
  });

  it('a timeout after the change was made is confirmed from the mailbox, without writing again', async () => {
    const t = await deliver('Timed out');
    await w.cmd({ type: 'move', id: t.id, box: 'follow-up' });
    await jobs().drain();
    fake().failNext.set('GMAIL_MODIFY_THREAD_LABELS', 'sent-then-timeout');
    await w.cmd({ type: 'move', id: t.id, box: 'archived' });
    await jobs().drain('effect.execute');
    const e = (await filings()).at(-1)!;
    expect(e.status).toBe('uncertain');
    const before = writes().length;
    await sysPool.query(`update effect set updated_at = now() - interval '2 minutes' where id = $1`, [e.id]);
    const after = await reconcileEffect(w.workspaceId, e.id);
    expect(after).toMatchObject({ status: 'completed' });
    expect(writes()).toHaveLength(before);
  });

  it('a reply can still be sent on a thread that was just filed', async () => {
    const t = await deliver('File then reply');
    await w.cmd({ type: 'move', id: t.id, box: 'follow-up' });
    // The filing has not run yet; it must not count as "an email already waiting on this thread".
    const out = await w.cmd({ type: 'reply', id: t.id, body: 'On it.' });
    expect(out.ok).toBe(true);
    expect(out.holding).toBeDefined();
  });
});
