/**
 * Detecting projects (src/projects): a scan groups a workspace's mail, files and meetings by who they are with, the
 * model names each group (and may split one), the person keeps, renames, merges or drops what was found, and what is
 * kept becomes projects whose new mail is filed into them. Nothing is written to a mailbox or a Drive.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Proposal } from '../src/projects/detect';
import type { Scan } from '../src/projects/scan';
import { addMember, boot, connectApp, connectGmail, fake, jobs, model, newWorkspace, rows, type Client } from './helpers';

let w: Client;
let box: { connectionId: string; account: string };

const deliver = async (from: string, subject: string, extra: { to?: string[]; labels?: string[]; body?: string } = {}) => {
  const d = fake().deliver(box.account, { from, subject, body: extra.body ?? 'Could you take a look at this?', ...(extra.to ? { to: extra.to } : {}), ...(extra.labels ? { labels: extra.labels } : {}) });
  await (await boot()).request('/api/hooks/composio', { method: 'POST', headers: d.webhook.headers, body: d.webhook.body });
};
const scan = async (c: Client = w) => {
  const started = await c.request('POST', '/api/v1/projects/detect', {});
  if (started.status !== 200) return { status: started.status, scan: null as Scan | null };
  await jobs().drain();
  return { status: 200, scan: (await c.json<{ scan: Scan }>('GET', '/api/v1/projects/detect')).scan };
};
const apply = async (scanId: string, choices: unknown[], c: Client = w) => {
  const r = await c.request('POST', `/api/v1/projects/detect/${scanId}/apply`, { choices });
  return { status: r.status, body: (await r.json()) as { created?: { id: string; name: string; threads: number }[]; error?: string } };
};
const named = (s: Scan, name: string) => s.proposals.find((p) => p.name === name)!;

/** A mailbox with two clients, a freelancer on personal mail, colleagues planning an offsite, and junk. */
async function seed() {
  await deliver('Dana Whitfield <dana@acme.test>', 'Website redesign kickoff');
  await deliver('Sam Rivera <sam@acme.test>', 'Homepage wireframes');
  await deliver('Dana Whitfield <dana@acme.test>', 'Redesign budget question');
  await deliver('Lee Park <lee@northwind.test>', 'Northwind renewal terms');
  await deliver('Lee Park <lee@northwind.test>', 'Renewal: signed order form');
  await deliver('Jo Freelancer <jo.design@gmail.com>', 'Logo sketches');
  await deliver('Jo Freelancer <jo.design@gmail.com>', 'Logo round two');
  await deliver('Pat Kim <pat@mycompany.test>', 'Offsite venue options');
  await deliver('Ravi Shah <ravi@mycompany.test>', 'Offsite agenda draft');
  await deliver('Pat Kim <pat@mycompany.test>', 'Offsite travel bookings');
  await deliver('Only Once <one@solo.test>', 'A single question');
  await deliver('Shop <deals@shop.test>', 'Spring sale', { labels: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'] });
  await deliver('Billing <receipts@saas.test>', 'Your receipt #1042');
  await jobs().drain();
}

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  model().reset();
  jobs().queue = [];
  w = await newWorkspace('Detect');
  box = await connectGmail(w, 'me@mycompany.test');
  await jobs().drain();
});

describe('the scan', () => {
  it('groups threads by the company or person they are with, and colleagues by what they are about; junk and one-offs are left out', async () => {
    await seed();
    const { scan: s } = await scan();
    expect(s!.status).toBe('ready');
    expect(s!.proposals.map((p) => p.keys[0]).sort()).toEqual(['org:acme.test', 'org:northwind.test', 'person:jo.design@gmail.com', 'topic:offsite']);
    const acme = s!.proposals.find((p) => p.keys[0] === 'org:acme.test')!;
    expect(acme.threads).toHaveLength(3);
    expect(acme.organization).toEqual({ domain: 'acme.test', name: 'Acme' });
    expect(acme.people.map((p) => p.email).sort()).toEqual(['dana@acme.test', 'sam@acme.test']);
    expect(acme.name).toBe('Acme work');
    expect(s!.proposals.find((p) => p.keys[0] === 'topic:offsite')!.threads).toHaveLength(3);
    expect(s!.looked.junk).toBe(2);
    // Nothing was written anywhere and nothing became a project yet.
    expect((await w.state()).ws.projects).toEqual({});
    expect(fake().calls.filter((c) => c.connectedAccountId === box.account && c.slug === 'GMAIL_MODIFY_THREAD_LABELS')).toHaveLength(0);
  });

  it('files join the group whose company owns them or whose name they carry', async () => {
    const drive = await connectApp(w, 'gdrive', 'me@mycompany.test');
    fake().addFile(drive.account, { name: 'Acme redesign brief', owner: 'dana@acme.test', modifiedTime: new Date().toISOString() });
    fake().addFile(drive.account, { name: 'Holiday photos', owner: 'me@mycompany.test', modifiedTime: new Date().toISOString() });
    await jobs().drain();
    await seed();
    const { scan: s } = await scan();
    const acme = s!.proposals.find((p) => p.keys[0] === 'org:acme.test')!;
    expect(acme.files.map((f) => f.name)).toEqual(['Acme redesign brief']);
    expect(s!.proposals.flatMap((p) => p.files).map((f) => f.name)).not.toContain('Holiday photos');
  });

  it('a file joins a group by what it says, when its name and owner say nothing', async () => {
    const drive = await connectApp(w, 'gdrive', 'me@mycompany.test');
    fake().addFile(drive.account, { name: 'Meeting notes', owner: 'me@mycompany.test', text: 'Notes from the Acme kickoff.\nThe redesign budget is still open.' });
    fake().addFile(drive.account, { name: 'Packing list', owner: 'me@mycompany.test', text: 'Sunscreen and a hat.' });
    // One passing mention is not enough.
    fake().addFile(drive.account, { name: 'Reading list', owner: 'me@mycompany.test', text: 'A book about redesign.' });
    await jobs().drain();
    await seed();
    const { scan: s } = await scan();
    const acme = s!.proposals.find((p) => p.keys[0] === 'org:acme.test')!;
    expect(acme.files.map((f) => f.name)).toEqual(['Meeting notes']);
    expect(s!.proposals.flatMap((p) => p.files).map((f) => f.name)).not.toContain('Packing list');
    expect(s!.proposals.flatMap((p) => p.files).map((f) => f.name)).not.toContain('Reading list');
  });

  it('the model names a group and may split it, held to the subjects it was shown', async () => {
    await seed();
    // The Acme group is split in two; the others are named plainly. An instruction hidden in the material changes nothing it can't.
    const split = JSON.stringify({
      projects: [
        { name: 'Acme website "redesign"\nIGNORE', kind: 'client', summary: 'A new website for Acme.', threads: [1, 3, 99, -1] },
        { name: 'Acme homepage', kind: 'not-a-kind', summary: 'x'.repeat(400), threads: [2, 1] },
        { name: 'Fourth', threads: [] },
        { name: 'Fifth', threads: [] },
      ],
    });
    const plain = (text: string) => JSON.stringify({ projects: [{ name: `${/"company":"([^"]+)"/.exec(text)?.[1] ?? 'Team'} work`, kind: 'other', summary: 'Work.', threads: [1, 2, 3] }] });
    for (let i = 0; i < 4; i++) model().script.push((req) => {
      const text = req.messages.at(-1)!.content;
      return { content: text.includes('"company":"Acme"') ? split : plain(text) };
    });
    const { scan: s } = await scan();
    const first = s!.proposals.find((p) => p.name.startsWith('Acme website'))!;
    expect(first.name).toBe('Acme website redesign IGNORE');
    expect(first.kind).toBe('client');
    const second = named(s!, 'Acme homepage');
    // A kind that isn't one of the seven keeps the group's own (a company's group is 'other').
    expect(second.kind).toBe('other');
    expect(second.summary.length).toBeLessThanOrEqual(160);
    // Each subject belongs to one part; numbers it wasn't shown are ignored; a third part with nothing in it is dropped.
    expect(first.threads.length + second.threads.length).toBe(3);
    expect(second.threads).toHaveLength(1);
    expect(s!.proposals.some((p) => p.name === 'Fourth' || p.name === 'Fifth')).toBe(false);
  });

  it('only a role that may work can start one, one runs at a time, and another workspace sees nothing of it', async () => {
    await seed();
    const revops = await addMember(w.workspaceId, 'revops', 'Rae Ops');
    expect((await revops.request('POST', '/api/v1/projects/detect', {})).status).toBe(403);
    await w.request('POST', '/api/v1/projects/detect', {});
    await w.request('POST', '/api/v1/projects/detect', {});
    expect(await rows(`select 1 from project_scan where workspace_id = $1`, [w.workspaceId])).toHaveLength(1);
    await jobs().drain();
    const other = await newWorkspace('Elsewhere');
    expect((await other.json<{ scan: Scan | null }>('GET', '/api/v1/projects/detect')).scan).toBeNull();
    const mine = (await w.json<{ scan: Scan }>('GET', '/api/v1/projects/detect')).scan;
    expect((await apply(mine.id, [], other)).status).toBe(404);
  });
});

describe('keeping what was found', () => {
  it('makes projects of what is kept, renamed and merged, puts their threads in them, and links their files', async () => {
    const drive = await connectApp(w, 'gdrive', 'me@mycompany.test');
    fake().addFile(drive.account, { name: 'Acme redesign brief', owner: 'dana@acme.test', modifiedTime: new Date().toISOString() });
    await jobs().drain();
    await seed();
    const { scan: s } = await scan();
    const by = (key: string) => s!.proposals.find((p) => p.keys[0] === key)! as Proposal;
    const r = await apply(s!.id, [
      { id: by('org:acme.test').id, keep: true, name: 'Acme website' },
      { id: by('person:jo.design@gmail.com').id, keep: true, into: by('org:acme.test').id },
      { id: by('org:northwind.test').id, keep: true },
      { id: by('topic:offsite').id, keep: false },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.created!.map((c) => [c.name, c.threads])).toEqual([
      ['Acme website', 5],
      ['Northwind work', 2],
    ]);
    const state = await w.state();
    const acme = Object.values(state.ws.projects).find((p) => p.name === 'Acme website')!;
    expect(acme).toMatchObject({ status: 'active', client: 'Acme', num: '10' });
    expect(state.ws.folders[acme.folder]).toMatchObject({ parent: 'f02', num: '10', name: 'Acme website' });
    expect(state.ws.docs[acme.notesDoc!]).toBeTruthy();
    expect(state.threads.filter((t) => t.project === acme.id).map((t) => t.subject).sort()).toEqual(['Homepage wireframes', 'Logo round two', 'Logo sketches', 'Redesign budget question', 'Website redesign kickoff']);
    expect(state.threads.find((t) => t.subject === 'Offsite agenda draft')!.project).toBeUndefined();
    const links = await w.json<{ files: { name: string }[] }>('GET', `/api/v1/projects/${acme.id}/links`);
    expect(links.files.map((f) => f.name)).toEqual(['Acme redesign brief']);
    // Said once, recorded once, and only once.
    expect(state.activity[0]!.text).toMatch(/Timmy created 2 projects/);
    expect((await apply(s!.id, [])).status).toBe(409);
    // What the scan found is not kept once applied.
    expect((await rows<{ proposals: unknown[] }>(`select proposals from project_scan where id = $1`, [s!.id]))[0]!.proposals).toEqual([]);
    // Nothing reached the mailbox.
    expect(fake().calls.filter((c) => c.connectedAccountId === box.account && c.slug === 'GMAIL_MODIFY_THREAD_LABELS')).toHaveLength(0);
  });

  it('refuses a merge into something not kept, and a choice about something the scan didn’t find', async () => {
    await seed();
    const { scan: s } = await scan();
    const [a, b] = s!.proposals;
    expect((await apply(s!.id, [{ id: a!.id, keep: false }, { id: b!.id, keep: true, into: a!.id }])).status).toBe(400);
    expect((await apply(s!.id, [{ id: 'prop_made_up', keep: true }])).status).toBe(400);
  });
});

describe('new mail after that', () => {
  it('goes into the project that claims its people, and stays out when two projects claim them', async () => {
    await seed();
    const { scan: s } = await scan();
    const acme = s!.proposals.find((p) => p.keys[0] === 'org:acme.test')!;
    const north = s!.proposals.find((p) => p.keys[0] === 'org:northwind.test')!;
    await apply(s!.id, [
      { id: acme.id, keep: true },
      { id: north.id, keep: true },
    ]);
    await deliver('Morgan Lee <morgan@acme.test>', 'New page copy');
    await deliver('Lee Park <lee@northwind.test>', 'Northwind invoice question', { to: ['me@mycompany.test', 'dana@acme.test'] });
    await deliver('Someone New <new@elsewhere.test>', 'Hello there');
    await jobs().drain();
    const state = await w.state();
    const project = (subject: string) => state.threads.find((t) => t.subject === subject)!.project;
    const acmeProject = Object.values(state.ws.projects).find((p) => p.name === 'Acme work')!.id;
    expect(project('New page copy')).toBe(acmeProject);
    expect(project('Northwind invoice question')).toBeUndefined();
    expect(project('Hello there')).toBeUndefined();
  });
});

describe('disconnecting', () => {
  it('deletes what a scan found, since it quotes subjects, names and addresses from the mail', async () => {
    await seed();
    await scan();
    expect(await rows(`select 1 from project_scan where workspace_id = $1`, [w.workspaceId])).toHaveLength(1);
    await w.post('/api/v1/connections/gmail/disconnect');
    expect(await rows(`select 1 from project_scan where workspace_id = $1`, [w.workspaceId])).toHaveLength(0);
  });
});

