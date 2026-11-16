/**
 * Hardening found by attacking the API the way an outsider with an account would: inputs that are well-formed
 * JSON but lean on how JavaScript objects work, rather than on anything the screens would ever send.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
