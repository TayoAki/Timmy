/*
 * Timmy's summary of a page, taken from the page itself: one line per section
 * (its heading and first point) and the open to-dos. Nothing is made up; if
 * the page has nothing to summarize, Timmy says so.
 */
import type { Block } from '../../data/ws-types';
import { textOf } from '../../lib/blocks';
import type { Written } from './editor/presence';

const firstSentence = (t: string) => {
  const s = t.trim().replace(/\s+/g, ' ');
  const m = s.match(/^.{20,140}?[.!?](\s|$)/);
  const out = m ? m[0].trim() : s;
  return out.length > 140 ? `${out.slice(0, 137).trimEnd()}…` : out;
};

/** One line for a block that has no prose of its own (tables, links, pages). */
function blockLine(b: Block, nameOf: (id: string) => string | undefined): string | null {
  if (b.type === 'table') {
    const rows = b.rows.filter((r) => r.some((c) => c.trim()));
    if (!rows.length) return null;
    const first = rows[0]!.filter((c) => c.trim()).join(' · ');
    return `${rows.length} row${rows.length === 1 ? '' : 's'}, latest: ${firstSentence(first)}`;
  }
  if (b.type === 'file' || b.type === 'page') return nameOf(b.file) ?? null;
  if (b.type === 'linked-table') {
    const n = nameOf(b.sheet);
    return n ? `Figures from ${n}` : null;
  }
  const t = textOf(b).trim();
  return t ? firstSentence(t) : null;
}

export function summarize(blocks: Block[], nameOf: (id: string) => string | undefined = () => undefined): Written[] {
  const secs: { title: string; items: Block[] }[] = [{ title: '', items: [] }];
  for (const b of blocks) {
    if (b.type === 'h1' || b.type === 'h2' || b.type === 'h3') secs.push({ title: b.text.trim(), items: [] });
    else if (b.type !== 'callout' || !/summary/i.test(b.text)) secs[secs.length - 1]!.items.push(b);
  }
  const lines: string[] = [];
  // What the page opens with.
  const intro = secs[0]!.items.filter((b) => b.type !== 'todo');
  const introLines = intro.map((b) => blockLine(b, nameOf)).filter((x): x is string => !!x);
  if (introLines.length) lines.push(...introLines.slice(0, 2));
  // One line per section.
  for (const s of secs.slice(1)) {
    const items = s.items.filter((b) => b.type !== 'todo');
    const parts = items.map((b) => blockLine(b, nameOf)).filter((x): x is string => !!x);
    if (!parts.length) continue;
    const allNames = items.every((b) => b.type === 'file' || b.type === 'page' || b.type === 'linked-table');
    lines.push(allNames ? `${s.title}: ${parts.join(', ')}` : `${s.title}: ${parts[0]}${parts.length > 1 ? ` (+${parts.length - 1} more)` : ''}`);
  }
  const open = blocks.filter((b): b is Extract<Block, { type: 'todo' }> => b.type === 'todo' && !b.checked && !!b.text.trim());
  if (open.length) lines.push(`Open to-dos (${open.length}): ${open.slice(0, 3).map((t) => t.text.trim()).join('; ')}${open.length > 3 ? '; …' : ''}`);
  if (!lines.length) return [];
  return [
    { type: 'callout', attrs: { icon: '✨' }, text: 'Timmy’s summary, from what’s on this page' },
    ...lines.map((text) => ({ type: 'bullet', attrs: { indent: 0 }, text })),
  ];
}
