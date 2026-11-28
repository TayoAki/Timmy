// Due today in the sample demo: a campaign not launched yet is worked by hand. Its leads' first steps are listed,
// each written for the lead; sending one moves the lead on to their next step; a step can be skipped; and the tab
// says how many are left.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:5173/';
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };
const KEY = 'timmy-state-v3';
const saved = (p) => p.evaluate((KEY) => JSON.parse(localStorage.getItem(KEY) || '{}'), KEY);
const until = async (p, test) => {
  for (let i = 0; i < 40; i++) {
    if (test(await saved(p))) return true;
    await p.waitForTimeout(100);
  }
  return false;
};

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE);
  await p.evaluate(() => localStorage.clear());
  await p.reload();
  await p.waitForTimeout(600);

  await p.locator('.rail [aria-label="Outbound"]').click();
  await p.getByRole('tab', { name: /^Due today/ }).click();
  assert(/Nothing due today/.test(await p.locator('.due-tab').innerText()), 'with no campaign worked by hand, nothing is due');

  // A campaign Timmy writes, not launched: its leads' first steps are due at once.
  await p.getByRole('tab', { name: /^Campaigns/ }).click();
  await p.getByRole('button', { name: 'New campaign' }).first().click();
  const dlg = p.locator('.modal', { hasText: 'New campaign' });
  await dlg.waitFor();
  await dlg.getByRole('button', { name: 'Write the sequence' }).click();
  await p.waitForTimeout(400);
  const st = await saved(p);
  const camp = Object.values(st.ws ? st.out.campaigns : {}).find((c) => c.status === 'draft' && c.leads.length > 0);
  assert(camp && camp.leads.length >= 2, `the campaign has leads (${camp ? camp.leads.length : 0})`);

  await p.locator('.rail [aria-label="Outbound"]').click();
  await p.getByRole('tab', { name: /^Due today/ }).click();
  const list = p.getByRole('list', { name: 'Steps due' });
  await list.waitFor();
  const n = await list.locator('.due-row').count();
  assert(n === camp.leads.length, `each lead’s first step is due (${n})`);
  const tabCount = await p.getByRole('tab', { name: /^Due today/ }).innerText();
  assert(tabCount.includes(String(n)), 'the tab counts them');
  const first = list.locator('.due-row').first();
  assert(!/\{\{/.test(await first.innerText()), 'each is written for the lead, with no merge field showing');

  // Write it: the step, filled in; sending it moves the lead on.
  const who = (await first.locator('strong').innerText()).trim();
  await first.getByRole('button', { name: 'Write it' }).click();
  const form = p.locator('.msg-form');
  await form.waitFor();
  const body = await form.locator('textarea.msg-body').inputValue();
  assert(body.length > 40 && !/\{\{/.test(body), 'the email starts as their step of the sequence');
  await p.locator('.modal').last().getByRole('button', { name: /^Send/ }).first().click();
  assert(await until(p, (s) => Object.values(s.out.leads).some((l) => `${l.first} ${l.last}` === who && l.step === 1)), 'sending it moves the lead to their next step');
  await p.waitForTimeout(300);
  assert((await list.locator('.due-row').count()) === n - 1, 'and they leave Due today until it is due');

  // Skip one.
  const next = list.locator('.due-row').first();
  const skipped = (await next.locator('strong').innerText()).trim();
  await next.getByRole('button', { name: 'Skip this step' }).click();
  assert(await until(p, (s) => Object.values(s.out.leads).some((l) => `${l.first} ${l.last}` === skipped && l.step === 1)), 'a step can be skipped');
  await p.waitForTimeout(300);
  assert((await list.locator('.due-row').count()) === n - 2, 'and that lead waits for their next step');

  assert(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await b.close();
})().catch((e) => { console.error(e.message || e); process.exit(1); });
