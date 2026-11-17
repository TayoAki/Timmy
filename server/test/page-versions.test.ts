/**
 * Version history for pages, and the emptying of the page trash.
 *
 * Time is never waited out here: a test makes a stored row look older (a version's `created_at`, a trash
 * row's `updated_at`) and then does the next thing.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Patch } from '../../src/live/patches';
import { purgeDeletedWorkspaces } from '../src/db/purge';
import { startHub, stopHub, subscribe } from '../src/state/hub';
import { mutate } from '../src/state/mutate';
import { addMember, appPool, boot, jobs, newWorkspace, rows, sysPool, withWorkspace, type Client } from './helpers';

let w: Client;
const OWNER = 'Versions Owner';

type Blocks = Record<string, unknown>[];
const para = (text: string, id = 'b1') => ({ id, type: 'p', text });
const ws = (ops: unknown[], c: Client = w) => c.cmd({ type: 'ws', ops });
const file = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, kind: 'doc', folder: '', updated: new Date(), owner: 'me', ...extra });
/** A new page, the way the app makes one. */
const newPage = (id: string, name: string, blocks: Blocks, extra: Record<string, unknown> = {}, c: Client = w) => ws([{ op: 'put', col: 'files', item: file(id, name) }, { op: 'put', col: 'docs', item: { id, blocks, ...extra } }], c);
/** A save from the editor: the page's blocks are replaced and the file is marked as changed. */
const save = (id: string, blocks: Blocks, c: Client = w) => ws([{ op: 'patch', col: 'docs', id, patch: { blocks } }, { op: 'patch', col: 'files', id, patch: { updated: new Date() } }], c);
/** To the trash, the way the app sends it: the file moves from `files` to `trash`, sub-pages with it. */
const trash = (id: string, name: string, children: { id: string; name: string }[] = [], at = new Date(), c: Client = w) =>
  ws([{ op: 'remove', col: 'files', id }, { op: 'put', col: 'trash', item: file(id, name, { trashed: at }) }, ...children.flatMap((k) => [{ op: 'remove', col: 'files', id: k.id }, { op: 'put', col: 'trash', item: file(k.id, k.name, { parent: id, trashed: at, trashRoot: id }) }])], c);

interface Listed {
  number: number;
  at: Date;
  by: string;
  why: string;
  preview: string;
  blockCount: number;
}
const list = async (id: string, c: Client = w) => (await c.json<{ versions: Listed[]; canRestore: boolean }>('GET', `/api/v1/pages/${id}/versions`)).versions;
const restore = (id: string, n: number, c: Client = w) => c.post(`/api/v1/pages/${id}/versions/${n}/restore`);
const stored = (id: string, workspaceId = w.workspaceId) => rows<{ version: number; reason: string; author: string | null; blocks: Blocks; icon: string | null; cover: unknown }>('select version, reason, author, blocks, icon, cover from doc_revision where workspace_id = $1 and file_id = $2 order by version', [workspaceId, id]);
const textOf = async (id: string, c: Client = w) => (((await c.state()).ws.docs[id] as unknown as { blocks: { text?: string }[] } | undefined)?.blocks ?? []).map((b) => b.text);
/** Makes a page's kept versions look this much older. */
const ageVersions = (id: string, interval: string) => sysPool.query(`update doc_revision set created_at = created_at - $3::interval where workspace_id = $1 and file_id = $2`, [w.workspaceId, id, interval]);
/** Makes pages look as if they went to the trash this long ago, by the server's own record. */
const ageTrash = (ids: string[], interval: string, workspaceId = w.workspaceId) => sysPool.query(`update state_doc set updated_at = now() - $3::interval where workspace_id = $1 and slice = 'ws.trash' and id = any($2::text[])`, [workspaceId, ids, interval]);
const runJob = async (name: string) => {
  await jobs().enqueue(name, {});
  await jobs().drain();
};

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  w = await newWorkspace('Versions');
});

describe('keeping versions', () => {
  it('editing a page keeps what it held before as a version: blocks, icon and cover, and who made the change', async () => {
    await newPage('plan', 'Plan', [para('First draft')], { icon: '📝', cover: { kind: 'gradient', value: 'dawn' } });
    // A new page has nothing earlier to keep.
    expect(await stored('plan')).toEqual([]);
    expect((await save('plan', [para('Second draft')])).ok).toBe(true);
    expect(await stored('plan')).toEqual([{ version: 1, reason: 'edit', author: w.userId, blocks: [para('First draft')], icon: '📝', cover: { kind: 'gradient', value: 'dawn' } }]);
    // The page itself holds the new contents; the version holds the old.
    expect(await textOf('plan')).toEqual(['Second draft']);

    // Changing only the icon is a change to the page too. A colleague makes it, later.
    await ageVersions('plan', '6 minutes');
    const mia = await addMember(w.workspaceId, 'member', 'Mia Member');
    expect((await ws([{ op: 'patch', col: 'docs', id: 'plan', patch: { icon: '🚀' } }], mia)).ok).toBe(true);
    expect((await stored('plan'))[1]).toEqual({ version: 2, reason: 'edit', author: mia.userId, blocks: [para('Second draft')], icon: '📝', cover: { kind: 'gradient', value: 'dawn' } });
  });

  it('a burst of saves within five minutes is one version; a save after that keeps another', async () => {
    await newPage('notes', 'Notes', [para('one')]);
    for (const text of ['two', 'three', 'four']) await save('notes', [para(text)]);
    expect((await stored('notes')).map((v) => v.blocks)).toEqual([[para('one')]]);
    // Four minutes on, it is still the same burst.
    await ageVersions('notes', '4 minutes');
    await save('notes', [para('five')]);
    expect(await stored('notes')).toHaveLength(1);
    // Past five minutes, the next save keeps what the page held just before it.
    await ageVersions('notes', '2 minutes');
    await save('notes', [para('six')]);
    await save('notes', [para('seven')]);
    expect((await stored('notes')).map((v) => [v.version, v.reason, v.blocks])).toEqual([
      [1, 'edit', [para('one')]],
      [2, 'edit', [para('five')]],
    ]);
  });

  it('a save that leaves the contents as they were, a rename, or a refused save keeps nothing', async () => {
    await newPage('same', 'Same', [para('unchanged')]);
    await save('same', [para('unchanged')]);
    await ws([{ op: 'patch', col: 'files', id: 'same', patch: { name: 'Renamed' } }]);
    expect((await save('same', [{ id: 'x', type: 'iframe', text: 'nope' }])).ok).toBe(false);
    expect(await stored('same')).toEqual([]);
  });

  it('asking Timmy for a summary always keeps a version first, even in the middle of a burst', async () => {
    const blocks = [{ id: 'h', type: 'h1', text: 'Acme renewal plan' }, { id: 'p1', type: 'p', text: 'We hold the price at $62 per seat for 120 seats.' }];
    await newPage('plan', 'Acme renewal plan', [para('Outline')]);
    await save('plan', blocks);
    expect((await stored('plan')).map((v) => v.reason)).toEqual(['edit']);

    // The saved copy is kept when the editor sends nothing of its own.
    expect((await w.post('/api/v1/pages/plan/summarize', {})).status).toBe(200);
    let kept = await stored('plan');
    expect(kept.map((v) => [v.version, v.reason, v.author])).toEqual([[1, 'edit', w.userId], [2, 'before-timmy', w.userId]]);
    expect(kept[1]!.blocks).toEqual(blocks);

    // What a screen sends is summarised, but only what the page really held is kept as a version: anyone could
    // otherwise put words into the page's history that the page never had (found by the safety review, Nov 17).
    const onScreen = [...blocks, { id: 'p2', type: 'p', text: 'Typed a second ago and not saved.' }];
    expect((await w.post('/api/v1/pages/plan/summarize', { blocks: onScreen })).status).toBe(200);
    kept = await stored('plan');
    expect(kept.map((v) => v.reason)).toEqual(['edit', 'before-timmy', 'before-timmy']);
    expect(kept[2]!.blocks).toEqual(blocks);

    // The editor then types the summary in and saves: that save belongs to the copy just kept.
    await save('plan', [...onScreen, { id: 's', type: 'callout', text: 'Timmy’s summary, from what’s on this page' }]);
    expect(await stored('plan')).toHaveLength(3);
    expect((await list('plan')).map((v) => [v.number, v.why, v.by])).toEqual([[3, 'before-timmy', OWNER], [2, 'before-timmy', OWNER], [1, 'edit', OWNER]]);
  });

  it('nothing is kept when there is nothing to summarise, or for someone who may not change pages', async () => {
    await newPage('empty', 'Empty', [para('')]);
    expect(((await (await w.post('/api/v1/pages/empty/summarize', {})).json()) as { lines: unknown[] }).lines).toEqual([]);
    await newPage('plan', 'Plan', [para('Some words to summarise.')]);
    const reader = await addMember(w.workspaceId, 'revops');
    expect((await reader.post('/api/v1/pages/plan/summarize', {})).status).toBe(403);
    expect((await w.post('/api/v1/pages/plan/summarize', { blocks: [{ id: 'x', type: 'iframe', text: 'x' }] })).status).toBe(400);
    expect([...(await stored('empty')), ...(await stored('plan'))]).toEqual([]);
  });

  it('a change made by server code, with nobody at the keyboard, is kept as Timmy’s, every time', async () => {
    await newPage('log', 'Log', [para('line 1')]);
    const append = (text: string) =>
      mutate(w.workspaceId, 'automation', async (_tx, loaded) => {
        const doc = loaded.state.ws.docs.log!;
        return { state: { ...loaded.state, ws: { ...loaded.state.ws, docs: { ...loaded.state.ws.docs, log: { ...doc, blocks: [...doc.blocks, { id: `b-${text}`, type: 'p' as const, text }] } } } }, result: null };
      });
    await append('line 2');
    await append('line 3');
    expect((await stored('log')).map((v) => [v.reason, v.author, v.blocks.length])).toEqual([['before-timmy', null, 1], ['before-timmy', null, 2]]);
    expect((await list('log')).map((v) => v.by)).toEqual(['Timmy', 'Timmy']);
  });
});

describe('reading versions', () => {
  it('the list is newest first, with the person’s name, the reason and a one-line preview, and without the blocks', async () => {
    const long = `Kickoff ${'word '.repeat(60)}`.trim();
    await newPage('plan', 'Plan', [para(long), para('BODY-LINE-TWO', 'b2'), { id: 'b3', type: 'table', columns: ['Date', 'Notes'], rows: [['Nov 16', 'First call']] }]);
    await save('plan', [{ id: 't', type: 'table', columns: ['Date', 'Owner'], rows: [['Nov 17', 'Dana']] }]);
    await ageVersions('plan', '10 minutes');
    const mia = await addMember(w.workspaceId, 'member', 'Mia Member');
    await save('plan', [para('Third')], mia);

    const res = await w.get('/api/v1/pages/plan/versions');
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as { versions: Listed[]; canRestore: boolean; keeps: Record<string, number> };
    expect(body.versions.map((v) => [v.number, v.by, v.why, v.blockCount])).toEqual([[2, 'Mia Member', 'edit', 1], [1, OWNER, 'edit', 3]]);
    // One line each: the first words of the page as it was. A table shows its headings and first row.
    expect(body.versions[0]!.preview).toBe('Date Owner Nov 17 Dana');
    expect(body.versions[1]!.preview.startsWith('Kickoff word word')).toBe(true);
    expect(body.versions[1]!.preview.length).toBeLessThanOrEqual(140);
    expect(new Date(body.versions[0]!.at).getTime()).toBeGreaterThan(new Date(body.versions[1]!.at).getTime());
    // Exactly these fields: no blocks, and no text from further down the page.
    for (const v of body.versions) expect(Object.keys(v).sort()).toEqual(['at', 'blockCount', 'by', 'number', 'preview', 'why']);
    expect(raw).not.toContain('BODY-LINE-TWO');
    expect(body.canRestore).toBe(true);
    expect(body.keeps).toEqual({ versions: 100, days: 90, minutes: 5 });
  });

  it('one version can be read with its blocks, for a preview; a number that was never kept is not found', async () => {
    await newPage('plan', 'Plan', [para('First draft'), para('Second line', 'b2')], { icon: '📝' });
    await save('plan', [para('Second draft')]);
    const one = await w.json<Listed & { blocks: Blocks; icon?: string; cover?: unknown }>('GET', '/api/v1/pages/plan/versions/1');
    expect(one).toMatchObject({ number: 1, by: OWNER, why: 'edit', blockCount: 2, preview: 'First draft', blocks: [para('First draft'), para('Second line', 'b2')], icon: '📝' });
    expect(one.cover).toBeUndefined();
    for (const n of ['2', '0', '-1', 'abc', '1e3', '99999999999']) expect([n, (await w.get(`/api/v1/pages/plan/versions/${n}`)).status]).toEqual([n, 404]);
    expect((await w.get('/api/v1/pages/no-such-page/versions')).status).toBe(404);
    expect((await w.get('/api/v1/pages/bad%20id/versions')).status).toBe(404);
  });
});

describe('putting a version back', () => {
  beforeEach(async () => {
    await newPage('plan', 'Plan', [para('First draft')], { icon: '📝', cover: { kind: 'gradient', value: 'dawn' } });
    // The second state has another icon and no cover at all.
    await ws([{ op: 'put', col: 'docs', item: { id: 'plan', blocks: [para('Second draft')], icon: '🚀' } }]);
  });

  it('restores the old contents, keeps what they replaced, writes an audit entry, and reaches a colleague’s open tab', async () => {
    const mia = await addMember(w.workspaceId, 'member', 'Mia Member');
    await startHub();
    const seen: { rev: number; patches: Patch[] }[] = [];
    const off = subscribe({ workspaceId: w.workspaceId, rev: (await mia.state()).rev, send: (e, d) => e === 'patch' && seen.push(d as { rev: number; patches: Patch[] }) });

    const res = await restore('plan', 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, changed: true, kept: 2 });

    // The colleague's state has the old contents: blocks, icon and cover.
    const theirs = (await mia.state()).ws.docs.plan as unknown as { blocks: Blocks; icon?: string; cover?: unknown };
    expect(theirs).toMatchObject({ blocks: [para('First draft')], icon: '📝', cover: { kind: 'gradient', value: 'dawn' } });
    // What was replaced is a version of its own, so the restore can be taken back.
    const kept = await stored('plan');
    expect(kept.map((v) => [v.version, v.reason, v.author])).toEqual([[1, 'edit', w.userId], [2, 'before-restore', w.userId]]);
    expect(kept[1]).toMatchObject({ blocks: [para('Second draft')], icon: '🚀', cover: null });
    expect(await rows(`select actor, detail from audit_log where workspace_id = $1 and action = 'page.version.restored'`, [w.workspaceId])).toEqual([{ actor: w.userId, detail: { page: 'plan', version: 1, kept: 2 } }]);
    expect((await w.state()).activity[0]!.text).toBe('Restored an earlier version of the page “Plan”');
    // It went out on the stream, as one change to the page. (Waits for the delivery, then a moment more for any stray second one.)
    for (let i = 0; i < 100 && !seen.length; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 200));
    off();
    await stopHub();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.patches.some((p) => p.s === 'ws.docs' && 'id' in p && p.id === 'plan')).toBe(true);

    // Back again: version 2 holds what the restore replaced, including that it had no cover.
    expect(await (await restore('plan', 2, mia)).json()).toEqual({ ok: true, changed: true, kept: 3 });
    const mine = (await w.state()).ws.docs.plan as unknown as { blocks: Blocks; icon?: string; cover?: unknown };
    expect(mine.blocks).toEqual([para('Second draft')]);
    expect(mine.icon).toBe('🚀');
    expect(mine.cover).toBeUndefined();
    expect((await list('plan')).map((v) => [v.number, v.why, v.by])).toEqual([[3, 'before-restore', 'Mia Member'], [2, 'before-restore', OWNER], [1, 'edit', OWNER]]);
    // Putting back what the page already holds changes nothing and keeps nothing.
    expect(await (await restore('plan', 2)).json()).toEqual({ ok: true, changed: false });
    expect(await stored('plan')).toHaveLength(3);
    // An edit straight after a restore belongs to the copy the restore kept.
    await save('plan', [para('Third draft')]);
    expect(await stored('plan')).toHaveLength(3);
  });

  it('links to pages deleted for good since are left out of the restored page, and the answer says how many', async () => {
    const link = (id: string, to: string) => ({ id, type: 'page', file: to });
    await newPage('hub', 'Hub', [para('Index'), link('l1', 'gone-a'), link('l2', 'gone-b'), link('l3', 'binned'), link('l4', 'here')]);
    for (const [id, name] of [['gone-a', 'Gone A'], ['gone-b', 'Gone B'], ['binned', 'Binned'], ['here', 'Here']]) await newPage(id!, name!, [para(name!)]);
    // Version 1 holds all four links; the page then loses them.
    await save('hub', [para('Index, emptied')]);
    await trash('gone-a', 'Gone A');
    await trash('gone-b', 'Gone B');
    await trash('binned', 'Binned');
    expect((await ws(['gone-a', 'gone-b'].flatMap((id) => [{ op: 'remove', col: 'trash', id }, { op: 'remove', col: 'docs', id }]))).ok).toBe(true);

    const res = await restore('hub', 1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, changed: true, kept: 2, leftOut: 2, note: '2 links to pages that have been deleted since were left out.' });
    // A page in the trash can still come back, so its link stays; so does the link to a page that is still here.
    const blocks = ((await w.state()).ws.docs.hub as unknown as { blocks: Blocks }).blocks;
    expect(blocks).toEqual([para('Index'), link('l3', 'binned'), link('l4', 'here')]);
    // The version itself is kept as it was.
    expect((await stored('hub'))[0]!.blocks).toEqual([para('Index'), link('l1', 'gone-a'), link('l2', 'gone-b'), link('l3', 'binned'), link('l4', 'here')]);
    expect((await rows<{ detail: Record<string, unknown> }>(`select detail from audit_log where workspace_id = $1 and action = 'page.version.restored'`, [w.workspaceId]))[0]!.detail).toMatchObject({ leftOut: 2 });
    // Putting the same version back again changes nothing, and still says what was left out.
    expect(await (await restore('hub', 1)).json()).toEqual({ ok: true, changed: false, leftOut: 2, note: '2 links to pages that have been deleted since were left out.' });
    // One left out is said in the singular; a version with nothing deleted behind it says nothing about links.
    await newPage('solo', 'Solo', [para('one'), link('l9', 'here'), link('l8', 'gone-a')]);
    await save('solo', [para('two')]);
    expect(await (await restore('solo', 1)).json()).toEqual({ ok: true, changed: true, kept: 2, leftOut: 1, note: 'A link to a page that has been deleted since was left out.' });
    await newPage('plain', 'Plain', [para('one'), link('l7', 'here')]);
    await save('plain', [para('two')]);
    expect(await (await restore('plain', 1)).json()).toEqual({ ok: true, changed: true, kept: 2 });
  });

  it('putting back a version the page already matches is not a change, however the database ordered its fields', async () => {
    // The page goes back to its first contents by an ordinary save; version 1 holds the same contents, stored by the database.
    await ageVersions('plan', '6 minutes');
    await ws([{ op: 'put', col: 'docs', item: { id: 'plan', cover: { value: 'dawn', kind: 'gradient' }, icon: '📝', blocks: [{ text: 'First draft', type: 'p', id: 'b1' }] } }]);
    expect(await stored('plan')).toHaveLength(2);
    expect(await (await restore('plan', 1)).json()).toEqual({ ok: true, changed: false });
    expect(await stored('plan')).toHaveLength(2);
    expect(await rows(`select 1 from audit_log where workspace_id = $1 and action = 'page.version.restored'`, [w.workspaceId])).toEqual([]);
  });

  it('a version that would not pass the checks every save passes is refused, and the page is left as it was', async () => {
    const corrupt = (blocks: unknown, cover: unknown = null) => sysPool.query(`update doc_revision set blocks = $2::jsonb, cover = $3::jsonb where workspace_id = $1 and file_id = 'plan' and version = 1`, [w.workspaceId, JSON.stringify(blocks), cover ? JSON.stringify(cover) : null]);
    const refused = async (why: RegExp) => {
      const res = await restore('plan', 1);
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toMatch(why);
    };
    await corrupt([{ id: 'x', type: 'iframe', text: 'hi' }]);
    await refused(/can’t be put back.*block Timmy doesn’t know/);
    await corrupt([{ id: 'x', type: 'p', text: 'click', rich: [{ type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }]);
    await refused(/isn’t a web or email address/);
    await corrupt([para('fine')], { kind: 'image', value: 'http://insecure.test/a.png' });
    await refused(/cover/);
    await corrupt('not blocks');
    await refused(/can’t be put back/);

    expect(await textOf('plan')).toEqual(['Second draft']);
    expect((await stored('plan')).map((v) => v.reason)).toEqual(['edit']);
    expect(await rows(`select 1 from audit_log where workspace_id = $1 and action = 'page.version.restored'`, [w.workspaceId])).toEqual([]);
  });

  it('a role that only reads can list and preview, but not restore; a role that cannot read sees nothing', async () => {
    const reader = await addMember(w.workspaceId, 'revops', 'Rae Reader');
    const res = await reader.json<{ versions: Listed[]; canRestore: boolean }>('GET', '/api/v1/pages/plan/versions');
    expect(res.versions.map((v) => v.number)).toEqual([1]);
    expect(res.canRestore).toBe(false);
    expect((await reader.get('/api/v1/pages/plan/versions/1')).status).toBe(200);
    const no = await restore('plan', 1, reader);
    expect(no.status).toBe(403);
    expect(((await no.json()) as { error: string }).error).toMatch(/role can’t change pages/);

    const client = await addMember(w.workspaceId, 'client', 'Cal Client');
    expect((await client.get('/api/v1/pages/plan/versions')).status).toBe(403);
    expect((await client.get('/api/v1/pages/plan/versions/1')).status).toBe(403);
    expect((await restore('plan', 1, client)).status).toBe(403);
    expect((await client.get('/api/v1/pages/trash')).status).toBe(403);

    expect(await textOf('plan')).toEqual(['Second draft']);
    expect(await stored('plan')).toHaveLength(1);
  });

  it('a page in the trash still lists its versions, but none can be put back until it is out of the trash', async () => {
    await trash('plan', 'Plan');
    const res = await w.json<{ versions: Listed[]; canRestore: boolean }>('GET', '/api/v1/pages/plan/versions');
    expect(res.versions.map((v) => v.number)).toEqual([1]);
    expect(res.canRestore).toBe(false);
    expect((await w.get('/api/v1/pages/plan/versions/1')).status).toBe(200);
    const no = await restore('plan', 1);
    expect(no.status).toBe(409);
    expect(((await no.json()) as { error: string }).error).toMatch(/in the trash/);
    expect(await textOf('plan')).toEqual(['Second draft']);
    expect(await stored('plan')).toHaveLength(1);
    // Out of the trash, it works again.
    await ws([{ op: 'remove', col: 'trash', id: 'plan' }, { op: 'put', col: 'files', item: file('plan', 'Plan') }]);
    expect((await restore('plan', 1)).status).toBe(200);
    expect(await textOf('plan')).toEqual(['First draft']);
  });
});

describe('how long versions are kept', () => {
  /** Kept versions written straight into the table, numbered from 1, each a minute older than the next. */
  const seed = (id: string, count: number, workspaceId = w.workspaceId) =>
    sysPool.query(
      `insert into doc_revision (workspace_id, file_id, version, blocks, reason, preview, block_count, created_at)
       select $1, $2, n, jsonb_build_array(jsonb_build_object('id', 'b1', 'type', 'p', 'text', 'copy ' || n)), 'edit', 'copy ' || n, 1, now() - make_interval(mins => ($3 - n) + 10) from generate_series(1, $3::int) as n`,
      [workspaceId, id, count],
    );

  it('the newest 100 versions of a page are kept: the list never shows more, and the job removes the rest', async () => {
    await newPage('busy', 'Busy', [para('now')]);
    await newPage('quiet', 'Quiet', [para('now')]);
    await seed('busy', 105);
    await seed('quiet', 3);
    // Before the job has run, the list already stops at the newest 100.
    const before = await list('busy');
    expect(before).toHaveLength(100);
    expect([before[0]!.number, before[99]!.number]).toEqual([105, 6]);

    await runJob('page.versions.prune');
    const left = (await stored('busy')).map((v) => v.version);
    expect(left).toHaveLength(100);
    expect([left[0], left[99]]).toEqual([6, 105]);
    expect((await stored('quiet')).map((v) => v.version)).toEqual([1, 2, 3]);
    // The next version carries on from the newest number.
    await save('busy', [para('later')]);
    expect((await list('busy'))[0]).toMatchObject({ number: 106, preview: 'now' });
  });

  it('nothing older than 90 days is kept: it is not listed, read or put back, and the job removes it', async () => {
    await newPage('old', 'Old', [para('now')]);
    await seed('old', 4);
    await sysPool.query(`update doc_revision set created_at = now() - interval '91 days' where workspace_id = $1 and file_id = 'old' and version <= 2`, [w.workspaceId]);
    await sysPool.query(`update doc_revision set created_at = now() - interval '89 days' where workspace_id = $1 and file_id = 'old' and version = 3`, [w.workspaceId]);
    // Even before the job has run.
    expect((await list('old')).map((v) => v.number)).toEqual([4, 3]);
    expect((await w.get('/api/v1/pages/old/versions/2')).status).toBe(404);
    expect((await restore('old', 2)).status).toBe(404);
    expect(await textOf('old')).toEqual(['now']);
    expect((await w.get('/api/v1/pages/old/versions/3')).status).toBe(200);

    await runJob('page.versions.prune');
    expect((await stored('old')).map((v) => v.version)).toEqual([3, 4]);
  });
});

describe('when a page or a workspace is deleted for good', () => {
  /** Makes pages deleted for good look as if they went this long ago. */
  const ageGone = (ids: string[], interval: string, workspaceId = w.workspaceId) => sysPool.query(`update doc_revision set page_gone_at = now() - $3::interval where workspace_id = $1 and file_id = any($2::text[]) and page_gone_at is not null`, [workspaceId, ids, interval]);
  const gone = (id: string, workspaceId = w.workspaceId) => rows<{ version: number; gone: boolean }>('select version, page_gone_at is not null as gone from doc_revision where workspace_id = $1 and file_id = $2 order by version', [workspaceId, id]);
  /** "Delete forever", as the app sends it. */
  const deleteForever = (ids: string[], c: Client = w) => ws(ids.flatMap((id) => [{ op: 'remove', col: 'trash', id }, { op: 'remove', col: 'docs', id }]), c);

  // Changed on purpose: deleting a page for good used to remove its versions at once, so Undo brought the page back
  // without its history. They are now hidden for the trash period instead, and removed by the trash job.
  it('deleting a page for good hides its versions and its sub-pages’ versions; Undo brings the pages back with them', async () => {
    await newPage('parent', 'Parent', [para('p1'), { id: 'l', type: 'page', file: 'child' }]);
    await ws([{ op: 'put', col: 'files', item: file('child', 'Child', { parent: 'parent' }) }, { op: 'put', col: 'docs', item: { id: 'child', blocks: [para('c1')] } }]);
    await newPage('other', 'Other', [para('o1')]);
    for (const id of ['parent', 'child', 'other']) await save(id, [para(`${id} changed`), ...(id === 'parent' ? [{ id: 'l', type: 'page', file: 'child' }] : [])]);
    await trash('parent', 'Parent', [{ id: 'child', name: 'Child' }]);
    // In the trash, the versions are still there and still listed.
    expect([...(await stored('parent')), ...(await stored('child'))]).toHaveLength(2);
    expect(await list('parent')).toHaveLength(1);

    const deleted = await deleteForever(['parent', 'child']);
    expect(deleted.ok).toBe(true);
    // The rows are kept, but marked: nothing shows or reads them while the page is gone.
    expect([...(await gone('parent')), ...(await gone('child'))]).toEqual([{ version: 1, gone: true }, { version: 1, gone: true }]);
    expect(await gone('other')).toEqual([{ version: 1, gone: false }]);
    expect((await w.get('/api/v1/pages/parent/versions')).status).toBe(404);
    expect((await w.get('/api/v1/pages/parent/versions/1')).status).toBe(404);
    expect((await w.get('/api/v1/pages/child/versions/1')).status).toBe(404);

    // Undo of the deletion: both pages are back in the trash, each with its history.
    const undone = await w.cmd({ type: 'undo', command: deleted.id });
    expect(undone.ok).toBe(true);
    const s = await w.state();
    expect(Object.keys(s.ws.trash).sort()).toEqual(['child', 'parent']);
    expect(Object.keys(s.ws.docs).sort()).toEqual(['child', 'other', 'parent']);
    expect([...(await gone('parent')), ...(await gone('child'))]).toEqual([{ version: 1, gone: false }, { version: 1, gone: false }]);
    expect((await list('parent')).map((v) => v.preview)).toEqual(['p1']);
    expect((await w.json<{ blocks: Blocks }>('GET', '/api/v1/pages/child/versions/1')).blocks).toEqual([para('c1')]);
    // Out of the trash, a version can be put back as before.
    expect((await ws([{ op: 'remove', col: 'trash', id: 'parent' }, { op: 'put', col: 'files', item: file('parent', 'Parent') }])).ok).toBe(true);
    expect(await (await restore('parent', 1)).json()).toMatchObject({ ok: true, changed: true });
    // The sub-page is still in the trash, so the link to it stays.
    expect(((await w.state()).ws.docs.parent as unknown as { blocks: Blocks }).blocks).toEqual([para('p1'), { id: 'l', type: 'page', file: 'child' }]);
  });

  it('the hidden versions of a page deleted for good are removed by the trash job after 30 days, not before, and only that workspace’s', async () => {
    await newPage('gone', 'Gone', [para('one')]);
    await save('gone', [para('two')]);
    const keep = await newWorkspace('Kept');
    await newPage('gone', 'Gone', [para('theirs')], {}, keep);
    await save('gone', [para('theirs, changed')], keep);
    for (const c of [w, keep]) {
      await trash('gone', 'Gone', [], new Date(), c);
      expect((await deleteForever(['gone'], c)).ok).toBe(true);
    }
    // Day 29: Undo could still bring it back, so the versions stay.
    await ageGone(['gone'], '29 days');
    await runJob('page.trash.sweep');
    expect(await gone('gone')).toEqual([{ version: 1, gone: true }]);
    // Day 31: they go. The other workspace's page went today, so its versions stay.
    await ageGone(['gone'], '31 days');
    await runJob('page.trash.sweep');
    expect(await gone('gone')).toEqual([]);
    expect(await gone('gone', keep.workspaceId)).toEqual([{ version: 1, gone: true }]);
  });

  it('a page that comes back other than by Undo, under the same id, does not get the old history', async () => {
    await newPage('reused', 'Reused', [para('secret plan')]);
    await save('reused', [para('secret plan, changed')]);
    await trash('reused', 'Reused');
    expect((await deleteForever(['reused'])).ok).toBe(true);
    // A new page written straight into the deleted one's place.
    await newPage('reused', 'Reused', [para('a fresh start')]);
    expect(await list('reused')).toEqual([]);
    expect((await w.get('/api/v1/pages/reused/versions/1')).status).toBe(404);
    expect(await gone('reused')).toEqual([{ version: 1, gone: true }]);
    // Its own history starts after the old one, and is the only one shown.
    await save('reused', [para('a fresh start, changed')]);
    expect((await list('reused')).map((v) => [v.number, v.preview])).toEqual([[2, 'a fresh start']]);
  });

  it('a deleted workspace’s versions go with the rest of it', async () => {
    await newPage('plan', 'Plan', [para('one')]);
    await save('plan', [para('two')]);
    const keep = await newWorkspace('Kept');
    await newPage('plan', 'Plan', [para('theirs')], {}, keep);
    await save('plan', [para('theirs, changed')], keep);
    await sysPool.query(`update workspace set deleted_at = now() - interval '31 days' where id = $1`, [w.workspaceId]);
    await purgeDeletedWorkspaces(sysPool, 30);
    expect(await rows('select 1 from doc_revision where workspace_id = $1', [w.workspaceId])).toEqual([]);
    expect(await stored('plan', keep.workspaceId)).toHaveLength(1);
  });
});

describe('safety: no cross-workspace reads', () => {
  it('another workspace can neither list, read nor restore this workspace’s versions by id', async () => {
    await newPage('plan', 'Plan', [para('Alpha only: launch code 4242')]);
    await save('plan', [para('Alpha only, changed')]);
    const other = await newWorkspace('Elsewhere');

    // The other workspace has no such page.
    for (const res of [await other.get('/api/v1/pages/plan/versions'), await other.get('/api/v1/pages/plan/versions/1'), await restore('plan', 1, other)]) {
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('4242');
    }
    // Even with a page of the same id of its own, it gets its own history, never this workspace's.
    await newPage('plan', 'Plan', [para('Bravo page')], {}, other);
    expect(await list('plan', other)).toEqual([]);
    expect((await other.get('/api/v1/pages/plan/versions/1')).status).toBe(404);
    expect((await restore('plan', 1, other)).status).toBe(404);
    expect(await textOf('plan', other)).toEqual(['Bravo page']);
    await save('plan', [para('Bravo page, changed')], other);
    const theirs = await other.get('/api/v1/pages/plan/versions/1');
    expect(await theirs.text()).not.toContain('4242');
    expect((await restore('plan', 1, other)).status).toBe(200);
    expect(await textOf('plan', other)).toEqual(['Bravo page']);
    // And nothing of this workspace's moved.
    expect(await textOf('plan')).toEqual(['Alpha only, changed']);
    expect((await stored('plan')).map((v) => v.blocks)).toEqual([[para('Alpha only: launch code 4242')]]);
    // Its test hook is pinned to its own workspace too.
    expect(await (await other.post('/api/test/pages/age-versions', { page: 'plan', minutes: 60 })).json()).toEqual({ aged: 2 });
    expect(await rows(`select 1 from doc_revision where workspace_id = $1 and created_at < now() - interval '30 minutes'`, [w.workspaceId])).toEqual([]);
  });

  it('the database itself keeps versions apart: the app role sees only its own workspace’s rows and cannot change a kept version', async () => {
    await newPage('plan', 'Plan', [para('Alpha only')]);
    await save('plan', [para('Alpha only, changed')]);
    const other = await newWorkspace('Elsewhere');
    await newPage('theirs', 'Theirs', [para('Bravo only')], {}, other);
    await save('theirs', [para('Bravo only, changed')], other);

    // With no workspace set, the table is empty.
    const c = await appPool().connect();
    try {
      expect((await c.query('select count(*)::int as n from doc_revision')).rows[0].n).toBe(0);
    } finally {
      c.release();
    }
    await withWorkspace({ workspaceId: other.workspaceId }, async (tx) => {
      expect((await tx.query('select file_id from doc_revision')).rows).toEqual([{ file_id: 'theirs' }]);
      expect((await tx.query('select 1 from doc_revision where workspace_id = $1', [w.workspaceId])).rowCount).toBe(0);
      expect((await tx.query('delete from doc_revision where workspace_id = $1', [w.workspaceId])).rowCount).toBe(0);
    });
    await expect(withWorkspace({ workspaceId: other.workspaceId }, (tx) => tx.query(`insert into doc_revision (workspace_id, file_id, version, blocks, reason) values ($1, 'plan', 99, '[]'::jsonb, 'edit')`, [w.workspaceId]))).rejects.toThrow(/row-level security/);
    // A kept version is never rewritten, not even by its own workspace.
    await expect(withWorkspace({ workspaceId: w.workspaceId }, (tx) => tx.query(`update doc_revision set blocks = '[]'::jsonb`))).rejects.toThrow(/permission denied/);
    expect(await stored('plan')).toHaveLength(1);
  });
});

describe('the trash is emptied after 30 days', () => {
  const link = (id: string, to: string) => ({ id, type: 'page', file: to });

  it('tells the app how long a page is kept', async () => {
    expect(await w.json('GET', '/api/v1/pages/trash')).toEqual({ keptDays: 30 });
  });

  it('a page in the trash for more than 30 days is deleted for good with its sub-pages, their contents, their versions and the links to them; newer ones stay', async () => {
    // "Home" links to two pages; "Old" has a page inside it; "Index" links to that sub-page as well.
    await newPage('home', 'Home', [para('Welcome'), link('l1', 'old'), link('l2', 'fresh')]);
    await newPage('old', 'Old', [para('old v1'), link('l3', 'old-child')]);
    await ws([{ op: 'put', col: 'files', item: file('old-child', 'Old child', { parent: 'old' }) }, { op: 'put', col: 'docs', item: { id: 'old-child', blocks: [para('child v1')] } }]);
    await newPage('fresh', 'Fresh', [para('fresh v1')]);
    await newPage('index', 'Index', [link('l4', 'old-child'), para('The end')]);
    await save('old', [para('old v2'), link('l3', 'old-child')]);
    await save('old-child', [para('child v2')]);
    await save('fresh', [para('fresh v2')]);
    await trash('old', 'Old', [{ id: 'old-child', name: 'Old child' }]);
    await trash('fresh', 'Fresh');
    const count = async (id: string) => (await stored(id)).length;
    expect([await count('old'), await count('old-child'), await count('fresh')]).toEqual([1, 1, 1]);

    // Day 29: nothing goes.
    await ageTrash(['old', 'old-child', 'fresh'], '29 days');
    await runJob('page.trash.sweep');
    expect(Object.keys((await w.state()).ws.trash).sort()).toEqual(['fresh', 'old', 'old-child']);

    // Day 31 for "Old" and what went with it; "Fresh" has been there 29 days.
    await ageTrash(['old', 'old-child'], '31 days');
    await runJob('page.trash.sweep');
    const s = await w.state();
    expect(Object.keys(s.ws.trash)).toEqual(['fresh']);
    expect(Object.keys(s.ws.docs).sort()).toEqual(['fresh', 'home', 'index']);
    expect(await rows(`select id from state_doc where workspace_id = $1 and slice in ('ws.docs', 'ws.trash') and id in ('old', 'old-child')`, [w.workspaceId])).toEqual([]);
    expect([await count('old'), await count('old-child'), await count('fresh')]).toEqual([0, 0, 1]);
    // The links to the deleted pages are gone from the pages that remain; everything else on them is as it was.
    expect((s.ws.docs.home as unknown as { blocks: Blocks }).blocks).toEqual([para('Welcome'), link('l2', 'fresh')]);
    expect((s.ws.docs.index as unknown as { blocks: Blocks }).blocks).toEqual([para('The end')]);
    // Taking a dead link off a page is housekeeping, not an edit: it keeps no version.
    expect([await count('home'), await count('index')]).toEqual([0, 0]);
    // It is on the record, as the system's doing, and in the activity log.
    expect(await rows(`select actor, detail from audit_log where workspace_id = $1 and action = 'page.deleted'`, [w.workspaceId])).toEqual([{ actor: 'system', detail: { page: 'old', name: 'Old', pages: 2, why: 'in the trash for more than 30 days' } }]);
    expect(s.activity[0]!.text).toBe('Deleted the page “Old” for good: it had been in the trash for 30 days');
    expect((await w.get('/api/v1/pages/old/versions')).status).toBe(404);

    // Running it again changes nothing.
    const rev = s.rev;
    await runJob('page.trash.sweep');
    expect((await w.state()).rev).toBe(rev);
  });

  it('counts the days on the server’s own record, so a browser with a wrong clock can’t get a page deleted early; other workspaces are untouched', async () => {
    await newPage('dated', 'Dated', [para('still wanted')]);
    await save('dated', [para('still wanted, changed')]);
    // The browser says it went to the trash two months ago. It arrived just now.
    await trash('dated', 'Dated', [], new Date(Date.now() - 60 * 86400_000));
    const other = await newWorkspace('Elsewhere');
    await newPage('theirs', 'Theirs', [para('theirs')], {}, other);
    await trash('theirs', 'Theirs', [], new Date(), other);

    await runJob('page.trash.sweep');
    expect(Object.keys((await w.state()).ws.trash)).toEqual(['dated']);
    expect(await stored('dated')).toHaveLength(1);

    // Only this workspace's page is old enough.
    await ageTrash(['dated'], '31 days');
    await runJob('page.trash.sweep');
    expect(Object.keys((await w.state()).ws.trash)).toEqual([]);
    expect((await w.state()).ws.docs.dated).toBeUndefined();
    expect(await stored('dated')).toEqual([]);
    expect(Object.keys((await other.state()).ws.trash)).toEqual(['theirs']);
    expect((await other.state()).ws.docs.theirs).toBeDefined();
  });

  it('a sub-page left in the trash with nothing above it goes on its own date', async () => {
    await newPage('gone-parent', 'Gone parent', [para('x')]);
    await ws([{ op: 'put', col: 'trash', item: file('orphan', 'Orphan', { parent: 'gone-parent', trashed: new Date(), trashRoot: 'no-longer-in-the-trash' }) }, { op: 'put', col: 'docs', item: { id: 'orphan', blocks: [para('orphan')] } }]);
    await ageTrash(['orphan'], '40 days');
    await runJob('page.trash.sweep');
    const s = await w.state();
    expect(s.ws.trash.orphan).toBeUndefined();
    expect(s.ws.docs.orphan).toBeUndefined();
    expect(s.ws.docs['gone-parent']).toBeDefined();
  });
});
