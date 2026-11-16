// Outbound: leads, import, qualify, campaigns, sequence, launch, limits, unibox, speed to lead, templates, approvals, Ask Timmy, social.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:5173/';
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => m.type() === 'error' && errors.push(m.text()));
  await p.goto(BASE); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(800);
  const state = async () => { await p.waitForTimeout(500); return p.evaluate(() => JSON.parse(localStorage.getItem('timmy-state-v3') || '{}')); };
  const toast = () => p.locator('.toast').last().innerText();
  const tab = async (name) => { await p.click(`[role=tab]:has-text("${name}")`); await p.waitForTimeout(350); };

  /* Leads */
  await p.click('button[aria-label="Outbound"]'); await p.waitForTimeout(500);
  assert(await p.locator('.lead-table tbody tr').count() === 54, 'leads table lists all 54 leads');
  const firstFit = await p.locator('.lead-table tbody tr').first().locator('.fit').innerText();
  assert(/Excellent/.test(firstFit), `best fit first (${firstFit.replace(/\n/g, ' ')})`);
  await p.fill('.lead-search input', 'Dental'); await p.waitForTimeout(200);
  const dental = await p.locator('.lead-table tbody tr').allInnerTexts();
  assert(dental.length > 0 && dental.every(t => /Dental/i.test(t)), `search narrows to dental leads (${dental.length})`);
  await p.fill('.lead-search input', '');

  /* Import */
  await p.click('button:has-text("Import CSV")');
  await p.click('button:has-text("Use a 5-row sample")'); await p.waitForTimeout(200);
  assert(await p.locator('.imp-table select').count() === 10, 'import maps each of the 10 columns');
  assert(await p.locator('.imp-table select').first().inputValue() === 'first', 'First Name column mapped to first name');
  await p.locator('.modal input.input').first().fill('Ops sample import');
  await p.click('.modal-foot button:has-text("Import 5 leads")'); await p.waitForTimeout(400);
  assert(/Imported 5 leads into “Ops sample import”/.test(await toast()), 'import notice');
  assert(await p.locator('.lead-table tbody tr').count() === 5, 'view switches to the new list with 5 leads');
  await p.click('button:has-text("Import CSV")');
  await p.click('button:has-text("Use a 5-row sample")'); await p.waitForTimeout(200);
  assert(/5 duplicates skipped/.test(await p.locator('.modal-foot').innerText()), 'duplicates are detected by email');
  await p.click('.modal-foot button:has-text("Cancel")');

  /* Qualify */
  await p.locator('.lead-table tbody tr').nth(0).locator('input[type=checkbox]').check();
  await p.locator('.lead-table tbody tr').nth(1).locator('input[type=checkbox]').check();
  await p.click('.bulk-bar button:has-text("Qualify with Timmy")'); await p.waitForTimeout(900);
  assert(await p.locator('.lead-table .qual.q-yes, .lead-table .qual.q-maybe, .lead-table .qual.q-no').count() === 2, 'two accounts qualified');
  await p.click('.bulk-bar button:has-text("Clear")');

  /* New campaign from picked leads */
  await p.click('.side-group button:has-text("Ops leaders")'); await p.waitForTimeout(300);
  await p.click('.seg-tab:has-text("Net new")'); await p.waitForTimeout(200);
  for (const i of [0, 1, 2, 3]) await p.locator('.lead-table tbody tr').nth(i).locator('input[type=checkbox]').check();
  const picked = await p.locator('.bulk-bar strong').innerText();
  await p.click('.bulk-bar button:has-text("Add to campaign")');
  await p.click('.menu-item:has-text("New campaign with these leads")'); await p.waitForTimeout(400);
  assert(await p.locator('.modal:has-text("New campaign")').count() === 1, `new campaign dialog opens for ${picked}`);
  await p.locator('.modal input.input').first().fill('Test outreach');
  await p.click('.modal-foot button:has-text("Write the sequence")'); await p.waitForTimeout(500);
  let s = await state();
  const camp = Object.values(s.out.campaigns).find(c => c.name === 'Test outreach');
  assert(camp && camp.steps.length === 5 && camp.steps.some(x => x.channel === 'call'), `Timmy wrote a 5-step sequence with a call (${camp && camp.steps.map(x => x.channel).join(',')})`);
  assert(camp.status === 'draft', 'campaign starts as a draft');
  assert(await p.locator('.seq-step').count() === 5, 'sequence tab shows 5 steps');

  /* Sequence editing */
  await p.click('button:has-text("Preview")'); await p.waitForTimeout(200);
  const prev = await p.locator('.seq-preview').innerText();
  assert(!/\{\{/.test(prev) && /Hi \w+,/.test(prev), 'preview fills every variable for a lead');
  await p.click('button:has-text("Edit")');
  await p.fill('.seq-subject-input', 'FREE trial!!! act now'); await p.waitForTimeout(200);
  const foot = await p.locator('.seq-ed-foot').innerText();
  assert(/Spam-filter words/.test(foot) && /Shouting/.test(foot), 'spam words and shouting are flagged');
  await p.click('button:has-text("Rewrite")'); await p.waitForTimeout(200);
  assert(!/FREE/.test(await p.inputValue('.seq-subject-input')), 'Rewrite replaces the subject from the offer');
  await p.locator('.seq-wait input').first().fill('4'); await p.waitForTimeout(200);
  s = await state();
  assert(Object.values(s.out.campaigns).find(c => c.name === 'Test outreach').steps[1].wait === 4, 'wait before step 2 saved');

  /* Launch */
  await p.click('.camp-title-actions button:has-text("Launch")'); await p.waitForTimeout(300);
  const facts = await p.locator('.launch-facts').innerText();
  assert(/Leads\s+4/.test(facts) && /Daily limit/.test(facts), 'launch dialog summarises leads and limit');
  await p.click('.modal-foot button:has-text("Launch")'); await p.waitForTimeout(300);
  assert(/Launched “Test outreach”/.test(await toast()), 'launch notice');
  s = await state();
  const launched = Object.values(s.out.campaigns).find(c => c.name === 'Test outreach');
  assert(launched.status === 'active' && launched.leads.every(id => s.out.leads[id].status === 'queued'), 'campaign active, leads queued');
  await tab('Analytics');
  assert(await p.locator('.sends-limit').count() === 1, 'analytics shows the daily limit line');

  /* Limits: one-off cold email */
  await p.click('button[aria-label="Outbound"]'); await p.waitForTimeout(300);
  await tab('Leads');
  await p.click('.side-group button:has-text("Ops leaders")'); await p.waitForTimeout(300);
  await p.click('.seg-tab:has-text("Net new")'); await p.waitForTimeout(200);
  const netRow = p.locator('.lead-table tbody tr').first();
  await netRow.locator('.lead-name').click(); await p.waitForTimeout(300);
  assert(await p.locator('.lp-actions button:has-text("Text")').isDisabled(), 'Text is disabled without consent');
  await p.click('.lp-actions button:has-text("Email")'); await p.waitForTimeout(300);
  assert(/Cold emails today/.test(await p.locator('.modal').innerText()), 'email dialog shows the cold limit meter');
  await p.click('.modal-foot button:has-text("Send")'); await p.waitForTimeout(300);
  assert(/of 82 cold emails today/.test(await toast()), `one-off cold email counts toward the limit: ${await toast()}`);
  // Use up the limit, then try again: it queues for tomorrow.
  await p.waitForTimeout(900); // let the app finish saving before editing saved state
  await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('timmy-state-v3')); for (const m of Object.values(s.out.mailboxes)) m.sentToday = 50; localStorage.setItem('timmy-state-v3', JSON.stringify(s)); });
  await p.reload(); await p.waitForTimeout(800);
  await p.click('.side-group button:has-text("Ops leaders")'); await p.waitForTimeout(300);
  await p.click('.seg-tab:has-text("Net new")'); await p.waitForTimeout(200);
  await p.locator('.lead-table tbody tr').first().locator('.lead-name').click(); await p.waitForTimeout(300);
  await p.click('.lp-actions button:has-text("Email")'); await p.waitForTimeout(300);
  assert(/Queue for tomorrow/.test(await p.locator('.modal-foot').innerText()), 'past the limit, Send becomes Queue for tomorrow');
  await p.click('.modal-foot button:has-text("Queue for tomorrow")'); await p.waitForTimeout(300);
  assert(/limit of 82 cold emails is used up, so this one goes out Tue, Nov 17 at 9:00 AM/.test(await toast()), 'queued for tomorrow at 9:00 AM');
  await p.waitForTimeout(900);
  await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('timmy-state-v3')); for (const m of Object.values(s.out.mailboxes)) m.sentToday = 0; localStorage.setItem('timmy-state-v3', JSON.stringify(s)); });
  await p.reload(); await p.waitForTimeout(800);

  /* Unibox */
  await tab('Unibox');
  await p.click('.filter:has-text("Unread")'); await p.waitForTimeout(200);
  await p.locator('.ubx-row:has-text("Jordan Okafor")').click(); await p.waitForTimeout(400);
  s = await state();
  assert(!s.out.leads['lead-2'].unread, 'opening a reply marks it read');
  await p.click('.ubx-compose button:has-text("Offer two times")'); await p.waitForTimeout(150);
  const reply = await p.inputValue('.ubx-input');
  assert(/tomorrow at|Wednesday at|Thursday at|Friday at/.test(reply) && !/\{\{/.test(reply), 'suggested reply offers real free times');
  await p.click('.ubx-compose button:has-text("Send")'); await p.waitForTimeout(300);
  assert(/Sent to Jordan/.test(await toast()) && !/cold emails today/.test(await toast()), 'a reply does not count as cold');
  await p.click('button[aria-label="Book a meeting"]'); await p.waitForTimeout(300);
  await p.locator('.book-time').first().click(); await p.waitForTimeout(300);
  s = await state();
  assert(s.out.leads['lead-2'].status === 'meeting' && Object.values(s.ws.events).some(e => /Intro call: Jordan Okafor/.test(e.title)), 'booking creates the calendar event and marks the meeting');
  await p.click('.filter:has-text("Form leads")'); await p.waitForTimeout(200);
  await p.locator('.ubx-row:has-text("Jamie Ortega")').click(); await p.waitForTimeout(300);
  assert(!(await p.locator('.seg-mini button:has-text("Text")').isDisabled()), 'texting allowed for a lead who opted in');

  /* Speed to lead */
  await tab('Speed to lead');
  assert(/\d+:\d\d/.test(await p.locator('.spd-time').first().innerText()), 'waiting lead shows a live timer');
  const t1 = await p.locator('.spd-time').first().innerText();
  await p.waitForTimeout(1300);
  assert(t1 !== await p.locator('.spd-time').first().innerText(), 'the timer ticks');
  // Auto-replies start off: a new lead waits for you, and shows on Today.
  await p.click('button:has-text("Simulate a form lead")'); await p.waitForTimeout(400);
  assert(/New lead from Website: Book a demo/.test(await toast()) && /Answer within 5 minutes/.test(await toast()), `a new lead waits for your reply with auto-reply off: ${await toast()}`);
  await p.locator('.spd-card, .form-card').filter({ hasText: 'Website: Book a demo' }).locator('input[type=checkbox]').first().check().catch(() => {});
  await p.click('button:has-text("Simulate a form lead")'); await p.waitForTimeout(400);
  assert(/Timmy emailed back in 40 seconds/.test(await toast()), `with auto-reply on, the lead gets an instant reply: ${await toast()}`);
  await p.locator('.spd-card:has-text("Alex Kim") button:has-text("Reply with times")').click(); await p.waitForTimeout(300);
  await p.click('.modal-foot button:has-text("Send")'); await p.waitForTimeout(300);
  s = await state();
  assert(s.out.leads['form-3'].firstReplyAt, 'answering records the first-reply time');
  assert(await p.locator('.spd-card:has-text("Alex Kim")').count() === 0, 'Alex no longer waits after the reply');

  /* Templates & offer */
  await tab('Templates & offer');
  await p.locator('.offer-card input').first().fill('90-day ops pilot');
  await p.click('button:has-text("Save offer")'); await p.waitForTimeout(300);
  s = await state();
  assert(s.out.offer.name === '90-day ops pilot', 'offer saved');

  /* Channels */
  await tab('Channels & limits');
  await p.locator('.ch-card:has-text("LinkedIn") button:has-text("Connect")').click();
  await p.locator('.modal input').fill('linkedin.com/in/taylor-morgan');
  await p.click('.modal-foot button:has-text("Connect")'); await p.waitForTimeout(300);
  s = await state();
  assert(s.out.channels.linkedin.connected, 'LinkedIn connected');
  await p.locator('.mb-row').first().locator('input[type=number]').fill('45'); await p.waitForTimeout(200);
  assert(/look like bulk mail/.test(await p.locator('.mb-row').first().innerText()), 'warns above 30 a day');

  /* Ask Timmy writes a campaign; its first emails are drafts in the sending account, not an approval card */
  await p.keyboard.press('Control+i'); await p.waitForTimeout(200);
  await p.locator('.ai-input').fill('write a campaign for my best leads'); await p.keyboard.press('Enter');
  await p.waitForTimeout(400); await p.waitForFunction(() => !document.querySelector('.ai-send .ai-spin'), null, { timeout: 8000 }); await p.waitForTimeout(300);
  const said = (await p.locator('.ai-msg').allInnerTexts()).pop();
  assert(/saved each first email as a draft in/.test(said) && /nothing goes out until you send it/.test(said), 'Ask Timmy writes the campaign and saves its emails as drafts');
  await p.locator('.ai-shell button:has-text("New chat")').first().click();
  await p.locator('.ai-input').fill("how's my campaign doing?"); await p.keyboard.press('Enter');
  await p.waitForTimeout(400); await p.waitForFunction(() => !document.querySelector('.ai-send .ai-spin'), null, { timeout: 8000 }); await p.waitForTimeout(300);
  assert(/Ops pilot: healthcare & services: \d+ emails/.test((await p.locator('.ai-msg').allInnerTexts()).pop()), 'campaign stats from Ask Timmy');
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  await p.click('button[aria-label="Approvals"]'); await p.waitForTimeout(400);
  assert(await p.locator('.ap-card:has(.ap-title:has-text("best fits"))').count() === 0, 'no approval card for the campaign');
  s = await state();
  const tc = Object.values(s.out.campaigns).find(c => /best fits/.test(c.name));
  const drafts = s.out.messages.filter(m => m.status === 'draft' && m.campaign === tc.id);
  assert(tc.status === 'review' && drafts.length === tc.leads.length && drafts.every(d => d.mailbox && d.subject && !/\{\{/.test(d.body)), 'one filled-in draft per lead, each in a sending account');
  await p.click('button[aria-label="Outbound"]'); await p.waitForTimeout(300);
  await p.locator('.nav-item:has-text("Drafts")').click(); await p.waitForTimeout(300);
  assert(await p.locator('.odr-row').count() === drafts.length, 'the drafts show in Outbound › Drafts');
  await p.click('button:has-text("Send all")'); await p.waitForTimeout(400);
  assert(/Sent \d+ drafts?/.test(await toast()), `sending the drafts confirms it (${await toast()})`);
  s = await state();
  const after = Object.values(s.out.campaigns).find(c => c.id === tc.id);
  const sent = s.out.messages.filter(m => m.campaign === tc.id && m.dir === 'out' && m.status !== 'draft');
  assert(after.status === 'active' && sent.length === drafts.length && !s.out.messages.some(m => m.status === 'draft' && m.campaign === tc.id), 'the drafts go out and the campaign is running');

  /* Social */
  await p.click('button[aria-label="Social (coming soon)"]'); await p.waitForTimeout(300);
  assert(/Coming soon/.test(await p.locator('.soon-banner').innerText()), 'social says coming soon');
  await tab('Create');
  await p.click('.soc-count button:has-text("Write with Timmy")'); await p.waitForTimeout(150);
  assert((await p.inputValue('.soc-text')).length > 40, 'Timmy writes a post');
  await p.click('.soc-btns button:has-text("Schedule")'); await p.waitForTimeout(300);
  assert(/Post scheduled for/.test(await toast()), 'post scheduled');
  s = await state();
  assert(Object.values(s.out.posts).filter(x => x.status === 'scheduled').length === 2, 'two scheduled posts saved');

  /* Saved across reloads */
  await p.reload(); await p.waitForTimeout(800);
  s = await state();
  assert(Object.values(s.out.lists).some(l => l.name === 'Ops sample import'), 'imported list survives a reload');

  assert(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await b.close();
})().catch(e => { console.error(e.message); process.exit(1); });
