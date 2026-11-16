const { chromium } = require('playwright');
const assert = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('ok -', m); };
(async () => {
  const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  const state = async () => { await p.waitForTimeout(650); return p.evaluate(() => JSON.parse(localStorage.getItem('timmy-state-v3'))); };
  const open = async (subject) => {
    await p.keyboard.press('Escape').catch(() => {});
    await p.keyboard.press('Control+k'); await p.keyboard.type(subject); await p.waitForTimeout(300); await p.keyboard.press('Enter'); await p.waitForTimeout(500);
  };
  const step = (text) => p.locator('.right .step-row', { hasText: text });
  await p.goto((process.env.BASE || 'http://localhost:5173/')); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(700);

  await open('Revised quote for 120 seats');
  assert(await step('Send reply and track').locator('.step-verb').innerText() === 'Send & track', 'send step shows "Send & track"');
  // Checkbox ticks without doing anything.
  await step('Check proposal v4').locator('.step-check').click();
  let s = await state();
  assert(s.threads.find(t => t.id === 'acme-quote').steps.find(x => x.id === 's3').done && s.threads.find(t => t.id === 'acme-quote').box === 'follow-up', 'checkbox only ticks the step');
  await step('Send reply and track').locator('.step-main').click();
  s = await state();
  let t = s.threads.find(t => t.id === 'acme-quote');
  assert(t.box === 'waiting' && !t.draft && t.steps.find(x => x.id === 's4').done, 'clicking "Send reply" sent it and tracked it in Waiting');
  await step('Update deal value').locator('.step-main').click();
  s = await state();
  assert(s.deals.acme.stage === 'Proposal sent' && s.deals.acme.value === 83520, 'clicking "Update deal value" updated the CRM');
  assert(s.threads.find(t => t.id === 'acme-quote').steps.find(x => x.id === 's5').done, '…and ticked the step');
  await step('Update the quote tracker').locator('.step-main').click(); await p.waitForTimeout(400);
  assert(await p.locator('.doc-title-input').inputValue() === '2026-Q4 Acme — Quote tracker', 'a step with a link opens it');

  await open('still good for a Dec 1 pilot');
  await step('kickoff invite').locator('.step-main').click();
  s = await state();
  assert(!!s.ws.events['ev-northwind-kickoff'] && s.decisions.find(d => d.id === 'northwind-kickoff').chosen, 'kickoff step sent the invite (and resolved the approval)');

  await open('QBR deck: can you own');
  await step('Block 2 hours').locator('.step-main').click();
  s = await state();
  const ev = Object.values(s.ws.events).find(e => e.thread === 'qbr-slides' && e.kind === 'focus');
  assert(!!ev && new Date(ev.start).getDay() === 4 && new Date(ev.end) - new Date(ev.start) === 2 * 3600e3, 'block step put a 2-hour focus block on Thursday');
  await step('Reply to confirm').locator('.step-main').click();
  s = await state();
  assert(s.threads.find(t => t.id === 'qbr-slides').box !== 'follow-up' || !s.threads.find(t => t.id === 'qbr-slides').draft, 'reply step sent the confirmation');

  await open('Feedback for Jordan Kim');
  await step('Paste Timmy').locator('.step-main').click();
  s = await state();
  assert(s.decisions.find(d => d.id === 'jordan-hire').chosen?.option === 'hire' && s.ws.tasks['t-scorecard'].status === 'done', 'scorecard step filled it in');

  // Full screen: Timmy editor and the full editor.
  await open('Acme Renewal — Running notes');
  await p.locator('.main').click({ position: { x: 600, y: 60 } });
  await p.keyboard.press('Control+Backslash'); await p.waitForTimeout(400);
  const fsNative = await p.evaluate(() => ({ el: document.fullscreenElement?.className ?? '', cls: !!document.querySelector('.file-stage.full') }));
  assert(/file-stage/.test(fsNative.el) || fsNative.cls, `Ctrl+\\ puts the Timmy editor in full screen (${JSON.stringify(fsNative)})`);
  await p.keyboard.press('Control+Backslash'); await p.waitForTimeout(400);
  assert(!(await p.evaluate(() => !!document.fullscreenElement || !!document.querySelector('.file-stage.full'))), 'Ctrl+\\ again leaves full screen');

  await open('Northwind Pilot — Budget');
  for (let i = 0; i < 40; i++) { if (/Saves go/.test(await p.locator('.craft-state').innerText().catch(() => ''))) break; await p.waitForTimeout(1000); }
  await p.locator('.craft-stage iframe').click({ position: { x: 300, y: 300 } }); await p.waitForTimeout(500);
  await p.keyboard.press('Control+Backslash'); await p.waitForTimeout(500);
  const fsCraft = await p.evaluate(() => ({ el: document.fullscreenElement?.className ?? '', cls: !!document.querySelector('.craft.full') }));
  assert(/craft/.test(fsCraft.el) || fsCraft.cls, `Ctrl+\\ inside the spreadsheet editor goes full screen (${JSON.stringify(fsCraft)})`);
  await p.screenshot({ path: 'shots/fullscreen-sheet.png' });
  await p.keyboard.press('Control+Backslash'); await p.waitForTimeout(400);
  assert(!(await p.evaluate(() => !!document.fullscreenElement || !!document.querySelector('.craft.full'))), 'and back out');
  const label = await p.locator('.craft-app').innerText();
  assert(label === 'Spreadsheet editor', `no brand name in the bar (${label})`);
  console.log('errors', errors);
  await b.close();
  if (errors.length) process.exit(1);
})().catch(e => { console.error(e.message); process.exit(1); });
