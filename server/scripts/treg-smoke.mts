// One small real search through Treg, run through the same pipeline as Suggest leads (findSuggestions in
// treg/leads.ts), with no workspace: it prints what each lead came to, people's names cut to initials and emails
// masked, and what it cost. Run from server/ with TREG_TOKEN set, or through a proxy that injects X-Treg-Token:
//   NODE_USE_ENV_PROXY=1 TREG_TOKEN=proxy-injected npx tsx scripts/treg-smoke.mts "dental practices in Portland, Oregon" 2
import type { Offer } from '../../src/data/outbound-types';
import { HttpTreg } from '../src/treg/client';
import { findSuggestions, type TregCaller } from '../src/treg/leads';

const ask = process.argv[2] ?? 'dental practices in Portland, Oregon';
const want = Math.min(Math.max(Number(process.argv[3] ?? 2) || 2, 1), 5);
const t = new HttpTreg((process.env.TREG_URL ?? 'https://treg.to').replace(/\/$/, ''), process.env.TREG_TOKEN || 'proxy-injected');
const offer: Offer = { name: 'Chair Reminders', product: 'Text reminders for dental practices', audience: 'Dental practices', pain: 'patients miss appointments', outcome: 'fewer no-shows', proof: '', cta: 'Open to a quick call?', icp: { titles: ['Practice Manager'], industries: ['Dental'], minEmployees: 5, maxEmployees: 200 } };
const calls: string[] = [];
const call: TregCaller = async (route, body, headers) => {
  const r = await t.call({ route, body, meta: 'workspace=timmy-smoke-test,feature=lead-suggest', idempotencyKey: `smoke2-${route}-${JSON.stringify(body)}`.slice(0, 200), maxCostUsd: 0.25, ...(headers ? { headers } : {}) });
  calls.push(`${route} · ${r.servedBy} · $${(r.costMicro / 1e6).toFixed(5)}`);
  return r as never;
};
const r = await findSuggestions(call, offer, { ask, want, known: new Set() });
console.log('calls:\n ' + calls.join('\n '));
console.log('\nskipped:', JSON.stringify(r.skipped), r.error ? `· stopped: ${r.error.message}` : '');
for (const l of r.found) {
  console.log(`\n· ${l.first.slice(0, 1)}. ${l.last.slice(0, 1)}. — ${l.title ?? '-'} at ${l.company} (${l.website})`);
  console.log(`  email ***@${l.email.split('@')[1]} · industry ${l.industry ?? '-'} · employees ${l.employees ?? '-'} · city ${l.city ?? '-'}`);
  console.log(`  about: ${(l.suggested?.about ?? '').slice(0, 140)}`);
  console.log(`  why it fits: ${l.suggested?.why.join('; ')}`);
  console.log(`  sources: ${l.suggested?.sources.map((s) => `${s.field}: ${s.from}`).join(' | ')}`);
}
console.log(`\nTOTAL: ${r.found.length} lead(s) · $${(r.spentMicro / 1e6).toFixed(5)}`);
