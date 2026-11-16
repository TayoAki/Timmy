const { chromium } = require('playwright');
const assert = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('ok -', m); };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => m.type() === 'error' && errors.push(m.text()));
  const state = async () => { await p.waitForTimeout(1100); return p.evaluate(() => JSON.parse(localStorage.getItem('timmy-state-v3'))); };
  const ask = async (q) => {
    const n = await p.locator('.ai-msg.timmy').count();
    await p.locator('.ai-input').fill(q); await p.keyboard.press('Enter');
    await p.waitForFunction((k) => document.querySelectorAll('.ai-msg.timmy').length > k && !document.querySelector('.ai-send .ai-spin'), n, { timeout: 15000 });
    await p.waitForTimeout(300);
  };
  const lastAnswer = () => p.locator('.ai-msg.timmy').last();
  await p.goto('http://localhost:5173/'); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(700);

  await p.keyboard.press('Control+i'); await p.waitForTimeout(300);
  assert(await p.locator('.ai-shell').count() === 1, 'Ctrl+I opens Ask Timmy');
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  assert(await p.locator('.ai-shell').count() === 0, 'Esc closes it');
  await p.click('.ai-launch'); await p.waitForTimeout(300);
  assert(await p.locator('.ai-card').count() === 3, 'welcome shows three suggestion cards');

  await p.click('.ai-card:has-text("Plan my day")');
  await p.waitForFunction(() => !document.querySelector('.ai-send .ai-spin'), null, { timeout: 15000 }); await p.waitForTimeout(300);
  const titles = await lastAnswer().locator('.aw-title').allInnerTexts();
  assert(titles.includes('Needs you today') && titles.includes('Today') && titles.includes('Waiting for your OK'), `plan my day shows urgent, today and approvals widgets (${titles.join(' | ')})`);
  assert(/Worked through 4 steps/.test(await lastAnswer().locator('.ai-steps-toggle').innerText()), 'the work steps fold into one line');
  assert((await lastAnswer().locator('.ai-text').innerText()).length > 40, 'Timmy answers in words too');

  // Act from widgets.
  await lastAnswer().locator('.aw-row', { hasText: 'Dec 1 pilot start' }).getByRole('button', { name: /^Send/ }).click();
  // A list doesn't show the email, so Send shows it first; send from the check.
  await p.waitForTimeout(200);
  await p.locator('[role=dialog] .send-check').waitFor();
  await p.locator('[role=dialog]').last().getByRole('button', { name: /^Send/ }).last().click();
  await p.waitForTimeout(200);
  let s = await state();
  assert(!s.threads.find(t => t.id === 'northwind-date').draft, 'Send in the urgent widget sent the reply');
  await lastAnswer().getByRole('button', { name: 'Approve $58' }).click();
  s = await state();
  assert(s.decisions.find(d => d.id === 'acme-price').chosen?.option === 'approve', 'Approve in the approvals widget made the decision');
  const before = Object.keys(s.ws.events).length;
  await lastAnswer().getByRole('button', { name: 'Block for focus' }).first().click();
  s = await state();
  assert(Object.keys(s.ws.events).length === before + 1, 'Block for focus in the day widget added a focus block');

  await ask('Brief me on the pipeline');
  assert(await lastAnswer().locator('.aw-table tbody tr').count() === 3, 'pipeline widget lists the three deals');

  await ask('Move my morning brief to 7:30');
  await lastAnswer().locator('.aw-choices .btn-primary').click();
  s = await state();
  assert(s.schedule.time === '07:30', `confirming the choice moved the morning run to 7:30 (${s.schedule.time}; ${await lastAnswer().locator('.ai-text').innerText()})`);
  assert(await lastAnswer().locator('.aw-done').count() === 1, 'the choice collapses to a note');

  await ask('Remind me to call Dana tomorrow');
  const tasksBefore = Object.keys(s.ws.tasks).length;
  await lastAnswer().locator('.aw-choices .btn-primary').click();
  s = await state();
  assert(Object.keys(s.ws.tasks).length === tasksBefore + 1, 'confirming added the task');

  // Voice: words with no field focused go to Timmy.
  await p.evaluate(() => window.dispatchEvent(new CustomEvent('timmy:voice', { detail: { text: 'What is urgent?' }, cancelable: true })));
  await p.waitForFunction(() => !document.querySelector('.ai-send .ai-spin'), null, { timeout: 15000 }); await p.waitForTimeout(300);
  assert(await lastAnswer().locator('.aw-title', { hasText: 'Needs you today' }).count() === 1, 'a voice question gets the urgent widget');

  // On a thread: draft a reply.
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  await p.keyboard.press('Control+k'); await p.keyboard.type('Intro to Dana at Acme'); await p.waitForTimeout(300); await p.keyboard.press('Enter'); await p.waitForTimeout(400);
  await p.keyboard.press('Control+i'); await p.waitForTimeout(300);
  await p.click('.ai-new');
  assert(/Intro to Dana/.test(await p.locator('.ai-screen-label').innerText()), 'Timmy knows the open thread');
  await ask('Draft a reply');
  s = await state();
  assert(!!s.threads.find(t => t.id === 'leo-intro').draft, 'Timmy drafted the reply on the open thread (not sent)');
  assert(await lastAnswer().locator('.aw-draft').count() === 1, 'the thread widget shows the draft with Send');

  // Research: makes a doc and opens it (the chat closes when you go somewhere).
  await ask('Research competitor pricing');
  await lastAnswer().locator('.aw-choices .btn-primary').click(); await p.waitForTimeout(500);
  const route = (await state()).route;
  assert(route.view === 'file' && await p.locator('.ai-shell').count() === 0, 'research doc created and opened; the chat closed');

  // History survives a reload.
  await p.reload(); await p.waitForTimeout(600);
  await p.click('.ai-launch'); await p.waitForTimeout(300);
  assert(await p.locator('.ai-convo').count() === 2, 'both conversations are in the history after reload');
  await p.locator('.ai-convo').last().click(); await p.waitForTimeout(300);
  assert(await p.locator('.ai-msg.me').count() >= 5, 'opening one shows its messages');
  console.log('errors', errors);
  await b.close();
  if (errors.length) process.exit(1);
})().catch(e => { console.error(e.message); process.exit(1); });
