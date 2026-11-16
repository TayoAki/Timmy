/*
 * Polish a post you wrote, keeping your words and your topic: an opening line
 * on its own, short paragraphs, filler cut, and trimmed to the network's limit.
 * It never swaps in a different post.
 */

const FILLER: [RegExp, string][] = [
  [/\b(just|really|very|basically|actually|literally|simply)\s+/gi, ''],
  [/\bI think that\s+/gi, ''],
  [/\bin order to\b/gi, 'to'],
  [/\ba lot of\b/gi, 'many'],
  [/\bat this point in time\b/gi, 'now'],
  [/\bdue to the fact that\b/gi, 'because'],
  [/\s+,/g, ','],
  [/ {2,}/g, ' '],
];

const sentences = (t: string) =>
  t
    .replace(/\s*\n+\s*/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9“"'$])/)
    .map((x) => x.trim())
    .filter(Boolean);

const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

export function polishPost(text: string, limit = Infinity): string {
  const kept = text.trim();
  if (!kept) return kept;
  // Lists and line breaks you chose stay as they are; only the words get tightened.
  const shaped = /\n\s*([-•*]|\d+[.)])\s+/.test(kept);
  let out: string;
  if (shaped) {
    out = kept
      .split('\n')
      .map((line) => FILLER.reduce((acc, [re, to]) => acc.replace(re, to), line).trimEnd())
      .join('\n');
  } else {
    const parts = sentences(kept).map((s) => cap(FILLER.reduce((acc, [re, to]) => acc.replace(re, to), s)));
    const [hook, ...rest] = parts;
    const paras: string[] = [];
    for (let i = 0; i < rest.length; i += 2) paras.push(rest.slice(i, i + 2).join(' '));
    out = [hook, ...paras].filter(Boolean).join('\n\n');
  }
  if (out.length > limit) {
    // Trim whole sentences from the end until it fits; keep the last line if it asks something.
    const blocks = out.split('\n\n');
    const last = blocks[blocks.length - 1]!;
    const ask = /\?\s*$/.test(last) && blocks.length > 1 ? last : '';
    let body = ask ? blocks.slice(0, -1) : blocks;
    while (body.length > 1 && [...body, ask].filter(Boolean).join('\n\n').length > limit) body = body.slice(0, -1);
    out = [...body, ask].filter(Boolean).join('\n\n');
    if (out.length > limit) out = `${out.slice(0, limit - 1).replace(/\s+\S*$/, '')}…`;
  }
  return out;
}
