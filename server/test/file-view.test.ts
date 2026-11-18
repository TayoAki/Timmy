/**
 * Showing a connected file inside Timmy (src/files/view.ts): read through its own connection when opened, never
 * stored; a Google Doc with its formatting and nothing that can act, a sheet as rows, slides one by one; only a file on
 * this workspace's own list, from an account still connected.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { docHtml } from '../src/files/view';
import { boot, connectApp, fake, jobs, newWorkspace, rows, type Client } from './helpers';

let w: Client;
let drive: { connectionId: string; account: string };

const add = async (f: Record<string, unknown> & { name: string }) => {
  fake().addFile(drive.account, f);
  const { syncFiles } = await import('../src/sync/files');
  await syncFiles(w.workspaceId, drive.connectionId);
  return (await rows<{ id: string }>(`select id from item where workspace_id = $1 and kind = 'file' and subject = $2`, [w.workspaceId, f.name]))[0]!.id;
};
const view = async (c: Client, id: string) => {
  const r = await c.request('GET', `/api/v1/connected-files/${id}/view`);
  return { status: r.status, body: (await r.json()) as { name: string; type: string; app: string; link?: string; view: Record<string, unknown> } };
};

const DOC = [
  { paragraph: { paragraphStyle: { namedStyleType: 'TITLE' }, elements: [{ textRun: { content: 'Acme redesign brief\n' } }] } },
  { paragraph: { elements: [{ textRun: { content: 'Launch by ' } }, { textRun: { content: 'March 3', textStyle: { bold: true } } }, { textRun: { content: '. See ' } }, { textRun: { content: 'the board', textStyle: { link: { url: 'https://acme.test/board' } } } }, { textRun: { content: '.\n' } }] } },
  { paragraph: { bullet: { listId: 'l1' }, elements: [{ textRun: { content: 'New homepage\n' } }] } },
  { paragraph: { bullet: { listId: 'l1' }, elements: [{ textRun: { content: '<script>alert(1)</script>\n' } }] } },
  { paragraph: { elements: [{ textRun: { content: 'Bad link', textStyle: { link: { url: 'javascript:alert(1)' } } } }] } },
  { table: { tableRows: [{ tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: 'Budget\n' } }] } }] }, { content: [{ paragraph: { elements: [{ textRun: { content: '$40,000\n' } }] } }] }] }] } },
];

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  jobs().queue = [];
  w = await newWorkspace('Viewer');
  drive = await connectApp(w, 'gdrive', 'owner@viewer.test');
  jobs().queue = [];
});

describe('a Google Doc', () => {
  it('turns Google’s structure into headings, bold, links, lists and tables, with every word escaped', () => {
    const html = docHtml(DOC as never);
    expect(html).toContain('<h1>Acme redesign brief</h1>');
    expect(html).toContain('<strong>March 3</strong>');
    expect(html).toContain('<a href="https://acme.test/board">the board</a>');
    expect(html).toContain('<ul><li style="margin-left:0px">New homepage</li><li style="margin-left:0px">&lt;script&gt;alert(1)&lt;/script&gt;</li></ul>');
    expect(html).toContain('<td><p>$40,000</p></td>');
  });

  it('is shown with its formatting, cleaned like an email: nothing in it can act', async () => {
    const id = await add({ name: 'Acme redesign brief', doc: DOC });
    const r = await view(w, id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: 'Acme redesign brief', type: 'Google Doc', app: 'Google Drive' });
    const html = String(r.body.view.html);
    expect(r.body.view.kind).toBe('doc');
    expect(html).toContain('<a href="https://acme.test/board" target="_blank" rel="noopener noreferrer nofollow">the board</a>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
    expect(r.body.link).toMatch(/^https:\/\/docs\.google\.com\//);
    // Read when opened; nothing of it stored.
    expect(await rows(`select 1 from item_body b join item i on i.id = b.item_id where i.id = $1 and b.text like '%Launch by%'`, [id])).toHaveLength(0);
  });
});

describe('other kinds', () => {
  it('a sheet as rows, slides one by one, and what can’t be shown says so', async () => {
    const sheet = await add({ name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet', rows: [['Item', 'Cost'], ['Design', 12000], ['Build', 28000]] });
    expect((await view(w, sheet)).body.view).toEqual({ kind: 'sheet', rows: [['Item', 'Cost'], ['Design', '12000'], ['Build', '28000']], more: false });
    const deck = await add({ name: 'Pitch', mimeType: 'application/vnd.google-apps.presentation', text: 'Welcome\n\nThe plan' });
    expect((await view(w, deck)).body.view).toEqual({ kind: 'slides', slides: ['Welcome', 'The plan'] });
    const pdf = await add({ name: 'Signed contract.pdf', mimeType: 'application/pdf' });
    const none = (await view(w, pdf)).body;
    expect(none.view.kind).toBe('none');
    expect(String(none.view.reason)).toMatch(/can’t show a pdf yet/i);
  });

  it('only a file on this workspace’s list, from an account still connected', async () => {
    const id = await add({ name: 'Private plan', text: 'Only ours.' });
    const other = await newWorkspace('Elsewhere');
    expect((await view(other, id)).status).toBe(404);
    expect((await view(w, 'itm_not_a_file')).status).toBe(404);
    await w.post('/api/v1/connections/gdrive/disconnect');
    expect((await view(w, id)).status).toBe(404);
  });
});
