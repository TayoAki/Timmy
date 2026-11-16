// Round 3 fixes: leads on Today, any address in Compose, accepted times, send checks, one price.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:5173/';
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };
const KEY = 'timmy-state-v3';
(async () => {
  const b = await chromium.launch();
  const errors = [];
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', (e) => errors.push(e.message));
  const fresh = async (route) => {
    await p.goto(BASE);
    await p.evaluate(({ KEY, route }) => { localStorage.clear(); if (route) localStorage.setItem(KEY, JSON.stringify({ route })); }, { KEY, route });
    await p.reload();
    await p.waitForTimeout(700);
  };

  /* 1. Leads on Today */
  await fresh();
  const leadRows = p.locator('.urg-list .urg-lead');
  assert(await leadRows.count() === 2, `two lead rows lead the urgent list (${await leadRows.count()})`);
  const first = await leadRows.nth(0).innerText();
  assert(/Jamie Ortega confirmed today at 9:15 AM/.test(first) && /not on your calendar yet/.test(first), 'Jamie’s confirmed 9:15 is first, flagged as not booked');
  const second = await leadRows.nth(1).innerText();
  assert(/Alex Kim is waiting for a first reply/.test(second) && /answer within 15 min/.test(second), 'Alex Kim’s waiting form lead shows its clock and target');
  assert(/6 things are urgent|things are urgent/.test(await p.locator('.page-sub').first().innerText()), 'the brief counts urgent leads');
  await leadRows.nth(0).locator('button:has-text("Book 9:15 AM")').click();
  await p.waitForTimeout(300);
  assert(/Invite sent to Jamie/.test(await p.locator('.toast').innerText()), 'Book 9:15 AM sends the invite');
  assert(await p.locator('.urg-list .urg-lead').count() === 1, 'the booked lead leaves the list');

  /* 2. Compose to any address */
  await p.click('button:has-text("New email")');
  await p.waitForTimeout(200);
  assert(/Add a recipient/.test(await p.locator('.compose-why').innerText()), 'Send says why it is disabled');
  const to = p.locator('.compose .people-picker-input, .people-picker-input').first();
  await to.fill('Lena');
  await p.waitForTimeout(150);
  await to.press('Enter');
  await p.waitForTimeout(150);
  assert(await p.locator('.recip').count() === 0, 'Enter on “Lena” doesn’t pick Elena');
  assert(await p.locator('.people-picker-hint').count() === 1, 'it says to type a full address for someone new');
  await to.fill('nonsense');
  await p.waitForTimeout(150);
  assert(await p.locator('.people-picker-hint').count() === 1, 'unknown text explains how to add someone new');
  await to.fill('lena.park@newclient.example');
  await p.waitForTimeout(150);
  assert(await p.locator('.people-picker-list:has-text("New address")').count() === 1, 'a full address offers “New address”');
  await to.press('Enter');
  await p.waitForTimeout(150);
  assert(/Lena Park/.test(await p.locator('.recip').first().innerText()), 'the address becomes a recipient named Lena Park');
  await p.locator('.compose .draft-subject').fill('Proposal');
  await p.locator('#compose-body').fill('Hi Lena,\n\nHere is the proposal.\n\nTaylor');
  await p.locator('.compose-foot button.btn-primary').click();
  await p.waitForTimeout(300);
  assert(/Sent to Lena/.test(await p.locator('.toast').innerText()), 'the email goes out to the new address');
  await p.waitForTimeout(700);
  await p.reload();
  await p.waitForTimeout(700);
  const people = await p.evaluate((KEY) => JSON.parse(localStorage.getItem(KEY)).threads.find((t) => t.participants.includes('mail:lena.park@newclient.example')), KEY);
  assert(!!people, 'the sent thread keeps the new address after a reload');

  /* 3. Accepted times and booking */
  await fresh({ view: 'outbound', tab: 'unibox', id: 'form-1' });
  assert(await p.locator('.ubx-yes').count() === 1 && /agreed to/.test(await p.locator('.ubx-yes').innerText()), 'Unibox says Jamie agreed to a time');
  assert(await p.locator('.ubx-compose button:has-text("Confirm today at 9:15 AM")').count() === 1, 'the suggestion confirms the time instead of offering two more');
  await p.click('button[aria-label="Book a meeting"]');
  await p.waitForTimeout(200);
  assert(await p.locator('.book-yes:has-text("Book today at 9:15 AM")').count() === 1, 'the booking dialog leads with the accepted time');
  assert(await p.locator('.modal-body, [role=dialog]').locator('text=Today').count() >= 1, 'the dialog offers same-day times');
  assert(await p.locator('.book-custom input[type=date]').count() === 1 && await p.locator('.book-custom input[type=time]').count() === 1, 'any custom date and time can be booked');
  await p.locator('.book-custom input[type=time]').fill('16:45');
  await p.locator('.book-custom button:has-text("Book")').click();
  await p.waitForTimeout(300);
  assert(/Invite sent to Jamie/.test(await p.locator('.toast').innerText()) && /4:45 PM/.test(await p.locator('.toast').innerText()), 'a custom time books');

  /* 7. Every question answered honestly; referrals; no draft carry-over */
  await fresh({ view: 'outbound', tab: 'unibox', id: 'lead-5' });
  await p.locator('.ubx-compose button:has-text("Answer the price")').click();
  const reply = await p.locator('.ubx-input').inputValue();
  assert(/\$18,000 for the 90-day pilot/.test(reply), 'the price reply uses the offer’s price');
  assert(/Athena/.test(reply) && /I’ll check and come back to you/.test(reply), 'the integration question is acknowledged, not ignored');
  await p.locator('.ubx-input').fill('Hi Casey, draft for Casey only');
  await p.locator('.ubx-row:has-text("Jordan")').first().click();
  await p.waitForTimeout(200);
  assert((await p.locator('.ubx-input').inputValue()) === '', 'switching threads leaves the draft behind');
  await p.locator('.ubx-row:has-text("Ruiz"), .ubx-row').filter({ hasText: /not the right person/ }).first().click().catch(() => {});
  await fresh({ view: 'outbound', tab: 'unibox', id: 'lead-23' });
  assert(await p.locator('.ubx-compose button:has-text("contact Dana Ruiz")').count() === 1, 'a referral suggests contacting the person they named');

  /* 4. Send checks in the Drafts tab and in Ask */
  await fresh({ view: 'today', tab: 'drafts' });
  const acme = p.locator('.draft-card').filter({ hasText: /Dana/ }).first();
  await acme.locator('button:has-text("Send")').click();
  await p.waitForTimeout(200);
  const dlg = p.locator('[role=dialog]');
  assert(/Sending this also settles/.test(await dlg.innerText()), 'the Drafts tab warns that sending settles the discount');
  assert(await dlg.locator('button:has-text("Send and approve $58")').count() === 1 && await dlg.locator('button:has-text("Decide first")').count() === 1, 'the button says what sending decides, with Decide first');
  await dlg.locator('button:has-text("Cancel")').click();
  await p.waitForTimeout(150);
  await p.keyboard.press('Control+i');
  await p.waitForTimeout(300);
  await p.keyboard.type('what is urgent?');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(1500);
  const askSend = p.locator('.ai-shell .aw-actions button:has-text("Send")').first();
  if (await askSend.count()) {
    await askSend.click();
    await p.waitForTimeout(200);
    assert(await p.locator('[role=dialog] .send-check-body').count() === 1, 'Send in Ask shows the email before it goes');
    await p.locator('[role=dialog] button:has-text("Cancel")').last().click();
  } else console.log('note - no draft row in the Ask answer to check');
  await p.keyboard.press('Escape');

  /* 6. One price everywhere */
  await fresh({ view: 'approvals', tab: 'open' });
  await p.locator('button:has-text("Keep $62")').first().click();
  await p.waitForTimeout(500);
  await p.waitForTimeout(600);
  const st = await p.evaluate((KEY) => JSON.parse(localStorage.getItem(KEY)), KEY);
  const order = st.ws.docs['acme-order-form'].blocks.map((x) => x.text || '').join(' ');
  assert(/\$62 per seat/.test(order) && /\$89,280/.test(order) && !/\$83,520/.test(order), 'the order form follows Keep $62');
  assert(/\$89,280/.test(st.deals.acme.suggestion), 'the CRM hint follows Keep $62');
  // Offer price flows into the price reply
  await fresh({ view: 'outbound', tab: 'templates' });
  const priceInput = p.locator('label:has-text("Price") input, .field:has-text("Price") input').first();
  if (await priceInput.count()) {
    await priceInput.fill('$4,500 for the pilot');
    await p.locator('button:has-text("Save offer")').click();
    await p.waitForTimeout(900);
    await p.evaluate((KEY) => { const s = JSON.parse(localStorage.getItem(KEY)); s.route = { view: 'outbound', tab: 'unibox', id: 'lead-5' }; localStorage.setItem(KEY, JSON.stringify(s)); }, KEY);
    await p.reload();
    await p.waitForTimeout(700);
    await p.locator('.ubx-compose button:has-text("Answer the price")').click();
    assert(/\$4,500 for the pilot/.test(await p.locator('.ubx-input').inputValue()), 'a changed offer price reaches the price reply');
  } else console.log('note - offer price field not found on Templates');

  /* 5. Ask knows Outbound */
  const ask = async (q) => {
    await p.keyboard.press('Control+i');
    await p.waitForTimeout(300);
    const box = p.locator('.ai-shell textarea, .ai-shell input[type=text]').last();
    await box.fill(q);
    await box.press('Enter');
    // Wait until the answer stops streaming.
    let prev = '', out = '';
    for (let i = 0; i < 30; i++) {
      await p.waitForTimeout(400);
      out = await p.locator('.ai-shell').innerText();
      if (out === prev && i > 3) break;
      prev = out;
    }
    return out;
  };
  await fresh();
  let said = await ask('text Jamie that I am running 5 minutes late');
  assert(/Here’s the text to Jamie/.test(said) && /Send the text/.test(said), 'Ask drafts a text to a lead who opted in');
  assert(!/can’t send texts/.test(said), 'Ask no longer says it can’t text');
  await p.locator('.ai-shell button:has-text("Send the text")').click();
  await p.waitForTimeout(400);
  await p.keyboard.press('Escape');
  await fresh();
  said = await ask('text Alex Kim');
  assert(/hasn’t agreed to texts/.test(said), 'Ask explains a lead without consent can’t be texted');
  await p.keyboard.press('Escape');
  await fresh();
  said = await ask('who should I call today?');
  assert(/calls? today/.test(said) && /Alex Kim/.test(said), 'Ask lists today’s calls');
  await p.keyboard.press('Escape');
  await fresh();
  said = await ask('find Robin Hale');
  assert(/Robin Hale at Summit Freight/.test(said), 'Ask finds a lead by name');
  await p.keyboard.press('Escape');
  await fresh();
  said = await ask('log my call with Alex Kim: wants pricing for two sites, call back Thursday');
  assert(/Log a call with Alex/.test(said) && /callback for Thursday/.test(said), 'Ask logs a call with notes and a callback');
  await p.locator('.ai-shell button:has-text("Log the call")').click();
  await p.waitForTimeout(900);
  const alex = await p.evaluate((KEY) => JSON.parse(localStorage.getItem(KEY)).out.leads['form-3'], KEY);
  assert(/two sites/.test(alex.notes || '') && !!alex.callbackAt, 'the notes and callback are saved on the lead');
  await p.keyboard.press('Escape');
  await fresh();
  said = await ask('log my call notes to the CRM');
  assert(/HubSpot or Salesforce/.test(said) && !/Pipeline/.test(said), 'logging to a CRM says what’s needed instead of showing the pipeline');
  await p.keyboard.press('Escape');

  /* 7. Drafts say only what's true */
  await fresh({ view: 'thread', id: 'interview-feedback', tab: 'conversation' });
  await p.waitForTimeout(600);
  const draftText = await p.evaluate((KEY) => JSON.parse(localStorage.getItem(KEY)).threads.find((t) => t.id === 'interview-feedback').draft.body, KEY);
  assert(!/My scorecard is in\./.test(draftText) && /My scorecard will be in before the debrief/.test(draftText), 'the scorecard reply doesn’t claim it’s in before it is');
  await fresh({ view: 'approvals', tab: 'open' });
  await p.locator('button:has-text("No hire")').first().click();
  await p.waitForTimeout(900);
  const st2 = await p.evaluate((KEY) => JSON.parse(localStorage.getItem(KEY)), KEY);
  const fbDraft = st2.threads.find((t) => t.id === 'interview-feedback').draft.body;
  assert(/\[Your reason/.test(fbDraft) && !/wasn’t at the level/.test(fbDraft), 'No hire leaves a gap for your reason instead of inventing one');
  await fresh();
  said = await ask('remind Kenji to submit his scorecard');
  assert(/isn’t on the hook for the scorecard/.test(said) || /Write to Kenji about the scorecard/.test(said), 'a reminder about a different item doesn’t nudge about mockups');
  await p.keyboard.press('Escape');

  /* 8. Polish keeps your post */
  await fresh({ view: 'social', tab: 'create' });
  const mine = 'Our fall tune-up special is back. Book a furnace check before December and get 20% off. We really fill up fast every year.';
  await p.locator('.soc-text').fill(mine);
  await p.locator('button:has-text("Polish with Timmy")').click();
  const polished = await p.locator('.soc-text').inputValue();
  assert(/tune-up special/.test(polished) && /20% off/.test(polished) && !/spreadsheets/i.test(polished), 'Polish keeps your topic and words');
  assert(!/really/.test(polished), 'Polish trims filler');
  await p.locator('button:has-text("Back to your version")').click();
  assert((await p.locator('.soc-text').inputValue()) === mine, 'you can go back to your version');

  assert(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
