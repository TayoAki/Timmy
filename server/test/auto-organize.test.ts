/**
 * Organizing new mail and files into projects without being asked:
 *   - Timmy's read of a new thread puts it in the project it is plainly about, when plain code (the project's own
 *     people and companies) didn't, and its to-dos go with it (src/agent/read.ts);
 *   - a Drive or OneDrive file goes into the one project its owner, name or words plainly point to
 *     (src/projects/file-links.ts).
 * Neither ever moves something the person (or a rule) already placed, and neither writes anything outside Timmy.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '../../src/data/ws-types';
import { linkFilesToProjects, scoreFile } from '../src/projects/file-links';
import { boot, connectApp, connectGmail, fake, jobs, model, newWorkspace, rows, sysPool, type Client } from './helpers';

let w: Client;
let box: { connectionId: string; account: string };

const deliver = async (from: string, subject: string, body: string) => {
  const d = fake().deliver(box.account, { from, subject, body });
  await (await boot()).request('/api/hooks/composio', { method: 'POST', headers: d.webhook.headers, body: d.webhook.body });
  await jobs().drain();
  return d.message;
};
const threadOf = async (subject: string) => (await w.state()).threads.find((t) => t.subject === subject)!;
const tasks = async () => Object.values((await w.state()).ws.tasks) as Task[];
const project = (id: string, num: string, name: string, extra: Record<string, unknown> = {}) => ({ id, num, name, color: 'var(--c-blue)', status: 'active', folder: `f02-${num}`, sources: [], ...extra });
const addProjects = async (...ps: Record<string, unknown>[]) => {
  const r = await w.cmd({ type: 'ws', ops: ps.map((item) => ({ op: 'put', col: 'projects', item })) });
  expect(r.ok).toBe(true);
};

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  model().reset();
  jobs().queue = [];
  w = await newWorkspace('Organize');
  box = await connectGmail(w, 'me@mycompany.test');
  await jobs().drain();
});

describe('new mail into projects, by Timmy’s read', () => {
  it('a thread plainly about a project goes into it, with a line in its history, and its to-do goes there too', async () => {
    await addProjects(project('apollo', '10', 'Apollo launch', { client: 'NASA', goal: 'Land on the moon' }), project('gemini', '11', 'Gemini training'));
    await deliver('Gene Kranz <gene@mission.test>', 'Flight plan', 'Hi,\n\nThis is for the Apollo launch. Please send the flight plan by 2026-11-25.\n\nGene');
    const t = await threadOf('Flight plan');
    expect(t.project).toBe('apollo');
    expect(t.history?.some((h) => h.text === 'Timmy put it in the project “Apollo launch”')).toBe(true);
    const [todo] = await tasks();
    expect(todo).toMatchObject({ title: 'Send the flight plan', project: 'apollo', thread: t.id });
    // The projects were offered as outside content, numbered, with the client and goal.
    const read = model().requests.find((r) => r.route === 'read')!;
    const user = read.messages[read.messages.length - 1]!.content;
    expect(user).toContain('<untrusted source="projects">');
    expect(user).toMatch(/\d\. Apollo launch \(client: NASA\) — Land on the moon/);
  });

  it('a thread about none of them stays out of every project', async () => {
    await addProjects(project('apollo', '10', 'Apollo launch'));
    await deliver('Pat Kim <pat@lunch.test>', 'Lunch?', 'Are you free for lunch on Friday?');
    expect((await threadOf('Lunch?')).project).toBeUndefined();
  });

  it('a workspace with no projects is asked nothing about them', async () => {
    await deliver('Gene Kranz <gene@mission.test>', 'Hello', 'Hello there, how are you?');
    const read = model().requests.find((r) => r.route === 'read')!;
    expect(read.messages[read.messages.length - 1]!.content).not.toContain('source="projects"');
  });

  it('a pick that isn’t one of the listed open projects is ignored', async () => {
    await addProjects(project('apollo', '10', 'Apollo launch'), project('old', '12', 'Old program', { status: 'archived' }));
    // A model answering with a number that is not on the list (the archived project is never listed).
    model().script.push((req) => {
      const listed = /<untrusted source="projects">([\s\S]*?)<\/untrusted>/.exec(req.messages[req.messages.length - 1]!.content)?.[1] ?? '';
      expect(listed).not.toContain('Old program');
      return { content: JSON.stringify({ box: 'follow-up', confidence: 'high', effort: 'quick', ask: 'Reply.', reason: 'Asked.', due: null, commitments: [], decision: null, todos: [], things: [], new_kinds: [], project: 7 }) };
    });
    await deliver('Gene Kranz <gene@mission.test>', 'Odd one', 'About the Old program.');
    expect((await threadOf('Odd one')).project).toBeUndefined();
  });

  it('never moves a thread the project’s own people already placed', async () => {
    await addProjects(project('apollo', '10', 'Apollo launch'), project('acme', '11', 'Acme redesign'));
    await sysPool.query(`insert into project_key (workspace_id, project_id, key) values ($1, 'acme', 'org:acme.test')`, [w.workspaceId]);
    // Dana is from Acme, so plain code files her mail into Acme; it mentions Apollo, but it is not asked about again.
    await deliver('Dana Whitfield <dana@acme.test>', 'Apollo comparison', 'Like the Apollo launch, we need a big reveal.');
    expect((await threadOf('Apollo comparison')).project).toBe('acme');
    const read = model().requests.find((r) => r.route === 'read');
    if (read) expect(read.messages[read.messages.length - 1]!.content).not.toContain('source="projects"');
  });
});

describe('files into projects, by plain code', () => {
  let drive: { connectionId: string; account: string };
  const add = async (f: Record<string, unknown> & { name: string }) => {
    fake().addFile(drive.account, f);
    const { syncFiles } = await import('../src/sync/files');
    await syncFiles(w.workspaceId, drive.connectionId);
    return (await rows<{ id: string }>(`select id from item where workspace_id = $1 and kind = 'file' and subject = $2`, [w.workspaceId, f.name]))[0]!.id;
  };
  const links = () => rows<{ project_id: string; subject: string }>(`select l.project_id, i.subject from project_link l join item i on i.id = l.item_id where l.workspace_id = $1 order by i.subject`, [w.workspaceId]);

  beforeEach(async () => {
    drive = await connectApp(w, 'gdrive', 'me@mycompany.test');
    jobs().queue = [];
  });

  it('a file whose name carries a project’s name, client or own word goes into that project', async () => {
    await addProjects(project('apollo', '10', 'Apollo launch', { client: 'NASA' }), project('gemini', '11', 'Gemini training'));
    await add({ name: 'Apollo launch checklist', text: 'Go for launch.' });
    await add({ name: 'NASA budget 2027', text: 'Numbers.' });
    await add({ name: 'Gemini crew roster', text: 'Names.' });
    await add({ name: 'Holiday party ideas', text: 'Cake.' });
    expect(await linkFilesToProjects(w.workspaceId)).toBe(3);
    expect(await links()).toEqual([
      { project_id: 'apollo', subject: 'Apollo launch checklist' },
      { project_id: 'gemini', subject: 'Gemini crew roster' },
      { project_id: 'apollo', subject: 'NASA budget 2027' },
    ]);
    // The project's page lists them.
    const page = await w.json<{ files: { name: string }[] }>('GET', '/api/v1/projects/apollo/links');
    expect(page.files.map((f) => f.name).sort()).toEqual(['Apollo launch checklist', 'NASA budget 2027']);
  });

  it('a file owned by someone whose mail a project claims goes into it; what it says counts too, but less', async () => {
    await addProjects(project('acme', '10', 'Acme redesign', { client: 'Acme' }), project('north', '11', 'Northwind renewal'));
    await sysPool.query(`insert into project_key (workspace_id, project_id, key) values ($1, 'acme', 'org:acme.test')`, [w.workspaceId]);
    await add({ name: 'Untitled document', owner: 'dana@acme.test', text: 'Some notes.' });
    // A name that says nothing, and words that name the project: one sign, weaker than the name, so it alone isn't enough.
    await add({ name: 'Meeting notes', text: 'We talked about the Northwind renewal.' });
    await linkFilesToProjects(w.workspaceId);
    expect(await links()).toEqual([{ project_id: 'acme', subject: 'Untitled document' }]);
  });

  it('a tie, or a file already in a project, is left where it is', async () => {
    await addProjects(project('apollo', '10', 'Apollo launch'), project('apollo2', '11', 'Apollo landing'));
    // "Apollo" is in both names, so it isn't either project's own word.
    await add({ name: 'Apollo notes', text: '' });
    expect(await linkFilesToProjects(w.workspaceId)).toBe(0);
    const id = await add({ name: 'Apollo launch timeline', text: '' });
    await sysPool.query(`insert into project_link (workspace_id, project_id, item_id) values ($1, 'apollo2', $2)`, [w.workspaceId, id]);
    expect(await linkFilesToProjects(w.workspaceId)).toBe(0);
    expect(await links()).toEqual([{ project_id: 'apollo2', subject: 'Apollo launch timeline' }]);
  });

  it('happens on its own after Drive’s files are listed', async () => {
    await addProjects(project('apollo', '10', 'Apollo launch'));
    fake().addFile(drive.account, { name: 'Apollo launch press kit', text: 'Hello press.' });
    jobs().queue = [];
    await jobs().enqueue('files.sync', { workspaceId: w.workspaceId, connectionId: drive.connectionId });
    await jobs().drain();
    expect((await links()).map((l) => l.subject)).toEqual(['Apollo launch press kit']);
    // Nothing was written to the Drive for it.
    expect(fake().calls.some((c) => /UPLOAD|UPDATE|MOVE|CREATE/.test(c.slug) && c.connectedAccountId === drive.account)).toBe(false);
  });

  it('scores: owner, then name, then words', () => {
    const p = { id: 'x', phrases: [' apollo launch '], own: ['apollo'] };
    expect(scoreFile({ name: 'Apollo launch plan', owner: 'me@x.test', text: null }, p, new Set())).toBe(3);
    expect(scoreFile({ name: 'apollo-notes', owner: 'me@x.test', text: null }, p, new Set())).toBe(2);
    expect(scoreFile({ name: 'Notes', owner: 'dana@acme.test', text: null }, p, new Set(['org:acme.test']))).toBe(3);
    expect(scoreFile({ name: 'Notes', owner: 'me@x.test', text: 'the apollo launch is soon' }, p, new Set())).toBe(1);
  });
});
