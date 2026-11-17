/**
 * Three gaps in Outlook mail, closed:
 *   - the names of the files on received mail are shown, as Gmail's are, asked for once per new message that has any;
 *   - a mailbox with no Archive folder gets one, once, the first time a thread is archived, and the thread is filed;
 *   - a send that stops before its draft is sent removes that draft from Drafts, and never anything else.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EffectRow } from '../src/gateway/gateway';
import type { FakeAttachment, FakeMessage } from '../src/providers/composio';
import { MAX_ASKED } from '../src/sync/attachment-names';
import { backfillMail, reconcileMail } from '../src/sync/ingest';
import { LABEL_NAMES } from '../src/sync/labels';
import { boot, connectApp, fake, jobs, model, newWorkspace, releaseHolds, rows, samples, sysPool, uploadFile, type Client } from './helpers';

let w: Client;
let box: { connectionId: string; account: string };
const used: string[] = [];
const mailbox = () => fake().accounts.get(box.account)!;
const calls = (slug?: string) => fake().calls.filter((c) => c.connectedAccountId === box.account && (!slug || c.slug === slug));
const effects = (kind?: string) => rows<EffectRow>(`select * from effect where workspace_id = $1 and ($2::text is null or kind = $2) order by created_at, id`, [w.workspaceId, kind ?? null]);
const thread = async (subject: string) => (await w.state()).threads.find((t) => t.subject === subject.replace(/^Re: /, ''));
const deliver = async (message: Partial<FakeMessage> & { subject: string }) => {
  await w.post('/api/test/fake', { op: 'deliver', message: { from: 'Dana Whitfield <dana@client.test>', body: 'Could you take a look?', ...message } });
  await jobs().drain();
  return (await thread(message.subject))!;
};
const file = (name: string, extra: Partial<FakeAttachment> = {}): FakeAttachment => ({ name, mimetype: 'application/pdf', size: 1000, sha256: 'x', ...extra });
const drafts = () => mailbox().messages.filter((m) => m.labels.includes('DRAFT'));

async function connect(app: 'outlook' | 'gmail' = 'outlook', before?: () => void) {
  w = await newWorkspace(`Outlook gaps ${app}`);
  used.push(w.workspaceId);
  box = await connectApp(w, app, `owner@${app}-gaps.test`);
  before?.();
  await jobs().drain();
}

beforeAll(async () => {
  await boot();
});
beforeEach(() => {
  model().reset();
  jobs().queue = [];
  fake().failNext.clear();
});
afterEach(async () => {
  await sysPool.query(`update connection set status = 'disconnected', disconnected_at = now() where status in ('active', 'pending') and workspace_id = any($1::text[])`, [used.splice(0)]);
});
afterAll(() => {
  jobs().queue = [];
  fake().failNext.clear();
});

/* ═════════════════════════════ 5. Attachment names ═════════════════════════════ */

describe('the names of the files on Outlook mail', () => {
  beforeEach(() => connect());

  it('are shown on the message, as Gmail’s are; pictures inside the body are not files', async () => {
    const t = await deliver({ subject: 'The quote', attachments: [file('Quote.pdf'), file('Floor plan.png', { mimetype: 'image/png' }), file('image001.png', { mimetype: 'image/png', inline: true })] });
    expect(t.messages[0]!.attachments).toEqual(['Quote.pdf', 'Floor plan.png']);
    const [asked] = calls('OUTLOOK_LIST_OUTLOOK_ATTACHMENTS');
    expect(asked!.args).toEqual({ message_id: t.messages[0]!.id, response_detail: 'minimal' });
    const [stored] = await rows<{ meta: { attachments: string[] } }>(`select meta from item where workspace_id = $1 and kind = 'message'`, [w.workspaceId]);
    expect(stored!.meta.attachments).toEqual(['Quote.pdf', 'Floor plan.png']);
  });

  it('are asked for once per new message that has files: never for one without, never again when the thread is fetched again', async () => {
    const t = await deliver({ subject: 'Contract', attachments: [file('Contract.pdf')] });
    expect(calls('OUTLOOK_LIST_OUTLOOK_ATTACHMENTS')).toHaveLength(1);
    // A reply with no files: the whole thread is fetched again, and nothing is asked about either message.
    await deliver({ subject: 'Re: Contract', threadId: t.ext!.threadKey });
    // Mail with only a signature's logo has no files to ask about.
    await deliver({ subject: 'Signed off', attachments: [file('logo.png', { inline: true })] });
    expect(calls('OUTLOOK_LIST_OUTLOOK_ATTACHMENTS')).toHaveLength(1);
    // A second file on a later message is asked about, once.
    await deliver({ subject: 'Re: Contract', threadId: t.ext!.threadKey, attachments: [file('Annex.pdf')] });
    expect(calls('OUTLOOK_LIST_OUTLOOK_ATTACHMENTS')).toHaveLength(2);
    expect((await thread('Contract'))!.messages.map((m) => m.attachments ?? [])).toEqual([['Contract.pdf'], [], ['Annex.pdf']]);
  });

  it('a batch of mail asks about at most a set number of messages; a refusal leaves the message without names, not asked again', async () => {
    const n = MAX_ASKED + 5;
    for (let i = 0; i < n; i++) mailbox().messages.push({ id: `om-files-${w.workspaceId}-${i}`, threadId: `conv-files-${i}`, from: 'Dana Whitfield <dana@client.test>', to: [mailbox().address], subject: `Files ${i}`, body: 'Attached.', at: new Date(Date.now() - (i + 1) * 60_000), labels: ['INBOX'], attachments: [file(`File ${i}.pdf`)] });
    const before = calls('OUTLOOK_LIST_OUTLOOK_ATTACHMENTS').length;
    await reconcileMail(w.workspaceId, box.connectionId, { pageSize: 50 });
    expect(calls('OUTLOOK_LIST_OUTLOOK_ATTACHMENTS').length - before).toBe(MAX_ASKED);
    const named = (await w.state()).threads.filter((t) => t.messages[0]!.attachments?.length).length;
    expect(named).toBe(MAX_ASKED);
    // Read again, nothing already stored is asked about.
    await reconcileMail(w.workspaceId, box.connectionId, { pageSize: 50 });
    expect(calls('OUTLOOK_LIST_OUTLOOK_ATTACHMENTS').length - before).toBe(MAX_ASKED);

    fake().failNext.set('OUTLOOK_LIST_OUTLOOK_ATTACHMENTS', 'error');
    const t = await deliver({ subject: 'Refused list', attachments: [file('Hidden.pdf')] });
    expect(t.messages[0]!.attachments).toBeUndefined();
    const asked = calls('OUTLOOK_LIST_OUTLOOK_ATTACHMENTS').length;
    await deliver({ subject: 'Re: Refused list', threadId: t.ext!.threadKey });
    expect(calls('OUTLOOK_LIST_OUTLOOK_ATTACHMENTS')).toHaveLength(asked);
  });

  it('the first read of the mailbox names them too, page by page', async () => {
    for (let i = 0; i < 4; i++) mailbox().messages.push({ id: `om-first-${w.workspaceId}-${i}`, threadId: `conv-first-${i}`, from: 'Dana Whitfield <dana@client.test>', to: [mailbox().address], subject: `First ${i}`, body: 'Hello.', at: new Date(Date.now() - (i + 1) * 60_000), labels: ['INBOX'], ...(i % 2 ? { attachments: [file(`Doc ${i}.pdf`)] } : {}) });
    await backfillMail(w.workspaceId, box.connectionId, { days: 40, pageSize: 2, pauseMs: 0 });
    expect(calls('OUTLOOK_LIST_OUTLOOK_ATTACHMENTS')).toHaveLength(2);
    const s = await w.state();
    expect(s.threads.find((t) => t.subject === 'First 1')!.messages[0]!.attachments).toEqual(['Doc 1.pdf']);
    expect(s.threads.find((t) => t.subject === 'First 0')!.messages[0]!.attachments).toBeUndefined();
  });
});

describe('Gmail, for comparison', () => {
  it('names the files from its own listing, with no call of its own', async () => {
    await connect('gmail');
    const t = await deliver({ subject: 'Gmail files', attachments: [file('Brochure.pdf')] });
    expect(t.messages[0]!.attachments).toEqual(['Brochure.pdf']);
    expect(calls().filter((c) => c.slug.startsWith('OUTLOOK_'))).toEqual([]);
  });
});

/* ═════════════════════════════ 6. No Archive folder ═════════════════════════════ */

describe('archiving in an Outlook mailbox that has no Archive folder', () => {
  const where = (subject: string) => mailbox().messages.filter((m) => m.subject === subject).map((m) => m.labels.filter((l) => ['INBOX', 'ARCHIVE'].includes(l)).join());

  it('makes the folder once, the first time a thread is archived, and files the thread there', async () => {
    await connect('outlook', () => {
      mailbox().noArchive = true;
    });
    const a = await deliver({ subject: 'First to archive' });
    await w.cmd({ type: 'move', id: a.id, box: 'follow-up' });
    await jobs().drain();
    // Filing under a category needs no folder.
    expect(calls('OUTLOOK_CREATE_MAIL_FOLDER')).toHaveLength(0);
    await w.cmd({ type: 'move', id: a.id, box: 'archived' });
    await jobs().drain();
    expect(calls('OUTLOOK_CREATE_MAIL_FOLDER').map((c) => c.args)).toEqual([{ display_name: 'Archive', return_existing_if_exists: true }]);
    const made = mailbox().folders!.get('Archive')!;
    expect(calls('OUTLOOK_BATCH_MOVE_MESSAGES').map((c) => c.args.destination_id)).toEqual([made]);
    expect(where('First to archive')).toEqual(['ARCHIVE']);
    expect(mailbox().messages.find((m) => m.subject === 'First to archive')!.categories).toEqual([]);
    const filed = (await effects('mail.modify')).at(-1)!;
    expect(filed).toMatchObject({ status: 'completed' });
    expect(filed.result).toMatchObject({ madeFolder: 'Archive' });
    const [conn] = await rows<{ meta: { folders: Record<string, unknown> } }>('select meta from connection where id = $1', [box.connectionId]);
    expect(conn!.meta.folders).toMatchObject({ archive: made, madeArchive: true });

    // A second thread goes to the same folder; nothing is made again.
    const b = await deliver({ subject: 'Second to archive' });
    await w.cmd({ type: 'move', id: b.id, box: 'archived' });
    await jobs().drain();
    expect(calls('OUTLOOK_CREATE_MAIL_FOLDER')).toHaveLength(1);
    expect(where('Second to archive')).toEqual(['ARCHIVE']);
    expect((await effects('mail.modify')).at(-1)!.result).not.toHaveProperty('madeFolder');

    // Mail in the folder Timmy made reads as archived, and moving it back to the inbox works.
    await w.cmd({ type: 'move', id: a.id, box: 'inbox' });
    await jobs().drain();
    expect(where('First to archive')).toEqual(['INBOX']);
    expect((await effects('mail.modify')).map((e) => e.status)).toEqual(['completed', 'completed', 'completed', 'completed']);
  });

  it('when Outlook will not make the folder, the filing fails cleanly and nothing in the mailbox changes', async () => {
    await connect('outlook', () => {
      mailbox().noArchive = true;
    });
    const t = await deliver({ subject: 'Cannot archive' });
    await w.cmd({ type: 'move', id: t.id, box: 'follow-up' });
    await jobs().drain();
    fake().failNext.set('OUTLOOK_CREATE_MAIL_FOLDER', 'error');
    await w.cmd({ type: 'move', id: t.id, box: 'archived' });
    await jobs().drain();
    const e = (await effects('mail.modify')).at(-1)!;
    expect(e).toMatchObject({ status: 'failed' });
    expect(e.error).toMatch(/no Archive folder, and Outlook would not make one/);
    // The category was not taken off and nothing moved: the folder is settled before anything is changed.
    expect(where('Cannot archive')).toEqual(['INBOX']);
    expect(mailbox().messages.find((m) => m.subject === 'Cannot archive')!.categories).toEqual([LABEL_NAMES['follow-up']]);
    expect(calls('OUTLOOK_BATCH_MOVE_MESSAGES')).toHaveLength(0);
  });

  it('a mailbox that has its Archive folder is never given another', async () => {
    await connect();
    const t = await deliver({ subject: 'Normal archive' });
    await w.cmd({ type: 'move', id: t.id, box: 'archived' });
    await jobs().drain();
    expect(calls('OUTLOOK_CREATE_MAIL_FOLDER')).toHaveLength(0);
    expect(calls('OUTLOOK_BATCH_MOVE_MESSAGES').map((c) => c.args.destination_id)).toEqual(['archive']);
    expect(where('Normal archive')).toEqual(['ARCHIVE']);
  });
});

/* ═════════════════════════════ 7. Drafts left behind ═════════════════════════════ */

describe('a draft a stopped send made is removed, and nothing else', () => {
  beforeEach(async () => {
    await connect();
    // The person's own draft, sitting in Drafts. Nothing Timmy does may touch it.
    mailbox().messages.push({ id: `om-mine-${w.workspaceId}`, threadId: 'conv-mine', from: mailbox().address, to: ['sam@client.test'], subject: 'My own draft', body: 'Half written.', at: new Date(), labels: ['DRAFT'] });
  });
  const mine = () => drafts().filter((m) => m.subject === 'My own draft');

  it('a reply Outlook refused: the reply’s draft is removed, the record says so, and the person’s own draft stays', async () => {
    const t = await deliver({ subject: 'Refused reply' });
    await w.cmd({ type: 'reply', id: t.id, body: 'Answer' });
    fake().failNext.set('OUTLOOK_UPDATE_EMAIL', 'error');
    await releaseHolds(w);
    const [e] = await effects('email.reply');
    expect(e).toMatchObject({ status: 'failed' });
    // The draft the reply made is the one it tried to address.
    const made = calls('OUTLOOK_UPDATE_EMAIL')[0]!.args.message_id as string;
    expect(made).toBeTruthy();
    expect(e!.result).toEqual({ draft: made, draftRemoved: true });
    expect(calls('OUTLOOK_DELETE_MESSAGE').map((c) => c.args)).toEqual([{ message_id: made }]);
    expect(drafts().map((m) => m.subject)).toEqual(['My own draft']);
    expect(fake().sent(box.account)).toEqual([]);
  });

  it('a draft not addressed as approved is removed too, before anything is sent', async () => {
    await w.cmd({ type: 'sendNew', draft: { to: ['mail:dana@client.test'], subject: 'Just Dana', body: 'For Dana only.' } });
    const real = fake().execute.bind(fake());
    fake().execute = async (slug, args, who) => {
      const res = await real(slug, args, who);
      if (slug === 'OUTLOOK_CREATE_DRAFT') {
        mailbox().messages.find((x) => x.id === res.data.id)!.cc = ['stranger@elsewhere.test'];
        return { ...res, data: { ...res.data, ccRecipients: [{ emailAddress: { address: 'stranger@elsewhere.test' } }] } };
      }
      return res;
    };
    try {
      await releaseHolds(w);
    } finally {
      fake().execute = real;
    }
    const [e] = await effects('email.send');
    expect(e).toMatchObject({ status: 'failed', result: { draftRemoved: true } });
    expect(drafts().map((m) => m.subject)).toEqual(['My own draft']);
    expect(calls('OUTLOOK_SEND_DRAFT')).toHaveLength(0);
  });

  it('a file Outlook would not take: the draft with half its files is removed', async () => {
    const up = await uploadFile(w, { purpose: 'attachment', type: 'application/pdf', bytes: samples.pdf('Quote'), name: 'Quote.pdf' });
    const t = await deliver({ subject: 'Files please' });
    await w.cmd({ type: 'reply', id: t.id, body: 'Here it is.', files: [{ id: up.assetId, name: 'Quote.pdf', type: 'application/pdf', size: samples.pdf('Quote').length }] });
    fake().failNext.set('OUTLOOK_ADD_MAIL_ATTACHMENT', 'error');
    await releaseHolds(w);
    const [e] = await effects('email.reply');
    expect(e).toMatchObject({ status: 'failed', result: { draftRemoved: true } });
    expect(e!.error).toMatch(/refused the attached file/);
    expect(drafts().map((m) => m.subject)).toEqual(['My own draft']);
  });

  it('when the draft can’t be removed, the record says it is still there; the send still fails cleanly', async () => {
    const t = await deliver({ subject: 'Stuck draft' });
    await w.cmd({ type: 'reply', id: t.id, body: 'Answer' });
    fake().failNext.set('OUTLOOK_UPDATE_EMAIL', 'error');
    fake().failNext.set('OUTLOOK_DELETE_MESSAGE', 'error');
    await releaseHolds(w);
    const [e] = await effects('email.reply');
    expect(e).toMatchObject({ status: 'failed', result: { draftRemoved: false } });
    expect(drafts().map((m) => m.subject).sort()).toEqual(['My own draft', 'Re: Stuck draft']);
  });

  it('a send refused at the very last step leaves its draft, since whether it started can’t be told; an unknown outcome deletes nothing', async () => {
    const t = await deliver({ subject: 'Last step' });
    await w.cmd({ type: 'reply', id: t.id, body: 'Answer' });
    fake().failNext.set('OUTLOOK_SEND_DRAFT', 'error');
    await releaseHolds(w);
    const [e] = await effects('email.reply');
    expect(e).toMatchObject({ status: 'failed', result: { draftRemoved: false } });

    const u = await deliver({ subject: 'No answer' });
    await w.cmd({ type: 'reply', id: u.id, body: 'Answer' });
    fake().failNext.set('OUTLOOK_UPDATE_EMAIL', 'timeout');
    await releaseHolds(w);
    expect((await effects('email.reply')).at(-1)).toMatchObject({ status: 'uncertain' });
    expect(calls('OUTLOOK_DELETE_MESSAGE')).toHaveLength(0);
    expect(mine()).toHaveLength(1);
  });
});
