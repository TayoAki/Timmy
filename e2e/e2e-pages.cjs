// The Notion-style doc editor: "/" blocks, markdown shortcuts, nesting, toggles, formatting,
// moving blocks, page icon and cover, sub-pages and the page tree, Timmy's summary with its
// own cursor, the trash, and the same doc kept in sync across two tabs.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:5173/';
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };
const KEY = 'timmy-state-v3';
const saved = (p) => p.evaluate((KEY) => JSON.parse(localStorage.getItem(KEY) || '{}'), KEY);
const docBlocks = async (p, id) => (await saved(p)).ws.docs[id].blocks;
const open = async (p, id) => {
  await p.evaluate(([KEY, id]) => { const s = JSON.parse(localStorage.getItem(KEY) || '{}'); s.route = { view: 'file', id }; localStorage.setItem(KEY, JSON.stringify(s)); }, [KEY, id]);
  await p.reload();
  await p.waitForSelector('.nb-editor');
  await p.waitForTimeout(400);
};
const settle = (p) => p.waitForFunction(() => document.querySelector('.pg-save')?.textContent?.includes('Saved'), null, { timeout: 5000 }).then(() => p.waitForTimeout(500));

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));

  await p.goto(BASE);
  await p.evaluate(() => localStorage.clear());
  await p.reload();
  await open(p, 'acme-call-notes');
  await p.waitForTimeout(1200);
  const before = (await saved(p)).ws?.files?.['acme-call-notes'];
  assert(!before || String(before.updated).startsWith('2026-11-13'), 'opening a doc doesn’t change it');
  assert(await p.locator('.pg-save').textContent() === 'Saved', 'the badge says Saved');
  assert((await p.locator('.pg-icon').textContent()).includes('📞') && await p.locator('.pg-title').inputValue() === '2026-11-13 Acme — Call notes', 'the page shows its emoji and a big title');

  // "/" menu and markdown shortcuts, typed at the end of the page.
  await p.locator('.nb-editor > .nb-todo').last().locator('.nb-content').click();
  await p.waitForTimeout(80);
  await p.keyboard.press('End');
  await p.waitForTimeout(60);
  await p.keyboard.press('Enter');
  await p.keyboard.press('Enter'); // an empty to-do turns back into text
  await p.keyboard.type('/');
  await p.waitForSelector('.nb-slash');
  assert(await p.locator('.nb-slash-item').count() >= 15, 'typing / opens the block menu');
  await p.keyboard.type('quote');
  assert(await p.locator('.nb-slash-item').count() === 1, 'the menu filters as you type');
  await p.keyboard.press('Escape');
  await p.keyboard.press('Control+a').catch(() => {});
  // Start clean on a fresh line.
  await p.locator('.nb-editor > .nb-todo').last().locator('.nb-content').click();
  await p.waitForTimeout(80);
  await p.keyboard.press('End');
  await p.waitForTimeout(60);
  await p.keyboard.press('Enter');
  await p.keyboard.press('Enter');
  await p.keyboard.type('# Risks');
  await p.keyboard.press('Enter');
  await p.keyboard.type('- Seat count may drop');
  await p.keyboard.press('Enter');
  await p.keyboard.press('Tab');
  await p.keyboard.type('Dana confirms Friday');
  await p.keyboard.press('Enter');
  await p.keyboard.press('Shift+Tab');
  await p.keyboard.press('Backspace');
  await p.keyboard.type('1. Call Raj');
  await p.keyboard.press('Enter');
  await p.keyboard.type('Send the SOW');
  await p.keyboard.press('Enter');
  await p.keyboard.press('Enter');
  await p.keyboard.type('> Background');
  await p.keyboard.press('Enter');
  await p.keyboard.type('Renewal is due Jan 1');
  await p.keyboard.press('Enter');
  await p.keyboard.press('Backspace'); // out of the toggle
  await p.keyboard.type('" Price is fine if SSO is in');
  await p.keyboard.press('Enter');
  await p.keyboard.type('Ship it ');
  await p.waitForTimeout(60);
  await p.keyboard.press('Shift+Home');
  await p.waitForTimeout(60);
  await p.keyboard.press('Control+b');
  await p.keyboard.press('End');
  await p.waitForTimeout(60);
  await settle(p);
  let blocks = await docBlocks(p, 'acme-call-notes');
  const find = (t) => blocks.find((x) => x.text === t);
  assert(find('Risks')?.type === 'h1', '“# ” makes a heading');
  assert(find('Seat count may drop')?.type === 'bullet' && find('Dana confirms Friday')?.type === 'bullet' && find('Dana confirms Friday')?.indent === 1, '“- ” makes a bullet and Tab nests the next one');
  assert(find('Call Raj')?.type === 'numbered' && find('Send the SOW')?.type === 'numbered', '“1. ” starts a numbered list that continues on Enter');
  const nums = await p.locator('.nb-editor > .nb-numbered').evaluateAll((els) => els.map((e) => e.getAttribute('data-n')));
  assert(nums.join(',') === '1.,2.', `the list is numbered (${nums})`);
  assert(find('Background')?.type === 'toggle' && find('Renewal is due Jan 1')?.indent === 1, '“> ” makes a toggle, and Enter puts the next line inside it');
  assert(find('Price is fine if SSO is in')?.type === 'quote', '“" ” makes a quote');
  const bold = find('Ship it ') ?? find('Ship it');
  assert(bold && bold.rich?.some((n) => n.marks?.some((m) => m.type === 'bold')), 'Ctrl+B saves bold, while Timmy still reads plain text');

  // Close the toggle: what's inside it hides.
  await p.locator('.nb-editor > .nb-toggle .nb-toggle-ctl').first().click();
  await p.waitForTimeout(150);
  assert(await p.locator('.nb-editor > .nb-hidden').count() === 1, 'closing a toggle hides what’s inside it');
  await settle(p);
  blocks = await docBlocks(p, 'acme-call-notes');
  assert(blocks.find((x) => x.type === 'toggle')?.open === false, 'and it stays closed');

  // Block handle: the menu turns a block into a heading; Ctrl+Shift+↑ moves it.
  await p.locator('.nb-editor > p').first().hover();
  await p.waitForSelector('.nb-gutter');
  await p.locator('.nb-gutter-btn.grip').click();
  await p.locator('.nb-menu-item', { hasText: 'Turn into' }).click();
  await p.locator('.nb-menu-item', { hasText: 'Heading 3' }).click();
  await p.waitForTimeout(100);
  assert(await p.locator('.nb-editor > h3').count() === 1, 'the ⋮⋮ menu turns a block into a heading');
  // Ctrl+Shift+↑ moves a block, and anything nested under it goes too.
  await p.locator('.nb-editor > .nb-bullet', { hasText: 'Seat count may drop' }).click();
  await p.waitForTimeout(80);
  await p.keyboard.press('Control+Shift+ArrowUp');
  await p.waitForTimeout(150);
  const seq = await p.locator('.nb-editor > *').evaluateAll((els) => els.map((e) => e.textContent));
  const at = seq.indexOf('Seat count may drop');
  assert(at >= 0 && seq[at + 1] === 'Dana confirms Friday' && seq[at + 2] === 'Risks', 'Ctrl+Shift+↑ moves a bullet up, with the bullet nested under it');
  // Drag a block by its handle.
  await p.locator('.nb-editor > h2', { hasText: 'Action items' }).hover();
  const grip = await p.locator('.nb-gutter-btn.grip').boundingBox();
  const target = await p.locator('.nb-editor > h2', { hasText: 'Open questions' }).boundingBox();
  await p.mouse.move(grip.x + 8, grip.y + 10);
  await p.mouse.down();
  await p.mouse.move(grip.x + 20, grip.y - 20, { steps: 4 });
  await p.mouse.move(target.x + 60, target.y + 3, { steps: 8 });
  assert(await p.locator('.nb-drop-line').count() === 1, 'dragging shows a drop line between blocks');
  await p.mouse.up();
  await p.waitForTimeout(150);
  assert((await p.locator('.nb-editor > h2').allTextContents()).join('|') === 'Decisions|Action items|Open questions', 'dropping moves the block there');

  // Icon and cover.
  await p.locator('.pg-title').hover();
  await p.locator('.pg-addon', { hasText: 'Add cover' }).click();
  await p.locator('.pg-icon').click();
  await p.locator('.nb-emoji-search input').fill('rocket');
  await p.locator('.nb-emoji').first().click();
  await settle(p);
  let body = (await saved(p)).ws.docs['acme-call-notes'];
  assert(body.icon === '🚀' && body.cover?.kind === 'gradient', 'the page’s icon and cover are saved');
  assert((await p.locator('.pg-crumbs').textContent()).includes('🚀'), 'the breadcrumb shows the new icon');

  // Email the notes still reads the page.
  await p.locator('button', { hasText: 'Email the notes' }).click();
  await p.waitForTimeout(400);
  const draft = await p.locator('.compose textarea, .compose [contenteditable]').first().inputValue().catch(async () => p.locator('.compose').textContent());
  assert(/Annual plan/.test(draft) && /Action items/.test(draft), '“Email the notes” still builds the summary email from the blocks');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(200);

  // Timmy writes a summary with its own cursor.
  await open(p, 'acme-running-notes');
  await p.locator('.nb-editor > p').first().click();
  await p.waitForTimeout(80);
  await p.keyboard.press('End');
  await p.waitForTimeout(60);
  await p.keyboard.press('Enter');
  await p.keyboard.type('/summar');
  await p.waitForSelector('.nb-slash-item');
  await p.keyboard.press('Enter');
  await p.waitForSelector('.nb-caret.tagged', { timeout: 3000 });
  assert((await p.locator('.nb-caret.tagged .nb-caret-tag').textContent()) === 'Timmy', 'Timmy’s cursor, with its name, types the summary');
  assert(await p.locator('.pg-person').count() === 2, 'Timmy joins the people on the page while it writes');
  await p.waitForFunction(() => !document.querySelector('.nb-caret.tagged'), null, { timeout: 15000 });
  await settle(p);
  blocks = await docBlocks(p, 'acme-running-notes');
  const ci = blocks.findIndex((x) => x.type === 'callout');
  assert(ci === 1 && blocks[ci + 1].type === 'bullet' && /Nov 13/.test(blocks.slice(ci).map((x) => x.text).join(' ')), 'the summary lands under the first line and is taken from the page (the table’s latest row)');
  await p.keyboard.press('Control+z');
  await settle(p);
  assert(!(await docBlocks(p, 'acme-running-notes')).some((x) => x.type === 'callout'), 'one Ctrl+Z takes the whole summary out');

  // A page inside this page.
  await p.locator('.nb-editor > p').first().click();
  await p.waitForTimeout(80);
  await p.keyboard.press('End');
  await p.waitForTimeout(60);
  await p.keyboard.press('Enter');
  await p.keyboard.type('/page');
  await p.waitForSelector('.nb-slash-item');
  await p.keyboard.press('Enter');
  await p.waitForFunction(() => document.querySelector('.pg-title')?.value === 'Untitled', null, { timeout: 5000 });
  const crumbs = await p.locator('.pg-crumbs').textContent();
  assert(/Acme Renewal — Running notes/.test(crumbs) && /Untitled/.test(crumbs), 'the new page opens, with its parent in the breadcrumbs');
  await p.locator('.pg-title').fill('Security questions');
  await p.keyboard.press('Enter');
  await p.keyboard.type('Okta SCIM is the blocker');
  await settle(p);
  assert(await p.locator('.pt-row[aria-current="page"] .pt-name').textContent() === 'Security questions', 'the page tree shows the sub-page under its parent');
  await p.locator('.pg-crumb', { hasText: 'Acme Renewal' }).first().click();
  await p.waitForSelector('.nb-page-link');
  assert((await p.locator('.nb-page-link').textContent()).includes('Security questions'), 'the parent shows a link to its sub-page');

  // Trash: the page and its sub-page go; restore brings both back.
  await p.locator('.pg-top-right [aria-label^="Actions for"]').click();
  assert(await p.locator('.menu-item', { hasText: 'Version history' }).count() === 0, 'the demo’s page menu has no Version history: versions are kept by the server on a real workspace');
  await p.locator('.menu-item, [role="menuitem"]', { hasText: 'Move to trash' }).click();
  await p.waitForSelector('.pg-trash');
  assert(/in the trash/.test(await p.locator('.pg-trash').textContent()), 'a trashed page shows the red banner');
  assert(await p.locator('.nb-editor[contenteditable="false"]').count() === 1, 'and can’t be edited');
  assert(!(await p.locator('.pt-name').allTextContents()).some((t) => /Acme Renewal — Running/.test(t)), 'it leaves the page tree');
  await p.locator('.pt-trash').click();
  assert(await p.locator('.pt-trash-row').count() === 1 && /1 page inside/.test(await p.locator('.pt-trash-row').textContent()), 'the trash lists it, with its sub-page');
  await p.locator('.pt-trash-row [aria-label^="Restore"]').click();
  await p.waitForTimeout(80);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(200);
  let st = await saved(p);
  assert(st.ws.files['acme-running-notes'] && Object.values(st.ws.files).some((f) => f.name === 'Security questions') && !Object.keys(st.ws.trash).length, 'restore brings back the page and its sub-page');

  // Same doc in a second tab.
  const p2 = await ctx.newPage();
  await p2.goto(BASE);
  await p2.waitForSelector('.nb-editor');
  await p2.waitForTimeout(900);
  await p.waitForFunction(() => document.querySelectorAll('.pg-person').length === 2, null, { timeout: 8000 });
  assert(true, 'a second tab on the same doc shows up beside you');
  await p2.locator('.nb-editor > p').first().click();
  await p.waitForTimeout(80);
  await p2.keyboard.press('End');
  await p2.waitForTimeout(60);
  await p2.keyboard.type(' From tab two.');
  await p.waitForFunction(() => document.querySelector('.nb-editor > p')?.textContent.endsWith('From tab two.'), null, { timeout: 5000 });
  assert(true, 'what’s typed in one tab appears in the other');
  assert(await p.locator('.nb-caret').count() >= 1, 'with the other tab’s cursor');
  await p2.close();

  assert(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ')})`);
  await b.close();
  console.log('PASS e2e-pages');
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
