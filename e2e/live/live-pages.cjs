// Live mode: the page editor, the trash, the automation canvas, the website chat's settings and the Tasks board
// on a real workspace. What is typed and drawn is kept by the server, survives a reload, and switches that would
// promise something that does not run yet stay off and say why.
const { ok, open, signUp, api, run } = require('./lib.cjs');

run('live-pages', async (browser) => {
  const { page, errors } = await open(browser);
  await signUp(page, { name: 'Margaret Hamilton' });
  const slices = async () => (await api(page, 'GET', '/api/v1/state')).body.slices;
  const cmd = (action) => api(page, 'POST', '/api/v1/commands', { id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, action });
  const until = async (fn, tries = 40) => {
    for (let i = 0; i < tries; i++) {
      if (await fn()) return true;
      await page.waitForTimeout(250);
    }
    return false;
  };
  const saved = () => page.waitForFunction(() => document.querySelector('.pg-save')?.textContent?.includes('Saved'), null, { timeout: 8000 });

  // A new workspace has no sample pages, automations or chats.
  const start = await slices();
  ok(Object.keys(start['ws.docs'] || {}).length === 0 && Object.keys(start['ws.automations'] || {}).length === 0 && Object.keys(start['ws.chats'] || {}).length === 0, 'a new workspace starts with no pages, automations or visitor chats from the demo');
  ok(start['ws.chat'].site.on === false && start['ws.chat'].site.faq.length === 0, 'the website chat exists, switched off and empty');

  /* ── A page ── */
  const made = await cmd({ type: 'ws', ops: [{ op: 'put', col: 'files', item: { id: 'launch-plan', name: 'Launch plan', kind: 'doc', folder: '', updated: new Date().toISOString(), owner: 'me' } }, { op: 'put', col: 'docs', item: { id: 'launch-plan', blocks: [{ id: 'b1', type: 'p', text: '' }] } }] });
  ok(made.body.ok, 'a new page is accepted by the server');
  await page.click('button[aria-label="Docs"]');
  await page.locator('.main').getByText('Launch plan').first().click();
  await page.waitForSelector('.nb-editor');
  await page.locator('.nb-editor').click();
  await page.keyboard.type('# Guidance software');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- Priority displays first');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await page.waitForSelector('.nb-slash');
  ok((await page.locator('.nb-slash-item').count()) >= 15, 'typing / opens the block menu on a real workspace');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('Ship before July.');
  await saved();
  const typed = (s) => (s['ws.docs']['launch-plan'].blocks || []).map((b) => `${b.type}:${b.text}`);
  ok(await until(async () => typed(await slices()).includes('h1:Guidance software')), 'what is typed is saved on the server, as blocks');
  ok(typed(await slices()).includes('bullet:Priority displays first') && typed(await slices()).some((t) => /Ship before July\./.test(t)), 'markdown shortcuts made a heading and a bullet, and the text followed');

  // Summarize with Timmy: the model writes the lines, the server keeps only what the page backs, and Timmy types them in.
  await page.keyboard.press('Enter');
  await page.keyboard.type('/summ');
  await page.waitForSelector('.nb-slash');
  await page.keyboard.press('Enter');
  ok(await until(async () => typed(await slices()).some((t) => /^callout:Timmy’s summary/.test(t)), 80), 'Summarize with Timmy adds a summary to the page');
  const after = typed(await slices());
  ok(after.includes('bullet:Guidance software') && !after.some((t) => /999,999|Everyone agreed/.test(t)), 'its lines come from the page; a figure that is not on the page and a line resting on nothing were left out');

  // After a reload the page is still there, as typed: it came from the server, not from this browser.
  ok((await page.evaluate(() => localStorage.getItem('timmy-state-v3'))) === null, 'nothing about the page is kept in this browser');
  await page.reload();
  await page.locator('.main').waitFor();
  await page.click('button[aria-label="Docs"]');
  await page.locator('.main').getByText('Launch plan').first().click();
  await page.waitForSelector('.nb-editor');
  ok(/Guidance software/.test(await page.locator('.nb-editor').innerText()) && /Priority displays first/.test(await page.locator('.nb-editor').innerText()), 'after a reload the page shows what was typed');

  // Typing that carries on while a save is on its way back is kept. On a real workspace the save's answer is a new
  // copy of the same page; it must not replace what is on screen, or the letters typed in between are lost.
  // The cursor is put at the end of a line by clicking it, then End. The editor reads where a click put the
  // cursor a moment after the click, not during it. A person cannot press a key in that moment; a test can, and
  // the key then acts on the old cursor position at the top of the page. So the test lets the page take a turn first.
  const plain = page.locator('.nb-editor p', { hasText: 'Ship before July.' }).first();
  await plain.click();
  await page.waitForFunction(() => document.activeElement?.classList.contains('nb-editor') && /Ship before July\./.test(window.getSelection()?.anchorNode?.textContent || ''));
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 60)))));
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Abort modes reviewed');
  // The editor saves after a short pause. Each wait below ends a little later after that pause, so one of them
  // lands on the moment the answer arrives, whatever the speed of the connection.
  const words = [' with', ' the', ' crew', ' on', ' Tuesday', ' and', ' again', ' on', ' Friday'];
  for (const [i, word] of words.entries()) {
    await page.waitForTimeout(850 + i * 15);
    await page.keyboard.type(word, { delay: 12 });
  }
  await saved();
  const whole = /Abort modes reviewed with the crew on Tuesday and again on Friday$/;
  const line = async () => typed(await slices()).find((t) => /Abort modes/.test(t)) || '(no such line)';
  ok(await until(async () => whole.test(await line())), `typing that carries on while a save comes back is all kept on the server (it holds “${await line()}”)`);
  ok(/Abort modes reviewed with the crew on Tuesday and again on Friday/.test(await page.locator('.nb-editor').innerText()), 'and is all on screen');

  // Taking a cover off a page sticks. (Clearing a field is sent as "null": JSON has no word for "not set".)
  ok((await cmd({ type: 'ws', ops: [{ op: 'patch', col: 'docs', id: 'launch-plan', patch: { cover: { kind: 'gradient', value: 'dawn' } } }] })).body.ok, 'a cover is put on the page');
  const remove = page.locator('.pg-cover-btn', { hasText: 'Remove' });
  await remove.waitFor({ state: 'attached', timeout: 8000 });
  await remove.click({ force: true });
  ok(await until(async () => (await slices())['ws.docs']['launch-plan'].cover === undefined), 'removing the cover is kept by the server');
  await page.reload();
  await page.locator('.main').waitFor();
  await page.click('button[aria-label="Docs"]');
  await page.locator('.main').getByText('Launch plan').first().click();
  await page.waitForSelector('.nb-editor');
  ok((await page.locator('.pg-cover-btn', { hasText: 'Remove' }).count()) === 0 && whole.test((await page.locator('.nb-editor').innerText()).split('\n').find((l) => /Abort modes/.test(l)) || ''), 'after a reload the cover is still gone and the typed line is whole');

  // Something that isn't a page's contents is refused, with a reason, and the page is unchanged.
  const bad = await cmd({ type: 'ws', ops: [{ op: 'patch', col: 'docs', id: 'launch-plan', patch: { blocks: [{ id: 'x', type: 'p', text: 'click', rich: [{ type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] } }] });
  ok(bad.body.ok === false && /web or email address/.test(bad.body.error), 'a link that is not a web or email address is refused by the server');
  ok(typed(await slices()).includes('h1:Guidance software'), 'and the page keeps what it had');

  // The trash: the page goes, with a banner, and comes back.
  await page.locator('.pg-top-right [aria-label^="Actions for"]').click();
  await page.locator('.menu-item, [role="menuitem"]', { hasText: 'Move to trash' }).click();
  await page.waitForSelector('.pg-trash');
  ok(await until(async () => !!(await slices())['ws.trash']['launch-plan'] && !(await slices())['ws.files']['launch-plan']), 'moving a page to the trash is kept by the server');
  await page.reload();
  await page.locator('.main').waitFor();
  ok(!!(await slices())['ws.trash']['launch-plan'], 'it is still in the trash after a reload');
  const back = (await slices())['ws.trash']['launch-plan'];
  const restored = await cmd({ type: 'ws', ops: [{ op: 'remove', col: 'trash', id: 'launch-plan' }, { op: 'put', col: 'files', item: { ...back, trashed: undefined, trashRoot: undefined } }] });
  ok(restored.body.ok && !!(await slices())['ws.files']['launch-plan'] && !(await slices())['ws.trash']['launch-plan'], 'and it can be restored');

  /* ── Automations ── */
  await page.click('button[aria-label="AI library"]');
  await page.getByRole('tab', { name: /Automations/ }).click();
  ok((await page.locator('.au-card').count()) === 0, 'no sample automations are listed');
  await page.locator('button', { hasText: 'New automation' }).first().click();
  await page.waitForSelector('.au-sheet');
  await page.locator('.au-sheet input').first().fill('Thank new customers');
  await page.locator('.au-sheet button[type="submit"]').click();
  await page.waitForSelector('.ae');
  const canvas = await page.locator('.ae-canvas').boundingBox();
  await page.locator('.ae-card', { hasText: 'Form submitted' }).dragTo(page.locator('.ae-canvas'), { targetPosition: { x: canvas.width / 2, y: 120 } });
  await page.waitForTimeout(300);
  ok((await page.locator('.ae-node').count()) === 1, 'a trigger can be placed on the canvas');
  await page.locator('select').first().selectOption({ index: 1 });
  await page.locator('.ae-tabs [role="tab"]', { hasText: 'Blocks' }).click();
  await page.locator('.ae-card', { hasText: 'Create a task' }).click();
  await page.locator('.ae-template').fill('Send {{company}} a welcome pack');
  await page.locator('select').last().selectOption({ index: 1 });
  await page.locator('.ae-top button', { hasText: 'Save' }).click();
  const drawn = async () => Object.values((await slices())['ws.automations']).find((a) => a.name === 'Thank new customers');
  ok(await until(async () => (await drawn())?.nodes.length === 2), 'Save keeps the steps on the server');
  const au = await drawn();
  ok(au.edges.length === 1 && au.nodes[1].config.title === 'Send {{company}} a welcome pack' || Object.values(au.nodes[1].config).includes('Send {{company}} a welcome pack'), 'with their connections and settings');

  // A test run uses sample data and sends nothing. Switching this one on is refused: it starts from a form, and
  // forms can't be connected yet. (An automation the engine can run is switched on in live-automations.)
  await page.locator('button', { hasText: 'Test run' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.ae-log-list li:not(.ae-log-wait)').length === 2, null, { timeout: 8000 });
  ok(/Nothing is sent/.test(await page.locator('.ae-log').textContent()), 'a test run walks the steps with sample data and says nothing is sent');
  const on = await cmd({ type: 'ws', ops: [{ op: 'patch', col: 'automations', id: au.id, patch: { on: true } }] });
  ok(on.body.ok === false && /can’t be switched on yet\. “Form submitted” needs a lead form, and none can be connected yet\./.test(on.body.error) && (await drawn()).on === false, 'switching it on is refused with the reason (its trigger can’t run yet), and it stays off');
  const loop = await cmd({ type: 'ws', ops: [{ op: 'patch', col: 'automations', id: au.id, patch: { edges: [...au.edges, { id: 'back', from: au.nodes[1].id, to: au.nodes[0].id }] } }] });
  ok(loop.body.ok === false, 'a graph that loops back into its trigger is refused');
  await page.reload();
  await page.locator('.main').waitFor();
  await page.click('button[aria-label="AI library"]');
  await page.getByRole('tab', { name: /Automations/ }).click();
  ok((await page.locator('.au-card', { hasText: 'Thank new customers' }).count()) === 1, 'after a reload the automation is listed, from the server');

  /* ── The website chat's settings ── */
  // The chat can now really be put on a website (live-chat.cjs covers that end to end). What is checked here is
  // the switch itself: it is refused while there is no website for the chat to show on, and works once there is.
  const tooSoon = await cmd({ type: 'ws', ops: [{ op: 'patch', col: 'chat', id: 'site', patch: { on: true } }] });
  ok(tooSoon.body.ok === false && /Set your website first/.test(tooSoon.body.error) && (await slices())['ws.chat'].site.on === false, 'switching the chat on is refused with the reason while no website is set, and it stays off');
  const chat = await cmd({ type: 'ws', ops: [{ op: 'patch', col: 'chat', id: 'site', patch: { domain: 'apollo.example', faq: [{ id: 'f1', q: 'When is launch?', a: 'July 16.' }] } }] });
  ok(chat.body.ok && (await slices())['ws.chat'].site.domain === 'apollo.example', 'the chat’s settings are kept');
  const chatOn = await cmd({ type: 'ws', ops: [{ op: 'patch', col: 'chat', id: 'site', patch: { on: true } }] });
  ok(chatOn.body.ok === true && (await slices())['ws.chat'].site.on === true && /^[A-Za-z0-9_-]{32}$/.test((await slices())['ws.chat'].site.siteKey), 'with a website set, the owner switches the chat on, and it has its own key for the snippet');
  const forged = await cmd({ type: 'ws', ops: [{ op: 'put', col: 'chats', item: { id: 'fake', messages: [{ id: 'm', from: 'visitor', text: 'hi', at: new Date().toISOString() }], live: false, unread: true } }] });
  ok(forged.body.ok === false, 'a visitor’s conversation can’t be made up from a member’s screen');

  /* ── The Tasks board ── */
  await page.click('button[aria-label="Tasks"]');
  await page.locator('.tk-add-row').first().click();
  await page.getByLabel('New task').fill('Verify the abort program');
  await page.keyboard.press('Enter');
  ok(await until(async () => Object.values((await slices())['ws.tasks']).some((t) => t.title === 'Verify the abort program')), 'a task added with the board’s quick add is kept by the server');
  await page.reload();
  await page.locator('.main').waitFor();
  await page.click('button[aria-label="Tasks"]');
  await page.locator('.main').getByText('Verify the abort program').first().waitFor({ timeout: 10000 });
  ok(true, 'and is on the board after a reload');

  ok(errors.filter((e) => !/400|409/.test(e)).length === 0, `no page errors (${errors.join(' | ')})`);
});
