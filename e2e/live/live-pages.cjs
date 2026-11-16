// Live mode: the page editor, the trash, the automation canvas, the website chat's settings and the Tasks board
// on a real workspace. What is typed and drawn is kept by the server, survives a reload, and switches that would
// promise something that does not run yet stay off and say why. A picture put on a page is uploaded, and the page
// keeps a reference to it, never the picture itself.
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

  /* ── A picture on the page ── */
  // A photo as a phone saves it: a JPEG with a block of camera data (where it was taken) in front of the picture.
  const plain = Buffer.from(await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 640;
    c.height = 400;
    const g = c.getContext('2d');
    g.fillStyle = '#3f51d9';
    g.fillRect(0, 0, 640, 400);
    g.fillStyle = '#f8d77f';
    g.fillRect(40, 40, 200, 120);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  }), 'base64');
  const camera = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from('GPS 52.5200N 13.4050E TAKEN-AT-HOME')]);
  const marker = Buffer.alloc(4);
  marker.writeUInt16BE(0xffe1, 0);
  marker.writeUInt16BE(camera.length + 2, 2);
  const photo = Buffer.concat([plain.subarray(0, 2), marker, camera, plain.subarray(2)]);
  const pictures = async () => ((await slices())['ws.docs']['launch-plan'].blocks || []).filter((b) => b.type === 'image');
  const shown = (selector) => page.waitForFunction((sel) => { const i = document.querySelector(sel); return !!i && i.complete && i.naturalWidth > 0; }, selector, { timeout: 10000 });

  await page.locator('.nb-editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/image');
  await page.waitForSelector('.nb-slash');
  await page.keyboard.press('Enter');
  await page.locator('.nb-image-add input[type="file"]').setInputFiles({ name: 'IMG_2041.jpg', mimeType: 'image/jpeg', buffer: photo });
  await shown('.nb-figure img');
  ok(/^\/api\/v1\/assets\/ast_/.test(await page.locator('.nb-figure img').getAttribute('src')), 'a picture added to a page is uploaded, and shown from the server');
  await saved();
  ok(await until(async () => (await pictures()).length === 1 && /^asset:ast_/.test((await pictures())[0].src)), 'the page’s saved block holds a reference to the upload (asset:…)');
  const saw = JSON.stringify((await slices())['ws.docs']['launch-plan']);
  ok(!/data:image|base64/.test(saw) && saw.length < 20000, 'and no picture data: the page stays small');
  const assetId = (await pictures())[0].src.slice('asset:'.length);

  // What the server keeps and how it hands it back.
  const kept = await page.request.get(new URL(`/api/v1/assets/${assetId}`, page.url()).toString());
  const bytes = await kept.body();
  ok(kept.status() === 200 && kept.headers()['content-type'] === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8, 'the picture is served as the JPEG it is');
  ok(kept.headers()['x-content-type-options'] === 'nosniff' && /^attachment/.test(kept.headers()['content-disposition']) && /sandbox/.test(kept.headers()['content-security-policy']), 'with headers that keep an uploaded file from ever running as a page');
  ok(!bytes.includes('TAKEN-AT-HOME') && !bytes.includes('Exif'), 'where the photo was taken did not travel with it');

  // After a reload it is still there: it came from the server, through the reference.
  await page.reload();
  await page.locator('.main').waitFor();
  await page.click('button[aria-label="Docs"]');
  await page.locator('.main').getByText('Launch plan').first().click();
  await page.waitForSelector('.nb-editor');
  await shown('.nb-figure img');
  ok((await page.locator('.nb-figure img').getAttribute('src')) === `/api/v1/assets/${assetId}`, 'after a reload the picture shows again');

  // A cover is uploaded the same way.
  await page.locator('.pg-addon', { hasText: 'Add cover' }).click();
  await page.locator('.pg-cover').hover();
  await page.locator('.pg-cover-btn', { hasText: 'Change cover' }).click();
  await page.locator('.pg-cover-pop [role="tab"]', { hasText: 'Upload' }).click();
  await page.locator('.pg-cover-pop input[type="file"]').setInputFiles({ name: 'skyline.jpg', mimeType: 'image/jpeg', buffer: photo });
  ok(await until(async () => /^asset:ast_/.test((await slices())['ws.docs']['launch-plan'].cover?.value || '')), 'an uploaded cover is saved as a reference too');
  ok(/\/api\/v1\/assets\/ast_/.test(await page.locator('.pg-cover').evaluate((el) => getComputedStyle(el).backgroundImage)), 'and drawn from the server');

  // Someone in another workspace, and someone signed out, can't fetch the picture or put it on their own page.
  const outsider = await open(browser);
  await signUp(outsider.page, { name: 'Other Person' });
  ok((await api(outsider.page, 'GET', `/api/v1/assets/${assetId}`)).status === 404, 'another workspace gets 404 for the picture');
  const borrowed = await api(outsider.page, 'POST', '/api/v1/commands', { id: `t-${Date.now()}-x`, action: { type: 'ws', ops: [{ op: 'put', col: 'docs', item: { id: 'theirs', blocks: [{ id: 'b', type: 'image', src: `asset:${assetId}` }] } }] } });
  ok(borrowed.body.ok === false && /picture/.test(borrowed.body.error), 'and can’t reference it from a page of their own');
  await outsider.context.clearCookies();
  ok((await api(outsider.page, 'GET', `/api/v1/assets/${assetId}`)).status === 401, 'signed out, the answer is 401');
  await outsider.context.close();

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

  // A test run uses sample data and sends nothing; switching it on is refused, because nothing would run.
  await page.locator('button', { hasText: 'Test run' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.ae-log-list li:not(.ae-log-wait)').length === 2, null, { timeout: 8000 });
  ok(/Nothing is sent/.test(await page.locator('.ae-log').textContent()), 'a test run walks the steps with sample data and says nothing is sent');
  const on = await cmd({ type: 'ws', ops: [{ op: 'patch', col: 'automations', id: au.id, patch: { on: true } }] });
  ok(on.body.ok === false && /isn’t switched on yet/.test(on.body.error) && (await drawn()).on === false, 'switching it on is refused with the reason, and it stays off');
  const loop = await cmd({ type: 'ws', ops: [{ op: 'patch', col: 'automations', id: au.id, patch: { edges: [...au.edges, { id: 'back', from: au.nodes[1].id, to: au.nodes[0].id }] } }] });
  ok(loop.body.ok === false, 'a graph that loops back into its trigger is refused');
  await page.reload();
  await page.locator('.main').waitFor();
  await page.click('button[aria-label="AI library"]');
  await page.getByRole('tab', { name: /Automations/ }).click();
  ok((await page.locator('.au-card', { hasText: 'Thank new customers' }).count()) === 1, 'after a reload the automation is listed, from the server');

  /* ── The website chat's settings ── */
  const chat = await cmd({ type: 'ws', ops: [{ op: 'patch', col: 'chat', id: 'site', patch: { domain: 'apollo.example', faq: [{ id: 'f1', q: 'When is launch?', a: 'July 16.' }] } }] });
  ok(chat.body.ok && (await slices())['ws.chat'].site.domain === 'apollo.example', 'the chat’s settings are kept');
  const chatOn = await cmd({ type: 'ws', ops: [{ op: 'patch', col: 'chat', id: 'site', patch: { on: true } }] });
  ok(chatOn.body.ok === false && /isn’t switched on yet/.test(chatOn.body.error), 'switching the chat on is refused with the reason, because no website could load it yet');
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
