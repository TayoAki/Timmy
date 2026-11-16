const { chromium } = require('playwright');
const out = process.argv[2];
const results = [];
const check = (name, ok, extra = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  · ' + extra : ''}`); };
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto('http://localhost:5173/'); await p.waitForTimeout(400);
  const rail = (name) => p.getByRole('button', { name, exact: true }).first().click();
  const modal = () => p.locator('.modal').last();

  // ── Workday: email → task → block time → tracker → linked doc → send & track → reply → decision
  try {
    await p.locator('.urg-row', { hasText: 'revised quote' }).getByRole('button', { name: 'Review draft' }).click(); await p.waitForTimeout(200);
    // task already linked for acme-quote; use Block time
    await p.getByRole('button', { name: 'Block time', exact: true }).click(); await p.waitForTimeout(200);
    await modal().getByRole('button', { name: /^Block / }).click(); await p.waitForTimeout(200);
    const t1 = await p.locator('.toast').last().innerText().catch(() => '');
    check('Workday: block time from the email', /Block|Focus|blocked/i.test(t1), t1.split('\n')[0]);
    // open tracker via the step link
    await p.locator('.right .step-row', { hasText: 'Update the quote tracker' }).locator('.step-main').click(); await p.waitForTimeout(300);
    const seats = p.getByRole('textbox', { name: 'Seats, row 2' }).or(p.locator('input[aria-label="Seats, row 2"]'));
    await seats.fill('125'); await seats.press('Enter'); await p.waitForTimeout(200);
    await p.keyboard.press('Control+k'); await p.keyboard.type('Revised quote summary'); await p.waitForTimeout(200); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
    const docText = await p.locator('.main').innerText();
    check('Workday: tracker change flows into the linked doc', docText.includes('87,000'), docText.includes('87,000') ? '$87,000 shown' : 'value not found');
    await p.screenshot({ path: out + '/90-linked-doc.png' });
    await p.getByRole('button', { name: 'Today & mail' }).click();
    await p.locator('.side .nav-item', { hasText: 'Follow Up' }).click(); await p.locator('.row', { hasText: 'Revised quote' }).click(); await p.waitForTimeout(200);
    await p.getByRole('button', { name: 'Send & track in Waiting' }).click(); await p.waitForTimeout(200);
    await p.getByRole('button', { name: /Demo: Dana replies/ }).click(); await p.waitForTimeout(200);
    await p.getByRole('button', { name: 'Record decision and archive' }).click(); await p.waitForTimeout(200);
    await modal().getByRole('button', { name: 'Record and archive' }).click(); await p.waitForTimeout(250);
    await p.keyboard.press('Control+k'); await p.keyboard.type('Acme Renewal — Running notes'); await p.waitForTimeout(200); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
    await p.waitForTimeout(600);
    const notes = await p.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('timmy-state-v3')).ws.docs['acme-running-notes'].blocks));
    check('Workday: decision recorded in the project running notes', /CFO approved 12\d seats/.test(notes), (notes.match(/CFO approved[^"]*/) || ['not found'])[0]);
  } catch (e) { check('Workday flow', false, e.message.split('\n').slice(0, 3).join(' ')); }

  // ── Capture → review → task
  try {
    await rail('Tasks'); await p.waitForTimeout(200);
    const before = await p.locator('.tk-card, [class*="tk-card"]').count();
    await p.keyboard.press('Control+j'); await p.waitForTimeout(200);
    await modal().locator('input, textarea').first().fill('Draft Q1 territory plan'); await p.keyboard.press('Enter'); await p.waitForTimeout(250);
    const toast = await p.locator('.toast').last().innerText().catch(() => '');
    check('Capture: quick capture saves', /Captured|Task added|review/i.test(toast), toast.split('\n')[0]);
    await p.getByRole('tab', { name: /Review/ }).click(); await p.waitForTimeout(200);
    await p.getByRole('button', { name: 'Make it a task' }).first().click(); await p.waitForTimeout(200);
    await modal().getByRole('button', { name: 'Add task' }).click(); await p.waitForTimeout(250);
    await p.getByRole('tab', { name: /Board/ }).click(); await p.waitForTimeout(200);
    const after = await p.locator('.tk-card, [class*="tk-card"]').count();
    check('Review: a captured note becomes a task', after > before, `${before} → ${after} cards`);
  } catch (e) { check('Capture/review flow', false, e.message.split('\n')[0]); }

  // ── Docs: new doc from the 1:1 template, named in one step
  try {
    await rail('Docs'); await p.waitForTimeout(200);
    await p.getByRole('button', { name: /New doc/ }).first().click(); await p.waitForTimeout(200);
    const html = await modal().innerText();
    check('Docs: new doc dialog offers templates and naming', /1:1/.test(html) && /(Year|Quarter|Month|Day)/.test(html));
    await p.keyboard.press('Escape');
  } catch (e) { check('Docs new doc', false, e.message.split('\n')[0]); }

  // ── Slides: copy selected slides to Quick Share
  try {
    await p.keyboard.press('Control+k'); await p.keyboard.type('QBR — Briefing slides'); await p.waitForTimeout(200); await p.keyboard.press('Enter'); await p.waitForTimeout(300);
    await p.getByRole('button', { name: /Select slides to share/ }).click(); await p.waitForTimeout(200);
    const deck = await p.locator('.main').innerText();
    check('Slides: deck opens with Quick Share', /Quick Share/i.test(deck));
    await p.screenshot({ path: out + '/91-deck.png' });
  } catch (e) { check('Slides', false, e.message.split('\n')[0]); }

  // ── Drive: file an attachment
  try {
    await rail('Drive'); await p.getByRole('tab', { name: /To file/ }).click(); await p.waitForTimeout(200);
    const n0 = await p.getByRole('button', { name: 'File it' }).count();
    await p.getByRole('button', { name: 'File it' }).first().click(); await p.waitForTimeout(200);
    const n1 = await p.getByRole('button', { name: 'File it' }).count();
    check('Drive: file an attachment where you will use it', n1 === n0 - 1, `${n0} → ${n1}`);
  } catch (e) { check('Drive filing', false, e.message.split('\n')[0]); }

  // ── CRM: contact → start a conversation → compose has the recipient
  try {
    await rail('People'); await p.locator('.main').getByText('Marcus Lee').first().click(); await p.waitForTimeout(250);
    await p.getByRole('button', { name: 'Start a conversation' }).click(); await p.waitForTimeout(200);
    const c = await p.locator('.compose').innerText();
    check('CRM: start a conversation opens compose to the contact', /Marcus Lee/.test(c));
    await p.locator('.compose').getByRole('button', { name: 'Close' }).click();
  } catch (e) { check('CRM conversation', false, e.message.split('\n')[0]); }

  // ── Project: new task links to the project
  try {
    await rail('Projects'); await p.locator('.main').getByText('Northwind Pilot').first().click(); await p.waitForTimeout(250);
    await p.getByRole('button', { name: 'New task' }).first().click(); await p.waitForTimeout(200);
    await modal().locator('input').first().fill('Confirm pilot user list'); await modal().getByRole('button', { name: 'Add task' }).click(); await p.waitForTimeout(250);
    await p.getByRole('tab', { name: /Tasks/ }).click(); await p.waitForTimeout(200);
    check('Project: new task is linked to the project', (await p.locator('.main').innerText()).includes('Confirm pilot user list'));
  } catch (e) { check('Project task', false, e.message.split('\n')[0]); }

  // ── Library: use a prompt in an email
  try {
    await rail('AI library'); await p.getByRole('button', { name: 'Use in an email' }).first().click(); await p.waitForTimeout(200);
    check('AI library: prompt opens in compose', (await p.locator('.compose').count()) === 1);
    await p.locator('.compose').getByRole('button', { name: 'Close' }).click();
  } catch (e) { check('Library prompt', false, e.message.split('\n')[0]); }

  // ── Calendar: open the weekly review and its link to the queue
  try {
    await rail('Calendar'); await p.waitForTimeout(200);
    await p.locator('.main').getByText('Weekly review').first().click(); await p.waitForTimeout(200);
    check('Calendar: weekly review links to the review queue', /review queue/i.test(await modal().innerText()));
    await p.keyboard.press('Escape');
  } catch (e) { check('Calendar review', false, e.message.split('\n')[0]); }

  // ── Persistence across reload
  await p.waitForTimeout(600); await p.reload(); await p.waitForTimeout(500);
  await rail('Tasks'); await p.waitForTimeout(200);
  check('Saved: created tasks survive a reload', (await p.locator('.main').innerText()).includes('Confirm pilot user list') || (await p.locator('.main').innerText()).includes('Draft Q1 territory plan'));

  console.log(results.join('\n'));
  console.log('console errors:', JSON.stringify(errors));
  await b.close();
})();
