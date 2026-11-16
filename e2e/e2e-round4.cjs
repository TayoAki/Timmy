// Round 4: Treg on by default, cold email as drafts in the connected account, the Sent view
// in the Unibox, and two layout fixes (the "agreed to" banner and the form cards).
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:5173/';
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };
const KEY = 'timmy-state-v3';
(async () => {
  const b = await chromium.launch();
  const errors = [];
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  p.on('pageerror', (e) => errors.push(e.message));
  const fresh = async (route) => {
    await p.goto(BASE);
    await p.evaluate(({ KEY, route }) => { localStorage.clear(); if (route) localStorage.setItem(KEY, JSON.stringify({ route })); }, { KEY, route });
    await p.reload();
    await p.waitForTimeout(800);
  };
  const state = async () => { await p.waitForTimeout(600); return p.evaluate((KEY) => JSON.parse(localStorage.getItem(KEY)), KEY); };
  const toast = () => p.locator('.toast').innerText().catch(() => '');
  const ask = async (q) => {
    await p.keyboard.press('Control+i');
    await p.waitForTimeout(300);
    const box = p.locator('.ai-shell textarea, .ai-shell input[type=text]').last();
    await box.fill(q);
    await box.press('Enter');
    let prev = '', out = '';
    for (let i = 0; i < 30; i++) { await p.waitForTimeout(400); out = await p.locator('.ai-shell').innerText(); if (out === prev && i > 3) break; prev = out; }
    return out;
  };
  const card = (name) => p.locator('.conn-card').filter({ has: p.locator('strong', { hasText: new RegExp(`^${name}$`) }) });

  /* Treg is on for every workspace, and picks the source itself */
  await fresh({ view: 'connections' });
  assert(/Connected · Timmy’s Treg account/.test(await card('Treg').innerText()), 'Treg is connected by default with Timmy’s account');
  assert(/Using Treg, which picks the best data source for each lookup/.test(await p.locator('[aria-label="Enrichment"]').innerText()), 'enrichment runs on Treg without any setup');
  let said = await ask('find 5 dental practices in Austin');
  assert(/I added 5 leads/.test(said) && /enriched with Treg/.test(said) && /Nothing was sent/.test(said), 'Ask finds leads and enriches them with Treg, sending nothing');
  await p.keyboard.press('Escape');
  let s = await state();
  assert(Object.values(s.out.leads).filter((l) => l.source === 'found').every((l) => l.enriched?.by === 'Treg'), 'each found lead records Treg as its source');
  await card('Apollo').locator('button:has-text("Connect")').click();
  await p.locator('[role=dialog] button:has-text("Continue")').click();
  await p.waitForTimeout(300);
  assert(/Using Apollo\./.test(await p.locator('[aria-label="Enrichment"]').innerText()), 'a provider you connect yourself takes over from Treg');

  /* Cold email: drafts in the connected account, then the Unibox shows what you sent */
  await fresh();
  said = await ask('write a campaign for my best leads');
  assert(/saved each first email as a draft in/.test(said), 'Timmy saves the campaign’s first emails as drafts');
  await p.keyboard.press('Escape');
  await p.click('button[aria-label="Outbound"]');
  await p.waitForTimeout(300);
  await p.locator('.nav-item:has-text("Drafts")').click();
  await p.waitForTimeout(300);
  const rows = await p.locator('.odr-row').count();
  assert(rows > 0 && /Draft in .+@/.test(await p.locator('.odr-where').first().innerText()), `Drafts lists each one with the account it sends from (${rows})`);
  const first = p.locator('.odr-row').first();
  const who = (await first.locator('.odr-who strong').innerText()).trim();
  await first.locator('button:has-text("Edit")').click();
  await first.locator('textarea').fill('Hi there,\n\nA shorter note I wrote myself.\n\nBest,\nTaylor');
  await first.locator('button:has-text("Save draft")').click();
  await p.waitForTimeout(200);
  assert(/A shorter note I wrote myself/.test(await p.locator('.odr-row').first().innerText()), 'a draft can be edited before it goes out');
  await p.locator('.odr-row').first().locator('button:has-text("Send")').click();
  await p.waitForTimeout(400);
  assert(/Sent 1 draft/.test(await toast()), 'sending one draft confirms it');
  assert(await p.locator('.odr-row').count() === rows - 1, 'the sent draft leaves the list');
  await p.click('button:has-text("Unibox")');
  await p.waitForTimeout(300);
  await p.locator('.filters button:has-text("Sent")').click();
  await p.waitForTimeout(300);
  const row = p.locator('.ubx-row').filter({ hasText: who });
  assert(await row.count() === 1, `the lead you emailed shows under Unibox › Sent (${who})`);
  await row.click();
  await p.waitForTimeout(300);
  assert(/A shorter note I wrote myself/.test(await p.locator('.ubx-msgs').innerText()), 'the conversation shows the email you sent');

  /* Layout: the "agreed to" banner sits above the messages */
  await fresh({ view: 'outbound', tab: 'unibox', id: 'form-1' });
  const yes = await p.locator('.ubx-yes').boundingBox();
  const msgs = await p.locator('.ubx-msgs').boundingBox();
  assert(yes && msgs && yes.height > 30 && yes.y + yes.height <= msgs.y + 1, 'the banner is readable and doesn’t overlap the messages');
  assert(await p.locator('.ubx-yes > span').count() === 1, 'the banner text reads as one line of prose');

  /* Layout: form cards stay inside their columns */
  for (const w of [1280, 1440]) {
    await p.setViewportSize({ width: w, height: 900 });
    await fresh({ view: 'outbound', tab: 'speed' });
    const over = await p.evaluate(() => [...document.querySelectorAll('.form-card')].map((c) => c.scrollWidth - c.clientWidth));
    assert(over.length && over.every((x) => x <= 1), `form cards fit at ${w}px (${over.join(', ')})`);
  }

  assert(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
