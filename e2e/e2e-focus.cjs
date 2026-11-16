const { chromium } = require('playwright');
const assert = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('ok -', m); };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => m.type() === 'error' && errors.push(m.text()));
  await p.goto((process.env.BASE || 'http://localhost:5173/')); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(700);
  const urgentAll = await p.locator('.urg-list .urg-row').count();

  await p.click('.scope-btn'); await p.click('.scope-item:has-text("Acme Renewal")'); await p.waitForTimeout(300);
  assert((await p.locator('.scope-name').innerText()) === 'Acme Renewal', 'the picker shows Acme Renewal');
  const urgentAcme = await p.locator('.urg-list .urg-row').count();
  assert(urgentAcme >= 1 && urgentAcme < urgentAll, `the brief narrows to Acme (${urgentAll} → ${urgentAcme} urgent)`);
  assert(await p.locator('.scope-note').count() === 1, 'a note says only Acme is showing');
  const approvalRows = await p.locator('.ap-rows .ap-row').count();
  const badge = await p.locator('.bar-stat[aria-label^="To approve"] .bar-badge').innerText();
  assert(Number(badge) >= approvalRows && Number(badge) <= 3, `bar approvals badge is scoped (${badge})`);

  // Mail list
  await p.locator('.side .nav-item', { hasText: 'Follow Up' }).click(); await p.waitForTimeout(300);
  const rows = await p.locator('.row').count();
  const sideCount = Number(await p.locator('.side .nav-item', { hasText: 'Follow Up' }).locator('.nav-count').innerText());
  assert(rows === sideCount && rows >= 1, `Follow Up shows only Acme mail, and the sidebar count matches (${rows})`);

  // Approvals
  await p.click('button[aria-label="Approvals"]'); await p.waitForTimeout(300);
  const titles = await p.locator('.ap-card .ap-title').allInnerTexts();
  assert(titles.length >= 1 && titles.every(t => /Acme|quote|120 seats/i.test(t)), `Approvals lists only Acme items (${titles.join(' | ')})`);

  // Tasks
  await p.click('button[aria-label="Tasks"]'); await p.waitForTimeout(300);
  assert(/Acme Renewal tasks/.test(await p.locator('.main').innerText()), 'Tasks opens on the Acme board');

  // Ask Timmy works within the project
  await p.click('.ai-launch'); await p.waitForTimeout(300);
  assert(/Acme Renewal/.test(await p.locator('.ai-screen-label').innerText()), 'Ask Timmy knows the project');
  await p.locator('.ai-input').fill('What is urgent?'); await p.keyboard.press('Enter');
  await p.waitForFunction(() => document.querySelectorAll('.ai-msg.timmy').length > 0 && !document.querySelector('.ai-send .ai-spin'), null, { timeout: 15000 }); await p.waitForTimeout(300);
  const asks = await p.locator('.aw-row .aw-link').allInnerTexts();
  assert(asks.length >= 1 && asks.every(a => /Dana|quote|Acme|Raj|Hannah|Priya|MSA|travel/i.test(a)), `Timmy's urgent list stays in Acme (${asks.join(' | ')})`);
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);

  // Focus mode
  await p.click('button[aria-label="Today & mail"]'); await p.waitForTimeout(300);
  await p.keyboard.press('Control+.'); await p.waitForTimeout(300);
  const f = await p.evaluate(() => ({
    right: getComputedStyle(document.querySelector('.right')).display,
    badge: [...document.querySelectorAll('.rail-badge')].every(e => getComputedStyle(e).display === 'none'),
    quick: !!document.querySelector('.quick-actions'),
    tri: !!document.querySelector('.tri-grid'),
    bar: document.querySelector('.bar-status-text strong')?.textContent,
  }));
  assert(f.right === 'none' && f.badge && !f.quick && !f.tri, 'Ctrl+. hides the right panel, badges, quick actions and summary cards');
  assert(f.bar === 'Focus mode · Acme Renewal', `the bar says Focus mode · Acme Renewal (${f.bar})`);
  assert(await p.locator('.urg-list .urg-row').count() === urgentAcme, 'the urgent list stays');
  const pieces = await p.locator('.pf-title').allInnerTexts();
  assert(pieces.join('|') === 'Tasks due|Waiting on others|This week|Latest decisions|Key files|People', `the project cockpit shows every moving piece (${pieces.join(', ')})`);
  assert(/Acme Corp · Negotiation/.test(await p.locator('.pf-deal').innerText()), 'the deal line shows stage and value');
  await p.locator('.pf-piece', { hasText: 'Waiting on others' }).locator('.pf-line').first().click(); await p.waitForTimeout(300);
  assert(await p.locator('.thread-title').count() === 1, 'a piece opens where you act on it');
  await p.click('button[aria-label="Today & mail"]'); await p.waitForTimeout(300);
  await p.waitForTimeout(800); await p.reload(); await p.waitForTimeout(700);
  assert(await p.locator('.app[data-focus]').count() === 1 && (await p.locator('.scope-name').innerText()) === 'Acme Renewal', 'focus and project survive a reload');
  await p.click('.bar-focus'); await p.waitForTimeout(300);
  assert(await p.locator('.app[data-focus]').count() === 0 && await p.locator('.tri-grid').count() === 1, 'the Focus button turns it off');
  await p.click('.scope-note .link-btn'); await p.waitForTimeout(300);
  assert((await p.locator('.scope-name').innerText()) === 'All projects' && await p.locator('.urg-list .urg-row').count() === urgentAll, '"Show all projects" brings everything back');
  console.log('errors', errors);
  await b.close();
  if (errors.length) process.exit(1);
})().catch(e => { console.error(e.message); process.exit(1); });
