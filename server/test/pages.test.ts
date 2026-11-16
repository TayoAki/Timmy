/**
 * The new screens' records on a real workspace: pages and their blocks, the trash, automations and the
 * website chat's settings. The screens send plain put / patch / remove operations; the server decides what is kept.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { blankState } from '../../src/live/blank';
import { noteLeadMail } from '../src/sync/ingest';
import { MAX_BLOCKS, automationProblems, checkWsOps } from '../src/state/ws-check';
import { addMember, boot, newWorkspace, rows, type Client } from './helpers';

let w: Client;
const ws = (ops: unknown[]) => w.cmd({ type: 'ws', ops });
const put = (col: string, item: Record<string, unknown>) => ws([{ op: 'put', col, item }]);
const node = (id: string, kind: string, config: Record<string, string> = {}) => ({ id, kind, x: 0, y: 0, config });
const edge = (from: string, to: string, branch?: 'yes' | 'no') => ({ id: `${from}-${to}`, from, to, ...(branch ? { branch } : {}) });
const automation = (extra: Record<string, unknown> = {}) => ({ id: 'a1', name: 'New lead', description: '', on: false, nodes: [node('t', 'email'), node('s', 'task')], edges: [edge('t', 's')], updated: new Date(), ...extra });

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  w = await newWorkspace('Pages');
});

describe('pages', () => {
  it('a page’s blocks, formatting, icon and cover are kept, and come back the same after a reload', async () => {
    const blocks = [
      { id: 'b1', type: 'h1', text: 'Kickoff notes' },
      { id: 'b2', type: 'p', text: 'See the plan', color: 'blue-bg', rich: [{ type: 'text', text: 'See ' }, { type: 'text', text: 'the plan', marks: [{ type: 'link', attrs: { href: 'https://example.test/plan' } }, { type: 'bold' }] }] },
      { id: 'b3', type: 'toggle', text: 'Details', open: true },
      { id: 'b4', type: 'todo', text: 'Send the agenda', checked: false, indent: 1 },
      { id: 'b5', type: 'table', columns: ['Date', 'Notes'], rows: [['Nov 16', 'First call']] },
      { id: 'b6', type: 'image', src: `data:image/png;base64,${'A'.repeat(400)}`, width: 320 },
      { id: 'b7', type: 'page', file: 'sub1' },
    ];
    expect((await ws([{ op: 'put', col: 'files', item: { id: 'd1', name: 'Kickoff', kind: 'doc' } }, { op: 'put', col: 'docs', item: { id: 'd1', blocks, icon: '📝', cover: { kind: 'gradient', value: 'dawn', y: 40 } } }])).ok).toBe(true);
    const doc = (await w.state()).ws.docs.d1 as unknown as { blocks: unknown[]; icon: string; cover: unknown };
    expect(doc.blocks).toEqual(blocks);
    expect(doc).toMatchObject({ icon: '📝', cover: { kind: 'gradient', value: 'dawn', y: 40 } });
    expect(await rows(`select 1 from state_doc where workspace_id = $1 and slice = 'ws.docs' and id = 'd1'`, [w.workspaceId])).toHaveLength(1);
  });

  it('a block Timmy doesn’t know, a link that isn’t a web address, or a picture that could carry a script is refused, and nothing is saved', async () => {
    const save = (blocks: unknown[]) => put('docs', { id: 'd2', blocks });
    const refused = async (blocks: unknown[], why: RegExp) => {
      const out = await save(blocks);
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(why);
    };
    await refused([{ id: 'x', type: 'iframe', text: 'hi' }], /block Timmy doesn’t know/);
    await refused([{ id: 'x', type: 'p', text: 'click', rich: [{ type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }], /isn’t a web or email address/);
    await refused([{ id: 'x', type: 'p', text: 'click', rich: [{ type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href: 'data:text/html,<script>1</script>' } }] }] }], /isn’t a web or email address/);
    await refused([{ id: 'x', type: 'image', src: 'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pg==' }], /picture/);
    await refused([{ id: 'x', type: 'image', src: 'javascript:alert(1)' }], /picture/);
    await refused([{ id: 'x', type: 'image', src: `data:image/png;base64,${'A'.repeat(800_000)}` }], /picture/);
    await refused([{ id: 'x', type: 'p', text: 'deep', indent: 9 }], /nested too deep/);
    await refused([{ id: 'x', type: 'p', text: 'a' }, { id: 'x', type: 'p', text: 'b' }], /same id/);
    expect((await put('docs', { id: 'd2', blocks: [], cover: { kind: 'image', value: 'http://insecure.test/a.png' } })).ok).toBe(false);
    expect((await w.state()).ws.docs.d2).toBeUndefined();
    // The limit on blocks is checked on the page as a whole.
    const many = Array.from({ length: MAX_BLOCKS + 1 }, (_, i) => ({ id: `b${i}`, type: 'p', text: '' }));
    expect(checkWsOps(blankState({ first: 'A', company: 'B' }), [{ op: 'put', col: 'docs', item: { id: 'big', blocks: many } }])).toMatch(/up to 5,000 blocks/);
  });

  it('a change that edits a saved page is checked as the page it would become', async () => {
    await put('docs', { id: 'd3', blocks: [{ id: 'b1', type: 'p', text: 'fine' }] });
    const bad = await ws([{ op: 'patch', col: 'docs', id: 'd3', patch: { blocks: [{ id: 'b1', type: 'script', text: 'x' }] } }]);
    expect(bad.ok).toBe(false);
    expect(((await w.state()).ws.docs.d3 as unknown as { blocks: { type: string }[] }).blocks[0]!.type).toBe('p');
    // In one batch, a later operation is judged against what the earlier ones did.
    const batch = await ws([{ op: 'put', col: 'docs', item: { id: 'd4', blocks: [] } }, { op: 'patch', col: 'docs', id: 'd4', patch: { icon: 'x'.repeat(40) } }]);
    expect(batch.ok).toBe(false);
    expect((await w.state()).ws.docs.d4).toBeUndefined();
  });

  it('a page goes to the trash with its sub-pages and comes back, across a reload', async () => {
    await ws([
      { op: 'put', col: 'files', item: { id: 'p1', name: 'Parent', kind: 'doc' } },
      { op: 'put', col: 'files', item: { id: 'p2', name: 'Child', kind: 'doc', parent: 'p1' } },
    ]);
    const trashed = new Date();
    expect((await ws([{ op: 'remove', col: 'files', id: 'p1' }, { op: 'remove', col: 'files', id: 'p2' }, { op: 'put', col: 'trash', item: { id: 'p1', name: 'Parent', kind: 'doc', trashed } }, { op: 'put', col: 'trash', item: { id: 'p2', name: 'Child', kind: 'doc', parent: 'p1', trashed, trashRoot: 'p1' } }])).ok).toBe(true);
    let s = await w.state();
    expect(Object.keys(s.ws.files)).toEqual([]);
    expect(Object.keys(s.ws.trash).sort()).toEqual(['p1', 'p2']);
    expect(s.ws.trash.p2).toMatchObject({ trashRoot: 'p1', parent: 'p1' });
    await ws([{ op: 'remove', col: 'trash', id: 'p1' }, { op: 'remove', col: 'trash', id: 'p2' }, { op: 'put', col: 'files', item: { id: 'p1', name: 'Parent', kind: 'doc' } }, { op: 'put', col: 'files', item: { id: 'p2', name: 'Child', kind: 'doc', parent: 'p1' } }]);
    s = await w.state();
    expect(Object.keys(s.ws.files).sort()).toEqual(['p1', 'p2']);
    expect(Object.keys(s.ws.trash)).toEqual([]);
  });

  it('only collections that exist can be written, and never by a role that only reads', async () => {
    for (const col of ['__proto__', 'constructor', 'made-up', 'threads']) expect([col, (await put(col, { id: 'x' })).ok]).toEqual([col, false]);
    expect((await ws([{ op: 'put', col: 'notes', item: { id: 'has space' } }])).ok).toBe(false);
    expect((await ws([{ op: 'put', col: 'notes', item: { id: 'n1', name: 'x'.repeat(400) } }])).ok).toBe(false);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    // A change to an id that every object answers to ("constructor") changes nothing: no record is made under it.
    for (const id of ['constructor', 'toString', '__proto__']) expect((await ws([{ op: 'patch', col: 'tasks', id, patch: { title: 'made from nothing' } }])).ok, id).toBe(true);
    expect(Object.keys((await w.state()).ws.tasks)).toEqual([]);
    const client = await addMember(w.workspaceId, 'client');
    expect((await client.cmd({ type: 'ws', ops: [{ op: 'put', col: 'docs', item: { id: 'c1', blocks: [] } }] })).ok).toBe(false);
    // Another workspace never sees these pages.
    await put('docs', { id: 'mine', blocks: [{ id: 'b', type: 'p', text: 'private' }] });
    const other = await newWorkspace('Elsewhere');
    expect((await other.state()).ws.docs.mine).toBeUndefined();
  });
});

describe('automations', () => {
  it('a drawing is saved as drawn, finished or not, and comes back after a reload', async () => {
    expect((await put('automations', automation())).ok).toBe(true);
    expect((await put('automations', { ...automation(), id: 'a2', nodes: [node('s', 'task')], edges: [] })).ok).toBe(true);
    const saved = (await w.state()).ws.automations;
    expect(Object.keys(saved).sort()).toEqual(['a1', 'a2']);
    expect(saved.a1).toMatchObject({ name: 'New lead', on: false, nodes: [{ id: 't', kind: 'email' }, { id: 's', kind: 'task' }], edges: [{ from: 't', to: 's' }] });
  });

  it('a graph that isn’t one is refused: unknown steps, loops, two triggers, arrows to nowhere', async () => {
    const refused = async (extra: Record<string, unknown>, why: RegExp) => {
      const out = await put('automations', automation({ id: 'bad', ...extra }));
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(why);
    };
    await refused({ nodes: [node('t', 'email'), node('s', 'shell-command')], edges: [] }, /step Timmy doesn’t know/);
    await refused({ nodes: [node('t', 'email'), node('a', 'task'), node('b', 'notify')], edges: [edge('t', 'a'), edge('a', 'b'), edge('b', 'a')] }, /loop back/);
    await refused({ nodes: [node('t', 'email'), node('u', 'schedule'), node('s', 'task')], edges: [edge('t', 's')] }, /one trigger/);
    await refused({ edges: [edge('t', 'ghost')] }, /isn’t there/);
    await refused({ nodes: [node('t', 'email'), node('s', 'task')], edges: [edge('s', 't')] }, /nothing can lead into it/);
    await refused({ nodes: Array.from({ length: 61 }, (_, i) => node(`n${i}`, 'task')), edges: [] }, /up to 60 steps/);
    expect((await w.state()).ws.automations.bad).toBeUndefined();
  });

  it('what has to be true before one can run: one trigger, everything connected, settings filled, fields that exist', () => {
    const ok = { nodes: [node('t', 'form', { form: 'Website: Book a demo' }), node('c', 'condition', { field: 'budget', op: 'more than', value: '5000' }), node('n', 'notify', { where: 'Timmy (Today page)', message: 'New: {{name}} from {{company}}' })], edges: [edge('t', 'c'), edge('c', 'n', 'yes')] };
    expect(automationProblems(ok, true)).toEqual([]);
    expect(automationProblems({ nodes: [node('n', 'notify')], edges: [] }, true)).toEqual(['Add a trigger: what should start this automation?']);
    expect(automationProblems({ ...ok, nodes: [...ok.nodes, node('loose', 'task')] }, true).join(' ')).toMatch(/has to be connected/);
    expect(automationProblems({ nodes: [node('t', 'form'), node('n', 'notify')], edges: [edge('t', 'n')] }, true).join(' ')).toMatch(/needs its “Form” set/);
    expect(automationProblems({ nodes: [node('t', 'form', { form: 'Website: Book a demo' }), node('n', 'notify', { where: 'Timmy (Today page)', message: 'Hi {{password}}' })], edges: [edge('t', 'n')] }, true).join(' ')).toMatch(/\{\{password\}\}, which this trigger doesn’t provide/);
    expect(automationProblems({ nodes: [node('t', 'form', { form: 'Website: Book a demo' }), node('c', 'condition', { field: 'budget', value: '1' })], edges: [edge('t', 'c')] }, true).join(' ')).toMatch(/at least one branch/);
    // While it is only being drawn, an unfinished graph is fine.
    expect(automationProblems({ nodes: [node('n', 'notify')], edges: [] }, false)).toEqual([]);
  });
});

describe('the website chat’s settings', () => {
  it('every workspace has them, switched off and empty, and they can be filled in', async () => {
    const start = (await w.state()).ws.chat.site!;
    expect(start).toMatchObject({ id: 'site', on: false, domain: '', questions: [], faq: [], booking: false });
    expect((await ws([{ op: 'patch', col: 'chat', id: 'site', patch: { domain: 'acme.example', greeting: 'Hello!', questions: [{ id: 'q1', text: 'What’s your company called?' }], faq: [{ id: 'f1', q: 'Price?', a: '$29 a seat.' }] } }])).ok).toBe(true);
    expect((await w.state()).ws.chat.site).toMatchObject({ domain: 'acme.example', greeting: 'Hello!', questions: [{ id: 'q1' }], faq: [{ id: 'f1' }] });
  });

  it('settings outside their limits are refused, and the settings can’t be removed or doubled', async () => {
    const patch = (p: Record<string, unknown>) => ws([{ op: 'patch', col: 'chat', id: 'site', patch: p }]);
    expect((await patch({ domain: 'https://acme.example/path' })).error).toMatch(/plain address/);
    expect((await patch({ color: 'red; background:url(x)' })).error).toMatch(/colour/);
    expect((await patch({ icon: 'data:image/svg+xml;base64,PHN2Zz4=' })).error).toMatch(/picture/);
    expect((await patch({ questions: Array.from({ length: 11 }, (_, i) => ({ id: `q${i}`, text: 'x' })) })).error).toMatch(/up to 10 questions/);
    expect((await patch({ handoff: 'call-the-ceo' })).ok).toBe(false);
    expect((await ws([{ op: 'remove', col: 'chat', id: 'site' }])).ok).toBe(false);
    expect((await put('chat', { ...(await w.state()).ws.chat.site, id: 'second' })).ok).toBe(false);
    expect(Object.keys((await w.state()).ws.chat)).toEqual(['site']);
  });

  it('a visitor’s conversation can’t be written or rewritten by a member’s screen', async () => {
    expect((await put('chats', { id: 'c1', messages: [{ id: 'm', from: 'visitor', text: 'hi', at: new Date() }], live: false, unread: true })).error).toMatch(/can’t be changed that way/);
    expect((await ws([{ op: 'patch', col: 'chats', id: 'c1', patch: { messages: [] } }])).ok).toBe(false);
    expect((await ws([{ op: 'remove', col: 'chats', id: 'c1' }])).ok).toBe(false);
    expect((await ws([{ op: 'patch', col: 'chats', id: 'c1', patch: { unread: false, starred: true } }])).ok).toBe(true);
    expect((await w.state()).ws.chats).toEqual({});
  });
});

describe('cold-email drafts', () => {
  it('several drafts are never sent in one go from Timmy', async () => {
    const out = await w.cmd({ type: 'out', op: { op: 'sendDrafts', ids: ['d1', 'd2'] } });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/doesn’t send cold email itself/);
  });

  it('a draft leaves the list once the person’s own send to that lead is seen in Sent', () => {
    const s = blankState({ first: 'Ada', company: 'Ada Co' });
    s.out.leads = { l1: { id: 'l1', first: 'Lee', last: 'Park', email: 'lee@leadco.test', status: 'new' } as never, l2: { id: 'l2', first: 'Sam', last: 'Roe', email: 'sam@other.test', status: 'new' } as never };
    s.out.messages = [
      { id: 'draft-1', lead: 'l1', channel: 'email', dir: 'out', at: new Date(), subject: 'Idea', body: 'Hi Lee', status: 'draft' },
      { id: 'draft-2', lead: 'l2', channel: 'email', dir: 'out', at: new Date(), subject: 'Idea', body: 'Hi Sam', status: 'draft' },
    ] as never;
    const next = noteLeadMail(s, [{ id: 'm1', threadKey: 't1', at: new Date(), from: 'ada@adaco.test', to: ['lee@leadco.test'], cc: [], subject: 'Idea', text: 'Hi Lee', labels: ['SENT'], attachments: [] }]);
    expect(next.out.messages.map((m) => [m.lead, m.status])).toEqual([['l2', 'draft'], ['l1', 'sent']]);
    expect(next.out.leads.l1!.status).toBe('contacted');
  });
});
