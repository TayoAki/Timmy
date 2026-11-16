// Live mode: the Notion-style editor, automations and website chat on a real workspace. What you type
// in a doc, an automation you draw and the chat's settings are kept by the API and survive a reload;
// the trash keeps a page until it is restored. Nothing here sends anything.
const { ok, open, signUp, api, run } = require('./lib.cjs');

const state = async (page) => (await api(page, 'GET', '/api/v1/state')).body;
const cmd = async (page, action) => (await api(page, 'POST', '/api/v1/commands', { id: `pages-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, action })).body;
/** The workspace collections from GET /api/v1/state, which answers slice by slice. */
const wsOf = async (page) => {
  const sl = (await state(page)).slices;
  return { docs: sl['ws.docs'] ?? {}, files: sl['ws.files'] ?? {}, trash: sl['ws.trash'] ?? {}, automations: sl['ws.automations'] ?? {}, chat: sl['ws.chat'] ?? {}, messages: sl['out.messages'] ?? [] };
};

run('live-pages', async (browser) => {
  const { page, errors } = await open(browser);
  await signUp(page, { name: 'Grace Hopper', company: 'Pages Test Co' });

  // A doc to write in (a new workspace has none yet).
  const now = new Date().toISOString();
  ok(
    (await cmd(page, {
      type: 'ws',
      ops: [
        { op: 'put', col: 'files', item: { id: 'doc-plan', name: 'Launch plan', kind: 'doc', folder: 'root', updated: now, owner: 'me' } },
        { op: 'put', col: 'docs', item: { id: 'doc-plan', template: 'blank', blocks: [{ id: 'b1', type: 'p', text: 'Goals for the launch.' }] } },
      ],
    })).ok,
    'a doc can be added to a real workspace',
  );

  await page.click('button[aria-label="Docs"]');
  await page.locator('.pt-name', { hasText: 'Launch plan' }).click();
  await page.waitForSelector('.nb-editor');
  ok(await page.locator('.pg-title').inputValue() === 'Launch plan', 'the page tree opens the doc in the block editor');

  // Type with markdown shortcuts and the "/" menu.
  await page.locator('.nb-editor > p').first().click();
  await page.waitForTimeout(80);
  await page.keyboard.press('End');
  await page.waitForTimeout(80);
  await page.keyboard.press('Enter');
  await page.keyboard.type('## Risks');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- Seats may drop');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/todo');
  await page.waitForSelector('.nb-slash-item');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Send the quote');
  await page.waitForFunction(() => document.querySelector('.pg-save')?.textContent?.includes('Saved'), null, { timeout: 8000 });
  await page.waitForTimeout(1500);
  const doc = (await wsOf(page)).docs['doc-plan'];
  const types = (doc?.blocks ?? []).map((b) => `${b.type}:${b.text}`);
  ok(types.includes('h2:Risks') && types.includes('bullet:Seats may drop') && types.includes('todo:Send the quote'), `the server keeps what was typed (${types.join(' | ')})`);

  // Icon and cover.
  await page.locator('.pg-title').hover();
  await page.locator('.pg-addon', { hasText: 'Add cover' }).click();
  await page.locator('.pg-addon', { hasText: 'Add icon' }).click();
  await page.locator('.nb-emoji-search input').fill('rocket');
  await page.locator('.nb-emoji').first().click();
  await page.waitForTimeout(1500);

  await page.reload();
  await page.locator('.main').waitFor();
  await page.click('button[aria-label="Docs"]');
  await page.locator('.pt-name', { hasText: 'Launch plan' }).click();
  await page.waitForSelector('.nb-editor');
  ok((await page.locator('.nb-editor > h2').textContent()) === 'Risks' && (await page.locator('.nb-editor > .nb-todo').count()) === 1, 'after a reload the page comes back from the server as it was typed');
  ok((await page.locator('.pg-icon').textContent()).includes('🚀') && (await page.locator('.pg-cover').count()) === 1, 'and with its icon and cover');

  // Trash and restore.
  await page.locator('.pg-top-right [aria-label^="Actions for"]').click();
  await page.locator('[role="menuitem"], .menu-item', { hasText: 'Move to trash' }).click();
  await page.waitForSelector('.pg-trash');
  await page.waitForTimeout(1200);
  let W = await wsOf(page);
  ok(!W.files['doc-plan'] && W.trash['doc-plan'], 'moving a page to the trash is kept by the server');
  await page.locator('.pg-trash-btn', { hasText: 'Restore' }).click();
  await page.waitForTimeout(1200);
  W = await wsOf(page);
  ok(W.files['doc-plan'] && !W.trash['doc-plan'], 'and so is restoring it');

  // Automations: create one on the canvas and save it.
  await page.click('button[aria-label="AI library"]');
  await page.getByRole('tab', { name: 'Automations' }).click();
  ok(/Draw what happens/.test(await page.locator('.au-head').textContent()), 'a new workspace has no automations yet');
  await page.locator('button', { hasText: 'New automation' }).click();
  await page.locator('.au-sheet input').first().fill('Thank new customers');
  await page.locator('.au-sheet button[type="submit"]').click();
  await page.waitForSelector('.ae');
  await page.locator('.ae-card', { hasText: 'Form submitted' }).click();
  await page.locator('select').first().selectOption({ index: 1 });
  await page.locator('.ae-tabs [role="tab"]', { hasText: 'Blocks' }).click();
  await page.locator('.ae-card', { hasText: 'Create a task' }).click();
  await page.locator('.ae-template').fill('Welcome {{name}}');
  await page.locator('.ae-top button', { hasText: 'Save' }).click();
  await page.waitForTimeout(1500);
  W = await wsOf(page);
  const auto = Object.values(W.automations).find((a) => a.name === 'Thank new customers');
  ok(auto && auto.nodes.length === 2 && auto.edges.length === 1 && auto.nodes[1].config.title === 'Welcome {{name}}', 'an automation drawn on the canvas is saved by the server');

  // Website chat settings.
  await page.click('button[aria-label="Outbound"]');
  await page.getByRole('tab', { name: 'Website chat' }).click();
  await page.locator('.wc-add input').fill('What’s your budget?');
  await page.locator('.wc-add button').click();
  await page.waitForTimeout(1200);
  W = await wsOf(page);
  ok(W.chat.site.questions.length === 4 && W.chat.site.name === 'Pages Test Co', 'the website chat’s settings are saved, starting from the workspace’s own name');
  ok((await page.locator('.wc-code').textContent()).includes('data-site'), 'set up shows the snippet');

  ok(W.messages.length === 0, 'nothing was sent');
  ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
});
