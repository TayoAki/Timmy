import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signWebhook } from '../src/providers/composio';
import { boot, connectGmail, fake, jobs, model, newWorkspace, rows, type Client } from './helpers';

let w: Client;
let box: { connectionId: string; account: string };

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  jobs().queue = [];
  // Another file's test may have left a scripted model turn behind.
  model().reset();
  w = await newWorkspace('Sync');
});

const seed = (account: string, n: number, daysAgo = (i: number) => i) => {
  const b = fake().accounts.get(account)!;
  for (let i = 0; i < n; i++) b.messages.push({ id: `seed-${account}-${i}`, threadId: `th-${account}-${Math.floor(i / 2)}`, from: `Sender ${i} <sender${i}@client.test>`, to: [b.address], subject: `Topic ${Math.floor(i / 2)}`, body: `Message number ${i} about widgets.`, at: new Date(Date.now() - daysAgo(i) * 86400_000 - 60_000), labels: i % 5 === 4 ? ['CATEGORY_UPDATES'] : ['INBOX', 'UNREAD'] });
};

describe('connecting a mailbox', () => {
  it('shows as connected only after the provider confirms it', async () => {
    fake().nextAddress = 'ada@sync.test';
    const start = await w.json<{ redirectUrl: string; connectionId: string }>('POST', '/api/v1/connections/gmail/connect', {});
    expect((await w.state()).conn.apps.gmail?.connected).toBeFalsy();
    // Coming back without having consented does not connect anything.
    const early = await w.get(`/api/v1/connections/callback?c=${start.connectionId}&status=success`);
    expect(early.headers.get('location')).toMatch(/connect=failed/);
    expect((await w.state()).conn.apps.gmail?.connected).toBeFalsy();

    box = await connectGmail(w, 'ada@sync.test');
    const s = await w.state();
    expect(s.conn.apps.gmail).toMatchObject({ connected: true, account: 'ada@sync.test' });
    const [conn] = await rows('select status, account_label, toolkit, composio_user_id from connection where id = $1', [box.connectionId]);
    expect(conn).toMatchObject({ status: 'active', account_label: 'ada@sync.test', toolkit: 'gmail', composio_user_id: `${w.workspaceId}.${w.userId}` });
    expect(await rows('select slug from trigger_instance where connection_id = $1 order by slug', [box.connectionId])).toEqual([{ slug: 'GMAIL_EMAIL_SENT_TRIGGER' }, { slug: 'GMAIL_NEW_GMAIL_MESSAGE' }]);
    expect((await rows<{ action: string }>('select action from audit_log where workspace_id = $1', [w.workspaceId])).map((r) => r.action)).toEqual(expect.arrayContaining(['connection.started', 'connection.active']));
  });

  it('another workspace cannot finish or use this connection', async () => {
    fake().nextAddress = 'ada@sync.test';
    const start = await w.json<{ redirectUrl: string; connectionId: string }>('POST', '/api/v1/connections/gmail/connect', {});
    const other = await newWorkspace('Thief');
    fake().completeConnect(new URL(start.redirectUrl).searchParams.get('account')!);
    const res = await other.get(`/api/v1/connections/callback?c=${start.connectionId}`);
    expect(res.headers.get('location')).toMatch(/connect=failed/);
    expect((await other.state()).conn.apps.gmail?.connected).toBeFalsy();
  });

  it('a role that cannot connect apps is refused', async () => {
    const { addMember } = await import('./helpers');
    const ea = await addMember(w.workspaceId, 'assistant');
    expect((await ea.post('/api/v1/connections/gmail/connect', {})).status).toBe(403);
  });

  it('disconnecting removes the triggers and stops sends', async () => {
    box = await connectGmail(w, 'ada@sync.test');
    expect((await w.post('/api/v1/connections/gmail/disconnect', {})).status).toBe(200);
    expect((await w.state()).conn.apps.gmail).toMatchObject({ connected: false });
    expect(await rows('select 1 from trigger_instance where connection_id = $1', [box.connectionId])).toEqual([]);
    expect((await w.cmd({ type: 'sendNew', draft: { to: ['mail:x@y.test'], subject: 'S', body: 'B' } })).ok).toBe(false);
  });
});

describe('backfill', () => {
  it('stores every message, shows inbox threads, pages to the end and can be re-run safely', async () => {
    box = await connectGmail(w, 'ada@sync.test');
    seed(box.account, 130, (i) => i / 10);
    const { backfillMail } = await import('../src/sync/ingest');
    const first = await backfillMail(w.workspaceId, box.connectionId, { days: 30, maxPages: 1, pauseMs: 0 });
    expect(first).toMatchObject({ pages: 1, messages: 50, done: false });
    // A second call picks up from the saved page, not from the start.
    const rest = await backfillMail(w.workspaceId, box.connectionId, { days: 30, pauseMs: 0 });
    expect(rest).toMatchObject({ pages: 2, messages: 80, done: true });
    expect((await rows<{ n: number }>(`select count(*)::int as n from item where workspace_id = $1`, [w.workspaceId]))[0]!.n).toBe(130);
    expect((await rows<{ n: number }>(`select count(*)::int as n from item_body where workspace_id = $1`, [w.workspaceId]))[0]!.n).toBe(130);
    const again = await backfillMail(w.workspaceId, box.connectionId, { days: 30, pauseMs: 0 });
    expect(again).toMatchObject({ pages: 0, done: true });
    expect((await rows<{ n: number }>(`select count(*)::int as n from item where workspace_id = $1`, [w.workspaceId]))[0]!.n).toBe(130);

    const s = await w.state();
    expect(s.threads.length).toBe(65);
    const t = s.threads.find((x) => x.subject === 'Topic 0')!;
    expect(t).toMatchObject({ box: 'inbox', unread: true });
    expect(t.messages).toHaveLength(2);
    // Oldest first: message 1 was seeded as older than message 0.
    expect(t.messages.map((m) => m.from)).toEqual(['mail:sender1@client.test', 'mail:sender0@client.test']);
    expect(t.ext!.people!['mail:sender0@client.test']).toMatchObject({ name: 'Sender 0' });
    expect(t.messages[0]!.at).toBeInstanceOf(Date);
    // Every Composio call was counted, by phase.
    const calls = await rows<{ phase: string; n: number }>(`select phase, count(*)::int as n from provider_call where workspace_id = $1 group by phase`, [w.workspaceId]);
    expect(calls.find((c) => c.phase === 'backfill')!.n).toBe(3);
  });

  it('only goes back as far as asked', async () => {
    box = await connectGmail(w, 'ada@sync.test');
    seed(box.account, 20, (i) => i * 5);
    const { backfillMail } = await import('../src/sync/ingest');
    const p = await backfillMail(w.workspaceId, box.connectionId, { days: 30, pauseMs: 0 });
    expect(p.messages).toBe(6);
  });

  it('the connect callback queues the first pass, and the first pass queues the full one', async () => {
    box = await connectGmail(w, 'ada@sync.test');
    seed(box.account, 4);
    expect(jobs().queue.filter((j) => j.name === 'mail.backfill').map((j) => j.data.days)).toEqual([30]);
    await jobs().drain('mail.backfill');
    expect((await rows('select kind, state from sync_cursor where connection_id = $1 order by kind', [box.connectionId]))).toEqual([{ kind: 'backfill-30', state: 'done' }, { kind: 'backfill-90', state: 'done' }]);
    // After the first pass the model reads the newest threads people wrote (two here), and only those.
    const reads = jobs().queue.filter((j) => j.name === 'mail.read');
    expect(reads).toHaveLength(2);
    await jobs().drain();
    const s = await w.state();
    expect(s.threads.filter((t) => t.suggestion?.confidence === 'medium')).toHaveLength(2);
  });
});

describe('new mail', () => {
  beforeEach(async () => {
    box = await connectGmail(w, 'ada@sync.test');
    await jobs().drain();
  });

  const post = async (headers: Record<string, string>, body: string) => (await boot()).request('/api/hooks/composio', { method: 'POST', headers, body });

  it('a signed event becomes a thread within one job', async () => {
    const d = fake().deliver(box.account, { from: 'Dana Whitfield <dana@acme.test>', subject: 'Revised quote', body: 'Can you send the revised quote by Friday?\n\nThanks,\nDana' });
    expect((await post(d.webhook.headers, d.webhook.body)).status).toBe(200);
    await jobs().drain('mail.ingest');
    const t = (await w.state()).threads.find((x) => x.subject === 'Revised quote')!;
    expect(t).toMatchObject({ box: 'inbox', unread: true, participants: ['me', 'mail:dana@acme.test'] });
    expect(t.messages[0]!.body).toEqual(['Can you send the revised quote by Friday?', 'Thanks,\nDana']);
    expect(t.ask).toMatch(/revised quote by Friday/);
  });

  it('the same event delivered twice is stored once', async () => {
    const d = fake().deliver(box.account, { from: 'dana@acme.test', subject: 'Twice', body: 'Once only.' });
    await post(d.webhook.headers, d.webhook.body);
    const again = await post(d.webhook.headers, d.webhook.body);
    expect(await again.json()).toMatchObject({ duplicate: true });
    await jobs().drain();
    await jobs().drain();
    expect((await w.state()).threads.filter((x) => x.subject === 'Twice')).toHaveLength(1);
    expect((await rows<{ n: number }>(`select count(*)::int as n from item where workspace_id = $1 and subject = 'Twice'`, [w.workspaceId]))[0]!.n).toBe(1);
  });

  it('an unsigned, wrongly signed, altered or replayed-late event is rejected and stores nothing', async () => {
    const d = fake().deliver(box.account, { from: 'mallory@evil.test', subject: 'Forged', body: 'x' });
    const before = (await rows<{ n: number }>('select count(*)::int as n from webhook_event'))[0]!.n;
    expect((await post({ 'content-type': 'application/json' }, d.webhook.body)).status).toBe(401);
    expect((await post({ ...d.webhook.headers, 'webhook-signature': signWebhook(d.webhook.headers['webhook-id'], d.webhook.headers['webhook-timestamp'], d.webhook.body, 'wrong-secret') }, d.webhook.body)).status).toBe(401);
    expect((await post(d.webhook.headers, d.webhook.body.replace('Forged', 'Forged!'))).status).toBe(401);
    const old = String(Math.floor(Date.now() / 1000) - 7200);
    expect((await post({ ...d.webhook.headers, 'webhook-timestamp': old, 'webhook-signature': signWebhook(d.webhook.headers['webhook-id'], old, d.webhook.body, fake().secret) }, d.webhook.body)).status).toBe(401);
    expect((await rows<{ n: number }>('select count(*)::int as n from webhook_event'))[0]!.n).toBe(before);
    await jobs().drain();
    expect((await w.state()).threads.some((x) => x.subject === 'Forged')).toBe(false);
  });

  it('an event for an account nobody has connected is acknowledged and dropped', async () => {
    const body = JSON.stringify({ id: 'evt_unknown', metadata: { trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE', connected_account_id: 'ca_nobody', user_id: 'x' }, data: { thread_id: 't', message_id: 'm' } });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await post({ 'content-type': 'application/json', 'webhook-id': 'wh_unknown', 'webhook-timestamp': ts, 'webhook-signature': signWebhook('wh_unknown', ts, body, fake().secret) }, body);
    expect(res.status).toBe(200);
    expect(jobs().queue.filter((j) => j.name === 'mail.ingest')).toHaveLength(0);
  });

  it('a reply moves an archived thread back to the inbox and keeps your own edits', async () => {
    const d = fake().deliver(box.account, { from: 'dana@acme.test', subject: 'Contract', body: 'First message.' });
    await post(d.webhook.headers, d.webhook.body);
    await jobs().drain();
    const t = (await w.state()).threads.find((x) => x.subject === 'Contract')!;
    await w.cmd({ type: 'toggleStar', id: t.id });
    await w.cmd({ type: 'move', id: t.id, box: 'archived' });
    expect((await w.state()).threads.find((x) => x.id === t.id)).toMatchObject({ box: 'archived', starred: true });
    const d2 = fake().deliver(box.account, { from: 'dana@acme.test', subject: 'Re: Contract', body: 'Second message.', threadId: t.ext!.threadKey });
    await post(d2.webhook.headers, d2.webhook.body);
    await jobs().drain();
    const after = (await w.state()).threads.find((x) => x.id === t.id)!;
    expect(after).toMatchObject({ box: 'inbox', unread: true, starred: true });
    expect(after.messages).toHaveLength(2);
  });
});
