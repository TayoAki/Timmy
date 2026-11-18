// Fixes 2, 4, 5, 6 from the 1,000-user simulation.
const { chromium } = require('playwright');
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => m.type() === 'error' && errors.push(m.text()));
  await p.goto((process.env.BASE || 'http://localhost:5173/'));
  await p.evaluate(() => localStorage.clear());
  await p.reload();
  await p.waitForTimeout(700);
  const state = async () => { await p.waitForTimeout(500); return p.evaluate(() => JSON.parse(localStorage.getItem('timmy-state-v3') || '{}')); };
  const toast = () => p.locator('.toast').last().innerText();
  const go = async (label) => { await p.click(`button[aria-label="${label}"]`); await p.waitForTimeout(500); };

  /* ── #6 Triage never changes a deal ── */
  await p.click('[role=tab]:has-text("Triage")');
  await p.waitForTimeout(300);
  await p.click('button:has-text("Timmy is sure about")');
  await p.waitForTimeout(300);
  const t6 = await toast();
  assert(/Moving Brightwave to Closed won is waiting for your OK in Approvals/.test(t6), `bulk triage notice names the held CRM change: "${t6}"`);
  let s = await state();
  assert(s.deals.brightwave.stage === 'Contract sent', 'Brightwave stays at Contract sent after bulk triage');
  await go('Approvals');
  assert(await p.locator(`.ap-card:has(.ap-title:has-text("Move Brightwave to Closed won"))`).count() === 1, 'the Brightwave CRM change is waiting in Approvals');

  /* ── #4 Duplicate asks: notes on both cards ── */
  const reply = p.locator(`.ap-card:has(.ap-title:has-text("Re: Quick one"))`);
  const nudge = p.locator(`.ap-card:has(.ap-title:has-text("Signed SOW by Wed?"))`);
  assert(/drops the separate nudge/.test(await reply.innerText()), 'reply card says sending it drops the separate nudge');
  assert(/asks Marcus for the same thing/.test(await nudge.innerText()), 'nudge card warns the reply asks the same thing');
  const quote = p.locator(`.ap-card:has(.ap-title:has-text("Approval by Fri: revised quote"))`);
  assert(/also settles “Give Acme \$58 per seat at 120 seats\?” as Approve \$58/.test(await quote.innerText()), 'quote email says it settles the $58 decision');

  // Send the reply: nudge dropped, Marcus's promise reset to Wed, CRM no longer overdue, kickoff step not ticked.
  await reply.locator('button:has-text("Send")').click();
  await p.waitForTimeout(300);
  const t4 = await toast();
  assert(/dropped the separate nudge to Marcus/.test(t4), `send notice: "${t4}"`);
  s = await state();
  const sow = s.threads.find(t => t.id === 'northwind-sow');
  assert(!sow.draft, 'Marcus nudge is gone');
  assert(sow.waiting.due.startsWith('2026-11-18'), `Marcus now owes the SOW by Wed (${sow.waiting.due})`);
  assert(s.deals.northwind.due.startsWith('2026-11-18'), 'Northwind deal due moved to Wed (not overdue)');
  assert(s.ws.contacts.marcus.due.startsWith('2026-11-18'), 'Marcus contact due moved to Wed');
  const nd = s.threads.find(t => t.id === 'northwind-date');
  assert(nd.steps.find(x => x.id === 's1').done && !nd.steps.find(x => x.id === 's2').done, 'reply step ticked, kickoff invite step not');
  assert(s.approvalLog.some(r => r.choice === 'Not needed: your reply asked'), 'dropped nudge is logged in Decided');
  assert(await p.locator(`.ap-card:has(.ap-title:has-text("Signed SOW by Wed?"))`).count() === 0, 'nudge card left the queue');

  /* ── #4 Settled by sending: the $58 email logs the decision ── */
  await p.locator(`.ap-card:has(.ap-title:has-text("Approval by Fri: revised quote")) button:has-text("Send & track")`).click();
  await p.waitForTimeout(300);
  const tq = await toast();
  assert(/Logged your call: Approve \$58/.test(tq), `quote send notice logs the call: "${tq}"`);
  s = await state();
  assert(s.decisions.find(d => d.id === 'acme-price').chosen.option === 'approve', 'price decision recorded as Approve $58');
  assert(s.approvalLog.some(r => r.choice === 'Approve $58, by sending the email'), 'Decided lists Approve $58, by sending the email');
  /* ── #2 CRM follows the send ── */
  assert(s.deals.acme.next === 'CFO approval on the 120-seat quote' && s.deals.acme.owner === 'dana', `Acme next step is Dana's CFO approval (${s.deals.acme.next})`);
  assert(/^Nov 16 · You sent/.test(s.deals.acme.lastTouch), `Acme last touch updated (${s.deals.acme.lastTouch})`);
  assert(s.ws.tasks['t-acme-quote'].status === 'done', 'Revise Acme quote task is done');
  assert(s.ws.contacts.dana.next === 'CFO approval on the 120-seat quote', 'Dana contact next step updated');
  // Update the deal from Approvals: the thread's "Update deal value" action ticks.
  await p.locator(`.ap-card:has(.ap-title:has-text("Update Acme")) button:has-text("Update deal")`).click();
  await p.waitForTimeout(200);
  s = await state();
  assert(s.threads.find(t => t.id === 'acme-quote').steps.find(x => x.id === 's5').done, '"Update deal value" next action ticked after the CRM update');
  assert(s.deals.acme.value === 83520, 'Acme at $83,520');

  /* ── #2 Keep $62 carries into deck, tracker and next action (fresh state) ── */
  await p.evaluate(() => localStorage.clear());
  await p.reload();
  await p.waitForTimeout(700);
  await go('Approvals');
  await p.locator(`.ap-card:has(.ap-title:has-text("Give Acme $58")) button:has-text("Keep $62")`).click();
  await p.waitForTimeout(300);
  s = await state();
  const deck = s.ws.decks['proposal-v4'];
  assert(deck.slides.find(x => x.id === 's3').title === 'Pricing: 120 seats at $62', 'deck pricing slide says $62');
  assert(!JSON.stringify(deck).includes('$4 less per seat'), 'deck no longer claims $4 less per seat');
  assert(s.ws.sheets['acme-quote'].rows[1].price === 62, 'quote tracker revised price is 62');
  assert(s.threads.find(t => t.id === 'acme-quote').steps.find(x => x.id === 's5').text === 'Update deal value to $89,280', 'next action reads $89,280');
  assert(!/now has a per-seat price/.test(await p.locator(`.ap-card:has(.ap-title:has-text("revised quote"))`).first().innerText()), 'no stale warning after Keep $62');

  /* ── #2 Source changed: edit the tracker, the draft is flagged ── */
  await p.evaluate(() => localStorage.clear());
  await p.reload();
  await p.waitForTimeout(700);
  await p.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('timmy-state-v3'));
    s.ws.sheets['acme-quote'].rows[1].price = 60;
    localStorage.setItem('timmy-state-v3', JSON.stringify(s));
  });
  await p.reload();
  await p.waitForTimeout(700);
  await go('Approvals');
  const qc = await p.locator(`.ap-card:has(.ap-title:has-text("Approval by Fri: revised quote"))`).innerText();
  assert(/quote tracker now has a per-seat price of \$60, but this email doesn’t/.test(qc), 'quote email flagged after the tracker changed');
  const dc = await p.locator(`.ap-card:has(.ap-title:has-text("Give Acme $58"))`).innerText();
  assert(/worked out before the change/.test(dc), 'price decision flagged too');

  /* ── #4 Nudge first: the reply is trimmed ── */
  await p.evaluate(() => localStorage.clear());
  await p.reload();
  await p.waitForTimeout(700);
  await go('Approvals');
  await p.locator(`.ap-card:has(.ap-title:has-text("Signed SOW by Wed?")) button:has-text("Send & track")`).click();
  await p.waitForTimeout(300);
  s = await state();
  const body = s.threads.find(t => t.id === 'northwind-date').draft.body;
  assert(!/Could you send it by Wednesday/.test(body) && /as soon as the signed SOW is back/.test(body), 'reply no longer asks for the SOW again');
  assert(/took the repeat ask out/.test(await toast()), 'notice says the repeat ask was taken out');

  /* ── #5 Ctrl+I returns to the box; letters don't fire shortcuts ── */
  await p.evaluate(() => localStorage.clear());
  await p.reload();
  await p.waitForTimeout(700);
  // The first email row (lead rows can rank above it on Today).
  await p.locator('.urg-list .urg-row:not(.urg-lead) .urg-row-title').first().click();
  await p.waitForTimeout(300);
  const opened = (await state()).route;
  assert(opened.view === 'thread', `a mail row opens its thread (view ${opened.view})`);
  const threadId = opened.id;
  await p.keyboard.press('Control+i');
  await p.waitForTimeout(200);
  await p.keyboard.type("what's urgent?");
  await p.keyboard.press('Enter');
  await p.waitForTimeout(2500);
  // Click somewhere neutral in the chat, then type: letters go to the box.
  await p.click('.ai-head-title');
  await p.keyboard.type('fwres');
  await p.waitForTimeout(200);
  assert((await p.locator('.ai-input').inputValue()) === 'fwres', 'typed letters land in the Ask box');
  s = await state();
  const th = s.threads.find(t => t.id === threadId);
  assert(th.box !== 'archived' && th.box !== 'waiting' && th.box !== 'read-through', `open thread was not moved (box ${th.box})`);
  assert(!(await p.locator('.compose').count()), 'compose did not open');
  await p.locator('.ai-input').fill('');
  await p.click('.ai-head-title');
  await p.keyboard.press('Control+i');
  await p.waitForTimeout(100);
  assert(await p.locator('.ai-shell').count() === 1, 'Ctrl+I with focus elsewhere keeps the chat open');
  assert(await p.evaluate(() => document.activeElement?.classList.contains('ai-input')), 'Ctrl+I put the cursor back in the box');
  await p.keyboard.press('Control+i');
  await p.waitForTimeout(100);
  assert(await p.locator('.ai-shell').count() === 0, 'Ctrl+I from the box closes the chat');

  assert(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await b.close();
})().catch(e => { console.error(e.message); process.exit(1); });
