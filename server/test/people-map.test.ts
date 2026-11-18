/**
 * People › Map (src/ontology/map.ts): the people, companies, projects, files, meetings and open promises Timmy knows of,
 * and how they connect, drawn only from what it already keeps, and only the caller's own workspace's.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceMap } from '../src/ontology/map';
import type { Scan } from '../src/projects/scan';
import { addMember, boot, connectApp, connectGmail, fake, jobs, model, newWorkspace, rows, sysPool, type Client } from './helpers';

let w: Client;
let box: { connectionId: string; account: string };

const deliver = async (from: string, subject: string) => {
  const d = fake().deliver(box.account, { from, subject, body: 'Could you take a look?' });
  await (await boot()).request('/api/hooks/composio', { method: 'POST', headers: d.webhook.headers, body: d.webhook.body });
};
const map = (c: Client = w) => c.json<WorkspaceMap>('GET', '/api/v1/map');
const has = (m: WorkspaceMap, a: string, b: string, kind: string) => m.edges.some((e) => e.kind === kind && ((e.source === a && e.target === b) || (e.source === b && e.target === a)));

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  model().reset();
  jobs().queue = [];
  w = await newWorkspace('Map');
  box = await connectGmail(w, 'me@mycompany.test');
  await jobs().drain();
});

describe('the map', () => {
  it('shows people at their companies, kept projects with their companies and files, and open promises', async () => {
    const drive = await connectApp(w, 'gdrive', 'me@mycompany.test');
    fake().addFile(drive.account, { name: 'Acme redesign brief', owner: 'dana@acme.test' });
    await deliver('Dana Whitfield <dana@acme.test>', 'Website redesign kickoff');
    await deliver('Sam Rivera <sam@acme.test>', 'Homepage wireframes');
    await deliver('Dana Whitfield <dana@acme.test>', 'Redesign budget');
    await deliver('Lee Park <lee@northwind.test>', 'Renewal terms');
    await jobs().drain();
    // Keep the Acme project a scan finds.
    await w.request('POST', '/api/v1/projects/detect', {});
    await jobs().drain();
    const scan = (await w.json<{ scan: Scan }>('GET', '/api/v1/projects/detect')).scan;
    const acme = scan.proposals.find((p) => p.keys[0] === 'org:acme.test')!;
    await w.request('POST', `/api/v1/projects/detect/${scan.id}/apply`, { choices: [{ id: acme.id, keep: true, name: 'Acme website' }] });
    // A promise Dana made, as reading her email would have recorded it.
    const dana = (await rows<{ id: string }>(`select id from entity where workspace_id = $1 and type = 'person' and key = 'dana@acme.test'`, [w.workspaceId]))[0]!.id;
    await sysPool.query(`insert into entity (id, workspace_id, type, key, name, attrs) values ('ent_promise_1', $1, 'commitment', 'k1', 'send the signed SOW', '{"who":"them","due":"2026-11-20","open":true}')`, [w.workspaceId]);
    await sysPool.query(`insert into relation (id, workspace_id, kind, from_id, to_id) values ('rel_promise_1', $1, 'promised_by', 'ent_promise_1', $2)`, [w.workspaceId, dana]);

    const m = await map();
    const node = (id: string) => m.nodes.find((n) => n.id === id);
    expect(node('person:dana@acme.test')).toMatchObject({ type: 'person', label: 'Dana Whitfield', company: 'company:acme.test' });
    expect(node('company:acme.test')).toMatchObject({ type: 'company', label: 'Acme' });
    expect(node('company:northwind.test')).toBeTruthy();
    const project = m.nodes.find((n) => n.type === 'project')!;
    expect(project).toMatchObject({ label: 'Acme website', weight: 3 });
    expect(has(m, 'person:dana@acme.test', 'company:acme.test', 'works_at')).toBe(true);
    expect(has(m, project.id, 'company:acme.test', 'in_project')).toBe(true);
    const file = m.nodes.find((n) => n.type === 'file' && n.label === 'Acme redesign brief')!;
    expect(file).toBeTruthy();
    expect(has(m, project.id, file.id, 'linked')).toBe(true);
    const promise = m.nodes.find((n) => n.type === 'promise')!;
    expect(promise).toMatchObject({ label: 'send the signed SOW', who: 'them', due: '2026-11-20' });
    expect(has(m, 'person:dana@acme.test', promise.id, 'promised')).toBe(true);
    // Every edge joins two nodes on the map.
    const ids = new Set(m.nodes.map((n) => n.id));
    expect(m.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
    expect(m.totals).toMatchObject({ people: 3, companies: 2, projects: 1, promises: 1 });
    // The mailbox's owner and automated senders are not people on the map.
    expect(m.nodes.some((n) => n.id === 'person:me@mycompany.test')).toBe(false);
  });

  it('is only ever the caller’s own workspace, and only for a role that may read it', async () => {
    await deliver('Dana Whitfield <dana@acme.test>', 'Hello');
    await jobs().drain();
    expect((await map()).nodes.length).toBeGreaterThan(0);
    const other = await newWorkspace('Elsewhere');
    expect(await map(other)).toEqual({ nodes: [], edges: [], totals: { people: 0, companies: 0, projects: 0, files: 0, meetings: 0, promises: 0 } });
    const client = await addMember(w.workspaceId, 'client', 'Cli Ent');
    expect((await client.request('GET', '/api/v1/map')).status).toBe(403);
  });
});
