/**
 * The Notion-style doc editor, automations and website chat keep their state on the API like
 * everything else: the editor's blocks (with formatting, nesting and colours), page icons and
 * covers, sub-pages, the trash, automations and the chat's settings and conversations.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { forget } from '../src/state/docs';
import { boot, newWorkspace, type Client } from './helpers';

let w: Client;
beforeAll(async () => {
  await boot();
  w = await newWorkspace('Pages Co');
});

const at = new Date('2026-11-16T09:00:00Z');

describe('the new UI’s state', () => {
  it('a new workspace has an empty trash, no automations, no chats, and a chat that is off', async () => {
    const s = await w.state();
    expect(s.ws.trash).toEqual({});
    expect(s.ws.automations).toEqual({});
    expect(s.ws.chats).toEqual({});
    expect(s.ws.chat.site).toMatchObject({ on: false, name: 'Pages Co', faq: [] });
    expect(s.ws.chat.site.questions).toHaveLength(3);
  });

  it('keeps a doc’s blocks, formatting, nesting, icon and cover, and its sub-page', async () => {
    const blocks = [
      { id: 'b1', type: 'h1', text: 'Plan' },
      { id: 'b2', type: 'toggle', text: 'Details', open: false },
      { id: 'b3', type: 'p', text: 'Ship it', indent: 1, color: 'blue', rich: [{ type: 'text', text: 'Ship it', marks: [{ type: 'bold' }] }] },
      { id: 'b4', type: 'page', file: 'child' },
    ];
    const out = await w.cmd({
      type: 'ws',
      ops: [
        { op: 'put', col: 'files', item: { id: 'parent', name: 'Plan', kind: 'doc', folder: 'root', updated: at, owner: 'me' } },
        { op: 'put', col: 'docs', item: { id: 'parent', template: 'blank', blocks, icon: '🚀', cover: { kind: 'gradient', value: 'indigo' } } },
        { op: 'put', col: 'files', item: { id: 'child', name: 'Notes', kind: 'doc', folder: 'root', updated: at, owner: 'me', parent: 'parent' } },
        { op: 'put', col: 'docs', item: { id: 'child', template: 'blank', blocks: [{ id: 'c1', type: 'p', text: '' }] } },
      ],
    });
    expect(out.ok).toBe(true);
    forget();
    const s = await w.state();
    expect(s.ws.docs.parent).toMatchObject({ icon: '🚀', cover: { kind: 'gradient', value: 'indigo' } });
    expect(s.ws.docs.parent!.blocks).toEqual(blocks);
    expect(s.ws.files.child).toMatchObject({ parent: 'parent' });
  });

  it('moving a page to the trash takes it out of the files and keeps it, restorable', async () => {
    const s0 = await w.state();
    const file = s0.ws.files.child!;
    const out = await w.cmd({ type: 'ws', ops: [{ op: 'remove', col: 'files', id: 'child' }, { op: 'put', col: 'trash', item: { ...file, trashed: at } }] });
    expect(out.ok).toBe(true);
    forget();
    const s = await w.state();
    expect(s.ws.files.child).toBeUndefined();
    expect(s.ws.trash.child).toMatchObject({ name: 'Notes', parent: 'parent' });
    expect(s.ws.trash.child!.trashed).toBeInstanceOf(Date);
  });

  it('keeps an automation’s steps, links and settings, and its on/off switch', async () => {
    const automation = {
      id: 'a1',
      name: 'Reply to new leads',
      description: '',
      on: false,
      updated: at,
      nodes: [
        { id: 'n1', kind: 'form', x: 0, y: 0, config: { form: 'Website: Book a demo' } },
        { id: 'n2', kind: 'draft', x: 0, y: 150, config: { message: 'Hi {{name}}' } },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2' }],
    };
    expect((await w.cmd({ type: 'ws', ops: [{ op: 'put', col: 'automations', item: automation }] })).ok).toBe(true);
    expect((await w.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'automations', id: 'a1', patch: { on: true } }] })).ok).toBe(true);
    forget();
    const s = await w.state();
    expect(s.ws.automations.a1).toMatchObject({ on: true, nodes: automation.nodes, edges: automation.edges });
  });

  it('keeps the website chat’s settings and a visitor’s chat, and nothing is sent', async () => {
    const s0 = await w.state();
    const out = await w.cmd({
      type: 'ws',
      ops: [
        { op: 'patch', col: 'chat', id: 'site', patch: { on: true, domain: 'pages.example', faq: [{ id: 'f1', q: 'Price?', a: '$29 a seat' }] } },
        { op: 'put', col: 'chats', item: { id: 'c1', email: 'v@example.com', live: true, unread: false, messages: [{ id: 'm1', from: 'you', text: 'Hi there', at }] } },
      ],
    });
    expect(out.ok).toBe(true);
    forget();
    const s = await w.state();
    expect(s.ws.chat.site).toMatchObject({ on: true, domain: 'pages.example', name: s0.ws.chat.site!.name });
    expect(s.ws.chats.c1!.messages[0]).toMatchObject({ from: 'you', text: 'Hi there' });
    expect(s.out.messages).toEqual([]);
  });
});
