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
  await p.waitForTimeout(600);
  const state = () => p.evaluate(() => JSON.parse(localStorage.getItem('timmy-state-v3') || '{}'));
  const bar = () => p.locator('.bar').innerText();

  // Urgent list
  const urgentRows = await p.locator('.urg-list .urg-row').count();
  assert(urgentRows === 4 + await p.locator('.urg-list .urg-lead').count(), `brief lists 4 urgent threads after the urgent leads (got ${urgentRows})`);
  const brief = await p.locator('.ap-rows .ap-row-sub').allInnerTexts();
  assert(/^Decision/.test(brief[0]) && /^Decision/.test(brief[1]), `brief approvals lead with decisions: ${brief.slice(0,2).join(' | ')}`);

  // Time picker on the brief: keyboard
  await p.click('.run-control .tp-trigger');
  await p.keyboard.press('ArrowDown');
  await p.keyboard.press('ArrowDown');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(200);
  assert((await p.locator('.run-control .tp-value').innerText()) === '8:30 AM', 'keyboard picks 8:30 AM');
  assert(/next today at 8:30 AM/.test(await bar()), 'status bar shows next run today 8:30');
  await p.click('.run-control .tp-trigger');
  await p.getByRole('option', { name: '9:00 AM', exact: true }).click();
  await p.waitForTimeout(200);
  assert(/next today at 9:00 AM/.test(await bar()), 'a 9:00 AM run is still ahead today');

  // Everything mode
  await p.click('.urgent-head [role=radio]:has-text("Everything")');
  assert((await p.locator('.urg-list .urg-row:not(.urg-lead)').count()) === 16, 'everything mode lists all 16 open threads, after the urgent leads');
  await p.click('.urgent-head [role=radio]:has-text("Urgent")');

  // Approvals page
  await p.click('button[aria-label="Approvals"]');
  await p.waitForTimeout(650);
  const total0 = await p.locator('.ap-card').count();
  assert(total0 === 11, `11 approvals waiting (got ${total0})`);

  // Decide Acme price: keep $62 → draft rewritten
  const acme = p.locator('.ap-card', { hasText: 'Give Acme $58 per seat' });
  await acme.locator('button:has-text("Keep $62")').click();
  await p.waitForTimeout(650);
  let s = await state();
  const acmeDraft = s.threads.find(t => t.id === 'acme-quote').draft.body;
  assert(/\$62 per seat per month, billed annually: \$89,280/.test(acmeDraft) && !/\$4 less/.test(acmeDraft), 'Keep $62 rewrote the Acme draft');
  const notes = s.ws.docs['acme-running-notes'].blocks.find(x => x.type === 'table').rows[0];
  assert(/Kept \$62/.test(notes[1]), 'decision recorded in Acme running notes');

  // Undo from toast restores
  await p.click('.toast button:has-text("Undo")');
  await p.waitForTimeout(700);
  s = await state();
  assert(/\$58 per seat/.test(s.threads.find(t => t.id === 'acme-quote').draft.body), 'Undo restores the $58 draft');
  assert(!s.decisions.find(d => d.id === 'acme-price').chosen, 'Undo reopens the decision');

  // Approve $58
  await p.locator('.ap-card', { hasText: 'Give Acme $58 per seat' }).locator('button:has-text("Approve $58")').click();
  await p.waitForTimeout(200);

  // Leo: offer after renewal → new draft appears in queue, task added
  await p.locator('.ap-card', { hasText: 'Introduce Leo Grant' }).locator('button:has-text("Offer it after the renewal")').click();
  await p.waitForTimeout(650);
  s = await state();
  const leo = s.threads.find(t => t.id === 'leo-intro');
  assert(leo.box === 'follow-up' && leo.draft && /Happy to/.test(leo.draft.body), 'Leo thread moved to Follow Up with a draft');
  assert(!!s.ws.tasks['task-leo-intro'], 'Dec 1 intro task created');
  assert(await p.locator('.ap-card', { hasText: 'Re: Intro to Dana at Acme?' }).count() === 1, 'the new Leo draft waits for approval');

  // Kickoff invite
  await p.locator('.ap-card', { hasText: 'kickoff invite' }).locator('button:has-text("Send invite")').click();
  await p.waitForTimeout(650);
  s = await state();
  assert(!!s.ws.events['ev-northwind-kickoff'] && s.ws.tasks['t-kickoff'].status === 'done', 'kickoff event added and task done');

  // Brightwave CRM
  await p.locator('.ap-card', { hasText: 'Move Brightwave to Closed won' }).locator('button:has-text("Update deal")').click();
  await p.waitForTimeout(650);
  s = await state();
  assert(s.deals.brightwave.stage === 'Closed won', 'Brightwave moved to Closed won');

  // Send the Acme email → Acme CRM update appears with $83,520
  await p.locator('.ap-card', { hasText: 'Approval by Fri: revised quote' }).locator('button:has-text("Send & track")').click();
  await p.waitForTimeout(650);
  assert(await p.locator('.ap-card', { hasText: 'Update Acme to $83,520' }).count() === 1, 'Acme CRM update appears after the quote is sent');
  s = await state();
  assert(s.threads.find(t => t.id === 'acme-quote').box === 'waiting', 'Acme thread is in Waiting');

  // Discard a draft
  await p.locator('.ap-card', { hasText: 'October expense report' }).locator('button:has-text("Discard")').click();
  await p.waitForTimeout(650);

  // History
  await p.click('[role=tab]:has-text("Decided"), button:has-text("Decided") >> nth=0');
  await p.waitForTimeout(650);
  const hist = await p.locator('.ap-history .log-item').count();
  assert(hist === 6, `Decided lists 6 items (got ${hist})`);

  // Thread view: urgency line + override
  await p.evaluate(() => {});
  await p.click('button[aria-label="Today & mail"]');
  await p.waitForTimeout(200);
  await p.locator('.urg-row', { hasText: 'Jordan Kim' }).locator('button:has-text("Review draft")').click();
  await p.waitForTimeout(650);
  assert(await p.locator('.urg-line .urg-urgent').count() === 1, 'thread shows Urgent with reasons');
  assert(await p.locator('.thread-decisions .ap-card', { hasText: 'Jordan Kim' }).count() === 1, 'thread shows the hiring decision inline');
  await p.locator('.thread-decisions button:has-text("Strong hire")').click();
  await p.waitForTimeout(650);
  s = await state();
  assert(/strong hire\. Excellent/.test(s.threads.find(t => t.id === 'interview-feedback').draft.body), 'hiring decision rewrote the reply to Sofia');
  await p.click('.urg-line button[aria-label="Change urgency"]');
  await p.click('.menu-item:has-text("Mark as can wait")');
  await p.waitForTimeout(200);
  assert(await p.locator('.urg-line .urg-later').count() === 1, 'override marks the thread as can wait');

  // Urgency rule off changes reasons
  await p.click('button[aria-label="Rules & settings"]');
  await p.click('.side .nav-item:has-text("Urgency")');
  await p.waitForTimeout(200);
  await p.locator('.rule', { hasText: 'priority contacts' }).locator('.switch').click();
  await p.click('button[aria-label="Today & mail"]');
  await p.waitForTimeout(200);
  const reasons = await p.locator('.urg-list').innerText();
  assert(!/priority contact/.test(reasons), 'turning off the priority rule removes that reason');

  // Schedule: days off → paused
  await p.click('button[aria-label="Rules & settings"]');
  await p.click('.side .nav-item:has-text("Schedule")');
  for (const d of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) await p.click(`.day-btn[aria-label="${d}"]`);
  await p.waitForTimeout(200);
  assert(/morning run paused/.test(await bar()), 'no days selected pauses the run');
  await p.click('.day-btn[aria-label="Saturday"]');
  await p.waitForTimeout(200);
  assert(/next Saturday at 9:00 AM/.test(await bar()), 'Saturday only: next run Saturday 9:00');
  const ruleText = await p.locator('.rule', { hasText: 'morning brief' }).innerText();
  assert(/on Sat at 9:00 AM/.test(ruleText), `schedule rule text follows the picker: ${ruleText.split('\n')[0]}`);

  // Persistence
  await p.waitForTimeout(600);
  await p.reload();
  await p.waitForTimeout(600);
  assert(/next Saturday at 9:00 AM/.test(await bar()), 'schedule survives reload');
  s = await state();
  assert(s.approvalLog.length >= 7, 'approval history survives reload');

  console.log('errors', errors);
  await b.close();
  if (errors.length) process.exit(1);
})().catch(e => { console.error(e.message); process.exit(1); });
