// Automations (list, new-automation sheet, canvas, blocks, settings with field chips, test run,
// on/off), the website chat (setup, preview answers and booking, visitors' chats, take over),
// and the Tasks board's pipeline touches (lane summaries, quick add, contact cards).
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:5173/';
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };
const KEY = 'timmy-state-v3';
// The store writes to localStorage 400 ms after a change.
const saved = async (p) => (await p.waitForTimeout(500), p.evaluate((KEY) => JSON.parse(localStorage.getItem(KEY) || '{}'), KEY));
const go = async (p, route) => {
  await p.evaluate(([KEY, route]) => { const s = JSON.parse(localStorage.getItem(KEY) || '{}'); s.route = route; localStorage.setItem(KEY, JSON.stringify(s)); }, [KEY, route]);
  await p.reload();
  await p.waitForTimeout(500);
};

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE);
  await p.evaluate(() => localStorage.clear());
  await p.reload();

  /* ── Automations ── */
  await go(p, { view: 'library', tab: 'automations' });
  assert(await p.locator('.au-card').count() === 3, 'Library → Automations lists the three automations');
  assert(/Forms/.test(await p.locator('.au-card').first().textContent()), 'each card names the apps it uses');
  await p.locator('.au-card').nth(2).locator('[role="switch"]').click();
  await p.waitForTimeout(400);
  assert((await saved(p)).ws.automations['auto-recap'].on === true, 'the switch turns an automation on');

  await p.locator('button', { hasText: 'New automation' }).click();
  await p.waitForSelector('.au-sheet');
  assert(await p.locator('.au-sheet [role="dialog"], .au-sheet').count() >= 1, 'New automation opens a bottom sheet');
  await p.locator('.au-sheet input').first().fill('Thank new customers');
  await p.locator('.au-sheet button[type="submit"]').click();
  await p.waitForSelector('.ae');
  assert(await p.locator('.ae-empty').count() === 1, 'it opens an empty canvas that asks for a trigger');
  assert(await p.locator('.ae-group').first().textContent() === 'Triggers', 'the blocks panel starts with triggers');

  // Drag a trigger onto the canvas.
  const card = p.locator('.ae-card', { hasText: 'Deal stage changes' });
  const canvas = await p.locator('.ae-canvas').boundingBox();
  await card.dragTo(p.locator('.ae-canvas'), { targetPosition: { x: canvas.width / 2, y: 120 } });
  await p.waitForTimeout(300);
  assert(await p.locator('.ae-node').count() === 1, 'dragging a trigger onto the canvas adds it');
  assert(!(await p.locator('.ae-group').allTextContents()).includes('Triggers'), 'once there’s a trigger, the panel shows actions and logic');
  await p.locator('select').first().selectOption('Won');
  // Click two actions: each is added and wired under the last step.
  await p.locator('.ae-tabs [role="tab"]', { hasText: 'Blocks' }).click();
  await p.locator('.ae-card', { hasText: 'Draft a reply' }).click();
  await p.waitForTimeout(150);
  assert(await p.locator('.ae-node').count() === 2 && await p.locator('.react-flow__edge').count() === 1, 'clicking a block adds it and connects it under the selected step');
  assert(await p.locator('.ae-chip').count() >= 4, 'the step’s settings offer the trigger’s fields as chips');
  await p.locator('.ae-template').fill('Hi ');
  await p.locator('.ae-chip', { hasText: 'name' }).click();
  assert((await p.locator('.ae-template').inputValue()).includes('{{name}}') && /Hi Dana/.test(await p.locator('.ae-preview').textContent()), 'a chip inserts {{name}} and the preview fills it from sample data');
  await p.locator('select').last().selectOption('Warm');
  await p.locator('.ae-tabs [role="tab"]', { hasText: 'Blocks' }).click();
  await p.locator('.ae-card', { hasText: 'Create a task' }).click();
  await p.locator('.ae-template').fill('Send {{company}} a welcome pack');
  await p.locator('select').last().selectOption('Tomorrow');
  assert(/Unsaved changes/.test(await p.locator('.ae-saved').textContent()), 'edits show as unsaved');
  await p.locator('.ae-top button', { hasText: 'Save' }).click();
  await p.waitForTimeout(300);
  let au = Object.values((await saved(p)).ws.automations).find((a) => a.name === 'Thank new customers');
  assert(au && au.nodes.length === 3 && au.edges.length === 2 && au.nodes[1].config.message === 'Hi {{name}}', 'Save stores the steps, links and settings');

  // Test run.
  await p.locator('button', { hasText: 'Test run' }).click();
  await p.waitForFunction(() => document.querySelectorAll('.ae-log-list li:not(.ae-log-wait)').length === 3, null, { timeout: 6000 });
  const log = await p.locator('.ae-log').textContent();
  assert(/Sample data\. Nothing is sent/.test(log) && /Acme renewal moved to Won/.test(log) && /Hi Dana/.test(log) && /Send Acme a welcome pack/.test(log), 'a test run walks the steps with sample data and says nothing is sent');
  assert(await p.locator('.ae-node.done').count() === 3, 'each step is ticked as it runs');
  await p.locator('.ae-top [role="switch"]').click();
  await p.waitForTimeout(300);
  au = Object.values((await saved(p)).ws.automations).find((a) => a.name === 'Thank new customers');
  assert(au.on === true && au.tests === 1, 'it can be switched on, and the test run is counted');

  // The seeded flow: the condition sends a small budget down "no".
  await go(p, { view: 'automation', id: 'auto-speed' });
  await p.waitForSelector('.ae-node');
  await p.locator('.ae-node', { hasText: 'If / else' }).click();
  await p.locator('.ae-acc input').fill('9000');
  await p.locator('button', { hasText: 'Test run' }).click();
  await p.waitForFunction(() => !document.querySelector('.ae-node.running') && document.querySelectorAll('.ae-log-list li').length >= 3, null, { timeout: 8000 });
  await p.waitForTimeout(300);
  const t2 = await p.locator('.ae-log').textContent();
  assert(/budget is “8000”: no/.test(t2) && /Nurture: monthly tips/.test(t2) && !/Drafted/.test(t2), 'If / else follows the “no” branch when the sample budget is under the line');
  assert(await p.locator('.ae-node.skipped').count() === 3, 'steps on the other branch are greyed out');
  // One trigger only.
  await p.locator('.ae-tabs [role="tab"]', { hasText: 'Blocks' }).click();
  assert(!(await p.locator('.ae-card').allTextContents()).some((t) => /New email/.test(t)), 'triggers aren’t offered when the automation has one');

  /* ── Website chat ── */
  await go(p, { view: 'outbound', tab: 'chat' });
  await p.waitForSelector('.wc');
  assert(await p.locator('.wc-card').count() === 2 && /Wants a person/.test(await p.locator('.wc-card').first().textContent()), 'Chats opens on unread chats, flagging the one that wants a person');
  await p.locator('.wc-card').first().click();
  assert(/About 60/.test(await p.locator('.wc-facts').textContent()), 'a chat shows the answers to your questions');
  assert(await p.locator('.wc-compose input[aria-label="Your reply"]').isDisabled(), 'you can’t reply while Timmy is answering');
  await p.locator('.wc-take [role="switch"]').click();
  await p.locator('.wc-compose input[aria-label="Your reply"]').fill('Hi Priya, 60 seats can be $26 each. Want a quote?');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(300);
  let chat = (await saved(p)).ws.chats['chat-1'];
  assert(chat.live && chat.messages.at(-1).from === 'you' && !chat.urgent && !chat.unread, 'taking over lets you reply; the chat is read and no longer waiting');

  await p.locator('[role="radio"]', { hasText: 'Set up' }).click();
  assert(/timmy\.app\/chat\.js/.test(await p.locator('.wc-code').textContent()), 'set up shows the code snippet to paste');
  const msg = p.locator('.wc-compose input[aria-label="Message"]');
  const say = async (t) => { await msg.fill(t); await msg.press('Enter'); await p.waitForTimeout(900); };
  await say('Do you have SSO with Okta?');
  assert(/SAML SSO/.test(await p.locator('.wc-body').textContent()), 'the preview answers from the help desk answers');
  await say('sam@harbor.io');
  assert(/Thanks, Sam! What’s your company called\?/.test(await p.locator('.wc-body').textContent()), 'it takes the email, then asks your first question');
  await say('Harbor'); await say('12'); await say('In March');
  assert(await p.locator('.wc-slot').count() === 3, 'after the questions it offers three times to book');
  await p.locator('.wc-slot').first().click();
  await p.waitForTimeout(200);
  assert(/Booked: Tue, Nov 17 at 10:00 AM with Taylor\. The invite is on its way to sam@harbor\.io/.test(await p.locator('.wc-body').textContent()), 'picking a time books it');
  // Change the look; the preview follows.
  await p.locator('.wc-color').nth(2).click();
  await p.waitForTimeout(150);
  assert((await p.locator('.wc-launcher').evaluate((e) => getComputedStyle(e).backgroundColor)) === 'rgb(217, 115, 13)', 'the colour you pick changes the bubble');
  await p.locator('.wc-add input').fill('What’s your budget?');
  await p.locator('.wc-add button').click();
  assert((await saved(p)).ws.chat.site.questions.length === 4, 'you can add a question for Timmy to ask');

  /* ── Tasks board ── */
  await go(p, { view: 'tasks', tab: 'board' });
  await p.waitForSelector('.tk-board');
  assert(/due this week/.test(await p.locator('.tk-lane-sum').first().textContent()), 'each lane sums up what’s due');
  await p.locator('.tk-col').nth(1).locator('.tk-add-row').click();
  await p.keyboard.type('Call Raj about SCIM');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(300);
  const tk = Object.values((await saved(p)).ws.tasks).find((t) => t.title === 'Call Raj about SCIM');
  assert(tk && tk.status === 'doing', 'quick add puts a task straight into that lane');
  await p.locator('.tk-contact-chip').first().hover();
  await p.waitForTimeout(200);
  assert(await p.locator('.tk-hovercard').first().isVisible() && /@/.test(await p.locator('.tk-hovercard').first().textContent()), 'hovering the contact shows who they are and their email');

  assert(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ')})`);
  await b.close();
  console.log('PASS e2e-uis');
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
