// Phone layout (tab bar, no overlap, no key hints, urgent first) and the calm home.
const { chromium, devices } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:5173/';
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };
const overlap = (a, b) => !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
(async () => {
  const b = await chromium.launch();
  const errors = [];

  /* Phone */
  const ctx = await b.newContext({ ...devices['iPhone 13'] });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(e.message));
  await p.goto(BASE); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(800);
  assert(!(await p.locator('.rail').isVisible()), 'no icon rail on a phone');
  const tabs = p.locator('.bar-phone .ptab');
  assert(await tabs.count() === 5, 'five tabs: Today, Approve, Ask, Calendar, More');
  const boxes = [];
  for (let i = 0; i < 5; i++) boxes.push(await tabs.nth(i).boundingBox());
  let clash = false;
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) if (overlap(boxes[i], boxes[j])) clash = true;
  assert(!clash, 'no tab overlaps another (Ask no longer covers Urgent)');
  assert(boxes.every(x => x.height >= 44), 'tap targets are at least 44 px tall');
  assert(await p.locator('.kbd:visible').count() === 0, 'no keyboard hints on a touch screen');
  assert(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll');
  const firstTitle = await p.locator('.main-inner .section-title').first().innerText();
  assert(firstTitle === 'Needs you today', `urgent list comes first (${firstTitle})`);
  assert(await p.locator('.urg-list .urg-row').count() === 4, 'urgent list shows the 4 urgent items');
  assert(await p.locator('.quick-actions').count() === 0, 'quick actions move off the phone home');
  await p.locator('.ptab:has-text("Ask")').click(); await p.waitForTimeout(300);
  assert(await p.locator('.ai-shell').count() === 1, 'Ask opens the chat');
  assert(!(await p.locator('.ai-foot-keys').isVisible()), 'no Ctrl+I hint in the chat on a phone');
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  await p.locator('.ptab:has-text("More")').click(); await p.waitForTimeout(300);
  assert(await p.locator('.sheet-item').count() === 10, 'More lists the other 10 sections');
  await p.locator('.sheet-item:has-text("Outbound")').click(); await p.waitForTimeout(300);
  let s = await p.evaluate(() => { const x = JSON.parse(localStorage.getItem('timmy-state-v3') || '{}'); return x; });
  await p.waitForTimeout(500);
  s = await p.evaluate(() => JSON.parse(localStorage.getItem('timmy-state-v3') || '{}'));
  assert(s.route.view === 'outbound', 'More › Outbound opens Outbound');
  assert(await p.locator('.ptab[aria-current=page]:has-text("More")').count() === 1, 'More tab is marked current in other sections');
  await p.locator('.ptab:has-text("Calendar")').click(); await p.waitForTimeout(600);
  s = await p.evaluate(() => JSON.parse(localStorage.getItem('timmy-state-v3') || '{}'));
  assert(s.route.view === 'calendar' && s.route.tab === 'day', 'calendar opens on the day view on a phone');
  // One notice at a time
  await p.locator('.ptab:has-text("Today")').click(); await p.waitForTimeout(300);
  await p.locator('.ptab:has-text("More")').click(); await p.waitForTimeout(200);
  await p.locator('.sheet-chip:has-text("Focus")').click(); await p.waitForTimeout(200);
  await p.locator('.ptab:has-text("More")').click(); await p.waitForTimeout(200);
  await p.locator('.sheet-chip:has-text("Focus")').click(); await p.waitForTimeout(200);
  assert(await p.locator('.toast').count() === 1, 'notices never stack');
  await ctx.close();

  /* Calm home (desktop) */
  const d = await b.newPage({ viewport: { width: 1440, height: 900 } });
  d.on('pageerror', e => errors.push(e.message));
  await d.goto(BASE); await d.evaluate(() => localStorage.clear()); await d.reload(); await d.waitForTimeout(800);
  const fullBadges = await d.locator('.rail-badge').count();
  await d.click('.calm-toggle'); await d.waitForTimeout(300);
  assert(await d.locator('.rail-badge').count() < fullBadges && await d.locator('.rail-btn[aria-label="Approvals"] .rail-badge').count() === 1, `calm keeps only the Approvals badge (${fullBadges} → ${await d.locator('.rail-badge').count()})`);
  assert(await d.locator('.tri-grid, .quick-actions, .triage-summary').count() === 0, 'calm brief drops cards, quick actions and the triage summary');
  assert(await d.locator('.urg-list .urg-row').count() === 3, 'calm shows the top 3 urgent items');
  assert(/wait for your OK/.test(await d.locator('.calm-approvals').innerText()), 'approvals collapse to one line');
  assert(await d.locator('.calm-next').count() === 1, 'shows the next meeting');
  assert(await d.locator('button[aria-label="Unsorted: 7"]').count() === 0, 'bottom bar drops the Unsorted badge');
  await d.keyboard.press('Control+.'); await d.waitForTimeout(300);
  assert(await d.locator('.urg-list').count() === 0 && /6 urgent things waiting/.test(await d.locator('.calm-collapsed').innerText()), 'calm focus collapses the urgent list to one line');
  assert(await d.locator('.calm-approvals').count() === 0, 'calm focus hides approvals');
  await d.click('.calm-collapsed button:has-text("Show")'); await d.waitForTimeout(200);
  assert(await d.locator('.urg-list .urg-row').count() === 3, 'Show brings the urgent list back');
  await d.keyboard.press('Control+.'); await d.waitForTimeout(200);
  // Deals off
  await d.click('button[aria-label="Rules & settings"]'); await d.waitForTimeout(300);
  await d.locator('.side button:has-text("Appearance")').first().click(); await d.waitForTimeout(400);
  assert(await d.locator('[role=radio][aria-checked=true]:has-text("Calm")').count() === 1, 'Appearance shows Calm selected');
  await d.click('button[aria-label="Show deals and the CRM"]'); await d.waitForTimeout(300);
  await d.click('button[aria-label="Today & mail"]'); await d.waitForTimeout(300);
  const reasons = await d.locator('.urg-reasons').allInnerTexts();
  assert(reasons.every(r => !/\$\d/.test(r)), 'no deal money in urgency reasons with deals off');
  await d.locator('.urg-row-title').first().click(); await d.waitForTimeout(400);
  assert(await d.locator('.rp-title:has-text("CRM record")').count() === 0, 'no CRM record on the thread with deals off');
  await d.reload(); await d.waitForTimeout(800);
  const st = await d.evaluate(() => JSON.parse(localStorage.getItem('timmy-state-v3')));
  assert(st.calm === true && st.showDeals === false, 'preferences survive a reload');

  assert(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await b.close();
})().catch(e => { console.error(e.message); process.exit(1); });
