/**
 * What the person does in Gmail or Outlook itself is picked up in Timmy: a thread archived there, put back in
 * the inbox, given one of Timmy's labels, read, or deleted. A change that came from the mailbox is applied to
 * Timmy's state and is never written back: no effect record, and no call that changes the mailbox.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { morningRun } from '../src/agent/morning';
import type { EffectRow } from '../src/gateway/gateway';
import { ingestThread, reconcileMail } from '../src/sync/ingest';
import { LABEL_NAMES, type Labelled } from '../src/sync/labels';
import type { MessageState } from '../src/sync/mailbox';
import { seenIn } from '../src/sync/mailbox-changes';
import { appLoaded, checkMailbox, checkWhileOpen } from '../src/sync/mailbox-check';
import { appPool, boot, connectApp, fake, jobs, model, newWorkspace, rows, sysPool, withWorkspace, type Client } from './helpers';

const DAY = 86400_000;
const TIMMY_NAMES: readonly string[] = Object.values(LABEL_NAMES);
/** The one call a look makes, and the call a filing by Timmy makes first, per mailbox. */
const LIST = { gmail: 'GMAIL_FETCH_EMAILS', outlook: 'OUTLOOK_LIST_MESSAGES' } as const;
const WRITE = { gmail: 'GMAIL_MODIFY_THREAD_LABELS', outlook: 'OUTLOOK_BATCH_UPDATE_MESSAGES' } as const;
/** Every call that only reads. Anything else on the list of calls would be a write to the mailbox. */
const READS = ['GMAIL_FETCH_EMAILS', 'GMAIL_LIST_LABELS', 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID', 'OUTLOOK_LIST_MESSAGES', 'OUTLOOK_GET_MAIL_FOLDER'];

beforeAll(async () => {
  await boot();
});

describe('reading what a thread’s messages say', () => {
  const m = (labels: string[], filedAs: Labelled[] = [], at = 0, mine = labels.includes('SENT')): MessageState => ({ id: `m${Math.random()}`, threadKey: 't', at: new Date(1_000_000 + at), labels, filedAs, mine });

  it('a thread is in the inbox while any message is, and unread while any received message is', () => {
    expect(seenIn([m(['INBOX', 'UNREAD']), m(['SENT'])])).toEqual({ inInbox: true, labels: [], unread: true, gone: false });
    expect(seenIn([m([]), m(['INBOX'])])).toEqual({ inInbox: true, labels: [], unread: false, gone: false });
    expect(seenIn([m(['ARCHIVE']), m(['SENT'])])).toEqual({ inInbox: false, labels: [], unread: false, gone: false });
    // The person's own unread flag on a sent copy means nothing.
    expect(seenIn([m([]), m(['SENT', 'UNREAD'])])!.unread).toBe(false);
  });

  it('the newest received message says which of Timmy’s places it is filed under', () => {
    expect(seenIn([m(['INBOX'], ['waiting'], 1), m(['SENT'], [], 2)])!.labels).toEqual(['waiting']);
    // A reply that arrived after the thread was labelled carries no label: the thread is plain inbox mail again.
    expect(seenIn([m(['INBOX'], ['waiting'], 1), m(['INBOX', 'UNREAD'], [], 2)])!.labels).toEqual([]);
    expect(seenIn([m(['INBOX'], ['read-through', 'follow-up'])])!.labels).toEqual(['follow-up', 'read-through']);
    // The person's own reply that is not in Sent yet (in the outbox, or scheduled) is not the newest received message.
    expect(seenIn([m(['INBOX'], ['waiting'], 1), m([], [], 2, true)])).toEqual({ inInbox: true, labels: ['waiting'], unread: false, gone: false });
    // A note to oneself sits in the inbox too, and is read like any received message.
    expect(seenIn([m(['INBOX', 'SENT', 'UNREAD'], ['follow-up'])])).toEqual({ inInbox: true, labels: ['follow-up'], unread: true, gone: false });
    // A thread the person started, filed under Waiting and then archived in Gmail: their own message carries the label, and counts.
    expect(seenIn([m(['SENT'], ['waiting'])])).toEqual({ inInbox: false, labels: ['waiting'], unread: false, gone: false });
  });

  it('it is gone when every received message is in the trash or in spam, and says nothing when only sent copies or drafts were seen', () => {
    expect(seenIn([m(['TRASH']), m(['SENT'])])).toMatchObject({ gone: true, spam: false });
    expect(seenIn([m(['SPAM', 'UNREAD'])])).toMatchObject({ gone: true, spam: true });
    expect(seenIn([m(['TRASH']), m(['INBOX'])])).toMatchObject({ gone: false, inInbox: true });
    // One of the person's own messages thrown away says nothing about the thread.
    expect(seenIn([m(['SENT', 'TRASH']), m(['SENT'])])).toBeNull();
    expect(seenIn([m(['SENT'])])).toBeNull();
    expect(seenIn([m(['DRAFT'])])).toBeNull();
    expect(seenIn([])).toBeNull();
  });
});

describe.each(['gmail', 'outlook'] as const)('changes made in the mailbox itself (%s)', (app) => {
  const name = app === 'gmail' ? 'Gmail' : 'Outlook';
  const mark = app === 'gmail' ? 'label' : 'category';
  let w: Client;
  let box: { connectionId: string; account: string };

  const mailbox = () => fake().accounts.get(box.account)!;
  const of = (subject: string) => mailbox().messages.filter((m) => m.subject.replace(/^Re: /, '') === subject);
  const received = (subject: string) => of(subject).filter((m) => !m.labels.includes('SENT'));
  /** What the person does in their own mail app. Nothing here goes through Timmy. */
  const person = {
    /** Moves a thread's received messages: to the inbox, the archive, the trash or spam. */
    put(subject: string, where: 'INBOX' | 'ARCHIVE' | 'TRASH' | 'SPAM') {
      for (const m of received(subject)) {
        const rest = m.labels.filter((l) => !['INBOX', 'ARCHIVE', 'TRASH', 'SPAM'].includes(l));
        // Gmail has no archive folder: archived mail is mail that is not in the inbox.
        m.labels = app === 'gmail' && where === 'ARCHIVE' ? rest : [...rest, where];
      }
    },
    /** Leaves exactly these of Timmy's labels (Gmail) or categories (Outlook) on the thread. */
    marks(subject: string, places: Labelled[]) {
      if (app === 'outlook') {
        for (const m of received(subject)) m.categories = [...(m.categories ?? []).filter((c) => !TIMMY_NAMES.includes(c)), ...places.map((p) => LABEL_NAMES[p])];
        return;
      }
      // In Gmail a label has an id, whoever made it: Timmy, or the person by hand.
      const labels = mailbox().labels;
      for (const n of TIMMY_NAMES) if (!labels.has(n)) labels.set(n, `Label_${labels.size + 1}`);
      const timmy = TIMMY_NAMES.map((n) => labels.get(n)!);
      for (const m of of(subject)) m.labels = [...m.labels.filter((l) => !timmy.includes(l)), ...places.map((p) => labels.get(LABEL_NAMES[p])!)];
    },
    read(subject: string, yes: boolean) {
      for (const m of received(subject)) m.labels = yes ? m.labels.filter((l) => l !== 'UNREAD') : [...new Set([...m.labels, 'UNREAD'])];
    },
  };

  const thread = async (subject: string, who: Client = w) => (await who.state()).threads.find((t) => t.subject === subject);
  const deliver = async (subject: string, extra: Record<string, unknown> = {}, who: Client = w) => {
    await who.post('/api/test/fake', { op: 'deliver', message: { from: 'Dana Whitfield <dana@client.test>', subject, body: 'Could you take a look?', ...extra } });
    await jobs().drain();
    return (await thread(subject.replace(/^Re: /, ''), who))!;
  };
  const check = (opts?: Parameters<typeof checkMailbox>[2]) => checkMailbox(w.workspaceId, box.connectionId, opts);
  const effects = () => rows<EffectRow>('select * from effect where workspace_id = $1 order by created_at, id', [w.workspaceId]);
  const calls = () => fake().calls.filter((c) => c.connectedAccountId === box.account).map((c) => c.slug);
  /** Lets time pass: everything this workspace's filings and looks recorded is that many minutes older. */
  const later = async (minutes: number) => {
    await sysPool.query(`update effect set created_at = created_at - make_interval(mins => $2), executing_at = executing_at - make_interval(mins => $2), completed_at = completed_at - make_interval(mins => $2) where workspace_id = $1`, [w.workspaceId, minutes]);
    await sysPool.query(`update mailbox_seen set seen_at = seen_at - make_interval(mins => $2) where workspace_id = $1`, [w.workspaceId, minutes]);
    await sysPool.query(`update sync_cursor set started_at = started_at - make_interval(mins => $2) where workspace_id = $1 and kind = 'changes'`, [w.workspaceId, minutes]);
    await sysPool.query(`update command set at = at - make_interval(mins => $2) where workspace_id = $1`, [w.workspaceId, minutes]);
    await sysPool.query(`update run set created_at = created_at - make_interval(mins => $2) where workspace_id = $1`, [w.workspaceId, minutes]);
  };

  beforeEach(async () => {
    model().reset();
    jobs().queue = [];
    w = await newWorkspace('Mailbox');
    box = await connectApp(w, app, `owner@${app}-changes.test`);
    await jobs().drain();
  });

  it(`a thread archived in ${name} moves to Archived, with a line that says where it was archived`, async () => {
    const t = await deliver('Quarterly numbers');
    expect(t).toMatchObject({ box: 'inbox', unread: true });
    person.put('Quarterly numbers', 'ARCHIVE');
    const before = calls().length;
    expect(await check()).toMatchObject({ ran: true, calls: 1, moved: 1, marked: 0, removed: 0, leftAlone: 0 });
    const after = (await thread('Quarterly numbers'))!;
    // Only the place changed: it is still unread, as it is in the mailbox.
    expect(after).toMatchObject({ box: 'archived', unread: true });
    expect(after.history!.at(-1)!.text).toBe(`Archived in ${name}`);
    expect((await w.state()).activity[0]).toMatchObject({ kind: 'move', threadId: t.id, text: `“Quarterly numbers” was archived in ${name}` });
    // It was picked up, not written back: no effect record, and the one call made was the listing.
    expect(await effects()).toEqual([]);
    expect(calls().slice(before)).toEqual([LIST[app]]);
  });

  it('back in the inbox after being archived, it returns to Timmy’s inbox, or to the place its label names', async () => {
    const suggested = (await deliver('Plain')).suggestion;
    expect(suggested).toBeTruthy();
    await deliver('Labelled');
    person.put('Plain', 'ARCHIVE');
    person.put('Labelled', 'ARCHIVE');
    expect(await check()).toMatchObject({ moved: 2 });
    expect((await thread('Plain'))!.box).toBe('archived');

    person.put('Plain', 'INBOX');
    person.put('Labelled', 'INBOX');
    person.marks('Labelled', ['waiting']);
    expect(await check()).toMatchObject({ moved: 2 });
    const plain = (await thread('Plain'))!;
    expect(plain.box).toBe('inbox');
    expect(plain.history!.map((h) => h.text).slice(-2)).toEqual([`Archived in ${name}`, `Moved back to the inbox in ${name}`]);
    // It comes back as it left: Triage shows a suggestion for every inbox thread, and this one still has its own.
    expect(plain.suggestion).toEqual(suggested);
    const labelled = (await thread('Labelled'))!;
    expect(labelled.box).toBe('waiting');
    expect(labelled.history!.at(-1)!.text).toBe(`Filed under Waiting in ${name}`);
    // A thread under Waiting always says who is waited on, as it does when it is moved there in Timmy.
    expect(labelled.waiting).toMatchObject({ on: 'mail:dana@client.test', item: 'A reply' });
    expect(await effects()).toEqual([]);
  });

  it(`one of Timmy’s ${mark === 'label' ? 'labels' : 'categories'} put on, changed or removed in ${name} moves the thread to match`, async () => {
    await deliver('Contract draft');
    const before = calls().length;
    person.marks('Contract draft', ['follow-up']);
    expect(await check()).toMatchObject({ moved: 1 });
    expect(await thread('Contract draft')).toMatchObject({ box: 'follow-up' });
    expect((await thread('Contract draft'))!.history!.at(-1)!.text).toBe(`Filed under Follow Up in ${name}`);

    // A second one put on beside the first is the newer wish; taking it off again leaves the first.
    person.marks('Contract draft', ['follow-up', 'read-through']);
    await check();
    expect((await thread('Contract draft'))!.box).toBe('read-through');
    person.marks('Contract draft', ['follow-up']);
    await check();
    expect((await thread('Contract draft'))!.box).toBe('follow-up');

    person.marks('Contract draft', ['waiting']);
    await check();
    expect((await thread('Contract draft'))!.box).toBe('waiting');

    // All three removed while it is in the inbox: back to Timmy's inbox.
    person.marks('Contract draft', []);
    await check();
    const t = (await thread('Contract draft'))!;
    expect(t.box).toBe('inbox');
    expect(t.history!.at(-1)!.text).toBe(`Timmy’s ${mark} was removed in ${name}, so this is back in the inbox`);
    expect((await w.state()).activity[0]!.text).toBe(`Timmy’s ${mark} was removed from “Contract draft” in ${name}, so it is back in the inbox`);

    // Nothing was written, and no label was made: finding Timmy's labels in Gmail is one read, remembered for a day.
    expect(await effects()).toEqual([]);
    const made = calls().slice(before);
    expect(made.filter((s) => !READS.includes(s))).toEqual([]);
    expect(made.filter((s) => s === 'GMAIL_LIST_LABELS').length).toBe(app === 'gmail' ? 1 : 0);
  });

  it('the person’s own reply that has not reached Sent yet is not read as the thread losing its label', async () => {
    const t = await deliver('Reply scheduled');
    person.marks('Reply scheduled', ['waiting']);
    await check();
    expect((await thread('Reply scheduled'))!.box).toBe('waiting');
    // Written from the mailbox's own address, newer than everything else, and in no folder Timmy knows: an outbox, or a send scheduled for later.
    mailbox().messages.push({ id: `own-${w.workspaceId}`, threadId: t.ext!.threadKey!, from: mailbox().address, to: ['dana@client.test'], subject: 'Re: Reply scheduled', body: 'Will do.', at: new Date(Date.now() + 1000), labels: [] });
    expect(await check()).toMatchObject({ moved: 0, unclear: 0 });
    expect((await thread('Reply scheduled'))!.box).toBe('waiting');
  });

  it('the unread mark follows the mailbox, and reading a thread in Timmy is not undone by it', async () => {
    const t = await deliver('Read me');
    expect(t.unread).toBe(true);
    person.read('Read me', true);
    expect(await check()).toMatchObject({ marked: 1, moved: 0 });
    const read = (await thread('Read me'))!;
    expect(read).toMatchObject({ unread: false, box: 'inbox' });
    // A read mark is not something to log.
    expect(read.history ?? []).toEqual(t.history ?? []);

    person.read('Read me', false);
    expect(await check()).toMatchObject({ marked: 1 });
    expect((await thread('Read me'))!.unread).toBe(true);

    // Opened in Timmy: read here, still unread in the mailbox. That is not a change made in the mailbox.
    await w.cmd({ type: 'openThread', id: t.id });
    expect(await check()).toMatchObject({ marked: 0 });
    expect((await thread('Read me'))!.unread).toBe(false);
    // Nor when the same look picks up something else about the thread.
    person.marks('Read me', ['follow-up']);
    expect(await check()).toMatchObject({ moved: 1, marked: 0 });
    expect(await thread('Read me')).toMatchObject({ box: 'follow-up', unread: false });
    expect(await effects()).toEqual([]);
  });

  it(`deleted or marked as spam in ${name}, a thread leaves Timmy’s screens; its stored copy stays, and out of the trash it is shown again`, async () => {
    await deliver('You have won');
    await deliver('Old offer');
    person.put('You have won', 'SPAM');
    person.put('Old offer', 'TRASH');
    expect(await check()).toMatchObject({ removed: 2, moved: 0 });
    expect(await thread('You have won')).toBeUndefined();
    expect(await thread('Old offer')).toBeUndefined();
    const said = (await w.state()).activity.slice(0, 2).map((a) => a.text).sort();
    expect(said).toEqual([`“Old offer” was deleted in ${name}, so it is no longer shown in Timmy`, `“You have won” was marked as spam in ${name}, so it is no longer shown in Timmy`]);
    // The stored copy is not deleted here: it follows the same retention as all synced mail.
    const stored = await rows<{ subject: string; labels: string[] }>(`select subject, labels from item where workspace_id = $1 and kind = 'message' order by subject`, [w.workspaceId]);
    expect(stored.map((s) => [s.subject, s.labels.includes('TRASH') || s.labels.includes('SPAM')])).toEqual([['Old offer', true], ['You have won', true]]);

    // The nightly re-read of the mailbox does not bring it back.
    await reconcileMail(w.workspaceId, box.connectionId);
    expect(await thread('Old offer')).toBeUndefined();
    expect(await check()).toMatchObject({ removed: 0, back: [] });

    // Taken out of the trash again, it is in the inbox like any other mail.
    person.put('Old offer', 'INBOX');
    expect((await check()).back).toHaveLength(1);
    expect(await thread('Old offer')).toMatchObject({ box: 'inbox' });
    expect(await thread('You have won')).toBeUndefined();
    expect(await effects()).toEqual([]);
    expect(calls().filter((s) => !READS.includes(s) && !s.endsWith('_GET_PROFILE'))).toEqual([]);
  });

  it('every kind of change at once is picked up in one look, with no effect record, no approval and no write to the mailbox', async () => {
    for (const s of ['To archive', 'To label', 'To read', 'To delete', 'Untouched']) await deliver(s);
    person.put('To archive', 'ARCHIVE');
    person.marks('To label', ['read-through']);
    person.read('To read', true);
    person.put('To delete', 'TRASH');
    const before = calls().length;
    expect(await check()).toMatchObject({ calls: 1, moved: 2, marked: 1, removed: 1 });
    const s = await w.state();
    expect(Object.fromEntries(s.threads.map((t) => [t.subject, t.box]))).toEqual({ 'To archive': 'archived', 'To label': 'read-through', 'To read': 'inbox', Untouched: 'inbox' });
    expect(s.pending).toEqual([]);
    expect(await effects()).toEqual([]);
    expect(await rows(`select 1 from audit_log where workspace_id = $1 and action like 'effect.%'`, [w.workspaceId])).toEqual([]);
    expect(calls().slice(before).filter((c) => !READS.includes(c))).toEqual([]);
    expect(fake().sent(box.account)).toEqual([]);
  });

  it('a thread Timmy is filing is left alone, and what the person did to it is picked up once the filing has settled', async () => {
    // Timmy's filing has not run yet when the person archives the thread in the mailbox.
    const a = await deliver('Filing on its way');
    await w.cmd({ type: 'move', id: a.id, box: 'follow-up' });
    expect((await effects())[0]).toMatchObject({ kind: 'mail.modify', status: 'approved' });
    person.put('Filing on its way', 'ARCHIVE');
    expect(await check()).toMatchObject({ leftAlone: 1, moved: 0 });
    expect((await thread('Filing on its way'))!.box).toBe('follow-up');
    // The filing runs. It only just arrived, so the thread is still left alone.
    await jobs().drain();
    expect((await effects())[0]!.status).toBe('completed');
    expect(await check()).toMatchObject({ leftAlone: 1, moved: 0 });
    // Settled: the mailbox shows Timmy's filing, which came after the person's archiving. Nothing to pick up.
    await later(10);
    expect(await check()).toMatchObject({ leftAlone: 0, moved: 0 });
    expect((await thread('Filing on its way'))!.box).toBe('follow-up');

    // The other order: Timmy's filing completed, and right after it the person archives the thread in the mailbox.
    const b = await deliver('Filed, then archived');
    await w.cmd({ type: 'move', id: b.id, box: 'follow-up' });
    await jobs().drain();
    person.put('Filed, then archived', 'ARCHIVE');
    expect(await check()).toMatchObject({ leftAlone: 1, moved: 0 });
    expect((await thread('Filed, then archived'))!.box).toBe('follow-up');
    await later(10);
    expect(await check()).toMatchObject({ leftAlone: 0, moved: 1 });
    const picked = (await thread('Filed, then archived'))!;
    expect(picked.box).toBe('archived');
    expect(picked.history!.at(-1)!.text).toBe(`Archived in ${name}`);
    // Picking it up filed nothing: the two records are the two moves made in Timmy.
    expect((await effects()).map((e) => e.status)).toEqual(['completed', 'completed']);
  });

  it('a filing whose outcome is unknown holds the thread while it is being checked; after that the place is left as the person has it in Timmy', async () => {
    const t = await deliver('Timed out');
    fake().failNext.set(WRITE[app], 'sent-then-timeout');
    await w.cmd({ type: 'move', id: t.id, box: 'follow-up' });
    await jobs().drain('effect.execute');
    expect((await effects())[0]!.status).toBe('uncertain');
    person.put('Timed out', 'ARCHIVE');
    expect(await check()).toMatchObject({ leftAlone: 1, moved: 0 });
    // Half an hour on nobody is checking the filing any more. What the mailbox shows may be its doing or the
    // person's, so the place is not touched; it is only remembered.
    await later(40);
    expect(await check()).toMatchObject({ leftAlone: 0, moved: 0 });
    expect((await thread('Timed out'))!.box).toBe('follow-up');
    // From here on a change made in the mailbox is picked up as usual.
    person.put('Timed out', 'INBOX');
    await check();
    person.put('Timed out', 'ARCHIVE');
    expect(await check()).toMatchObject({ moved: 1 });
    expect((await thread('Timed out'))!.box).toBe('archived');
  });

  it('Timmy’s own filing is not taken for a change made in the mailbox, and a thread moved in Timmy stays where the person put it', async () => {
    const t = await deliver('Mine to place');
    await w.cmd({ type: 'move', id: t.id, box: 'follow-up' });
    await jobs().drain();
    await later(10);
    const lines = (await thread('Mine to place'))!.history?.length ?? 0;
    expect(await check()).toMatchObject({ moved: 0, leftAlone: 0 });
    expect((await thread('Mine to place'))!.box).toBe('follow-up');
    expect((await thread('Mine to place'))!.history?.length ?? 0).toBe(lines);

    // A second thread is filed by Timmy too, and no look sees that filing before the next step.
    const u = await deliver('Never looked at');
    await w.cmd({ type: 'move', id: u.id, box: 'waiting' });
    await jobs().drain();
    await later(10);

    // With sending switched off a move in Timmy is not written to the mailbox, which goes on showing the old place.
    // The mailbox did not change, so neither thread is pulled back: what it shows is Timmy's own earlier filing.
    await w.request('PATCH', '/api/v1/settings', { killSwitch: true });
    expect((await w.cmd({ type: 'move', id: t.id, box: 'archived' })).ok).toBe(true);
    expect((await w.cmd({ type: 'move', id: u.id, box: 'archived' })).ok).toBe(true);
    expect(await check()).toMatchObject({ moved: 0 });
    expect((await thread('Mine to place'))!.box).toBe('archived');
    expect((await thread('Never looked at'))!.box).toBe('archived');
    expect(await effects()).toHaveLength(2);
  });

  it(`Timmy’s filing undone in ${name} is picked up, though the mailbox then looks as it did before the filing`, async () => {
    const t = await deliver('Undone there');
    await w.cmd({ type: 'move', id: t.id, box: 'follow-up' });
    await jobs().drain();
    // Before any look saw the filing, the person takes Timmy's label off again.
    person.marks('Undone there', []);
    await later(10);
    expect(await check()).toMatchObject({ moved: 1 });
    const after = (await thread('Undone there'))!;
    expect(after.box).toBe('inbox');
    expect(after.history!.at(-1)!.text).toBe(`Timmy’s ${mark} was removed in ${name}, so this is back in the inbox`);
    // Sorting it in Timmy had used up Timmy's suggestion. An inbox thread always shows one, so it gets a plain guess that says why.
    expect(after.suggestion).toEqual({ box: 'follow-up', confidence: 'low', reason: `Timmy’s ${mark} was removed in ${name}, so this is back in the inbox. Timmy is guessing where it belongs.` });
    expect(await effects()).toHaveLength(1);
  });

  it('archiving a waiting thread in the mailbox keeps its wait and its draft; moving it to another place ends the wait, as in Timmy', async () => {
    const t = await deliver('Signed copy');
    model().script.push({ content: JSON.stringify({ body: 'Any news on the signed copy?' }) });
    await w.cmd({ type: 'makeDraft', id: t.id });
    await jobs().drain();
    await w.cmd({ type: 'move', id: t.id, box: 'waiting' });
    await jobs().drain();
    await later(10);
    await check();
    const waiting = (await thread('Signed copy'))!;
    expect(waiting.box).toBe('waiting');
    expect(waiting.waiting).toBeTruthy();
    expect(waiting.draft).toBeTruthy();

    person.put('Signed copy', 'ARCHIVE');
    expect(await check()).toMatchObject({ moved: 1 });
    const archived = (await thread('Signed copy'))!;
    expect(archived.box).toBe('archived');
    expect(archived.waiting).toEqual(waiting.waiting);
    expect(archived.draft).toEqual(waiting.draft);

    // Back in the inbox, still marked Waiting: under Waiting again, with the wait it had.
    person.put('Signed copy', 'INBOX');
    expect(await check()).toMatchObject({ moved: 1 });
    const again = (await thread('Signed copy'))!;
    expect(again.box).toBe('waiting');
    expect(again.waiting).toEqual(waiting.waiting);

    person.marks('Signed copy', ['follow-up']);
    expect(await check()).toMatchObject({ moved: 1 });
    const followUp = (await thread('Signed copy'))!;
    expect(followUp.box).toBe('follow-up');
    expect(followUp.waiting).toBeUndefined();
    expect(followUp.draft).toEqual(waiting.draft);
  });

  it('the same look taken twice changes nothing the second time', async () => {
    await deliver('Once only');
    await deliver('Also once');
    person.put('Once only', 'ARCHIVE');
    person.marks('Also once', ['follow-up']);
    expect(await check()).toMatchObject({ moved: 2 });
    const first = await w.state();
    expect(await check()).toMatchObject({ ran: true, calls: 1, moved: 0, marked: 0, removed: 0, leftAlone: 0, unclear: 0, back: [] });
    const second = await w.state();
    expect(second.rev).toBe(first.rev);
    expect(second.threads).toEqual(first.threads);
    expect(second.activity).toEqual(first.activity);
    expect(await effects()).toEqual([]);
  });

  it('one look costs one call however many threads there are, and never more than two', async () => {
    const n = 60;
    for (let i = 0; i < n; i++) mailbox().messages.push({ id: `bulk-${app}-${w.workspaceId}-${i}`, threadId: `bulk-thread-${i}`, from: `Sender ${i} <sender${i}@client.test>`, to: [mailbox().address], subject: `Bulk ${i}`, body: 'One of many.', at: new Date(Date.now() - (i + 1) * 60_000), labels: ['INBOX', 'UNREAD'] });
    // Taken in the way the nightly re-read takes in mail the triggers missed.
    await reconcileMail(w.workspaceId, box.connectionId);
    expect((await w.state()).threads).toHaveLength(n);
    expect(await check()).toMatchObject({ calls: 1, messages: n, moved: 0 });

    for (let i = 0; i < n; i++) person.put(`Bulk ${i}`, 'ARCHIVE');
    const before = calls().length;
    expect(await check()).toMatchObject({ calls: 1, messages: n, moved: n });
    expect(calls().slice(before)).toEqual([LIST[app]]);
    expect((await w.state()).threads.every((t) => t.box === 'archived')).toBe(true);
    // Each call is counted under its own phase.
    expect(await rows(`select op, count(*)::int as n from provider_call where workspace_id = $1 and phase = 'changes' group by op`, [w.workspaceId])).toEqual([{ op: LIST[app], n: 2 }]);

    // More mail than two pages hold: two calls and no more. What they did not reach is left as it is, and so is
    // the thread at the very edge of what was listed.
    for (let i = 0; i < n; i++) person.put(`Bulk ${i}`, 'INBOX');
    const cut = calls().length;
    expect(await check({ pageSize: 10, maxPages: 2 })).toMatchObject({ calls: 2, messages: 20, moved: 19 });
    expect(calls().slice(cut)).toEqual([LIST[app], LIST[app]]);
    const back = (await w.state()).threads.filter((t) => t.box === 'inbox').map((t) => Number(t.subject.slice(5))).sort((x, y) => x - y);
    expect(back).toEqual(Array.from({ length: 19 }, (_, i) => i));
  });

  it('mail older than the days looked at is left as it is', async () => {
    mailbox().messages.push({ id: `old-${w.workspaceId}`, threadId: 'old-thread', from: 'Old Timer <old@client.test>', to: [mailbox().address], subject: 'From last week', body: 'Old news.', at: new Date(Date.now() - 5 * DAY), labels: ['INBOX'] });
    await reconcileMail(w.workspaceId, box.connectionId, { days: 7 });
    await deliver('From today');
    expect((await thread('From last week'))!.box).toBe('inbox');
    await check();
    person.put('From last week', 'ARCHIVE');
    person.put('From today', 'ARCHIVE');
    // Only today's message is in the listing at all.
    expect(await check()).toMatchObject({ messages: 1, moved: 1 });
    expect((await thread('From last week'))!.box).toBe('inbox');
    expect((await thread('From today'))!.box).toBe('archived');
    // A wider look reaches it.
    await check({ days: 7 });
    expect(await check({ days: 7 })).toMatchObject({ moved: 0 });
  });

  it('a thread is taken off the screens only when every received message Timmy has stored is known to be deleted; otherwise it is archived', async () => {
    mailbox().messages.push({ id: `first-${w.workspaceId}`, threadId: 'long-thread', from: 'Dana Whitfield <dana@client.test>', to: [mailbox().address], subject: 'Long running', body: 'Where it started.', at: new Date(Date.now() - 5 * DAY), labels: ['INBOX'] });
    await reconcileMail(w.workspaceId, box.connectionId, { days: 7 });
    await deliver('Re: Long running', { threadId: 'long-thread' });
    expect((await thread('Long running'))!.messages).toHaveLength(2);
    // The person deletes the whole conversation. The look covers the last days only, so it sees one of the two messages.
    person.put('Long running', 'TRASH');
    expect(await check()).toMatchObject({ removed: 0, moved: 1 });
    const t = (await thread('Long running'))!;
    expect(t.box).toBe('archived');
    expect(t.history!.at(-1)!.text).toBe(`Its latest messages were deleted in ${name}, so it was archived here`);
    // A look that reaches the older message too finds the whole thread deleted.
    expect(await check({ days: 7 })).toMatchObject({ removed: 1 });
    expect(await thread('Long running')).toBeUndefined();
  });

  it('a listing that lacks a message Timmy has stored for the thread concludes nothing about it', async () => {
    const t = await deliver('Two messages');
    await deliver('Re: Two messages', { threadId: t.ext!.threadKey });
    expect((await thread('Two messages'))!.messages).toHaveLength(2);
    // One message is gone from the mailbox for good, and the other was archived: half a thread is all the listing shows.
    const [first, second] = of('Two messages');
    mailbox().messages = mailbox().messages.filter((m) => m !== first);
    second!.labels = second!.labels.filter((l) => l !== 'INBOX');
    expect(await check()).toMatchObject({ unclear: 1, moved: 0 });
    expect((await thread('Two messages'))!.box).toBe('inbox');
  });

  it('when the thread is fetched for new mail the change is picked up then, without a separate look; a reply still brings an archived thread back', async () => {
    const t = await deliver('Fetched again');
    person.marks('Fetched again', ['read-through']);
    await ingestThread(w.workspaceId, box.connectionId, t.ext!.threadKey!);
    expect(await thread('Fetched again')).toMatchObject({ box: 'read-through' });
    expect(await rows(`select 1 from provider_call where workspace_id = $1 and phase = 'changes'`, [w.workspaceId])).toEqual([]);

    await deliver('Answered later');
    person.put('Answered later', 'ARCHIVE');
    await check();
    expect((await thread('Answered later'))!.box).toBe('archived');
    const key = (await thread('Answered later'))!.ext!.threadKey;
    const replied = await deliver('Re: Answered later', { threadId: key, from: 'Dana Whitfield <dana@client.test>' });
    expect(replied).toMatchObject({ box: 'inbox', unread: true });
    expect(replied.history!.at(-1)!.text).toBe('A reply arrived');
    expect(await effects()).toEqual([]);
  });

  it('another workspace’s mailbox never moves this workspace’s threads', async () => {
    const other = await newWorkspace('Elsewhere');
    const theirs = await connectApp(other, app, `owner@${app}-elsewhere.test`);
    await jobs().drain();
    // Both mailboxes hold a thread with the same key and the same subject.
    await deliver('Same key', { threadId: 'shared-thread-key' });
    await deliver('Same key', { threadId: 'shared-thread-key' }, other);
    await checkMailbox(other.workspaceId, theirs.connectionId);
    person.put('Same key', 'ARCHIVE');

    // This workspace's connection, asked for from the other workspace, is not found: nothing is listed.
    const before = calls().length;
    expect(await checkMailbox(other.workspaceId, box.connectionId)).toMatchObject({ ran: false, calls: 0 });
    expect(calls().length).toBe(before);
    // The other workspace's own look sees its own mailbox, where nothing changed.
    expect(await checkMailbox(other.workspaceId, theirs.connectionId)).toMatchObject({ ran: true, moved: 0 });
    expect(await check()).toMatchObject({ moved: 1 });
    expect((await thread('Same key'))!.box).toBe('archived');
    expect((await thread('Same key', other))!.box).toBe('inbox');

    // What each mailbox last showed is kept per workspace, behind row-level security like everything else.
    const visibleTo = (id: string) => withWorkspace({ workspaceId: id }, async (tx) => [...new Set((await tx.query('select workspace_id from mailbox_seen')).rows.map((r) => r.workspace_id as string))]);
    expect(await visibleTo(w.workspaceId)).toEqual([w.workspaceId]);
    expect(await visibleTo(other.workspaceId)).toEqual([other.workspaceId]);
    const c = await appPool().connect();
    try {
      expect((await c.query('select count(*)::int as n from mailbox_seen')).rows[0].n).toBe(0);
    } finally {
      c.release();
    }
    await expect(withWorkspace({ workspaceId: other.workspaceId }, (tx) => tx.query(`insert into mailbox_seen (connection_id, workspace_id, thread_key, in_inbox, unread) values ($1, $2, 'planted', true, false)`, [box.connectionId, w.workspaceId]))).rejects.toThrow(/row-level security/);
  });

  it('a disconnected mailbox is not looked at, and what it last showed goes with its mail', async () => {
    await deliver('Before leaving');
    await check();
    expect((await rows('select 1 from mailbox_seen where workspace_id = $1', [w.workspaceId])).length).toBe(1);
    expect((await w.post(`/api/v1/connections/${app}/disconnect`, {})).status).toBe(200);
    await jobs().drain();
    const before = calls().length;
    expect(await check()).toMatchObject({ ran: false, calls: 0 });
    await jobs().enqueue('mail.changes', { workspaceId: w.workspaceId });
    await jobs().enqueue('mail.reconcile', { workspaceId: w.workspaceId, connectionId: box.connectionId });
    await morningRun(w.workspaceId);
    await jobs().drain();
    expect(calls().length).toBe(before);
    expect(await rows('select 1 from mailbox_seen where workspace_id = $1', [w.workspaceId])).toEqual([]);
  });

  it('it is looked at with the nightly check, in the morning run, when the app opens, and while it is in use', async () => {
    for (const s of ['Night', 'Morning', 'Open tab']) await deliver(s);
    person.put('Night', 'ARCHIVE');
    await jobs().enqueue('mail.reconcile', { workspaceId: w.workspaceId, connectionId: box.connectionId });
    await jobs().drain();
    expect((await thread('Night'))!.box).toBe('archived');

    person.put('Morning', 'ARCHIVE');
    await morningRun(w.workspaceId);
    await jobs().drain();
    expect((await thread('Morning'))!.box).toBe('archived');

    // The app opens: it loads its state, then opens its stream. One look is queued, however many tabs follow.
    person.put('Open tab', 'ARCHIVE');
    jobs().queue = [];
    await w.state();
    for (let i = 0; i < 2; i++) {
      const res = await w.get('/api/v1/stream');
      const reader = res.body!.getReader();
      await reader.read();
      await reader.cancel();
    }
    expect(jobs().queue.filter((j) => j.name === 'mail.changes').map((j) => j.data)).toEqual([{ workspaceId: w.workspaceId, gap: 60 }]);
    // The morning run looked a moment ago, so this look is skipped: no call is made.
    const before = calls().length;
    await jobs().drain();
    expect(calls().length).toBe(before);
    expect((await thread('Open tab'))!.box).toBe('inbox');
    // Opened again later, the look goes ahead.
    await later(10);
    await jobs().enqueue('mail.changes', { workspaceId: w.workspaceId, gap: 60 });
    await jobs().drain();
    expect(calls().slice(before)).toEqual([LIST[app]]);
    expect((await thread('Open tab'))!.box).toBe('archived');

    // A tab that stays open asks again every few minutes. Nobody has done anything in Timmy, so no look is made…
    person.put('Open tab', 'INBOX');
    await later(10);
    const idle = calls().length;
    await jobs().enqueue('mail.changes', { workspaceId: w.workspaceId, gap: 540, idle: 1800 });
    await jobs().drain();
    expect(calls().length).toBe(idle);
    expect((await thread('Open tab'))!.box).toBe('archived');
    // …until someone uses it again: here by asking Timmy something in the chat. And then not twice within ten minutes.
    await sysPool.query(`insert into run (id, workspace_id, user_id, kind, attended, status, input, model) values ($1, $2, $3, 'ask', true, 'completed', '{}', 'stand-in')`, [`run_${Math.random().toString(36).slice(2)}`, w.workspaceId, w.userId]);
    for (let i = 0; i < 2; i++) {
      await jobs().enqueue('mail.changes', { workspaceId: w.workspaceId, gap: 540, idle: 1800 });
      await jobs().drain();
    }
    expect(calls().slice(idle)).toEqual([LIST[app]]);
    expect((await thread('Open tab'))!.box).toBe('inbox');

    // Forty minutes on the workspace is idle again. Doing anything in the app counts as use too.
    person.put('Open tab', 'ARCHIVE');
    await later(40);
    const idleAgain = calls().length;
    await jobs().enqueue('mail.changes', { workspaceId: w.workspaceId, gap: 540, idle: 1800 });
    await jobs().drain();
    expect(calls().length).toBe(idleAgain);
    await w.cmd({ type: 'openThread', id: (await thread('Night'))!.id });
    await jobs().enqueue('mail.changes', { workspaceId: w.workspaceId, gap: 540, idle: 1800 });
    await jobs().drain();
    expect(calls().slice(idleAgain)).toEqual([LIST[app]]);
    expect((await thread('Open tab'))!.box).toBe('archived');
    expect(await effects()).toEqual([]);
  });
});

describe('asking for a look while a tab is open', () => {
  it('happens at once when the app has just been opened, otherwise at most every five minutes and only for a workspace in use', () => {
    jobs().queue = [];
    const id = `ws_open_${Math.random().toString(36).slice(2)}`;
    const queued = () => jobs().queue.filter((j) => j.name === 'mail.changes' && j.data.workspaceId === id).map((j) => j.data);
    // A stream that opens with no page having loaded its state is a reconnect: it is treated like any other ping.
    for (let i = 0; i < 5; i++) checkWhileOpen(id);
    expect(queued()).toEqual([{ workspaceId: id, gap: 540, idle: 1800 }]);
    // The app is opened: the next call asks at once, whoever is or is not using Timmy, and then it is back to waiting.
    jobs().queue = [];
    appLoaded(id);
    for (let i = 0; i < 5; i++) checkWhileOpen(id);
    expect(queued()).toEqual([{ workspaceId: id, gap: 60 }]);
    jobs().queue = [];
  });
});

describe('Gmail only', () => {
  it('a listing that comes back without any labels is not believed', async () => {
    model().reset();
    jobs().queue = [];
    const w = await newWorkspace('NoLabels');
    const box = await connectApp(w, 'gmail', 'owner@nolabels.test');
    await jobs().drain();
    for (let i = 0; i < 5; i++) {
      await w.post('/api/test/fake', { op: 'deliver', message: { from: 'Dana Whitfield <dana@client.test>', subject: `Plain ${i}`, body: 'Hello' } });
    }
    await jobs().drain();
    await checkMailbox(w.workspaceId, box.connectionId);
    for (const m of fake().accounts.get(box.account)!.messages) m.labels = [];
    await expect(checkMailbox(w.workspaceId, box.connectionId)).rejects.toThrow(/without labels/);
    expect((await w.state()).threads.map((t) => t.box)).toEqual(['inbox', 'inbox', 'inbox', 'inbox', 'inbox']);
    // The job that looks while a tab is open does not fail on it; it tries again at the next look.
    await jobs().enqueue('mail.changes', { workspaceId: w.workspaceId });
    await jobs().drain();
    expect((await w.state()).threads.every((t) => t.box === 'inbox')).toBe(true);
  });
});
