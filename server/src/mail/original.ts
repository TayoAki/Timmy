/**
 * An email as its sender laid it out, for reading in Timmy, fetched when a person opens it.
 *
 * Timmy stores the words of every email as plain text (that is what search, the model and the screens' lists use).
 * To read one the way Gmail or Outlook shows it, the original HTML is fetched from the mailbox at that moment, cleaned
 * here, and handed to the screen, which shows it in a frame that cannot run anything. It is not stored.
 *
 * Cleaning keeps formatting (text, tables, colours, links, pictures) and drops everything that can act: scripts,
 * forms, frames, objects, event handlers, and links to anything but the web, mail and phone. Links open in a new tab
 * without telling the site where they came from. Pictures and backgrounds from other sites are left out unless the
 * person asks for them, because loading one tells the sender the email was opened.
 */
import sanitizeHtml from 'sanitize-html';
import { callTool, type ConnectionRow } from '../sync/tools';
import { htmlToText } from '../sync/message';

export interface Original {
  /** The cleaned HTML, when the email has an HTML part. */
  html?: string;
  /** The plain text, when it has no HTML part. */
  text?: string;
  /** How many pictures from other sites were left out. */
  blocked: number;
}

/* ───────────── Fetching ───────────── */

interface GmailPart {
  mimeType?: string;
  headers?: { name?: string; value?: string }[];
  body?: { data?: string };
  parts?: GmailPart[];
}

const header = (p: GmailPart, name: string) => p.headers?.find((h) => h.name?.toLowerCase() === name)?.value ?? '';

/** A part's bytes as text, in the character set it says it uses (UTF-8 when it says nothing Node knows). */
function partText(p: GmailPart): string {
  const data = p.body?.data;
  if (!data) return '';
  const bytes = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const charset = /charset="?([\w.:-]+)"?/i.exec(header(p, 'content-type'))?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** The first part of a type, looking through nested parts the way a mail reader does (alternatives, related, mixed). */
function findPart(p: GmailPart | undefined, type: string, depth = 0): GmailPart | null {
  if (!p || depth > 8) return null;
  if (p.mimeType?.toLowerCase() === type && p.body?.data) return p;
  for (const child of p.parts ?? []) {
    // A forwarded or attached email is its own message: its body is not this one's.
    if (child.mimeType?.toLowerCase() === 'message/rfc822') continue;
    const found = findPart(child, type, depth + 1);
    if (found) return found;
  }
  return null;
}

/** The original body of one message, from the mailbox it came from. Null when the mailbox can't give it. */
export async function fetchOriginal(workspaceId: string, conn: ConnectionRow, messageId: string): Promise<{ html?: string; text?: string } | null> {
  if (conn.toolkit === 'gmail') {
    const res = await callTool(workspaceId, conn.id, 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', { message_id: messageId, format: 'full' }, 'sync');
    if (!res.successful) return null;
    const data = (res.data.response_data ?? res.data) as { payload?: GmailPart; messageText?: string };
    const html = findPart(data.payload, 'text/html');
    if (html) return { html: partText(html) };
    const plain = findPart(data.payload, 'text/plain');
    return { text: plain ? partText(plain) : String(data.messageText ?? '') };
  }
  if (conn.toolkit === 'outlook') {
    const res = await callTool(workspaceId, conn.id, 'OUTLOOK_GET_MESSAGE', { message_id: messageId, select: ['body'] }, 'sync');
    if (!res.successful) return null;
    const body = ((res.data.response_data ?? res.data) as { body?: { content?: string; contentType?: string } }).body;
    if (!body?.content) return { text: '' };
    return body.contentType?.toLowerCase() === 'html' ? { html: body.content } : { text: body.content };
  }
  return null;
}

/* ───────────── Cleaning ───────────── */

const FORMATTING = [
  'a', 'abbr', 'address', 'b', 'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt',
  'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'small', 'span',
  'strike', 'strong', 'style', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul', 'wbr',
];
const LAYOUT = ['align', 'valign', 'width', 'height', 'bgcolor', 'color', 'dir', 'border', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'face', 'size', 'title', 'lang', 'style', 'class', 'id'];
/** A web address inside CSS: url(...) and @import, which would fetch something from the sender's server. */
const CSS_REMOTE = /url\(\s*(['"]?)\s*(?:https?:)?\/\/[^)]*\)/gi;
const CSS_IMPORT = /@import[^;]*;?/gi;

/**
 * The email's HTML made safe to show. `images` keeps pictures from other sites; without it they are left out and
 * counted, so the screen can offer to show them.
 */
export function cleanEmail(html: string, images: boolean): { html: string; blocked: number } {
  let blocked = 0;
  // CSS is kept for layout, but never what CSS could fetch or run.
  const css = (text: string) =>
    text
      .replace(CSS_IMPORT, '')
      .replace(/expression\s*\(/gi, '')
      .replace(CSS_REMOTE, (whole) => {
        if (images) return whole.replace(/^url\(\s*(['"]?)\s*(?:https?:)?\/\//i, 'url($1https://');
        blocked++;
        return 'none';
      });
  const cleaned = sanitizeHtml(html, {
    allowedTags: FORMATTING,
    // The email is shown in its own document inside a frame that runs nothing, so its styles can only restyle the
    // email. That is the one reason <style> is let through.
    allowVulnerableTags: true,
    allowedAttributes: { '*': LAYOUT, a: [...LAYOUT, 'href', 'name', 'target', 'rel'], img: [...LAYOUT, 'src', 'alt'] },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: images ? ['https', 'data'] : ['data'] },
    allowProtocolRelative: false,
    nonTextTags: ['script', 'textarea', 'option', 'noscript', 'title', 'template', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'select', 'button'],
    transformTags: {
      a: (_tag, attribs) => ({ tagName: 'a', attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' } }),
      img: (_tag, attribs) => {
        const { src = '', ...rest } = attribs;
        if (/^(https?:)?\/\//i.test(src)) {
          if (!images) {
            blocked++;
            return { tagName: 'img', attribs: rest };
          }
          // Pictures load over HTTPS only: a plain-HTTP one is asked for over HTTPS.
          return { tagName: 'img', attribs: { ...rest, src: src.replace(/^(https?:)?\/\//i, 'https://') } };
        }
        // A picture carried inside the email (cid:) can't be shown from here; its alt text stands in.
        return { tagName: 'img', attribs: src.startsWith('data:image/') ? attribs : rest };
      },
    },
    // A picture with nothing left to show is dropped rather than left as an empty box.
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src && !frame.attribs.alt,
  });
  // What a stylesheet or a style attribute could fetch goes through the same filter. The library passes the text of
  // <style> through as it is, so both are filtered here, on its output.
  const styled = cleaned
    .replace(/<style>([\s\S]*?)<\/style>/gi, (_w, sheet: string) => `<style>${css(sheet)}</style>`)
    .replace(/\sstyle="([^"]*)"/gi, (_w, value: string) => ` style="${css(value.replace(/&quot;/g, '"')).replace(/"/g, '&quot;')}"`);
  return { html: styled, blocked };
}

/** One email's original, cleaned. Plain-text email comes back as text, for the screen to lay out and link. */
export async function readOriginal(workspaceId: string, conn: ConnectionRow, messageId: string, images: boolean): Promise<Original | null> {
  // A provider that fails outright is the same as one that refuses: the screen shows what Timmy stored.
  const got = await fetchOriginal(workspaceId, conn, messageId).catch(() => null);
  if (!got) return null;
  if (got.html !== undefined) {
    const { html, blocked } = cleanEmail(got.html.slice(0, 2_000_000), images);
    // HTML with no words in it at all (a picture-only email with its pictures left out) still shows: the frame says so.
    return { html, blocked, ...(htmlToText(html).trim() ? {} : { text: '' }) };
  }
  return { text: (got.text ?? '').slice(0, 200_000), blocked: 0 };
}
