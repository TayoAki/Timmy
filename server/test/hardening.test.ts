/**
 * Hardening found by attacking the API the way an outsider with an account would: inputs that are well-formed
 * JSON but lean on how JavaScript objects work, rather than on anything the screens would ever send.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearsAsNull } from '../../src/live/patches';
import { boot, newWorkspace, rows, type Client } from './helpers';

let w: Client;
const ws = (ops: unknown[]) => w.cmd({ type: 'ws', ops });

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  w = await newWorkspace('Hardening');
});

describe('records are kept under ids, and an id can’t be a name every object already has', () => {
  const BUILT_IN = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'];

  it('a record with such an id is refused, and nothing is saved', async () => {
    for (const id of BUILT_IN) {
      // JSON.parse is what the server does with a request body: it makes “__proto__” an ordinary key, which is the case to test.
      const item = JSON.parse(`{"id":${JSON.stringify(id)},"name":"Sneaky","kind":"doc"}`);
      const out = await ws([{ op: 'put', col: 'files', item }]);
      expect(out.ok, id).toBe(false);
      expect(out.error).toMatch(/isn’t in a form Timmy can save/);
    }
    expect(Object.keys((await w.state()).ws.files)).toEqual([]);
    expect(await rows(`select 1 from state_doc where workspace_id = $1 and slice = 'ws.files'`, [w.workspaceId])).toHaveLength(0);
  });

  it('changing or removing a record by such an id is refused too: it is not there, whatever the object says', async () => {
    for (const id of BUILT_IN) {
      expect((await ws([{ op: 'patch', col: 'files', id, patch: { name: 'Made from nothing' } }])).ok, id).toBe(false);
      expect((await ws([{ op: 'remove', col: 'files', id }])).ok, id).toBe(false);
    }
    expect(Object.keys((await w.state()).ws.files)).toEqual([]);
  });

  it('a collection that isn’t one of the workspace’s is refused, including the names every object has', async () => {
    for (const col of ['__proto__', 'constructor', 'toString', 'secrets']) {
      expect((await ws([{ op: 'put', col, item: { id: 'x1', name: 'x' } }])).ok, col).toBe(false);
    }
  });

  it('a key named “__proto__” inside a record does not change what the record is', async () => {
    const item = JSON.parse('{"id":"t-1","name":"Plain task","kind":"doc","__proto__":{"admin":true}}');
    await ws([{ op: 'put', col: 'files', item }]);
    const saved = (await w.state()).ws.files['t-1'] as unknown as Record<string, unknown> | undefined;
    // Kept or refused, it must not have gained anything by inheritance, and no other object may have either.
    expect(saved?.admin).toBeUndefined();
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it('ordinary ids still work, including ones with dots, colons and an @', async () => {
    expect((await ws([{ op: 'put', col: 'files', item: { id: 'mail:ada@example.test', name: 'Ada', kind: 'doc' } }])).ok).toBe(true);
    expect((await ws([{ op: 'put', col: 'files', item: { id: 'doc-lq3x9a-1.v2', name: 'Notes', kind: 'doc' } }])).ok).toBe(true);
    expect(Object.keys((await w.state()).ws.files).sort()).toEqual(['doc-lq3x9a-1.v2', 'mail:ada@example.test']);
  });
});

describe('a field is cleared by sending null for it in a patch', () => {
  it('taking the cover and the icon off a page removes them, and leaves the rest of the page alone', async () => {
    const blocks = [{ id: 'b1', type: 'p', text: 'Kept' }];
    expect((await ws([{ op: 'put', col: 'files', item: { id: 'd1', name: 'Page', kind: 'doc' } }, { op: 'put', col: 'docs', item: { id: 'd1', blocks, icon: '📝', cover: { kind: 'gradient', value: 'dawn' } } }])).ok).toBe(true);
    // What the browser sends: JSON has no “undefined”, so a cleared field arrives as null.
    expect((await ws([{ op: 'patch', col: 'docs', id: 'd1', patch: JSON.parse('{"cover":null,"icon":null}') }])).ok).toBe(true);
    const doc = (await w.state()).ws.docs.d1 as unknown as Record<string, unknown>;
    expect(doc.cover).toBeUndefined();
    expect(doc.icon).toBeUndefined();
    expect(doc.blocks).toEqual(blocks);
    const stored = (await rows(`select data from state_doc where workspace_id = $1 and slice = 'ws.docs' and id = 'd1'`, [w.workspaceId]))[0] as { data: Record<string, unknown> };
    expect(Object.keys(stored.data).sort()).toEqual(['blocks', 'id']);
  });

  it('the browser’s side turns a cleared field into null, and only inside a patch', () => {
    const action = { type: 'ws', ops: [{ op: 'patch', col: 'docs', id: 'd1', patch: { cover: undefined, icon: '📝' } }, { op: 'put', col: 'files', item: { id: 'f1', name: 'x', parent: undefined } }] };
    const sent = JSON.parse(JSON.stringify(clearsAsNull(action)));
    expect(sent.ops[0].patch).toEqual({ cover: null, icon: '📝' });
    expect(sent.ops[1].item).toEqual({ id: 'f1', name: 'x' });
    const other = { type: 'move', id: 't1', box: 'archived', filing: undefined };
    expect(clearsAsNull(other)).toBe(other);
  });

  it('a field that must be there can’t be cleared', async () => {
    await ws([{ op: 'put', col: 'files', item: { id: 'd2', name: 'Page', kind: 'doc' } }, { op: 'put', col: 'docs', item: { id: 'd2', blocks: [] } }]);
    expect((await ws([{ op: 'patch', col: 'docs', id: 'd2', patch: JSON.parse('{"blocks":null}') }])).ok).toBe(false);
    expect((await w.state()).ws.docs.d2).toBeTruthy();
  });
});

describe('a task every screen can draw', () => {
  const task = (extra: Record<string, unknown> = {}) => ({ id: 't1', title: 'Call the supplier', status: 'todo', priority: 'normal', created: new Date(), ...extra });

  it('a task with its status, priority and dates is kept', async () => {
    expect((await ws([{ op: 'put', col: 'tasks', item: task({ due: new Date(Date.now() + 86_400_000), notes: 'Ask about lead times.' }) }])).ok).toBe(true);
    expect((await w.state()).ws.tasks.t1).toMatchObject({ title: 'Call the supplier', priority: 'normal' });
  });

  it('a task without a priority or a status, or with one the board doesn’t know, is refused', async () => {
    for (const bad of [task({ priority: undefined }), task({ status: undefined }), task({ priority: 'urgent' }), task({ status: 'blocked' }), task({ title: 'x'.repeat(501) }), task({ created: 'not a date' }), task({ due: 'someday' }), task({ notes: { html: '<b>x</b>' } })]) {
      expect((await ws([{ op: 'put', col: 'tasks', item: bad }])).ok, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
    expect(Object.keys((await w.state()).ws.tasks)).toEqual([]);
  });

  it('a change that would leave a task the board can’t draw is refused, and the task stays as it was', async () => {
    await ws([{ op: 'put', col: 'tasks', item: task() }]);
    expect((await ws([{ op: 'patch', col: 'tasks', id: 't1', patch: { status: 'nope' } }])).ok).toBe(false);
    expect((await ws([{ op: 'patch', col: 'tasks', id: 't1', patch: JSON.parse('{"priority":null}') }])).ok).toBe(false);
    expect((await ws([{ op: 'patch', col: 'tasks', id: 't1', patch: { status: 'done' } }])).ok).toBe(true);
    expect((await w.state()).ws.tasks.t1).toMatchObject({ status: 'done', priority: 'normal' });
  });
});

