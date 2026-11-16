/**
 * Outlook, connected through Composio like Gmail, and held to the same rules: mail is read into the
 * workspace's own store, and nothing is sent or changed except through an approved effect record.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EffectRow } from '../src/gateway/gateway';
import { executeEffect, reconcileEffect } from '../src/gateway/gateway';
import type { FakeMessage } from '../src/providers/composio';
import { backfillMail, ingestThread, reconcileMail } from '../src/sync/ingest';
import { LABEL_NAMES } from '../src/sync/labels';
import { htmlToText, type MailMessage } from '../src/sync/message';
import { fromOutlook, outlookPlan, replyHtml } from '../src/sync/outlook';
import { boot, connectApp, fake, jobs, model, newWorkspace, releaseHolds, rows, type Client } from './helpers';

let w: Client;
let box: { connectionId: string; account: string };
const mailbox = () => fake().accounts.get(box.account)!;
const sent = () => fake().sent(box.account);
const calls = (slug?: string) => fake().calls.filter((c) => c.connectedAccountId === box.account && (!slug || c.slug === slug));
const effects = (kind?: string) => rows<EffectRow>(`select * from effect where workspace_id = $1 and ($2::text is null or kind = $2) order by created_at, id`, [w.workspaceId, kind ?? null]);
const put = (m: Partial<FakeMessage> & { subject: string }): FakeMessage => {
  const msg: FakeMessage = { id: `om-${Math.random().toString(36).slice(2, 10)}`, threadId: `conv-${Math.random().toString(36).slice(2, 10)}`, from: 'Dana Whitfield <dana@client.test>', to: ['owner@outlook.test'], body: 'Could you take a look?', at: new Date(), labels: ['INBOX', 'UNREAD'], ...m };
  mailbox().messages.push(msg);
  return msg;
};
const deliver = async (message: Partial<FakeMessage> & { subject: string; from?: string; body?: string }) => {
  await w.post('/api/test/fake', { op: 'deliver', message: { from: 'Dana Whitfield <dana@client.test>', body: 'Could you take a look?', ...message } });
  await jobs().drain();
  return (await w.state()).threads.find((t) => t.subject === message.subject.replace(/^Re: /, ''))!;
};
const where = (subject: string) => mailbox().messages.filter((m) => m.subject === subject).map((m) => ({ in: m.labels.filter((l) => ['INBOX', 'ARCHIVE', 'SENT'].includes(l)).join(','), categories: [...(m.categories ?? [])].sort() }));

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  model().reset();
  jobs().queue = [];
  w = await newWorkspace('Redmond');
  box = await connectApp(w, 'outlook', 'owner@outlook.test');
  await jobs().drain();
});

describe('reading what Outlook returns', () => {
  it('keeps the words of an HTML email and nothing a tag hides', () => {
    const html = `<html><head><title>x</title><style>.a{color:red}</style></head><body><!-- hidden --><p>Hi Taylor,</p><div>Two&nbsp;things &amp; a question:<br>is 5 &lt; 6?</div><script>alert(1)</script><ul><li>first</li><li>second</li></ul><p>Thanks&#33; &#x2014; Dana</p></body></html>`;
    const text = htmlToText(html);
    expect(text).toBe('Hi Taylor,\n\nTwo things & a question:\nis 5 < 6?\n• first\n• second\nThanks! — Dana');
    expect(text).not.toMatch(/alert|color:red|hidden|<\/?[a-z]/);
    // A character reference can't smuggle in a control character or an impossible one.
    expect(htmlToText('a&#0;b&#x1b;c&#x110000;d&#xD800;e')).toBe('abcde');
    // An entity that spells a tag stays text; it is never read as a tag afterwards.
    expect(htmlToText('&lt;script&gt;x&lt;/script&gt;')).toBe('<script>x</script>');
  });

  it('turns folders into the same places Gmail’s labels name, and never takes a display name for an address', () => {
    const folders = { inbox: 'F1', sentitems: 'F2', drafts: 'F3', archive: 'F4', deleteditems: 'F5', junkemail: 'F6' };
    const base = { id: 'A', conversationId: 'C', subject: ' Hello ', receivedDateTime: '2026-11-10T09:00:00Z', toRecipients: [{ emailAddress: { address: 'Owner@Outlook.test' } }], body: { contentType: 'html', content: '<p>Hi</p>' } };
    const inbox = fromOutlook({ ...base, parentFolderId: 'F1', isRead: false, categories: ['Red'], from: { emailAddress: { name: 'ceo@corp.test (Pat <pat@corp.test>)', address: 'Mallory@Evil.test' } } }, folders)!;
    expect(inbox).toMatchObject({ id: 'A', threadKey: 'C', subject: 'Hello', text: 'Hi', to: ['owner@outlook.test'], labels: ['INBOX', 'UNREAD', 'category:Red'] });
    expect(inbox.from.endsWith('<mallory@evil.test>')).toBe(true);
    expect(inbox.from).not.toMatch(/[()]|<pat@corp\.test>/);
    expect(fromOutlook({ ...base, parentFolderId: 'F2', isRead: false }, folders)!.labels).toEqual(['SENT']);
    expect(fromOutlook({ ...base, parentFolderId: 'F1', isDraft: true }, folders)!.labels).toEqual(['DRAFT']);
    expect(fromOutlook({ ...base, parentFolderId: 'F5' }, folders)!.labels).toEqual(['TRASH']);
    expect(fromOutlook({ ...base, parentFolderId: 'F6' }, folders)!.labels).toEqual(['SPAM']);
    expect(fromOutlook({ ...base, parentFolderId: 'somewhere-else', isRead: true }, folders)!.labels).toEqual([]);
    expect(fromOutlook({ subject: 'no id' }, folders)).toBeNull();
  });

  it('plans a filing as categories and, for the archive, a move; the person’s own categories are left alone', () => {
    const m = (id: string, labels: string[]): MailMessage => ({ id, threadKey: 'C', at: new Date(), from: '', to: [], cc: [], subject: 's', text: '', labels, attachments: [] });
    const thread = [m('in', ['INBOX', 'category:Red', `category:${LABEL_NAMES.waiting}`]), m('mine', ['SENT'])];
    expect(outlookPlan('follow-up', thread)).toEqual({ updates: [{ message_id: 'in', patch: { categories: ['Red', LABEL_NAMES['follow-up']] } }], toInbox: [], toArchive: [] });
    expect(outlookPlan('archived', thread)).toEqual({ updates: [{ message_id: 'in', patch: { categories: ['Red'] } }], toInbox: [], toArchive: ['in'] });
    expect(outlookPlan('inbox', [m('old', ['ARCHIVE'])])).toEqual({ updates: [], toInbox: ['old'], toArchive: [] });
    // Already where it should be: nothing to do. A word that is not a place adds no category.
    expect(outlookPlan('waiting', thread)).toEqual({ updates: [], toInbox: [], toArchive: [] });
    expect(outlookPlan('constructor', [m('x', ['INBOX'])]).updates).toEqual([]);
  });

  it('writes a reply as escaped text above what Outlook quoted', () => {
    const html = replyHtml('Hi <b>Dana</b>,\n\n5 > 3 & "so on"', '<html><body class="x"><hr>earlier</body></html>');
    expect(html).toBe('<html><body class="x"><div>Hi &lt;b&gt;Dana&lt;/b&gt;,<br><br>5 &gt; 3 &amp; &quot;so on&quot;</div><br><hr>earlier</body></html>');
    expect(replyHtml('Hello', 'no body tag')).toBe('<div>Hello</div><br>no body tag');
  });
});

describe('connecting Outlook', () => {
  it('is a Composio connection like any other: the account’s address is asked of Outlook, and events are subscribed to', async () => {
    const [conn] = await rows<{ status: string; toolkit: string; account_label: string; app_id: string }>('select status, toolkit, account_label, app_id from connection where id = $1', [box.connectionId]);
    expect(conn).toEqual({ status: 'active', toolkit: 'outlook', account_label: 'owner@outlook.test', app_id: 'outlook' });
    expect((await w.state()).conn.apps.outlook).toMatchObject({ connected: true, account: 'owner@outlook.test' });
    expect([...fake().triggers.values()].filter((t) => t.connectedAccountId === box.account).map((t) => t.slug).sort()).toEqual(['OUTLOOK_MESSAGE_TRIGGER', 'OUTLOOK_SENT_MESSAGE_TRIGGER']);
    expect(await rows('select owner_email from workspace where id = $1', [w.workspaceId])).toEqual([{ owner_email: 'owner@outlook.test' }]);
    // No Gmail tool is ever run on an Outlook account.
    expect(calls().filter((c) => c.slug.startsWith('GMAIL_'))).toEqual([]);
  });

  it('counts as the workspace’s one mailbox: Gmail can’t be added beside it', async () => {
    const res = await w.post('/api/v1/connections/gmail/connect', {});
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('owner@outlook.test');
  });
});

describe('the first read of the mailbox', () => {
  it('takes in the inbox and Sent, as text, and leaves out drafts and deleted mail', async () => {
    const asked = put({ subject: 'Renewal terms', body: 'Hi Taylor,\n\nCan we talk about <renewal> terms & pricing?' });
    put({ subject: 'Renewal terms', threadId: asked.threadId, from: 'owner@outlook.test', to: ['dana@client.test'], body: 'Yes, Thursday works.', labels: ['SENT'], at: new Date(Date.now() + 1000) });
    put({ subject: 'Half-written', labels: ['DRAFT'], from: 'owner@outlook.test' });
    put({ subject: 'Thrown away', labels: ['TRASH'] });
    put({ subject: 'Too old', at: new Date(Date.now() - 200 * 86400_000) });
    // Connecting already ran the first pass over an empty mailbox; a different span is a fresh pass.
    const p = await backfillMail(w.workspaceId, box.connectionId, { days: 45, pauseMs: 0 });
    expect(p).toMatchObject({ done: true, messages: 2 });
    const stored = await rows<{ subject: string; direction: string; sender: string; external_id: string }>(`select subject, direction, sender, external_id from item where workspace_id = $1 and kind = 'message' order by occurred_at`, [w.workspaceId]);
    expect(stored.map((s) => [s.subject, s.direction, s.sender])).toEqual([
      ['Renewal terms', 'in', 'dana@client.test'],
      ['Renewal terms', 'out', 'owner@outlook.test'],
    ]);
    const t = (await w.state()).threads.find((x) => x.subject === 'Renewal terms')!;
    expect(t.id).toMatch(/^o-[0-9a-f]{20}$/);
    expect(t.ext).toMatchObject({ threadKey: asked.threadId, connectionId: box.connectionId, app: 'outlook' });
    expect(t.messages.map((m) => [m.from, m.body])).toEqual([
      ['mail:dana@client.test', ['Hi Taylor,', 'Can we talk about <renewal> terms & pricing?']],
      ['me', ['Yes, Thursday works.']],
    ]);
    expect(t.ext!.people!['mail:dana@client.test']).toEqual({ name: 'Dana Whitfield', email: 'dana@client.test' });
    // The folder ids were looked up once and remembered; a second pass asks nothing about folders.
    const lookups = calls('OUTLOOK_GET_MAIL_FOLDER').length;
    expect(lookups).toBe(6);
    await reconcileMail(w.workspaceId, box.connectionId);
    expect(calls('OUTLOOK_GET_MAIL_FOLDER')).toHaveLength(lookups);
  });

  it('pages through a mailbox larger than one page and picks up where it stopped', async () => {
    for (let i = 0; i < 7; i++) put({ subject: `Message ${i}`, at: new Date(Date.now() - i * 60_000) });
    const first = await backfillMail(w.workspaceId, box.connectionId, { days: 46, pageSize: 3, maxPages: 2, pauseMs: 0 });
    expect(first).toMatchObject({ done: false, pages: 2, messages: 6 });
    const rest = await backfillMail(w.workspaceId, box.connectionId, { days: 46, pageSize: 3, pauseMs: 0 });
    expect(rest).toMatchObject({ done: true, messages: 1 });
    expect(await rows(`select 1 from item where workspace_id = $1 and kind = 'message'`, [w.workspaceId])).toHaveLength(7);
  });
});

describe('new mail', () => {
  it('arrives through a signed event, and is stored under the id Outlook’s own listing gives it', async () => {
    const t = await deliver({ subject: 'Quick question' });
    expect(t).toMatchObject({ box: 'inbox', unread: true });
    const [m] = mailbox().messages.filter((x) => x.subject === 'Quick question');
    // The event carried a different, short-lived id for the same message; the stored one is the listing's.
    expect(await rows(`select external_id, thread_key from item where workspace_id = $1 and kind = 'message'`, [w.workspaceId])).toEqual([{ external_id: m!.id, thread_key: m!.threadId }]);
    expect(calls('OUTLOOK_LIST_MESSAGES').at(-1)!.args.filter).toBe(`receivedDateTime ge 2000-01-01T00:00:00Z and conversationId eq '${m!.threadId}'`);
  });

  it('a conversation id with a quote in it cannot change the question asked of Outlook', async () => {
    const odd = put({ subject: 'Odd id', threadId: "abc' or '1' eq '1" });
    put({ subject: 'Someone else’s thread' });
    expect(await ingestThread(w.workspaceId, box.connectionId, odd.threadId)).toBe(1);
    expect(calls('OUTLOOK_LIST_MESSAGES').at(-1)!.args.filter).toBe(`receivedDateTime ge 2000-01-01T00:00:00Z and conversationId eq 'abc'' or ''1'' eq ''1'`);
    expect((await rows<{ subject: string }>(`select subject from item where workspace_id = $1 and kind = 'message'`, [w.workspaceId])).map((r) => r.subject)).toEqual(['Odd id']);
  });

  it('when the conversation can’t be fetched the job fails so it is tried again, rather than storing the event’s preview', async () => {
    const m = put({ subject: 'Flaky' });
    fake().failNext.set('OUTLOOK_LIST_MESSAGES', 'error');
    await expect(ingestThread(w.workspaceId, box.connectionId, m.threadId)).rejects.toThrow(/could not be fetched/);
    expect(await rows(`select 1 from item where workspace_id = $1`, [w.workspaceId])).toEqual([]);
    expect(await ingestThread(w.workspaceId, box.connectionId, m.threadId)).toBe(1);
  });

  it('the nightly check takes in what an event missed', async () => {
    put({ subject: 'No event came for this' });
    const found = await reconcileMail(w.workspaceId, box.connectionId);
    expect(found).toMatchObject({ messages: 1, fresh: 1 });
    expect((await w.state()).threads.map((t) => t.subject)).toContain('No event came for this');
    // Asking again stores nothing twice.
    expect((await reconcileMail(w.workspaceId, box.connectionId)).fresh).toBe(0);
  });

  it('an email the person sent by hand from Outlook is noticed through the Sent event', async () => {
    await w.post('/api/test/fake', { op: 'sent-by-hand', message: { to: 'lead@prospect.test', subject: 'Intro', body: 'Hello there' } });
    await jobs().drain();
    expect(await rows(`select subject, direction from item where workspace_id = $1 and kind = 'message'`, [w.workspaceId])).toEqual([{ subject: 'Intro', direction: 'out' }]);
  });
});

describe('sending from Outlook', () => {
  it('a new email waits out the hold, then goes out once, exactly as approved', async () => {
    const out = await w.cmd({ type: 'sendNew', draft: { to: ['mail:dana@client.test'], subject: 'Quote', body: 'Hi Dana,\n\nHere is the quote.\n\nTaylor' } });
    expect(out.ok).toBe(true);
    const [e] = await effects('email.send');
    expect(e).toMatchObject({ status: 'approved', approved_by: w.userId });
    expect(e!.preview).toMatchObject({ from: 'owner@outlook.test', to: ['dana@client.test'] });
    await jobs().drain();
    // During the hold nothing has been asked of Outlook: not even a draft exists there.
    expect(calls('OUTLOOK_CREATE_DRAFT')).toHaveLength(0);
    expect(await releaseHolds(w)).toBe(1);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ to: ['dana@client.test'], cc: [], subject: 'Quote', body: 'Hi Dana,\n\nHere is the quote.\n\nTaylor' });
    expect(calls('OUTLOOK_CREATE_DRAFT')[0]!.args).toMatchObject({ is_html: false, to_recipients: ['dana@client.test'] });
    // Run again, by any number of workers: nothing more leaves.
    await Promise.all([executeEffect(w.workspaceId, e!.id), executeEffect(w.workspaceId, e!.id)]);
    await jobs().drain();
    expect(sent()).toHaveLength(1);
    const [done] = await effects('email.send');
    expect(done).toMatchObject({ status: 'completed', attempt: 1, external_id: sent()[0]!.id });
    expect(done!.result).toMatchObject({ via: 'outlook', threadId: sent()[0]!.threadId });
    expect(calls().filter((c) => c.slug.startsWith('GMAIL_'))).toEqual([]);
  });

  it('a reply goes to the people who were approved, not to whoever Outlook would have answered', async () => {
    // Dana asked; Sam, copied in, wrote last. Outlook's own "reply" would answer Sam.
    const t = await deliver({ subject: 'Pricing?', body: 'What is the price?' });
    await deliver({ subject: 'Re: Pricing?', threadId: t.ext!.threadKey, from: 'Sam Rivera <sam@client.test>', body: 'Adding myself.' });
    const out = await w.cmd({ type: 'reply', id: t.id, body: 'It is $58 per seat.\n\n<script>alert(1)</script> & thanks' });
    expect(out.ok).toBe(true);
    const [e] = await effects('email.reply');
    const approved = (e!.payload as { to: string[]; cc: string[] }).to;
    await releaseHolds(w);
    const [m] = sent();
    expect(m!.threadId).toBe(t.ext!.threadKey);
    expect(m!.to).toEqual(approved);
    // The draft Outlook made was addressed to Sam; the approved recipients replaced that before anything was sent.
    const order = calls().map((c) => c.slug).filter((s) => /DRAFT|UPDATE_EMAIL/.test(s));
    expect(order).toEqual(['OUTLOOK_CREATE_DRAFT_REPLY', 'OUTLOOK_UPDATE_EMAIL', 'OUTLOOK_SEND_DRAFT']);
    expect(calls('OUTLOOK_UPDATE_EMAIL')[0]!.args.to_recipients).toEqual(approved.map((address) => ({ address })));
    // The words arrive as written, line breaks and all, and markup in them is text, not markup.
    expect(m!.body).toBe('It is $58 per seat.\n\n<script>alert(1)</script> & thanks');
    expect(m!.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; thanks');
    expect(m!.html).not.toContain('<script>');
    expect((await effects('email.reply'))[0]).toMatchObject({ status: 'completed', external_id: m!.id });
    // The copy that comes back through sync is the same message, not a second one.
    await deliver({ subject: 'Re: Pricing?', threadId: t.ext!.threadKey, body: 'Great, thanks.' });
    const after = (await w.state()).threads.find((x) => x.id === t.id)!;
    expect(after.messages.filter((x) => x.from === 'me')).toHaveLength(1);
    expect(after.messages).toHaveLength(4);
  });

  it('if Outlook won’t take the approved recipients, nothing is sent', async () => {
    const t = await deliver({ subject: 'Hold on' });
    await w.cmd({ type: 'reply', id: t.id, body: 'Answer' });
    fake().failNext.set('OUTLOOK_UPDATE_EMAIL', 'error');
    await releaseHolds(w);
    expect(sent()).toHaveLength(0);
    expect(calls('OUTLOOK_SEND_DRAFT')).toHaveLength(0);
    expect((await effects('email.reply'))[0]).toMatchObject({ status: 'failed' });
  });

  it('if the draft Outlook holds is not addressed to exactly the approved people, it is not sent', async () => {
    await w.cmd({ type: 'sendNew', draft: { to: ['mail:dana@client.test'], subject: 'Just Dana', body: 'For Dana only.' } });
    // Outlook (or anything between) adds someone to the draft: a copy to an address nobody approved.
    const real = fake().execute.bind(fake());
    fake().execute = async (slug, args, who) => {
      const res = await real(slug, args, who);
      if (slug === 'OUTLOOK_CREATE_DRAFT') {
        const draft = mailbox().messages.find((m) => m.id === res.data.id)!;
        draft.cc = ['eve@elsewhere.test'];
        (res.data.ccRecipients as unknown[]).push({ emailAddress: { address: 'eve@elsewhere.test' } });
      }
      return res;
    };
    try {
      await releaseHolds(w);
    } finally {
      fake().execute = real;
    }
    expect(sent()).toHaveLength(0);
    expect(calls('OUTLOOK_SEND_DRAFT')).toHaveLength(0);
    expect((await effects('email.send'))[0]).toMatchObject({ status: 'failed' });
  });

  it('a timeout after the message left is found in Sent Items and never sent again', async () => {
    await w.cmd({ type: 'sendNew', draft: { to: ['mail:dana@client.test'], subject: 'Lost answer', body: 'Body that did go out.' } });
    fake().failNext.set('OUTLOOK_SEND_DRAFT', 'sent-then-timeout');
    await releaseHolds(w);
    let [e] = await effects('email.send');
    expect(e!.status).toBe('uncertain');
    expect(sent()).toHaveLength(1);
    expect(await executeEffect(w.workspaceId, e!.id)).toBeNull();
    await reconcileEffect(w.workspaceId, e!.id);
    [e] = await effects('email.send');
    expect(e).toMatchObject({ status: 'completed', external_id: sent()[0]!.id });
    expect(sent()).toHaveLength(1);
  });

  it('a timeout with no trace in Sent Items stays unconfirmed, and is never sent again', async () => {
    await w.cmd({ type: 'sendNew', draft: { to: ['mail:dana@client.test'], subject: 'Never left', body: 'x' } });
    fake().failNext.set('OUTLOOK_SEND_DRAFT', 'timeout');
    await releaseHolds(w);
    const [e] = await effects('email.send');
    expect(e!.status).toBe('uncertain');
    await reconcileEffect(w.workspaceId, e!.id);
    await executeEffect(w.workspaceId, e!.id);
    await jobs().drain();
    expect((await effects('email.send'))[0]!.status).toBe('uncertain');
    expect(sent()).toHaveLength(0);
    expect(calls('OUTLOOK_SEND_DRAFT')).toHaveLength(1);
  });
});

describe('filing in Outlook', () => {
  it('a place in Timmy becomes a category; the archive is the Archive folder; the inbox undoes both', async () => {
    const t = await deliver({ subject: 'Needs an answer' });
    mailbox().messages.find((m) => m.subject === 'Needs an answer')!.categories = ['Red category'];
    expect((await w.cmd({ type: 'move', id: t.id, box: 'follow-up' })).ok).toBe(true);
    const [e] = await effects('mail.modify');
    expect(e).toMatchObject({ status: 'approved', source: 'user', approved_by: w.userId });
    expect(e!.preview.title).toBe('File “Needs an answer” under Follow Up in Outlook');
    // The record comes first: nothing is written until the job runs.
    expect(calls('OUTLOOK_BATCH_UPDATE_MESSAGES')).toHaveLength(0);
    await jobs().drain();
    expect(where('Needs an answer')).toEqual([{ in: 'INBOX', categories: [LABEL_NAMES['follow-up'], 'Red category'].sort() }]);

    await w.cmd({ type: 'move', id: t.id, box: 'archived' });
    await jobs().drain();
    expect(where('Needs an answer')).toEqual([{ in: 'ARCHIVE', categories: ['Red category'] }]);

    await w.cmd({ type: 'move', id: t.id, box: 'inbox' });
    await jobs().drain();
    expect(where('Needs an answer')).toEqual([{ in: 'INBOX', categories: ['Red category'] }]);
    expect((await effects('mail.modify')).map((x) => x.status)).toEqual(['completed', 'completed', 'completed']);
    // Filing is private to the mailbox: nothing was sent, and nothing waits in Approvals.
    expect(sent()).toHaveLength(0);
    expect((await w.state()).pending).toHaveLength(0);
  });

  it('the person’s own copies in Sent Items are left as they are', async () => {
    const t = await deliver({ subject: 'Thread with my reply' });
    put({ subject: 'Thread with my reply', threadId: t.ext!.threadKey, from: 'owner@outlook.test', to: ['dana@client.test'], labels: ['SENT'], at: new Date(Date.now() + 1000) });
    await w.cmd({ type: 'move', id: t.id, box: 'archived' });
    await jobs().drain();
    expect(where('Thread with my reply')).toEqual([
      { in: 'ARCHIVE', categories: [] },
      { in: 'SENT', categories: [] },
    ]);
  });

  it('a long conversation is written in batches of twenty, and a batch that half-fails is finished on a second look', async () => {
    const t = await deliver({ subject: 'Long thread' });
    for (let i = 1; i < 25; i++) put({ subject: 'Long thread', threadId: t.ext!.threadKey, at: new Date(Date.now() + i * 1000) });
    fake().failNext.set('OUTLOOK_BATCH_UPDATE_MESSAGES', 'partial');
    await w.cmd({ type: 'move', id: t.id, box: 'waiting' });
    await jobs().drain();
    expect((await effects('mail.modify'))[0]).toMatchObject({ status: 'completed' });
    expect(where('Long thread').every((m) => m.categories.join() === LABEL_NAMES.waiting)).toBe(true);
    const sizes = calls('OUTLOOK_BATCH_UPDATE_MESSAGES').map((c) => (c.args.updates as unknown[]).length);
    // First look: 20 (of which one took) and 5. Second look: the 19 still missing.
    expect(sizes).toEqual([20, 5, 19]);
  });

  it('a change Outlook refuses outright is a clean failure, and an unknown outcome is settled by looking at the mailbox', async () => {
    const t = await deliver({ subject: 'Refused' });
    fake().failNext.set('OUTLOOK_BATCH_UPDATE_MESSAGES', 'error');
    await w.cmd({ type: 'move', id: t.id, box: 'follow-up' });
    await jobs().drain();
    expect((await effects('mail.modify'))[0]).toMatchObject({ status: 'failed' });
    expect(where('Refused')).toEqual([{ in: 'INBOX', categories: [] }]);

    const u = await deliver({ subject: 'Unknown' });
    fake().failNext.set('OUTLOOK_BATCH_UPDATE_MESSAGES', 'sent-then-timeout');
    await w.cmd({ type: 'move', id: u.id, box: 'read-through' });
    await jobs().drain();
    const e = (await effects('mail.modify')).find((x) => (x.payload as { threadKey: string }).threadKey === u.ext!.threadKey)!;
    expect(e.status).toBe('uncertain');
    await reconcileEffect(w.workspaceId, e.id);
    expect((await effects('mail.modify')).find((x) => x.id === e.id)).toMatchObject({ status: 'completed' });
    expect(calls('OUTLOOK_BATCH_UPDATE_MESSAGES').filter((c) => JSON.stringify(c.args).includes(LABEL_NAMES['read-through']))).toHaveLength(1);
  });
});

describe('disconnecting Outlook', () => {
  it('takes its threads off the screens and its stored mail out of the store', async () => {
    await deliver({ subject: 'Soon gone' });
    expect((await w.post('/api/v1/connections/outlook/disconnect', {})).status).toBe(200);
    await jobs().drain();
    expect((await w.state()).threads.map((t) => t.subject)).not.toContain('Soon gone');
    expect(await rows(`select 1 from item where workspace_id = $1`, [w.workspaceId])).toEqual([]);
    expect((await w.cmd({ type: 'sendNew', draft: { to: ['mail:x@y.test'], subject: 's', body: 'b' } })).error).toMatch(/Connect Gmail or Outlook first/);
  });
});
