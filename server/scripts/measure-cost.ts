/**
 * Measures what one user costs, by running the real code paths.
 *
 *   - Composio calls: the real sync code against the fake provider, which
 *     answers the same tool slugs. The number of calls is the same as with a
 *     real mailbox, because the calls are made by our code, not by the provider.
 *   - Model cost: real questions through the real model on OpenRouter, read
 *     back from the usage rows the server writes (tokens in, out, reasoning,
 *     cached, and dollars).
 *
 * Run from server/:
 *   DATABASE_URL=postgres://timmy_owner:timmy@localhost:5432/timmy_cost \
 *   OPENROUTER_API_KEY=... COMPOSIO_API_KEY=unused TIMMY_ENV=development \
 *   npx tsx scripts/measure-cost.ts [--days 30] [--per-day 100] [--no-model]
 *
 * In a cloud session also set NODE_USE_ENV_PROXY=1; the proxy supplies the OpenRouter key.
 */
import { draftReply } from '../src/agent/draft';
import { readThread } from '../src/agent/read';
import { ASK_SYSTEM } from '../src/agent/prompts';
import { startRun } from '../src/agent/loop';
import { rulesFor } from '../src/auth/roles';
import { initAuth } from '../src/auth/auth';
import { migrate } from '../src/db/migrate';
import { closePools, sysPool } from '../src/db/pool';
import { registerJobs } from '../src/jobs/handlers';
import { inlineJobs } from '../src/jobs/jobs';
import { FakeComposio, setComposioForTests, signWebhook } from '../src/providers/composio';
import { buildApp } from '../src/http/app';
import type { Ctx } from '../src/state/engine';
import { backfillMail } from '../src/sync/ingest';
import { finishConnect, startConnect } from '../src/sync/connect';

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const DAYS = arg('days', 30);
const PER_DAY = arg('per-day', 100);
const WITH_MODEL = !process.argv.includes('--no-model');

/* ───────────── A realistic mailbox ───────────── */

const PEOPLE = [
  ['Dana Whitfield', 'dana.whitfield@acme-corp.test', 'Acme Corp'],
  ['Marcus Lee', 'marcus@northwindhealth.test', 'Northwind Health'],
  ['Priya Raman', 'priya@brightwave.test', 'Brightwave'],
  ['Leo Grant', 'leo@harborfreight.test', 'Harbor Freight'],
  ['Sofia Alvarez', 'sofia@lumenlabs.test', 'Lumen Labs'],
  ['Kenji Watanabe', 'kenji@oakridge.test', 'Oakridge Partners'],
  ['Nina Okafor', 'nina@summitdental.test', 'Summit Dental'],
  ['Ben Carter', 'ben@riverbend.test', 'Riverbend Logistics'],
] as const;
const TOPICS = ['renewal quote', 'pilot kickoff', 'security questionnaire', 'invoice 4471', 'onboarding plan', 'contract redlines', 'Q1 forecast', 'reference call', 'pricing tiers', 'data migration'];
const FILLER =
  'We reviewed this with the team yesterday and there are a few open points. First, the timeline: we would like to start in the first week of next month, which means the paperwork has to be done by the end of this one. Second, the scope: the pilot covers two departments and about forty users, and we expect to add the rest once the first results are in. Third, the budget owner changed last quarter, so approvals now go through finance before legal. None of this should hold things up, but I wanted you to have the full picture before we talk.';
const NEWSLETTER =
  'This week in the industry: pricing pressure continues across the mid-market, with three vendors announcing new tiers. Our analysis of forty public filings shows gross margins holding while sales cycles lengthen by roughly two weeks. In product news, two platforms shipped workflow automation and one retired its legacy API. Below, a longer read on procurement trends, a field guide to renewal negotiations, and the events calendar for the quarter. '.repeat(6) +
  '\n\nYou are receiving this because you subscribed. Unsubscribe or view this email in your browser.';

function fill(fake: FakeComposio, account: string, days: number, perDay: number) {
  const box = fake.accounts.get(account)!;
  let n = 0;
  const price = (i: number) => 40 + (i % 9) * 3;
  for (let d = 0; d < days; d++) {
    for (let k = 0; k < perDay; k++) {
      const i = d * perDay + k;
      const at = new Date(Date.now() - d * 86400_000 - k * 600_000 - 60_000);
      const kind = k % 20;
      if (kind < 11) {
        // A person writing about real work. Threads run two to four messages.
        const [name, email, company] = PEOPLE[(i * 7) % PEOPLE.length]!;
        const topic = TOPICS[(i * 3) % TOPICS.length]!;
        const thread = `th-${d}-${Math.floor(k / 3)}`;
        const body = `Hi,\n\nFollowing up on the ${topic} for ${company}. ${FILLER.slice(0, 220 + ((i * 37) % 320))}\n\nFor reference, the figure we discussed was $${price(i)} per seat for ${80 + (i % 7) * 20} seats, and we would need the paperwork by ${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'][i % 5]}.\n\nThanks,\n${name.split(' ')[0]}`;
        box.messages.push({ id: `m-${++n}`, threadId: thread, from: `${name} <${email}>`, to: [box.address], subject: `${k % 3 ? 'Re: ' : ''}${topic[0]!.toUpperCase()}${topic.slice(1)} for ${company}`, body, at, labels: d === 0 ? ['INBOX', 'UNREAD'] : ['INBOX'] });
      } else if (kind < 16) {
        box.messages.push({ id: `m-${++n}`, threadId: `nl-${n}`, from: 'Pricing Weekly <hello@pricingweekly.test>', to: [box.address], subject: `Pricing Weekly #${300 - d}: what changed this week`, body: NEWSLETTER, at, labels: ['INBOX', 'CATEGORY_PROMOTIONS'] });
      } else if (kind < 18) {
        box.messages.push({ id: `m-${++n}`, threadId: `rc-${n}`, from: 'Billing <billing@figtools.test>', to: [box.address], subject: `Receipt for your payment of $${15 + (i % 40)}.00`, body: `Thanks for your payment. Receipt number ${10000 + i}. Amount: $${15 + (i % 40)}.00. Paid with the card ending 4242. Nothing further is needed.`, at, labels: ['INBOX', 'CATEGORY_UPDATES'] });
      } else {
        box.messages.push({ id: `m-${++n}`, threadId: `cal-${n}`, from: 'Calendar <calendar-notification@mailer.test>', to: [box.address], subject: `Accepted: ${TOPICS[i % TOPICS.length]} sync`, body: 'This event has been accepted.', at, labels: ['INBOX', 'CATEGORY_UPDATES'] });
      }
    }
  }
  return n;
}

/* ───────────── Measuring ───────────── */

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await sysPool.query(sql, params)).rows as T[];
const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!/cost|test|e2e/.test(url.pathname)) throw new Error('Point DATABASE_URL at a scratch database (its name must contain cost, test or e2e).');
  await sysPool.query('drop schema if exists pgboss cascade; drop schema if exists auth cascade; drop schema if exists public cascade; create schema public;');
  await migrate();
  await initAuth();
  registerJobs();
  const app = buildApp();
  const fake = new FakeComposio();
  setComposioForTests(fake);

  const workspaceId = 'ws_cost';
  await sysPool.query(`insert into workspace (id, name, owner_name, owner_email, monthly_spend_cap_usd) values ($1, 'Cost test', 'Taylor Morgan', 'taylor@costtest.test', 25)`, [workspaceId]);
  const ctx: Ctx = { user: { id: 'u_cost', name: 'Taylor Morgan', email: 'taylor@costtest.test' }, workspaceId, role: 'owner', rules: rulesFor('owner') };
  // The run loop checks the person is still a member before resuming; give it a real membership.
  await sysPool.query(`insert into auth."user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ('u_cost', 'Taylor Morgan', 'taylor@costtest.test', true, now(), now())`);
  await sysPool.query(`insert into auth.organization (id, name, slug, "createdAt") values ($1, 'Cost test', 'cost-test', now())`, [workspaceId]);
  await sysPool.query(`insert into auth.member (id, "organizationId", "userId", role, "createdAt") values ('m_cost', $1, 'u_cost', 'owner', now())`, [workspaceId]);

  /* Connect and backfill */
  fake.nextAddress = 'taylor@costtest.test';
  const start = await startConnect(ctx, 'gmail');
  const account = new URL(start.redirectUrl).searchParams.get('account')!;
  fake.completeConnect(account);
  await finishConnect(ctx, start.connectionId);
  const total = fill(fake, account, DAYS, PER_DAY);
  const t0 = Date.now();
  const bf = await backfillMail(workspaceId, start.connectionId, { days: DAYS + 1, maxPages: 10_000, pauseMs: 0 });
  const backfillMs = Date.now() - t0;
  const threads = (await q<{ n: number }>(`select count(*)::int as n from state_doc where workspace_id = $1 and slice = 'threads'`, [workspaceId]))[0]!.n;
  const sorted = await q<{ box: string; confidence: string; n: number }>(`select data->'suggestion'->>'box' as box, data->'suggestion'->>'confidence' as confidence, count(*)::int as n from state_doc where workspace_id = $1 and slice = 'threads' group by 1, 2 order by 3 desc`, [workspaceId]);

  /* One day of new mail, through the signed webhook */
  const before = (await q<{ n: number }>(`select count(*)::int as n from provider_call where workspace_id = $1`, [workspaceId]))[0]!.n;
  const NEW = PER_DAY;
  for (let i = 0; i < NEW; i++) {
    const [name, email, company] = PEOPLE[i % PEOPLE.length]!;
    const d = fake.deliver(account, { from: `${name} <${email}>`, subject: `Quick question about ${TOPICS[i % TOPICS.length]} (${company})`, body: `Hi Taylor,\n\n${FILLER.slice(0, 300)}\n\nThanks,\n${name.split(' ')[0]}` });
    await app.request('/api/hooks/composio', { method: 'POST', headers: d.webhook.headers, body: d.webhook.body });
  }
  // Only the sync jobs run here; reading the new threads with the model is measured on its own below.
  await inlineJobs()!.drain('mail.ingest');
  inlineJobs()!.queue = [];
  const perNew = ((await q<{ n: number }>(`select count(*)::int as n from provider_call where workspace_id = $1`, [workspaceId]))[0]!.n - before) / NEW;
  void signWebhook;

  const calls = await q<{ phase: string; op: string; n: number }>(`select phase, op, count(*)::int as n from provider_call where workspace_id = $1 group by 1, 2 order by 1, 3 desc`, [workspaceId]);

  console.log('\n== Composio calls (counted from the real sync code) ==');
  console.log(`Mailbox: ${total} messages over ${DAYS} days (${PER_DAY} a day). Backfill: ${bf.pages} pages in ${(backfillMs / 1000).toFixed(1)}s of our own time, ${threads} threads shown.`);
  for (const c of calls) console.log(`  ${c.phase.padEnd(9)} ${c.op.padEnd(34)} ${c.n}`);
  console.log(`  Calls per new email: ${perNew.toFixed(2)}`);
  console.log('First sort by plain code (no model call):');
  for (const s of sorted) console.log(`  ${String(s.box).padEnd(13)} ${String(s.confidence).padEnd(7)} ${s.n}`);

  /* The read route: one call for each thread plain code could not sort */
  if (WITH_MODEL) {
    console.log('\n== Read route (real calls, one model call per thread a person wrote) ==');
    const todo = await q<{ id: string; subject: string }>(`select id, data->>'subject' as subject from state_doc where workspace_id = $1 and slice = 'threads' and data->'suggestion'->>'confidence' = 'low' order by ord limit 6`, [workspaceId]);
    for (const t of todo) {
      const out = await readThread(workspaceId, t.id);
      const after = (await q<{ s: string; ask: string }>(`select data->'suggestion'::text as s, data->>'ask' as ask from state_doc where workspace_id = $1 and slice = 'threads' and id = $2`, [workspaceId, t.id]))[0]!;
      console.log(`  [${out.ok ? 'ok' : 'failed: ' + out.reason}] ${t.subject.slice(0, 44).padEnd(44)} → ${String(after.ask).slice(0, 110)}`);
    }
    const r = (await q<{ calls: number; tin: number; tout: number; reasoning: number; cached: number; cost: number }>(`select count(*)::int as calls, avg(tokens_in)::int as tin, avg(tokens_out)::int as tout, avg(tokens_reasoning)::int as reasoning, avg(tokens_cached)::int as cached, avg(cost_usd)::float8 as cost from usage_event where workspace_id = $1 and route = 'read'`, [workspaceId]))[0]!;
    console.log(`  Average per read over ${r.calls} threads: input ${r.tin} (cached ${r.cached})  output ${r.tout} (reasoning ${r.reasoning})  cost ${money(r.cost)}`);
  }

  /* The drafting route: one call per draft */
  if (WITH_MODEL) {
    console.log('\n== Drafting route (real calls, one model call per draft) ==');
    const people = await q<{ id: string; subject: string }>(`select id, data->>'subject' as subject from state_doc where workspace_id = $1 and slice = 'threads' and data->'suggestion'->>'box' = 'follow-up' order by ord limit 4`, [workspaceId]);
    for (const [i, t] of people.entries()) {
      const out = await draftReply(workspaceId, t.id, i === 3 ? { note: 'Say Tuesday at 2pm works, and ask them to bring the signed order form.' } : {});
      console.log(`  [${out.ok ? 'ok' : 'failed: ' + out.reason}] ${t.subject.slice(0, 50).padEnd(50)} → ${(out.draft?.body ?? '').replace(/\s+/g, ' ').slice(0, 110)}`);
    }
    const d = (await q<{ calls: number; tin: number; tout: number; reasoning: number; cached: number; cost: number }>(`select count(*)::int as calls, avg(tokens_in)::int as tin, avg(tokens_out)::int as tout, avg(tokens_reasoning)::int as reasoning, avg(tokens_cached)::int as cached, avg(cost_usd)::float8 as cost from usage_event where workspace_id = $1 and route = 'draft'`, [workspaceId]))[0]!;
    console.log(`  Average per draft over ${d.calls} drafts: input ${d.tin} (cached ${d.cached})  output ${d.tout} (reasoning ${d.reasoning})  cost ${money(d.cost)}`);
  }

  /* Ask, on the real model */
  if (WITH_MODEL && !process.argv.includes('--only-draft')) {
    const ask = async (text: string) => {
      const t = Date.now();
      const out = await startRun(ctx, { kind: 'ask', attended: true, system: ASK_SYSTEM, messages: [{ role: 'user', content: `<context>\nNow: ${new Date().toISOString()}\nUser: Taylor Morgan\n</context>\n\n${text}` }], effort: 'low' });
      const u = (await q<{ calls: number; tin: number; tout: number; reasoning: number; cached: number; cost: number }>(`select count(*)::int as calls, sum(tokens_in)::int as tin, sum(tokens_out)::int as tout, sum(tokens_reasoning)::int as reasoning, sum(tokens_cached)::int as cached, sum(cost_usd)::float8 as cost from usage_event where run_id = $1`, [out.runId]))[0]!;
      console.log(`  [${out.status}] ${text.slice(0, 58).padEnd(58)} calls ${u.calls}  in ${u.tin}  cached ${u.cached}  out ${u.tout}  reasoning ${u.reasoning}  ${money(u.cost)}  ${((Date.now() - t) / 1000).toFixed(1)}s`);
      if (out.status === 'failed') console.log(`      error: ${out.error}`);
      else console.log(`      → ${out.text.replace(/\s+/g, ' ').slice(0, 150)}`);
      return { ...u, kind: /^draft/i.test(text) ? 'draft' : /^send/i.test(text) ? 'send' : 'ask' };
    };
    console.log('\n== Model cost (real calls, Claude Opus 5.5 through OpenRouter, effort low) ==');
    const rows = [];
    const questions = [
      'What did Dana Whitfield ask me for most recently?',
      'Find the email about the renewal quote for Northwind Health and tell me the price per seat they mentioned.',
      'Who has written to me today that I have not answered?',
      'Summarize the latest thread with Priya Raman about the security questionnaire.',
      'Do I have anything from Riverbend Logistics about invoice 4471?',
      'What is in my inbox that looks like a newsletter?',
      'Draft a reply to the latest email from Marcus Lee saying Tuesday works for the pilot kickoff.',
      'Draft a reply to the latest email from Sofia Alvarez asking for the signed contract by Friday.',
      'Send Kenji Watanabe at kenji@oakridge.test a short note that the contract redlines are approved.',
    ];
    for (const text of questions) rows.push(await ask(text));
    const mean = (kind: string, f: (r: (typeof rows)[number]) => number) => {
      const set = rows.filter((r) => r.kind === kind);
      return set.length ? set.reduce((a, r) => a + f(r), 0) / set.length : 0;
    };
    console.log('\nAverages per turn:');
    for (const kind of ['ask', 'draft', 'send']) {
      console.log(`  ${kind.padEnd(6)} model calls ${mean(kind, (r) => r.calls).toFixed(1)}  input ${mean(kind, (r) => r.tin).toFixed(0)} (cached ${mean(kind, (r) => r.cached).toFixed(0)})  output ${mean(kind, (r) => r.tout).toFixed(0)} (reasoning ${mean(kind, (r) => r.reasoning).toFixed(0)})  cost ${money(mean(kind, (r) => r.cost))}`);
    }
    const all = (await q<{ cost: number; calls: number }>(`select coalesce(sum(cost_usd), 0)::float8 as cost, count(*)::int as calls from usage_event where workspace_id = $1`, [workspaceId]))[0]!;
    console.log(`  This measurement spent ${money(all.cost)} on ${all.calls} model calls.`);
  }
  await closePools();
}

main().catch(async (e) => {
  console.error(e);
  await closePools();
  process.exit(1);
});
