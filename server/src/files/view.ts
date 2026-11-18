/**
 * Showing a file from a connected Google Drive or OneDrive inside Timmy, read only. The file is read through its own
 * connection when it is opened, and not stored:
 *   - a Google Doc as formatted HTML, built from Google's document structure (headings, bold, italic, links, lists,
 *     tables) and then cleaned like an email (see mail/original.ts), to be shown in a frame that runs nothing;
 *   - a Google Sheet as a table (its first sheet, top-left corner);
 *   - Google Slides slide by slide, as their words;
 *   - Word, Excel and PowerPoint files in OneDrive as their words;
 *   - anything else says it can't be previewed yet, with the link to open it in its own app.
 * Only a file on the workspace's own list, on a connection still active, is ever asked for.
 */
import { withWorkspace } from '../db/pool';
import { log } from '../lib/log';
import { cleanEmail } from '../mail/original';
import { exportedDocText, readListed, canRead, tooLarge } from '../sync/files';
import type { ListedFile } from '../sync/file-kinds';
import { callTool } from '../sync/tools';

export type FileView =
  | { kind: 'doc'; html: string }
  | { kind: 'sheet'; rows: string[][]; more: boolean }
  | { kind: 'slides'; slides: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'none'; reason: string };

export interface Viewed {
  name: string;
  /** "Google Doc", "Word document"… */
  type: string;
  app: string;
  link?: string;
  view: FileView;
}

const APP_NAMES: Record<string, string> = { googledrive: 'Google Drive', one_drive: 'OneDrive' };
const SAFE_LINK = /^https:\/\/((docs|drive|sheets|slides|forms)\.google\.com|[\w-]+\.sharepoint\.com|onedrive\.live\.com|1drv\.ms)\//;
const payload = (data: Record<string, unknown>) => (data.response_data ?? data) as Record<string, unknown>;
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ───────────── A Google Doc as HTML ───────────── */

interface TextRun {
  content?: string;
  textStyle?: { bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean; link?: { url?: string } };
}
interface DocsElement {
  paragraph?: { elements?: { textRun?: TextRun }[]; paragraphStyle?: { namedStyleType?: string }; bullet?: { listId?: string; nestingLevel?: number } };
  table?: { tableRows?: { tableCells?: { content?: DocsElement[] }[] }[] };
}

const HEADINGS: Record<string, string> = { TITLE: 'h1', SUBTITLE: 'h2', HEADING_1: 'h1', HEADING_2: 'h2', HEADING_3: 'h3', HEADING_4: 'h4', HEADING_5: 'h5', HEADING_6: 'h6' };

function runHtml(r: TextRun): string {
  let html = esc((r.content ?? '').replace(/\n$/, '')).replace(/\n/g, '<br>');
  if (!html) return '';
  const s = r.textStyle ?? {};
  if (s.bold) html = `<strong>${html}</strong>`;
  if (s.italic) html = `<em>${html}</em>`;
  if (s.underline && !s.link) html = `<u>${html}</u>`;
  if (s.strikethrough) html = `<s>${html}</s>`;
  if (s.link?.url) html = `<a href="${esc(s.link.url)}">${html}</a>`;
  return html;
}

/** Google's document structure as HTML: paragraphs, headings, runs of bullets as lists, tables. */
export function docHtml(content: DocsElement[] | undefined, depth = 0): string {
  if (depth > 4) return '';
  const out: string[] = [];
  let list: string[] | null = null;
  const closeList = () => {
    if (list) out.push(`<ul>${list.join('')}</ul>`);
    list = null;
  };
  for (const el of content ?? []) {
    if (el.paragraph) {
      const inner = (el.paragraph.elements ?? []).map((e) => (e.textRun ? runHtml(e.textRun) : '')).join('');
      if (el.paragraph.bullet) {
        (list ??= []).push(`<li style="margin-left:${(el.paragraph.bullet.nestingLevel ?? 0) * 18}px">${inner}</li>`);
        continue;
      }
      closeList();
      if (!inner.trim()) continue;
      const tag = HEADINGS[el.paragraph.paragraphStyle?.namedStyleType ?? ''] ?? 'p';
      out.push(`<${tag}>${inner}</${tag}>`);
    } else if (el.table) {
      closeList();
      const rows = (el.table.tableRows ?? []).map((row) => `<tr>${(row.tableCells ?? []).map((c) => `<td>${docHtml(c.content, depth + 1)}</td>`).join('')}</tr>`);
      out.push(`<table>${rows.join('')}</table>`);
    }
  }
  closeList();
  return out.join('\n');
}

const DOC_STYLE = `<style>
body { max-width: 760px; margin: 0 auto; padding: 8px 4px 24px; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.1em 0 0.4em; }
p, li { margin: 0 0 0.6em; }
ul { padding-left: 1.4em; }
table { border-collapse: collapse; margin: 0.8em 0; }
td { border: 1px solid #d5d1c7; padding: 6px 8px; vertical-align: top; }
td p { margin: 0; }
</style>`;

/* ───────────── Viewing one file ───────────── */

/** The file by Timmy's own item id, on a connection of this workspace that is still active. */
async function listed(workspaceId: string, itemId: string): Promise<(ListedFile & { link?: string }) | null> {
  const row = await withWorkspace({ workspaceId }, async (tx) =>
    (
      await tx.query(
        `select i.connection_id, c.toolkit, i.external_id, i.subject, i.snippet, i.meta->>'mimeType' as mime, i.meta->>'size' as size, i.meta->>'driveId' as drive_id, i.meta->>'link' as link
         from item i join connection c on c.id = i.connection_id
         where i.workspace_id = $1 and i.id = $2 and i.kind = 'file' and c.status = 'active'`,
        [workspaceId, itemId],
      )
    ).rows[0],
  );
  if (!row) return null;
  return {
    connectionId: row.connection_id,
    toolkit: row.toolkit,
    id: row.external_id,
    name: row.subject ?? '',
    kind: row.snippet ?? 'File',
    mime: row.mime ?? '',
    size: row.size == null ? undefined : Number(row.size),
    driveId: row.drive_id ?? undefined,
    ...(typeof row.link === 'string' && SAFE_LINK.test(row.link) ? { link: row.link } : {}),
  };
}

export async function viewFile(workspaceId: string, itemId: string): Promise<Viewed | null> {
  const f = await listed(workspaceId, itemId);
  if (!f) return null;
  try {
    return await view(workspaceId, f);
  } catch (e) {
    log.warn('file could not be shown', { workspaceId, connectionId: f.connectionId, error: (e as Error).message });
    // The provider failed outright (not a polite refusal): the screen says so and offers the file's own app.
    const app = APP_NAMES[f.toolkit] ?? 'Files';
    return { name: f.name, type: f.kind, app, ...(f.link ? { link: f.link } : {}), view: { kind: 'none', reason: `${app} didn’t hand over this file just now. Try again, or open it in ${app}.` } };
  }
}

async function view(workspaceId: string, f: ListedFile & { link?: string }): Promise<Viewed> {
  const base = { name: f.name, type: f.kind, app: APP_NAMES[f.toolkit] ?? 'Files', ...(f.link ? { link: f.link } : {}) };
  const cannot = (reason: string): Viewed => ({ ...base, view: { kind: 'none', reason } });
  if (!canRead(f.toolkit, f.mime, f.name)) return cannot(`Timmy can’t show a ${f.kind.toLowerCase()} yet. Open it in ${base.app}.`);

  if (f.toolkit === 'googledrive' && f.mime === 'application/vnd.google-apps.document') {
    // A document too long to come back whole is shown as its words, as Google exports them.
    const asText = async (): Promise<Viewed> => {
      const text = await exportedDocText(workspaceId, f.connectionId, f.id, 'agent');
      return text === null ? cannot(`${base.app} didn’t hand over this file just now. Try again, or open it in ${base.app}.`) : { ...base, view: { kind: 'text', text: text.slice(0, 200_000) } };
    };
    let res;
    try {
      res = await callTool(workspaceId, f.connectionId, 'GOOGLEDRIVE_GET_DOCUMENT', { document_id: f.id }, 'agent');
    } catch (e) {
      if (tooLarge(e)) return asText();
      throw e;
    }
    if (!res.successful && tooLarge(res.error)) return asText();
    if (!res.successful) return cannot(`${base.app} didn’t hand over this file just now. Try again, or open it in ${base.app}.`);
    const content = (payload(res.data).body as { content?: DocsElement[] } | undefined)?.content;
    // Built here from plain values and escaped as it is built, then cleaned like an email all the same.
    const { html } = cleanEmail(DOC_STYLE + docHtml(content), false);
    return { ...base, view: { kind: 'doc', html } };
  }
  if (f.toolkit === 'googledrive' && f.mime === 'application/vnd.google-apps.spreadsheet') {
    const res = await callTool(workspaceId, f.connectionId, 'GOOGLEDRIVE_GET_SPREADSHEET_VALUES', { spreadsheet_id: f.id, range: 'A1:Z200' }, 'agent');
    if (!res.successful) return cannot(`${base.app} didn’t hand over this file just now. Try again, or open it in ${base.app}.`);
    const values = ((payload(res.data).values ?? []) as unknown[][]).slice(0, 200);
    const rows = values.map((r) => (Array.isArray(r) ? r.slice(0, 26) : []).map((c) => String(c ?? '').slice(0, 500)));
    return { ...base, view: { kind: 'sheet', rows, more: values.length >= 200 } };
  }
  if (f.toolkit === 'googledrive' && f.mime === 'application/vnd.google-apps.presentation') {
    const read = await readListed(workspaceId, f, 'agent');
    if ('reason' in read) return cannot(read.reason);
    const slides = read.text.split(/\n\n(?=Slide \d+\n)/).map((s) => s.replace(/^Slide \d+\n?/, '').trim());
    return { ...base, view: { kind: 'slides', slides } };
  }
  // OneDrive's Word, Excel and PowerPoint files: their words.
  const read = await readListed(workspaceId, f, 'agent');
  if ('reason' in read) return cannot(read.reason);
  return { ...base, view: { kind: 'text', text: read.text.slice(0, 200_000) } };
}
