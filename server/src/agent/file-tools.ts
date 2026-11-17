/**
 * Ask's two tools for the person's files, in Google Drive and OneDrive: finding a file by its name or by what it
 * says, and reading one. Both only read Timmy's own store and the app the file came from, through its connection,
 * and only for accounts still connected. Everything they return was written by someone else, so it goes back to the
 * model inside the outside-content wrapper.
 */
import { withWorkspace } from '../db/pool';
import { readFileText } from '../sync/files';
import type { AgentTool } from './tools';
import { untrusted } from './prompts';

const str = (v: unknown, max = 4000) => String(v ?? '').slice(0, max);

/** The words of a search as "contains" patterns, with the characters that mean "anything" taken out. */
const containsAny = (query: string): string[] =>
  query
    .split(/\s+/)
    .map((w) => w.replace(/[%_\\]/g, ''))
    .filter((w) => w.length > 1)
    .slice(0, 6)
    .map((w) => `%${w}%`);

/** The words of a search for Postgres's web-style query parser, joined by "or" so a file with any of them is found. */
const anyOfWords = (query: string): string =>
  query
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !/^or$/i.test(w))
    .slice(0, 8)
    .join(' or ');

const APP_NAMES: Record<string, string> = { googledrive: 'Google Drive', one_drive: 'OneDrive' };

/** A short passage around the words that matched, on one line. */
const passage = (s: unknown) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);

export const searchFiles: AgentTool = {
  kind: 'read',
  step: 'Looking through your files',
  def: {
    name: 'search_files',
    description:
      'Search the files in the user’s connected Google Drive and OneDrive, by the words of their names and by what they say (the words of Google Docs, Sheets and Slides, and of Word, Excel and PowerPoint files, changed in the last 90 days). Returns each match’s name, what kind of file it is, which app it is in, who owns it, when it last changed, a link to open it, a short passage around the words when they were found inside the file, and a `file` value for read_file.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Words from the file’s name or from what it says' }, limit: { type: 'integer', description: 'How many results, 1-20. Default 8.' } }, required: ['query'] },
  },
  async run(args, t) {
    const query = str(args.query, 200).trim();
    const limit = Math.min(Math.max(Number(args.limit ?? 8), 1), 20);
    const words = containsAny(query);
    const fts = anyOfWords(query);
    // Nothing searchable was given: an empty answer, not every file there is.
    if (!words.length && !fts) return { result: untrusted('files', { query, results: [] }), outside: true };
    const rows = await withWorkspace({ workspaceId: t.ctx.workspaceId }, async (tx) => {
      // Files whose names match the most words come first, then those whose contents match best; newest first among
      // equals. Only files from accounts still connected count. The passage is made for the few that are returned.
      const { rows } = await tx.query(
        `with q as (select websearch_to_tsquery('english', $3) as q),
         found as (
           select i.id, i.external_id, i.subject, i.snippet, i.sender, i.occurred_at, i.meta->>'link' as link, i.meta->>'ownerName' as owner_name, c.toolkit,
                  (select count(*) from unnest($2::text[]) w where i.subject ilike w) as hits,
                  coalesce(b.tsv @@ q.q, false) as in_text,
                  case when b.tsv @@ q.q then ts_rank(b.tsv, q.q) else 0 end as rank
           from item i join connection c on c.id = i.connection_id left join item_body b on b.item_id = i.id, q
           where i.workspace_id = $1 and i.kind = 'file' and c.status = 'active'
             and (i.subject ilike any($2::text[]) or b.tsv @@ q.q)
           order by hits desc, rank desc, i.occurred_at desc limit $4)
         select f.*, case when f.in_text then ts_headline('english', b.text, q.q, 'MaxFragments=1, MaxWords=30, MinWords=10, StartSel="", StopSel="", FragmentDelimiter=" … "') end as passage
         from found f left join item_body b on b.item_id = f.id, q
         order by f.hits desc, f.rank desc, f.occurred_at desc`,
        [t.ctx.workspaceId, words, fts, limit],
      );
      return rows;
    });
    const results = rows.map((r) => ({
      name: r.subject,
      kind: r.snippet,
      app: APP_NAMES[r.toolkit as string] ?? 'Files',
      owner: r.owner_name || r.sender || undefined,
      changed: new Date(r.occurred_at).toISOString(),
      link: r.link ?? undefined,
      found_in: Number(r.hits) > 0 ? (r.in_text ? 'name and contents' : 'name') : 'contents',
      passage: r.in_text ? passage(r.passage) : undefined,
      file: r.external_id,
    }));
    // File names and contents are written by whoever made or shared the file, so they are outside content like mail is.
    return { result: untrusted('files', { query, results }), outside: true };
  },
};

export const readFile: AgentTool = {
  kind: 'read',
  step: 'Reading the file',
  def: {
    name: 'read_file',
    description:
      'Read what a file in the user’s Google Drive or OneDrive says. Works for Google Docs, Sheets (the first sheet’s first 200 rows) and Slides, and for Word, Excel (the first sheet’s first 200 rows) and PowerPoint files; other kinds can’t be opened yet. Takes the `file` value from search_files. Long files are cut off, and the result says so.',
    parameters: { type: 'object', properties: { file: { type: 'string', description: 'The `file` value from search_files' } }, required: ['file'] },
  },
  async run(args, t) {
    const out = await readFileText(t.ctx.workspaceId, str(args.file, 300));
    // The reason can carry the file's name, which whoever shared the file chose: it is outside content too.
    if (!out.ok) return { result: untrusted('file', { could_not_read: out.reason }), outside: true };
    // A file's contents are written by whoever wrote the file: information, never instructions.
    return { result: untrusted('file', { name: out.name, kind: out.kind, text: out.text, cut_off: out.truncated }), outside: true };
  },
};
