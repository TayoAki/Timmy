// Bids in the sample demo: finding open notices, tracking one (with its deadline on the to-do list), reading what its
// documents say, pricing it at a markup, finding subs and asking one for a quote through the compose window, the
// proposal page with its [bracketed] blanks, the company details, and the bid page on a phone.
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
const go = async (p, route) => {
  for (let i = 0; i < 4; i++) {
    await p.waitForTimeout(500);
    await p.evaluate(([KEY, route]) => { const s = JSON.parse(localStorage.getItem(KEY) || '{}'); s.route = route; localStorage.setItem(KEY, JSON.stringify(s)); }, [KEY, route]);
    await p.reload();
    await p.waitForTimeout(500);
    const now = await p.evaluate((KEY) => JSON.parse(localStorage.getItem(KEY) || '{}').route, KEY);
    if (now && now.view === route.view && now.tab === route.tab && now.id === route.id) return;
  }
};
const tab = (p, name) => p.locator('[role=tab]', { hasText: name }).first().click();

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));

  await p.goto(BASE);
  await p.evaluate(() => localStorage.clear());
  await p.reload();
  await p.waitForTimeout(600);

  // Find: the company's first state, services only, marked as samples.
  await p.locator('.rail [aria-label="Bids"]').click();
  await p.waitForSelector('.bd-result');
  assert((await p.locator('select[aria-label="State"]').inputValue()) === 'OR', 'Find starts in the company’s first state');
  assert((await p.locator('.bd-result').count()) === 2, 'two open service notices in Oregon');
  assert((await p.locator('.bd-count').innerText()).includes('Sample notices, not real ones'), 'the list says the notices are samples');
  assert((await p.locator('.bd-result', { hasText: 'Janitorial Services' }).getByRole('button', { name: 'Open bid' }).count()) === 1, 'a notice already bid on offers to open the bid');

  await p.locator('select[aria-label="State"]').selectOption('');
  await p.locator('input[aria-label="What work"]').fill('snow');
  await p.locator('.bd-search button[type=submit]').click();
  await p.waitForTimeout(200);
  const snow = p.locator('.bd-result');
  assert((await snow.count()) === 1 && /Snow and Ice Removal/.test(await snow.innerText()) && /Local/.test(await snow.innerText()), 'a search finds the city’s snow removal bid');
  await p.locator('input[aria-label="What work"]').fill('paper');
  await p.locator('.bd-search button[type=submit]').click();
  await p.waitForTimeout(200);
  assert((await p.locator('.bd-result').count()) === 0, 'services only leaves out a buy of goods');
  await p.locator('.bd-check input').uncheck();
  await p.locator('.bd-search button[type=submit]').click();
  await p.waitForTimeout(200);
  assert((await p.locator('.bd-result').count()) === 1, 'and shows it when unticked');

  // Track the grounds contract: the bid opens, and its deadline goes on the to-do list.
  await p.locator('.bd-check input').check();
  await p.locator('input[aria-label="What work"]').fill('grounds');
  await p.locator('.bd-search button[type=submit]').click();
  await p.waitForTimeout(200);
  await p.locator('.bd-result').getByRole('button', { name: 'Track' }).click();
  await p.waitForSelector('.bd-title');
  assert(await until(p, (s) => Object.values(s.ws.bids).some((x) => x.notice.id === 'sample-grounds-usfs')), 'tracking starts a bid');
  const st0 = await saved(p);
  const bid = Object.values(st0.ws.bids).find((x) => x.notice.id === 'sample-grounds-usfs');
  const task = st0.ws.tasks[bid.task];
  assert(task && task.title === 'Submit the bid: Grounds Maintenance, Three Ranger Stations' && task.priority === 'high', 'its deadline is a high-priority to-do');
  assert(bid.pricing.markupPct === 18, 'the bid takes the company’s usual markup');

  // Read the documents: the facts and a plain-English read; price lines come from it.
  await p.getByRole('button', { name: 'Read the documents' }).click();
  await p.waitForSelector('.bd-docs li');
  assert((await p.locator('.bd-docs li').count()) === 1 && /In plain English/.test(await p.locator('.bd-overview').innerText()), 'reading lists the documents and gives a plain-English read');

  // The sample bid that has been worked on shows each fact with its words and document.
  await go(p, { view: 'bid', id: 'bid-janitorial', tab: 'overview' });
  const budget = p.locator('.bd-fact', { hasText: 'Budget' });
  assert(/\$180,000 to \$240,000 \(estimate\)/.test(await budget.innerText()) && /The estimated annual value is \$180,000 to \$240,000\./.test(await budget.innerText()) && /Statement of Work\.pdf/.test(await budget.innerText()), 'a fact shows its value, the words it came from and the document');

  // Pricing: a sub cost priced at the markup, in whole cents, with totals over the contract.
  await go(p, { view: 'bid', id: bid.id, tab: 'pricing' });
  await p.locator('input[aria-label="Line 1 sub cost"]').fill('1000');
  await p.getByRole('button', { name: 'Price at markup' }).click();
  await p.waitForTimeout(200);
  assert(await until(p, (s) => s.ws.bids[bid.id].pricing.lines[0].price === 118000 && s.ws.bids[bid.id].pricing.lines[0].subCost === 100000), 'a $1,000 sub cost at 18% is a $1,180.00 price, saved in cents');
  assert(/\$1,180\.00/.test(await p.locator('.bd-totals .inv-grand').innerText()), 'the price per period shows');
  await p.getByRole('button', { name: 'Look up past awards' }).click();
  await p.waitForSelector('.bd-awards');
  assert((await p.locator('.bd-awards .table-row:not(.table-head)').count()) === 4, 'past awards like it are listed');

  // Subs: find, add, find their email, ask for a quote.
  await tab(p, 'Subs');
  await p.waitForSelector('.bd-subs');
  await p.locator('.bd-subs').getByRole('button', { name: 'Search', exact: true }).click();
  await p.waitForSelector('[aria-label="Businesses found"] .bd-sub');
  assert((await p.locator('[aria-label="Businesses found"] .bd-sub').count()) === 3, 'a business search lists three');
  await p.locator('[aria-label="Businesses found"] .bd-sub').first().getByRole('button', { name: 'Add' }).click();
  assert(await until(p, (s) => s.ws.bids[bid.id].subs.length === 1 && s.ws.bids[bid.id].stage === 'sourcing'), 'adding a sub puts it on the bid and moves the bid to sourcing');
  const subName = (await saved(p)).ws.bids[bid.id].subs[0].name;
  await p.getByRole('button', { name: `More for ${subName}` }).click();
  await p.getByRole('menuitem', { name: /Find their email/ }).click();
  assert(await until(p, (s) => s.ws.bids[bid.id].subs[0].email === 'bids@evergreen-clean.example'), 'their email is found on their website');
  await p.locator('.bd-sub', { hasText: subName }).getByRole('button', { name: 'Ask for a quote' }).click();
  await p.waitForSelector('.compose[aria-label="New message"]');
  assert((await p.locator('.draft-subject').inputValue()) === 'Quote request: Grounds Maintenance, Three Ranger Stations', 'the quote request is written');
  const body = await p.locator('textarea[aria-label="Message"]').inputValue();
  assert(!/1,180|1180|markup/i.test(body), 'it never shows the bid’s own price or markup');
  await p.locator('.compose-foot button.btn-primary').click();
  assert(await until(p, (s) => s.ws.bids[bid.id].subs[0].status === 'asked' && !!s.ws.bids[bid.id].subs[0].thread), 'sending it marks the sub asked and keeps the email');

  // The proposal: a Docs page filled from the bid, with blanks bracketed.
  await go(p, { view: 'bid', id: bid.id, tab: 'proposal' });
  await p.getByRole('button', { name: 'Start the proposal' }).click();
  await p.waitForSelector('.nb-editor');
  await p.waitForTimeout(400);
  const page = await p.locator('.nb-editor').innerText();
  assert(/Proposal: Grounds Maintenance, Three Ranger Stations/.test(await p.locator('.pg-title').inputValue().catch(() => page)) || /Proposal: Grounds Maintenance/.test(page), 'the proposal page opens');
  assert(page.includes('[UEI]') && page.includes('[similar contracts you have done: buyer, value, dates, and a reference]'), 'blanks stay bracketed; nothing is made up');
  assert(await until(p, (s) => !!s.ws.bids[bid.id].proposal), 'the bid keeps its proposal');

  // Company details.
  await go(p, { view: 'bids', tab: 'company' });
  await p.locator('.inv-form label', { hasText: 'UEI' }).locator('input').fill('ABCDEF123456');
  await p.getByRole('button', { name: 'Save details' }).click();
  assert(await until(p, (s) => s.ws.bidding.profile.uei === 'ABCDEF123456'), 'company details are saved');

  // My bids.
  await go(p, { view: 'bids', tab: 'mine' });
  assert((await p.locator('.bd-row').count()) === 2, 'My bids lists both');
  await p.locator('.inv-filters button', { hasText: 'Sourcing' }).click();
  assert((await p.locator('.bd-row').count()) === 2, 'both are sourcing');
  await p.locator('.inv-filters button', { hasText: 'Won' }).click();
  assert((await p.locator('.bd-row').count()) === 0, 'none is won yet');

  // A phone.
  await go(p, { view: 'bid', id: 'bid-janitorial', tab: 'subs' });
  const phone = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const q = await phone.newPage();
  q.on('pageerror', (e) => errors.push(e.message));
  await q.goto(BASE);
  await q.waitForSelector('.bd-subs');
  const wide = await q.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(wide <= 1, 'a bid fits a phone screen without sideways scrolling');
  await q.screenshot({ path: __dirname + '/shots/bid-phone.png' });

  assert(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await b.close();
})().catch((e) => { console.error(e.message || e); process.exit(1); });
