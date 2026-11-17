/**
 * What the agent can do. Three kinds of tool:
 *   read     — looks something up in the workspace's own store;
 *   internal — changes Timmy's own records (a draft), which nobody else sees;
 *   write    — would reach outside the workspace, so it only proposes an effect
 *              at the Action gateway and the run waits for the decision.
 * A tool never talks to a provider directly, and never holds a credential.
 */
import type { Thread } from '../../../src/data/types';
import { withWorkspace, type Tx } from '../db/pool';
import { propose, type EffectRow } from '../gateway/gateway';
import { ADDRESS, prepareMailSend, type MailSend } from '../gateway/mail';
import type { ToolDef } from '../providers/model';
import { actorOf, emailOf, type Ctx } from '../state/engine';
import { mutate, readState } from '../state/mutate';
import { findPeople, openCommitments } from '../ontology/ontology';
import { readFileText } from '../sync/files';
import { readPage, searchPages } from './pages';
import { BOX_WORDS, filingProposal, isBox } from '../sync/labels';
import { LostLease } from './errors';
import { untrusted } from './prompts';
import { findThingsTool } from './things-tool';

export interface ToolRun {
  ctx: Ctx;
  runId: string;
  fence: number;
  /** The id of this tool call. A write's idempotency key is built from it. */
  callId: string;
  conversation?: string;
  attended: boolean;
  /** Auto mode's verdict for this call, when one was asked for. */
  auto?: { verdict: 'approve' | 'ask'; reason: string };
}

export type ToolOutcome =
  | { result: string; outside?: boolean }
  /** A write was proposed and is waiting for a decision (or its undo window). */
  | { effect: EffectRow; outcome: 'approved' | 'waiting'; outside?: boolean }
  | { blocked: string };

export interface AgentTool {
  def: ToolDef;
  kind: 'read' | 'internal' | 'write';
  /** Shown in the chat while it runs. */
  step: string;
  /** For writes: the kind of effect it proposes. */
  effectKind?: string;
  /**
   * For writes Auto mode may decide: what the judge is told this call would do. Built from our own fixed words
   * and the call's plain choices only, never from anything fetched (a subject, a sender, a body).
   */
  describe?(args: Record<string, unknown>): string | undefined;
  /** For writes Auto mode may decide: the id of the one thing this call acts on, so it can be checked against what the person has open. */
  target?(args: Record<string, unknown>): string | undefined;
  run(args: Record<string, unknown>, t: ToolRun): Promise<ToolOutcome>;
}

const str = (v: unknown, max = 4000) => String(v ?? '').slice(0, max);
/**
 * The words of a search, as patterns for a "contains" match. The characters that mean "anything" in a pattern are
 * taken out first, so a search for "%" finds nothing instead of everything.
 */
const containsAny = (query: string): string[] =>
  query
    .split(/\s+/)
    .map((w) => w.replace(/[%_\\]/g, ''))
    .filter((w) => w.length > 1)
    .slice(0, 6)
    .map((w) => `%${w}%`);
/** Mail or files from an account that has been disconnected are not Timmy's to read any more, even before the stored copy is deleted. */
const FROM_A_CONNECTED_MAILBOX = `exists (select 1 from connection c where c.id = i.connection_id and c.status = 'active')`;

/** A run that lost its lease must not write. Checked inside the same transaction as the write. */
async function assertFence(tx: Tx, t: ToolRun) {
  const { rows } = await tx.query('select 1 from run where id = $1 and workspace_id = $2 and fence = $3 for share', [t.runId, t.ctx.workspaceId, t.fence]);
  if (!rows[0]) throw new LostLease();
}

const searchMail: AgentTool = {
  kind: 'read',
  step: 'Searching your mail',
  def: {
    name: 'search_mail',
    description: 'Search the user’s synced mail (subjects, senders and bodies). Returns the best matches, newest first among equals. Use plain keywords, a name or an address.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Keywords, a person’s name or an email address' }, limit: { type: 'integer', description: 'How many results, 1-20. Default 8.' } }, required: ['query'] },
  },
  async run(args, t) {
    const query = str(args.query, 200).trim();
    const limit = Math.min(Math.max(Number(args.limit ?? 8), 1), 20);
    const rows = await withWorkspace({ workspaceId: t.ctx.workspaceId }, async (tx) => {
      const { rows } = await tx.query(
        `with q as (select coalesce(nullif(array_to_string(tsvector_to_array(to_tsvector('english', $2)), ' | '), '')::tsquery, websearch_to_tsquery('english', $2)) as q)
         select i.thread_key, i.occurred_at, i.sender, i.subject, i.snippet, i.direction,
                ts_rank(to_tsvector('english', coalesce(i.subject, '') || ' ' || coalesce(i.snippet, '') || ' ' || coalesce(i.sender, '')), q.q) * 2 + coalesce(ts_rank(b.tsv, q.q), 0) as rank
         from item i left join item_body b on b.item_id = i.id, q
         where i.workspace_id = $1 and i.kind = 'message' and ${FROM_A_CONNECTED_MAILBOX}
           and (to_tsvector('english', coalesce(i.subject, '') || ' ' || coalesce(i.snippet, '') || ' ' || coalesce(i.sender, '')) @@ q.q or b.tsv @@ q.q or i.sender ilike any($3::text[]) or i.subject ilike any($3::text[]))
         order by rank desc, i.occurred_at desc limit $4`,
        [t.ctx.workspaceId, query, containsAny(query), limit],
      );
      return rows;
    });
    const results = rows.map((r) => ({ thread: r.thread_key, at: new Date(r.occurred_at).toISOString(), from: r.sender, direction: r.direction === 'out' ? 'sent by the user' : 'received', subject: r.subject, snippet: r.snippet }));
    return { result: untrusted('mail', { query, results }), outside: true };
  },
};

const readThread: AgentTool = {
  kind: 'read',
  step: 'Reading the thread',
  def: {
    name: 'read_thread',
    description: 'Read every message in one mail thread, oldest first. Takes the `thread` value from search_mail or list_inbox.',
    parameters: { type: 'object', properties: { thread: { type: 'string' } }, required: ['thread'] },
  },
  async run(args, t) {
    // The model may pass the thread's own key or the id Timmy shows for it; either finds the thread.
    const given = str(args.thread, 400);
    const shown = (await readState(t.ctx.workspaceId)).state.threads.find((th) => th.id === given);
    const key = shown?.ext?.threadKey ?? given.replace(/^g-/, '');
    const rows = await withWorkspace({ workspaceId: t.ctx.workspaceId }, async (tx) => {
      const { rows } = await tx.query(
        `select i.occurred_at, i.sender, i.recipients, i.subject, left(b.text, 6000) as text from item i left join item_body b on b.item_id = i.id
         where i.workspace_id = $1 and i.kind = 'message' and i.thread_key = $2 and ${FROM_A_CONNECTED_MAILBOX} order by i.occurred_at limit 30`,
        [t.ctx.workspaceId, key],
      );
      return rows;
    });
    if (!rows.length) return { result: 'No thread with that id is in the synced mail.' };
    return { result: untrusted('mail', { thread: key, messages: rows.map((r) => ({ at: new Date(r.occurred_at).toISOString(), from: r.sender, to: r.recipients?.to, subject: r.subject, body: r.text })) }), outside: true };
  },
};

const searchFiles: AgentTool = {
  kind: 'read',
  step: 'Looking through your files',
  def: {
    name: 'search_files',
    description:
      'Search the names of the files in the user’s connected Google Drive. Returns each match’s name, what kind of file it is, who owns it, when it last changed, a link to open it, and a `file` value for read_file. Only names are searched, not contents.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Words from the file’s name' }, limit: { type: 'integer', description: 'How many results, 1-20. Default 8.' } }, required: ['query'] },
  },
  async run(args, t) {
    const query = str(args.query, 200).trim();
    const limit = Math.min(Math.max(Number(args.limit ?? 8), 1), 20);
    const words = containsAny(query);
    // Nothing searchable was given: an empty answer, not every file there is.
    if (!words.length) return { result: untrusted('files', { query, results: [] }), outside: true };
    const rows = await withWorkspace({ workspaceId: t.ctx.workspaceId }, async (tx) => {
      // Files matching every word come first, then files matching any of them; newest first among equals.
      const { rows } = await tx.query(
        `select i.external_id, i.subject, i.snippet, i.sender, i.occurred_at, i.meta->>'link' as link, i.meta->>'ownerName' as owner_name,
                (select count(*) from unnest($2::text[]) w where i.subject ilike w) as hits
         from item i
         where i.workspace_id = $1 and i.kind = 'file' and ${FROM_A_CONNECTED_MAILBOX} and i.subject ilike any($2::text[])
         order by hits desc, i.occurred_at desc limit $3`,
        [t.ctx.workspaceId, words, limit],
      );
      return rows;
    });
    const results = rows.map((r) => ({ name: r.subject, kind: r.snippet, owner: r.owner_name || r.sender || undefined, changed: new Date(r.occurred_at).toISOString(), link: r.link ?? undefined, file: r.external_id }));
    // File names are written by whoever made or shared the file, so they are outside content like mail is.
    return { result: untrusted('files', { query, results }), outside: true };
  },
};

const searchPagesTool: AgentTool = {
  kind: 'read',
  step: 'Looking through your pages',
  def: {
    name: 'search_pages',
    description: 'Search the pages the user has written in Timmy (notes, meeting docs, plans) by the words in their titles and text. Returns each page’s name, the lines that matched and a `page` value for read_page. Pages in the trash are left out.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Words from the page' } }, required: ['query'] },
  },
  async run(args, t) {
    const query = str(args.query, 200).trim();
    const { state } = await readState(t.ctx.workspaceId);
    return { result: untrusted('pages', { query, results: searchPages(state, query) }), outside: true };
  },
};

const readPageTool: AgentTool = {
  kind: 'read',
  step: 'Reading the page',
  def: {
    name: 'read_page',
    description: 'Read one of the user’s pages in Timmy. Takes the `page` value from search_pages. Long pages are cut off, and the result says so.',
    parameters: { type: 'object', properties: { page: { type: 'string', description: 'The `page` value from search_pages' } }, required: ['page'] },
  },
  async run(args, t) {
    const { state } = await readState(t.ctx.workspaceId);
    const page = readPage(state, str(args.page, 200));
    if (!page) return { result: 'There is no page with that id (it may be in the trash).' };
    // Pages are typed and pasted by people; what they say is information, never instructions.
    return { result: untrusted('page', { name: page.name, text: page.text, cut_off: page.truncated }), outside: true };
  },
};

const readFile: AgentTool = {
  kind: 'read',
  step: 'Reading the file',
  def: {
    name: 'read_file',
    description:
      'Read what a file in the user’s Google Drive says. Works for Google Docs, Sheets (the first sheet’s first 200 rows) and Slides; other kinds can’t be opened yet. Takes the `file` value from search_files. Long files are cut off, and the result says so.',
    parameters: { type: 'object', properties: { file: { type: 'string', description: 'The `file` value from search_files' } }, required: ['file'] },
  },
  async run(args, t) {
    const out = await readFileText(t.ctx.workspaceId, str(args.file, 200));
    // The reason can carry the file's name, which whoever shared the file chose: it is outside content too.
    if (!out.ok) return { result: untrusted('file', { could_not_read: out.reason }), outside: true };
    // A file's contents are written by whoever wrote the file: information, never instructions.
    return { result: untrusted('file', { name: out.name, kind: out.kind, text: out.text, cut_off: out.truncated }), outside: true };
  },
};

const lookupPerson: AgentTool = {
  kind: 'read',
  step: 'Looking up who that is',
  def: {
    name: 'lookup_person',
    description:
      'Look up a person or a company the user has been in touch with: who they are, where they work, the latest threads with them, and what they and the user have promised each other. It is built from the user’s own mail, calendar and files, and every promise comes with the sentence it rests on. Takes a name, an email address or a company name.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'A name, an email address or a company' } }, required: ['query'] },
  },
  async run(args, t) {
    const query = str(args.query, 200).trim();
    const people = await findPeople(t.ctx.workspaceId, query);
    // Names, subjects and quotes all come from other people's mail, so they are outside content.
    return { result: untrusted('people', { query, people }), outside: true };
  },
};

const listCommitments: AgentTool = {
  kind: 'read',
  step: 'Checking what has been promised',
  def: {
    name: 'list_commitments',
    description:
      'List the open promises in the user’s mail: what other people said they would send or do for the user (who: "them"), and what the user said they would do for others (who: "me"), with the date when one was named and the sentence each rests on. Use it for "what am I waiting on" and "what do I owe people".',
    parameters: { type: 'object', properties: {} },
  },
  async run(_args, t) {
    return { result: untrusted('people', { commitments: await openCommitments(t.ctx.workspaceId) }), outside: true };
  },
};

const listInbox: AgentTool = {
  kind: 'read',
  step: 'Checking your inbox',
  def: {
    name: 'list_inbox',
    description: 'List the threads that currently need the user (inbox and follow-up), newest first, and the ones they are waiting on. Each has an id for read_thread, show_thread and draft_reply.',
    parameters: { type: 'object', properties: { limit: { type: 'integer' } } },
  },
  async run(args, t) {
    const { state } = await readState(t.ctx.workspaceId);
    const limit = Math.min(Math.max(Number(args.limit ?? 15), 1), 40);
    const last = (th: Thread) => th.messages[th.messages.length - 1];
    const open = state.threads.filter((th) => th.box === 'inbox' || th.box === 'follow-up' || th.box === 'waiting');
    const list = open
      .sort((a, b) => new Date(last(b)?.at ?? 0).getTime() - new Date(last(a)?.at ?? 0).getTime())
      .slice(0, limit)
      .map((th) => ({ id: th.id, thread: th.ext?.threadKey, box: th.box, subject: th.subject, from: last(th)?.from, at: last(th)?.at, unread: !!th.unread, has_draft: !!th.draft, waiting_for: th.waiting?.item }));
    return { result: untrusted('mail', { threads: list, total_open: open.length }), outside: true };
  },
};

const draftReply: AgentTool = {
  kind: 'internal',
  step: 'Writing a draft',
  def: {
    name: 'draft_reply',
    description: 'Save a draft reply on a thread. Nothing is sent: the draft waits in Approvals until the user presses Send. Takes the thread `id` from list_inbox.',
    parameters: { type: 'object', properties: { id: { type: 'string', description: 'The thread id from list_inbox' }, body: { type: 'string', description: 'The reply, plain text' } }, required: ['id', 'body'] },
  },
  async run(args, t) {
    const id = str(args.id, 200);
    const body = str(args.body, 20000).trim();
    if (!body) return { result: 'The draft was empty, so nothing was saved.' };
    if (!t.ctx.rules.work) return { result: 'This person’s role can’t change drafts in this workspace. Nothing was saved.' };
    const saved = await mutate(t.ctx.workspaceId, 'agent', async (tx, loaded) => {
      await assertFence(tx, t);
      const thread = loaded.state.threads.find((x) => x.id === id);
      if (!thread) return { result: 'missing' as const };
      // A draft someone already wrote or reviewed is never replaced from the chat.
      if (thread.draft) return { result: 'exists' as const };
      const to = [...new Set(thread.messages.map((m) => m.from).filter((p) => p !== 'me'))].slice(-1);
      const draft = { to: to.length ? to : thread.participants.filter((p) => p !== 'me').slice(0, 1), subject: /^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`, body, sources: [], kind: 'reply' as const };
      const history = [...(thread.history ?? []), { at: new Date(), text: 'Timmy drafted a reply from the chat' }];
      return { state: { ...loaded.state, threads: loaded.state.threads.map((x) => (x.id === id ? { ...x, draft, history } : x)) }, result: 'saved' as const };
    });
    if (saved === 'exists') return { result: 'That thread already has a draft. It was left as it is; the user can discard it in Approvals if they want a new one.' };
    return { result: saved === 'saved' ? 'The draft is saved on the thread and is waiting in Approvals. It has not been sent.' : 'There is no thread with that id.' };
  },
};

const sendEmail: AgentTool = {
  kind: 'write',
  step: 'Preparing the email',
  effectKind: 'email.send',
  def: {
    name: 'send_email',
    description: 'Prepare a new email from the user’s mailbox. It is not sent by this call: it goes to the user for approval, and they see exactly what will go out. Use only when the user asked for an email to be sent.',
    parameters: { type: 'object', properties: { to: { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses' }, cc: { type: 'array', items: { type: 'string' } }, subject: { type: 'string' }, body: { type: 'string', description: 'Plain text' } }, required: ['to', 'subject', 'body'] },
  },
  async run(args, t) {
    const addresses = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => str(x, 320).trim()).filter((x) => ADDRESS.test(x));
    const to = addresses(args.to);
    const cc = addresses(args.cc);
    const subject = str(args.subject, 300).trim();
    const body = str(args.body, 50000).trim();
    if (!to.length) return { result: 'That needs at least one valid email address in `to`.' };
    if (!body) return { result: 'The email has no body.' };
    return proposeMail(t, { to, cc, subject: subject || '(no subject)', body });
  },
};

const sendReply: AgentTool = {
  kind: 'write',
  step: 'Preparing the reply',
  effectKind: 'email.reply',
  def: {
    name: 'send_reply',
    description: 'Prepare a reply on an existing thread, to the person who wrote last. It is not sent by this call: it goes to the user for approval. Takes the thread `id` from list_inbox.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, body: { type: 'string', description: 'Plain text' } }, required: ['id', 'body'] },
  },
  async run(args, t) {
    const { state, workspace } = await readState(t.ctx.workspaceId).then((l) => ({ state: l.state, workspace: l }));
    const thread = state.threads.find((x) => x.id === str(args.id, 200));
    const body = str(args.body, 50000).trim();
    if (!thread) return { result: 'There is no thread with that id.' };
    if (!thread.ext?.threadKey) return { result: 'That thread isn’t in the connected mailbox, so it can’t be replied to from here.' };
    if (!body) return { result: 'The reply has no body.' };
    // Who it goes to is worked out here, from the thread itself, not taken from the model.
    const lastFrom = [...thread.messages].reverse().find((m) => m.from !== 'me')?.from;
    const email = lastFrom ? emailOf(workspace, state, lastFrom) : null;
    if (!email) return { result: 'There is nobody to reply to on that thread.' };
    return proposeMail(t, { to: [email], cc: [], subject: /^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`, body, threadId: thread.id, existing: { threadKey: thread.ext.threadKey, connectionId: thread.ext.connectionId } });
  },
};

/** A write tool's only way out: the email becomes a proposal at the gateway, and the run waits for the decision. */
async function proposeMail(t: ToolRun, m: MailSend): Promise<ToolOutcome> {
  return mutate<ToolOutcome>(t.ctx.workspaceId, 'agent', async (tx, loaded) => {
    await assertFence(tx, t);
    const mail = await prepareMailSend(tx, t.ctx.workspaceId, m);
    if (!mail.ok) return { result: { result: `${mail.reason} Nothing was prepared.` } };
    const p = await propose(tx, loaded, loaded.state, t.attended ? actorOf(t.ctx) : null, {
      ...mail.proposal,
      why: 'Timmy prepared this from your request in the chat.',
      idempotencyKey: `run:${t.runId}:${t.callId}`,
      source: t.attended ? 'agent' : 'routine',
      runId: t.runId,
      conversation: t.conversation,
      auto: t.auto,
    });
    if (p.outcome === 'blocked' || !p.effect) return { result: { blocked: p.reason ?? 'That isn’t allowed.' } };
    return { state: p.state, result: { effect: p.effect, outcome: p.outcome } };
  });
}

const fileThread: AgentTool = {
  kind: 'write',
  step: 'Filing the thread',
  effectKind: 'mail.modify',
  // What the judge is told: the action and the place, both from our own fixed words. Never the thread's subject.
  // Nothing to describe means nothing to judge: a call the tool would refuse anyway is never put to Auto mode.
  describe: (args) => (isBox(args.box) ? `Move the mail thread the user has open ${BOX_WORDS[args.box]} in the user’s own mailbox` : undefined),
  target: (args) => (typeof args.id === 'string' ? args.id : undefined),
  def: {
    name: 'file_thread',
    description:
      'File one mail thread: "follow-up" (the user owes a reply or an action), "waiting" (the user is waiting on someone), "read-through" (worth reading, no action), "archived" (needs nothing) or "inbox" (back to unsorted). The same label is applied in the user’s mailbox. Depending on their settings it happens at once or waits for their OK. Use it only when the user asks you to sort, file or archive mail. Takes the thread `id` from list_inbox.',
    parameters: { type: 'object', properties: { id: { type: 'string', description: 'The thread id from list_inbox' }, box: { type: 'string', enum: ['follow-up', 'waiting', 'read-through', 'archived', 'inbox'] } }, required: ['id', 'box'] },
  },
  async run(args, t) {
    const id = str(args.id, 200);
    const box = args.box;
    if (!isBox(box)) return { result: 'That is not a place a thread can be filed.' };
    return mutate<ToolOutcome>(t.ctx.workspaceId, 'agent', async (tx, loaded) => {
      await assertFence(tx, t);
      const thread = loaded.state.threads.find((x) => x.id === id);
      if (!thread) return { result: { result: 'There is no thread with that id.' } };
      if (thread.box === box) return { result: { result: 'That thread is already there.' } };
      const filing = filingProposal(thread, box);
      if (!filing) return { result: { result: 'That thread isn’t in the connected mailbox, so it can’t be filed from here.' } };
      const p = await propose(tx, loaded, loaded.state, t.attended ? actorOf(t.ctx) : null, {
        ...filing,
        why: 'Timmy proposed this from your request in the chat.',
        idempotencyKey: `run:${t.runId}:${t.callId}`,
        source: t.attended ? 'agent' : 'routine',
        runId: t.runId,
        conversation: t.conversation,
        auto: t.auto,
      });
      if (p.outcome === 'blocked' || !p.effect) return { result: { blocked: p.reason ?? 'That isn’t allowed.' } };
      return { state: p.state, result: { effect: p.effect, outcome: p.outcome } };
    });
  },
};

export const TOOLS: AgentTool[] = [searchMail, readThread, listInbox, searchFiles, readFile, searchPagesTool, readPageTool, lookupPerson, listCommitments, findThingsTool, draftReply, sendEmail, sendReply, fileThread];
export const TOOL_BY_NAME: Record<string, AgentTool> = Object.fromEntries(TOOLS.map((t) => [t.def.name, t]));
