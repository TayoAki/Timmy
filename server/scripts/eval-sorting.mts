/**
 * How well Timmy sorts mail, measured on made-up emails (scripts/sorting-eval/cases.ts): each goes through the first
 * sort by plain code (sync/sorting.ts) and, when plain code leaves it for the model, through the model's read with the
 * read's own prompt (agent/read.ts). Prints each email's expected and actual box, and the totals.
 *
 *   npx tsx scripts/eval-sorting.mts [model] [--holdout]   (default: the server's default model; --holdout runs the
 *   second set, written after the fix and never tuned on)
 *
 * It calls OpenRouter directly (no database, no budget), on made-up mail only, with a made-up user name.
 */
import { READ_MAX_TOKENS, READ_SYSTEM } from '../src/agent/read';
import { untrusted } from '../src/agent/prompts';
import { config } from '../src/config';
import { suggest } from '../src/sync/sorting';
import { CASES as MAIN, type Box, type Case } from './sorting-eval/cases';
import { HOLDOUT } from './sorting-eval/holdout';

const holdout = process.argv.includes('--holdout');
const CASES = holdout ? HOLDOUT : MAIN;
const model = process.argv.slice(2).find((a) => !a.startsWith('--')) || config.openrouter.defaultModel;

async function read(c: Case): Promise<{ box: Box | 'unusable'; reason: string; cost: number }> {
  const body = {
    model,
    stream: false,
    max_tokens: READ_MAX_TOKENS,
    reasoning: { effort: 'low' },
    provider: { zdr: true, data_collection: 'deny' },
    usage: { include: true },
    messages: [
      { role: 'system', content: READ_SYSTEM },
      { role: 'user', content: `The user is Morgan Lee. Today is 2026-11-18.\n\n${untrusted('mail', { subject: c.subject, messages: [{ from: `${c.name} <${c.sender}>`, at: '2026-11-18T09:00:00.000Z', body: c.text }] })}` },
    ],
  };
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? 'x'}` },
    body: JSON.stringify(body),
  });
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { cost?: number }; error?: unknown };
  const text = j.choices?.[0]?.message?.content ?? '';
  if (!text) return { box: 'unusable', reason: `no answer: ${res.status} ${JSON.stringify(j.error ?? j).slice(0, 160)}`, cost: 0 };
  const m = /\{[\s\S]*\}/.exec(text);
  try {
    const out = JSON.parse(m?.[0] ?? '{}') as { box?: string; reason?: string };
    const box = out.box === 'follow-up' || out.box === 'read-through' || out.box === 'archived' ? out.box : 'unusable';
    return { box, reason: String(out.reason ?? ''), cost: j.usage?.cost ?? 0 };
  } catch {
    return { box: 'unusable', reason: JSON.stringify(j.error ?? text).slice(0, 200), cost: j.usage?.cost ?? 0 };
  }
}

const rows: { c: Case; plain: string; final: string; by: 'code' | 'model'; reason: string }[] = [];
let cost = 0;
const queue = [...CASES];
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const s = suggest({ sender: c.sender, subject: c.subject, text: c.text, labels: c.labels });
      if (!s.provisional) {
        rows.push({ c, plain: `${s.box} (${s.confidence})`, final: s.box, by: 'code', reason: s.reason });
        continue;
      }
      const r = await read(c);
      cost += r.cost;
      rows.push({ c, plain: 'left for the model', final: r.box, by: 'model', reason: r.reason });
    }
  }),
);
rows.sort((a, b) => CASES.indexOf(a.c) - CASES.indexOf(b.c));
const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
console.log(`model: ${model}${holdout ? ' (held-out set)' : ''}\n`);
console.log(pad('email', 22), pad('expected', 13), pad('plain code', 22), pad('final', 13), 'ok');
for (const r of rows) console.log(pad(r.c.id, 22), pad(r.c.expect, 13), pad(r.plain, 22), pad(r.final, 13), r.final === r.c.expect ? 'yes' : `NO  (${r.by}: ${r.reason.slice(0, 80)})`);
const right = rows.filter((r) => r.final === r.c.expect).length;
const boxes: Box[] = ['follow-up', 'read-through', 'archived'];
console.log(`\ncorrect: ${right} of ${rows.length} (${Math.round((100 * right) / rows.length)}%)`);
for (const b of boxes) {
  const expected = rows.filter((r) => r.c.expect === b);
  const got = rows.filter((r) => r.final === b);
  console.log(`${pad(b, 13)} expected ${String(expected.length).padStart(2)}, got ${String(got.length).padStart(2)}, of those right ${got.filter((r) => r.c.expect === b).length}; found ${expected.filter((r) => r.final === b).length} of ${expected.length}`);
}
console.log(`\nread by the model: ${rows.filter((r) => r.by === 'model').length}; model cost $${cost.toFixed(3)}`);
