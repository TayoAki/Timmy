/**
 * One email as Timmy stores it, whichever mailbox it came from, and the helpers that read addresses and bodies.
 *
 * `labels` uses Gmail's words for where a message sits, and every mailbox is translated into them:
 * INBOX, SENT, DRAFT, UNREAD, TRASH, SPAM. The rest of the code only ever asks those questions.
 */
export interface MailMessage {
  id: string;
  threadKey: string;
  at: Date;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  labels: string[];
  attachments: string[];
}

const ADDRESS = /[^\s<>,;"']+@[^\s<>,;"']+\.[a-z]{2,}/gi;
export const addresses = (v: unknown): string[] => (Array.isArray(v) ? v.join(', ') : String(v ?? '')).match(ADDRESS)?.map((a) => a.toLowerCase()) ?? [];

/** "Dana Whitfield <dana@acme.com>" → { name: "Dana Whitfield", email: "dana@acme.com" } */
export function parseSender(v: unknown): { name: string; email: string } {
  // A From header may carry comments in parentheses, and a comment can hold anything, including something shaped
  // like an address in angle brackets: mallory@evil.test (Pat <ceo@corp.test>). Comments are dropped first.
  let s = String(v ?? '');
  for (let before = ''; before !== s; ) {
    before = s;
    s = s.replace(/\([^()]*\)/g, ' ');
  }
  // The address is what sits in the last <…>. The display name is free text the sender chose
  // and may itself look like an address ("ceo@corp.com" <mallory@evil.test>), so it is never used as one.
  const angle = [...s.matchAll(/<([^<>]*)>/g)].pop()?.[1];
  const email = (angle !== undefined ? addresses(angle)[0] : addresses(s)[0]) ?? '';
  const name = (angle !== undefined ? s.slice(0, s.lastIndexOf('<')) : '').replace(/["']/g, '').trim();
  return { name: name && name.toLowerCase() !== email ? name.slice(0, 120) : '', email };
}

/** Gmail's shape, as Composio returns it. Accepts the fetch tools' camelCase and the trigger's snake_case. */
export function normalize(raw: Record<string, unknown>): MailMessage | null {
  const id = String(raw.messageId ?? raw.message_id ?? raw.id ?? '');
  if (!id) return null;
  const ts = raw.messageTimestamp ?? raw.message_timestamp ?? raw.internalDate;
  const at = ts ? new Date(/^\d+$/.test(String(ts)) ? Number(ts) : String(ts)) : new Date();
  return {
    id,
    threadKey: String(raw.threadId ?? raw.thread_id ?? id),
    at: Number.isNaN(at.getTime()) ? new Date() : at,
    from: String(raw.sender ?? raw.from ?? ''),
    to: addresses(raw.to),
    cc: addresses(raw.cc),
    subject: String(raw.subject ?? '').trim() || '(no subject)',
    text: String(raw.messageText ?? raw.message_text ?? '').replace(/\u0000/g, ''),
    labels: ((raw.labelIds ?? raw.label_ids ?? []) as string[]).map(String),
    attachments: ((raw.attachmentList ?? raw.attachment_list ?? []) as { filename?: string }[]).map((a) => a?.filename ?? '').filter(Boolean),
  };
}

/** The message without the quoted history under it, as short paragraphs. */
export function paragraphs(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const cut = lines.findIndex((l) => /^On .{5,80} wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(l.trim()) || /^From: .+@.+/.test(l.trim()));
  const kept = (cut > 0 ? lines.slice(0, cut) : lines).filter((l) => !l.trim().startsWith('>'));
  const body = kept.join('\n').trim().slice(0, 20000);
  const parts = body.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts : [''];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', bull: '•', middot: '·' };

/**
 * The words of an HTML email as plain text. Outlook hands bodies over as HTML; Timmy stores and shows text only,
 * so markup never reaches a screen or a prompt. What a tag hides (styles, scripts, the head, comments) is dropped
 * with it, and block tags become line and paragraph breaks so the shape of the message survives.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    // The end of a paragraph or heading is a paragraph break; the end of any other block is a line break.
    .replace(/<\/(p|h[1-6])\s*>/gi, '\n\n')
    .replace(/<\/(div|tr|li|blockquote|table|section|article|header|footer)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
      const code = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      // A character reference can spell a control character or something outside Unicode; those become nothing.
      return Number.isFinite(code) && code >= 0x20 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    });
  return text
    .replace(/[\u0000 ​﻿]/g, (ch) => (ch === ' ' ? ' ' : ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
