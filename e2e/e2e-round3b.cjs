// Round 3, part 2: connections, RevOps approvals, Outlook, lead sources, enrichment and lead finding,
// the call list, delegate mode, client workspaces, mailboxes at scale, import checks, showings.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:5173/';
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };
const KEY = 'timmy-state-v3';
(async () => {
  const b = await chromium.launch();
  const errors = [];
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  p.on('pageerror', (e) => errors.push(e.message));
  const fresh = async (route) => {
    await p.goto(BASE);
    await p.evaluate(({ KEY, route }) => { localStorage.clear(); if (route) localStorage.setItem(KEY, JSON.stringify({ route })); }, { KEY, route });
    await p.reload();
    await p.waitForTimeout(700);
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
  const connect = async (name) => {
    await p.locator('.conn-card').filter({ hasText: name }).locator('button:has-text("Connect")').click();
    await p.waitForTimeout(150);
    await p.locator('[role=dialog] button:has-text("Continue")').click();
    await p.waitForTimeout(250);
  };

  /* Connections */
  await fresh();
  await p.click('button[aria-label="Connections"]');
  await p.waitForTimeout(300);
  assert(/apps connected/.test(await p.locator('.page-sub').first().innerText()), 'Connections opens from the rail');
  assert(await p.locator('.conn-card').count() >= 18, `every app has a card (${await p.locator('.conn-card').count()})`);
  await connect('HubSpot');
  assert(/HubSpot connected/.test(await toast()) && /Morgan Diaz \(RevOps\)/.test(await toast()), 'connecting HubSpot says CRM changes go to RevOps');
  assert(await p.locator('.conn-card[data-connected]').filter({ hasText: 'HubSpot' }).count() === 1, 'HubSpot shows as connected');
  await p.locator('.conn-card').filter({ hasText: 'Outlook' }).locator('button:has-text("Connect")').click();
  await p.locator('[role=dialog] button:has-text("Continue")').click();
  await p.waitForTimeout(200);
  assert(/admin/.test(await toast()) && await p.locator('.conn-card').filter({ hasText: 'Outlook' }).locator('text=Waiting for your admin').count() === 1, 'Outlook waits for the Microsoft admin');
  await p.locator('.conn-card').filter({ hasText: 'Outlook' }).locator('button:has-text("Admin approved")').click();
  await p.waitForTimeout(200);
  assert(await p.locator('.conn-card[data-connected]').filter({ hasText: 'Outlook' }).count() === 1, 'Outlook connects once the admin approves');
  await connect('Zillow');
  await connect('Apollo');
  let s = await state();
  assert(s.out.forms['src-zillow']?.connected, 'Zillow becomes a lead source in Speed to lead');

  /* RevOps approves CRM writes */
  let said = await ask('set Acme to $40,000');
  await p.locator('.ai-shell button:has-text("Update Acme")').click();
  await p.waitForTimeout(400);
  await p.keyboard.press('Escape');
  s = await state();
  assert(s.deals.acme.value !== 40000 && s.conn.held.length === 1 && s.conn.held[0].waitingOn === 'revops', 'the deal change waits for RevOps instead of writing');
  await p.click('button[aria-label="Approvals"]');
  await p.waitForTimeout(300);
  assert(/Waiting on someone else/.test(await p.locator('#ap-held').innerText()), 'Approvals lists what waits on RevOps');
  await p.locator('.held-row button:has-text("Morgan approved")').click();
  s = await state();
  assert(s.deals.acme.value === 40000 && s.conn.held.length === 0, 'once RevOps approves, the deal updates');
  assert(s.approvalLog.some((x) => /approved by Morgan Diaz/.test(x.choice)), 'the log records who approved');

  /* Enrichment and lead finding */
  await p.evaluate(() => {});
  await p.click('button[aria-label="Outbound"]');
  await p.waitForTimeout(300);
  const before = Object.keys(s.out.leads).length;
  await p.click('button:has-text("Find leads")');
  await p.locator('[role=dialog] input').fill('15 dental practices in Austin');
  await p.locator('[role=dialog] button:has-text("Find and add")').click();
  await p.waitForTimeout(300);
  assert(/Timmy added 15 leads/.test(await toast()) && /enriched with Apollo/.test(await toast()), 'Find leads adds 15 enriched leads and sends nothing');
  s = await state();
  const found = Object.values(s.out.leads).filter((l) => l.source === 'found');
  assert(found.length === 15 && found.every((l) => /Dental/.test(l.industry) && l.city === 'Austin, TX' && l.enriched), 'they match the ask and carry enrichment');
  assert(await p.locator('.lead-origin').first().innerText() === ' · Found by Timmy', 'the table marks leads Timmy found');
  said = await ask('find 5 veterinary clinics in Denver');
  assert(/I added 5 leads/.test(said) && /Nothing was sent/.test(said), 'Ask finds and adds leads by itself within the daily limit');
  await p.keyboard.press('Escape');
  s = await state();
  assert(Object.values(s.out.leads).filter((l) => l.source === 'found').length === 20 && s.conn.enrich.credits < 500, 'credits are spent and counted');

  // Enrich existing leads
  await fresh({ view: 'outbound', tab: 'leads' });
  await p.locator('.conn-card').count();
  await p.evaluate((KEY) => { const x = JSON.parse(localStorage.getItem(KEY)); x.conn = x.conn || {}; }, KEY);
  await p.goto(BASE);
  await p.click('button[aria-label="Connections"]'); await p.waitForTimeout(200);
  await connect('Apollo');
  await p.click('button[aria-label="Outbound"]'); await p.waitForTimeout(300);
  const leadsRows = p.locator('tbody tr input[type=checkbox]');
  await leadsRows.nth(0).check(); await leadsRows.nth(1).check();
  await p.locator('.bulk-bar button:has-text("Enrich")').click();
  await p.waitForTimeout(300);
  assert(/Enriched \d leads? with Apollo|already have every field/.test(await toast()), `Enrich fills empty fields (${await toast()})`);

  /* Call list */
  await fresh({ view: 'outbound', tab: 'calls' });
  const calls = await p.locator('.call-row').count();
  assert(calls >= 2 && /Alex Kim/.test(await p.locator('.call-list').innerText()), `the call list has today’s calls (${calls})`);
  await p.click('button:has-text("Start calling")');
  await p.waitForTimeout(200);
  assert(/Call 1 of/.test(await p.locator('[role=dialog]').innerText()), 'Start calling opens the first call');
  await p.locator('[role=dialog] textarea').fill('Wants pricing for two sites');
  await p.locator('[role=dialog] label:has-text("Set a callback") input').check();
  await p.locator('[role=dialog] button:has-text("Asked me to call back")').click();
  await p.waitForTimeout(300);
  assert(/Call 2 of/.test(await p.locator('[role=dialog]').innerText().catch(() => '')), 'logging moves straight to the next call');
  await p.keyboard.press('Escape');
  s = await state();
  const called = Object.values(s.out.leads).find((l) => /two sites/.test(l.notes || ''));
  assert(called && called.callbackAt, 'the notes and the callback are saved');

  /* Delegate mode */
  await fresh({ view: 'connections' });
  await p.click('button[aria-label="Delegate mode"]');
  await p.waitForTimeout(200);
  await p.click('button[aria-label="Today & mail"]');
  await p.waitForTimeout(300);
  assert(/Good morning, Jess/.test(await p.locator('.page-title').first().innerText()) && await p.locator('.delegate-chip:has-text("Working for Taylor Brooks")').count() === 1, 'delegate mode greets the assistant and says who they work for');
  await p.click('button[aria-label="Approvals"]');
  await p.waitForTimeout(300);
  await p.locator('button:has-text("Keep $62")').first().click();
  await p.waitForTimeout(300);
  assert(/Sent to Taylor Brooks for approval/.test(await toast()), 'a decision goes to the exec');
  await p.locator('.held-row button:has-text("Taylor approved")').click();
  s = await state();
  assert(s.decisions.find((d) => d.id === 'acme-price').chosen?.option === 'hold', 'once the exec approves, the decision is made');
  assert(s.approvalLog.some((x) => /approved by Taylor Brooks, asked by Jess Park/.test(x.choice)), 'the log says the exec approved and the assistant asked');

  /* Client workspaces */
  await fresh({ view: 'outbound', tab: 'leads' });
  const own = Object.keys((await state()).out.leads).length;
  await p.click('button:has-text("New client workspace")');
  await p.locator('[role=dialog] input').fill('Acme Dental Group');
  await p.locator('[role=dialog] button:has-text("Create")').click();
  await p.waitForTimeout(300);
  s = await state();
  assert(Object.keys(s.out.leads).length === 0 && Object.keys(s.out.mailboxes).length === 0 && s.clients.names[s.clients.active] === 'Acme Dental Group', 'a client workspace starts with its own empty leads and mailboxes');
  await p.selectOption('select[aria-label="Client workspace"]', 'own');
  s = await state();
  assert(Object.keys(s.out.leads).length === own && s.clients.active === 'own', 'switching back restores your own outbound');

  /* Mailboxes at scale and domain checks */
  await fresh({ view: 'outbound', tab: 'channels' });
  await p.click('button:has-text("Add in bulk")');
  await p.locator('[role=dialog] textarea').fill('alex@trynorthpeak.io, Alex Rivera\nsam@outreach-northpeak.com, Sam Lee\nnot-an-address');
  assert(/2 ready/.test(await p.locator('[role=dialog]').innerText()), 'bulk add validates the list');
  await p.locator('[role=dialog] button:has-text("Add 2 mailboxes")').click();
  await p.waitForTimeout(300);
  s = await state();
  assert(Object.keys(s.out.mailboxes).length === 5, 'both mailboxes are added, warming up');
  assert(await p.locator('.dns-row').count() === 3 && /outreach-northpeak\.com/.test(await p.locator('.dns-list').innerText()), 'each sending domain gets SPF, DKIM and DMARC checks');

  /* Import checks */
  await fresh({ view: 'outbound', tab: 'leads' });
  await p.click('button:has-text("Import CSV")');
  await p.locator('[role=dialog] textarea').first().fill('Name,Email,Company,Employees\n"Doe, Jane",jane@doeco.example,Doe Co,60-80\nJohn Roe,JOHN@roe.example,Roe Inc,12\nJohn Roe,john@roe.example,Roe Inc,12\nBad Row,not-an-email,Bad Co,5');
  await p.waitForTimeout(300);
  const foot = await p.locator('.modal-foot-note').innerText();
  assert(/1 duplicate skipped/.test(foot) && /1 invalid email skipped/.test(foot), `import skips case duplicates and bad emails (${foot})`);
  await p.locator('[role=dialog] button.btn-primary:has-text("Import")').click();
  s = await state();
  const jane = Object.values(s.out.leads).find((l) => l.email === 'jane@doeco.example');
  assert(jane && jane.first === 'Jane' && jane.last === 'Doe' && jane.employees === 60, '“Doe, Jane” splits and 60-80 reads as 60');

  /* Showings */
  await fresh({ view: 'outbound', tab: 'unibox', id: 'form-1' });
  await p.click('button[aria-label="Book a meeting"]');
  await p.locator('[role=dialog] button[role=radio]:has-text("Showing")').click();
  await p.locator('[role=dialog] input[aria-label="Property address"]').fill('14 Maple Street');
  await p.locator('[role=dialog] .book-time').first().click();
  s = await state();
  assert(Object.values(s.ws.events).some((e) => /Showing: Jamie Ortega at 14 Maple Street/.test(e.title)), 'a showing is booked with its address');

  assert(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
