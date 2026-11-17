/*
 * Docs are stored as Timmy blocks (what drafts, exports and Ask Timmy read);
 * the editor works on a ProseMirror document. Every block is one top-level
 * node, so the two map one to one and nothing is lost either way.
 */
import type { JSONContent } from '@tiptap/core';
import type { Block, BlockColor, InlineNode } from '../../../data/ws-types';
import { bid } from '../templates';

const plain = (inline: InlineNode[]) => inline.map((n) => (n.type === 'text' ? n.text : '\n')).join('');

const inlineFromText = (text: string): JSONContent[] => {
  const out: JSONContent[] = [];
  text.split('\n').forEach((part, i) => {
    if (i > 0) out.push({ type: 'hardBreak' });
    if (part) out.push({ type: 'text', text: part });
  });
  return out;
};

const inlineOf = (b: { text: string; rich?: InlineNode[] }): JSONContent[] =>
  b.rich && plain(b.rich) === b.text ? (b.rich as JSONContent[]) : inlineFromText(b.text);

const base = (b: Block) => ({ bid: b.id, indent: b.indent ?? 0, color: b.color ?? null });

export function blockToNode(b: Block): JSONContent {
  switch (b.type) {
    case 'p':
      return { type: 'paragraph', attrs: base(b), content: inlineOf(b) };
    case 'h1':
    case 'h2':
    case 'h3':
      return { type: 'heading', attrs: { ...base(b), level: Number(b.type[1]) }, content: inlineOf(b) };
    case 'bullet':
    case 'numbered':
    case 'quote':
      return { type: b.type, attrs: base(b), content: inlineOf(b) };
    case 'todo':
      return { type: 'todo', attrs: { ...base(b), checked: b.checked }, content: inlineOf(b) };
    case 'toggle':
      return { type: 'toggle', attrs: { ...base(b), open: b.open !== false }, content: inlineOf(b) };
    case 'callout':
      return { type: 'callout', attrs: { ...base(b), icon: b.icon ?? '💡' }, content: inlineOf(b) };
    case 'code':
      return { type: 'codeBlock', attrs: { ...base(b), language: b.lang ?? null }, content: b.text ? [{ type: 'text', text: b.text }] : [] };
    case 'divider':
      return { type: 'horizontalRule', attrs: base(b) };
    case 'image':
      return { type: 'image', attrs: { ...base(b), src: b.src, width: b.width ?? null, caption: b.caption ?? '' } };
    case 'table':
      return { type: 'table', attrs: { ...base(b), columns: b.columns, rows: b.rows } };
    case 'linked-table':
      return { type: 'linkedTable', attrs: { ...base(b), sheet: b.sheet, columns: b.columns ?? null } };
    case 'file':
      return { type: 'fileLink', attrs: { ...base(b), file: b.file } };
    case 'page':
      return { type: 'pageLink', attrs: { ...base(b), file: b.file } };
  }
}

export const toDoc = (blocks: Block[]): JSONContent => ({
  type: 'doc',
  content: blocks.length ? blocks.map(blockToNode) : [{ type: 'paragraph', attrs: { bid: bid(), indent: 0, color: null } }],
});

/* ── back to blocks ── */

const MARKS = new Set(['bold', 'italic', 'underline', 'strike', 'code', 'link', 'textStyle', 'highlight']);

function readInline(content: JSONContent[] | undefined): { text: string; rich?: InlineNode[] } {
  const nodes: InlineNode[] = [];
  let formatted = false;
  for (const n of content ?? []) {
    if (n.type === 'hardBreak') nodes.push({ type: 'hardBreak' });
    else if (n.type === 'text' && n.text) {
      const marks = (n.marks ?? [])
        .filter((m) => MARKS.has(m.type))
        .map((m) => (m.attrs && Object.values(m.attrs).some((v) => v != null) ? { type: m.type, attrs: m.attrs } : { type: m.type }));
      if (marks.length) formatted = true;
      nodes.push(marks.length ? { type: 'text', text: n.text, marks } : { type: 'text', text: n.text });
    }
  }
  const text = plain(nodes);
  return formatted ? { text, rich: nodes } : { text };
}

const common = (n: JSONContent) => {
  const a = n.attrs ?? {};
  const out: { id: string; indent?: number; color?: BlockColor } = { id: (a.bid as string) || bid() };
  if (a.indent) out.indent = a.indent as number;
  if (a.color) out.color = a.color as BlockColor;
  return out;
};

export function nodeToBlock(n: JSONContent): Block | null {
  const a = n.attrs ?? {};
  const c = common(n);
  switch (n.type) {
    case 'paragraph':
      return { ...c, type: 'p', ...readInline(n.content) };
    case 'heading': {
      const level = Math.min(3, Math.max(1, Number(a.level) || 2));
      return { ...c, type: `h${level}` as 'h1' | 'h2' | 'h3', ...readInline(n.content) };
    }
    case 'bullet':
    case 'numbered':
    case 'quote':
      return { ...c, type: n.type, ...readInline(n.content) };
    case 'todo':
      return { ...c, type: 'todo', checked: !!a.checked, ...readInline(n.content) };
    case 'toggle':
      return { ...c, type: 'toggle', open: a.open !== false, ...readInline(n.content) };
    case 'callout':
      return { ...c, type: 'callout', icon: (a.icon as string) || '💡', ...readInline(n.content) };
    case 'codeBlock':
      return { ...c, type: 'code', text: (n.content ?? []).map((t) => t.text ?? '').join(''), ...(a.language ? { lang: a.language as string } : {}) };
    case 'horizontalRule':
      return { ...c, type: 'divider' };
    case 'image':
      return { ...c, type: 'image', src: a.src as string, ...(a.width ? { width: a.width as number } : {}), ...(a.caption ? { caption: a.caption as string } : {}) };
    case 'table':
      return { ...c, type: 'table', columns: a.columns as string[], rows: a.rows as string[][] };
    case 'linkedTable':
      return { ...c, type: 'linked-table', sheet: a.sheet as string, ...(a.columns ? { columns: a.columns as string[] } : {}) };
    case 'fileLink':
      return { ...c, type: 'file', file: a.file as string };
    case 'pageLink':
      return { ...c, type: 'page', file: a.file as string };
    default:
      return null;
  }
}

export const fromDoc = (doc: JSONContent): Block[] => (doc.content ?? []).map(nodeToBlock).filter((b): b is Block => !!b);

/** Same content, ignoring key order: used to skip no-op saves and echo updates. */
export const sameBlocks = (a: Block[], b: Block[]) => a.length === b.length && JSON.stringify(a.map(norm)) === JSON.stringify(b.map(norm));

/**
 * A value with every object's keys in one order and its empty fields left out, at every depth. The server's copy
 * of a page comes back with keys in the database's order, so two copies of the same blocks only compare equal this way.
 */
const canon = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canon);
  if (v instanceof Date) return v.toISOString();
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) if (o[k] !== undefined && o[k] !== null) out[k] = canon(o[k]);
  return out;
};

const norm = (b: Block) => {
  const out = canon(b) as Record<string, unknown>;
  if (out.indent === 0) delete out.indent;
  return out;
};
