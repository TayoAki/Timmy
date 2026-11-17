/**
 * Two gaps in picking up what was done in the mailbox itself, closed:
 *   - a label or category already on a message the first time Timmy sees it (a colleague's Outlook category kept on
 *     mail sent within one company, a Gmail filter) is recorded and never acted on; only a change on a message Timmy
 *     has already seen can move a thread. Gmail labels behave the same as Outlook categories;
 *   - opening the app looks at the mailbox at most every five minutes, however often the page is reloaded.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FakeMessage } from '../src/testing/composio';
import { LABEL_NAMES, type Labelled } from '../src/sync/labels';
import { checkMailbox } from '../src/sync/mailbox-check';
import { appPool, boot, connectApp, fake, jobs, model, newWorkspace, rows, sysPool, withWorkspace, type Client } from './helpers';

const TIMMY_NAMES: readonly string[] = Object.values(LABEL_NAMES);
const LIST = { gmail: 'GMAIL_FETCH_EMAILS', outlook: 'OUTLOOK_LIST_MESSAGES' } as const;
const used: string[] = [];

beforeAll(async () => {
  await boot();
});
afterEach(async () => {
  await sysPool.query(`update connection set status = 'disconnected', disconnected_at = now() where status in ('active', 'pending') and workspace_id = any($1::text[])`, [used.splice(0)]);
});

describe.each(['gmail', 'outlook'] as const)('a mark already on a message when Timmy first sees it (%s)', (app) => {
  const name = app === 'gmail' ? 'Gmail' : 'Outlook';
  let w: Client;
  let box: { connectionId: string; account: string };
  const mailbox = () => fake().accounts.get(box.account)!;
  const thread = async (subject: string) => (await w.state()).threads.find((t) => t.subject === subject.replace(/^Re: /, ''));
  const check = () => checkMailbox(w.workspaceId, box.connectionId);
  const effects = () => rows('select 1 from effect where workspace_id = $1', [w.workspaceId]);
  /** The id Gmail gives one of Timmy's labels, made if the mailbox has none yet (a colleague's, or the person's own). */
  const labelId = (place: Labelled) => {
    const labels = mailbox().labels;
    if (!labels.has(LABEL_NAMES[place])) labels.set(LABEL_NAMES[place], `Label_${labels.size + 1}`);
    return labels.get(LABEL_NAMES[place])!;
  };
  /** A message as it arrives, already carrying one of Timmy's marks that nobody in this workspace put there. */
  const marked = (place: Labelled): Partial<FakeMessage> => (app === 'outlook' ? { categories: [LABEL_NAMES[place], 'Blue category'] } : { labels: ['INBOX', 'UNREAD', labelId(place)] });
  const deliver = async (subject: string, extra: Partial<FakeMessage> = {}) => {
    await w.post('/api/test/fake', { op: 'deliver', message: { from: 'Sam Colleague <sam@corp.test>', subject, body: 'From down the hall.', ...extra } });
    await jobs().drain();
    return (await thread(subject))!;
  };
  /** What the person does in their own mail app to one message: leaves exactly these of Timmy's marks on it. */
  const setMarks = (m: FakeMessage, places: Labelled[]) => {
    if (app === 'outlook') m.categories = [...(m.categories ?? []).filter((c) => !TIMMY_NAMES.includes(c)), ...places.map((p) => LABEL_NAMES[p])];
    else m.labels = [...m.labels.filter((l) => ![...mailbox().labels.values()].includes(l)), ...places.map(labelId)];
  };
  const messageOf = (subject: string, i = -1) => mailbox().messages.filter((m) => m.subject.replace(/^Re: /, '') === subject).at(i)!;
  /** Lets time pass for everything this workspace's filings and looks recorded. */
  const later = async (minutes: number) => {
    await sysPool.query(`update effect set created_at = created_at - make_interval(mins => $2), executing_at = executing_at - make_interval(mins => $2), completed_at = completed_at - make_interval(mins => $2) where workspace_id = $1`, [w.workspaceId, minutes]);
    await sysPool.query(`update mailbox_seen set seen_at = seen_at - make_interval(mins => $2) where workspace_id = $1`, [w.workspaceId, minutes]);
    await sysPool.query(`update mailbox_message_seen set seen_at = seen_at - make_interval(mins => $2) where workspace_id = $1`, [w.workspaceId, minutes]);
    await sysPool.query(`update sync_cursor set started_at = started_at - make_interval(mins => $2) where workspace_id = $1 and kind = 'changes'`, [w.workspaceId, minutes]);
  };

  beforeEach(async () => {
    model().reset();
    jobs().queue = [];
    fake().failNext.clear();
    w = await newWorkspace(`First sight ${app}`);
    used.push(w.workspaceId);
    box = await connectApp(w, app, `owner@${app}-first-sight.test`);
    await jobs().drain();
    // In Gmail the three labels exist before any mail carries one (a colleague's setup, or a filter), as they would.
    if (app === 'gmail') for (const p of Object.keys(LABEL_NAMES) as Labelled[]) labelId(p);
  });

  it('a colleague’s reply that arrives marked does not move the thread it joins, and is recorded with its mark', async () => {
    const t = await deliver('Budget question');
    await check();
    expect((await thread('Budget question'))!.box).toBe('inbox');
    // The colleague files with Timmy too: their reply comes in marked Waiting.
    await deliver('Re: Budget question', { threadId: t.ext!.threadKey, ...marked('waiting') });
    expect((await thread('Budget question'))!.box).toBe('inbox');
    expect(await check()).toMatchObject({ moved: 0 });
    expect((await thread('Budget question'))!.box).toBe('inbox');
    expect((await thread('Budget question'))!.history!.some((h) => /Filed under/.test(h.text))).toBe(false);
    const reply = messageOf('Budget question');
    expect(await rows(`select labels from mailbox_message_seen where connection_id = $1 and message_id = $2`, [box.connectionId, reply.id])).toEqual([{ labels: ['waiting'] }]);
    expect(await effects()).toEqual([]);
  });

  it('a new thread that arrives marked stays in the inbox; a change the person then makes to it moves it', async () => {
    await deliver('Marked from the start', marked('follow-up'));
    expect(await check()).toMatchObject({ moved: 0 });
    expect((await thread('Marked from the start'))!.box).toBe('inbox');
    // The person puts Read Through on it in the mailbox: that is a change on a message Timmy has seen.
    setMarks(messageOf('Marked from the start'), ['follow-up', 'read-through']);
    expect(await check()).toMatchObject({ moved: 1 });
    const t = (await thread('Marked from the start'))!;
    expect(t.box).toBe('read-through');
    expect(t.history!.at(-1)!.text).toBe(`Filed under Read Through in ${name}`);
  });

  it('a mark it came with, taken off and put back by the person, counts as theirs', async () => {
    await deliver('On and off', marked('waiting'));
    await check();
    setMarks(messageOf('On and off'), []);
    expect(await check()).toMatchObject({ moved: 0 });
    expect((await thread('On and off'))!.box).toBe('inbox');
    setMarks(messageOf('On and off'), ['waiting']);
    expect(await check()).toMatchObject({ moved: 1 });
    expect((await thread('On and off'))!.box).toBe('waiting');
  });

  it('Timmy filing the thread where the colleague’s mark already pointed is not taken for the mark being removed', async () => {
    const t = await deliver('Same place');
    await check();
    await deliver('Re: Same place', { threadId: t.ext!.threadKey, ...marked('follow-up') });
    await check();
    expect((await thread('Same place'))!.box).toBe('inbox');
    // The person files it under Follow Up in Timmy; Timmy writes that to the mailbox.
    await w.cmd({ type: 'move', id: t.id, box: 'follow-up' });
    await jobs().drain();
    await later(10);
    expect(await check()).toMatchObject({ moved: 0 });
    expect((await thread('Same place'))!.box).toBe('follow-up');
    // From then on the mark is Timmy's doing, and the person taking it off in the mailbox is picked up.
    for (const m of mailbox().messages.filter((x) => x.subject.replace(/^Re: /, '') === 'Same place')) setMarks(m, []);
    expect(await check()).toMatchObject({ moved: 1 });
    expect((await thread('Same place'))!.box).toBe('inbox');
  });

  it('a message Timmy saw before these records were kept counts as seen: a mark the person puts on it moves the thread', async () => {
    const t = await deliver('Seen long ago');
    await check();
    // As if the message had arrived twenty minutes before a look made before the records existed: there is none for it.
    messageOf('Seen long ago').at = new Date(Date.now() - 20 * 60_000);
    await sysPool.query(`delete from mailbox_message_seen where connection_id = $1`, [box.connectionId]);
    await sysPool.query(`update mailbox_seen set seen_at = now() where connection_id = $1`, [box.connectionId]);
    setMarks(messageOf('Seen long ago'), ['waiting']);
    expect(await check()).toMatchObject({ moved: 1 });
    expect((await thread('Seen long ago'))!.box).toBe('waiting');
    expect(t.id).toBe((await thread('Seen long ago'))!.id);
  });

  it('the records are the workspace’s own, and go with the mailbox', async () => {
    await deliver('Kept apart', marked('waiting'));
    await check();
    const mine = (id: string) => withWorkspace({ workspaceId: id }, async (tx) => (await tx.query('select workspace_id from mailbox_message_seen')).rows.map((r) => r.workspace_id as string));
    expect(new Set(await mine(w.workspaceId))).toEqual(new Set([w.workspaceId]));
    const other = await newWorkspace('Elsewhere first sight');
    expect(await mine(other.workspaceId)).toEqual([]);
    const c = await appPool().connect();
    try {
      expect((await c.query('select count(*)::int as n from mailbox_message_seen')).rows[0].n).toBe(0);
    } finally {
      c.release();
    }
    expect((await w.post(`/api/v1/connections/${app}/disconnect`, {})).status).toBe(200);
    await jobs().drain();
    expect(await rows('select 1 from mailbox_message_seen where connection_id = $1', [box.connectionId])).toEqual([]);
  });
});

describe('looking at the mailbox when the app is opened', () => {
  it('happens at most every five minutes per mailbox, however often the page is reloaded', async () => {
    model().reset();
    jobs().queue = [];
    const w = await newWorkspace('Reloader');
    used.push(w.workspaceId);
    const box = await connectApp(w, 'outlook', 'owner@reloader.test');
    await jobs().drain();
    const looks = () => fake().calls.filter((c) => c.connectedAccountId === box.account && c.slug === LIST.outlook).length;
    /** What a page load does: it reads the whole state, then opens its stream. */
    const open = async () => {
      await w.state();
      const res = await w.get('/api/v1/stream');
      const reader = res.body!.getReader();
      await reader.read();
      await reader.cancel();
      await jobs().drain('mail.changes');
    };
    const ago = (minutes: number) => sysPool.query(`update sync_cursor set started_at = now() - make_interval(mins => $2) where connection_id = $1 and kind = 'changes'`, [box.connectionId, minutes]);
    const before = looks();
    await open();
    expect(looks() - before).toBe(1);
    // Reloaded a minute later, and two minutes later: no look.
    await ago(1);
    await open();
    await ago(2);
    await open();
    expect(looks() - before).toBe(1);
    // Six minutes after the last look, a reload looks again.
    await ago(6);
    await open();
    expect(looks() - before).toBe(2);
  });
});
