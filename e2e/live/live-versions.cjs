// Live mode: a page's version history. What a page held before a round of changes is kept by the server,
// can be looked at read-only, and can be put back; a second tab follows without reloading, and the page
// still shows the old text after a reload. Also: the trash dialog says how long a page is kept.
const { BASE, ok, open, signUp, api, run } = require('./lib.cjs');

run('live-versions', async (browser) => {
  const { context, page, errors } = await open(browser);
  await signUp(page, { name: 'Grace Hopper' });
  const slices = async () => (await api(page, 'GET', '/api/v1/state')).body.slices;
  const cmd = (action) => api(page, 'POST', '/api/v1/commands', { id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, action });
  const versions = async () => (await api(page, 'GET', '/api/v1/pages/release-notes/versions')).body.versions;
  const until = async (fn, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      if (await fn()) return true;
      await page.waitForTimeout(250);
    }
    return false;
  };
  const texts = async () => ((await slices())['ws.docs']['release-notes'].blocks || []).map((b) => b.text);
  const editor = (p = page) => p.locator('.doc-editor .nb-editor');
  // The words on the page, without the name tag another tab's cursor draws in the middle of them.
  const shown = (p = page) =>
    editor(p).evaluate((el) => {
      const copy = el.cloneNode(true);
      copy.querySelectorAll('.nb-caret').forEach((tag) => tag.remove());
      return copy.textContent;
    });
  const openPage = async (p = page) => {
    await p.click('button[aria-label="Docs"]');
    await p.locator('.main').getByText('Release notes').first().click();
    await p.waitForSelector('.doc-editor .nb-editor');
  };
  const openHistory = async () => {
    await page.locator('.pg-top-right [aria-label^="Actions for"]').click();
    await page.locator('.menu-item', { hasText: 'Version history' }).click();
    const dialog = page.getByRole('dialog', { name: 'Version history' });
    await dialog.waitFor();
    return dialog;
  };

  const made = await cmd({ type: 'ws', ops: [{ op: 'put', col: 'files', item: { id: 'release-notes', name: 'Release notes', kind: 'doc', folder: '', updated: new Date().toISOString(), owner: 'me' } }, { op: 'put', col: 'docs', item: { id: 'release-notes', blocks: [{ id: 'b1', type: 'p', text: '' }] } }] });
  ok(made.body.ok, 'a new page is accepted by the server');
  ok((await versions()).length === 0, 'a new page has no earlier versions');

  /* ── Type, then change ── */
  await openPage();
  let dialog = await openHistory();
  ok(await until(async () => /No earlier versions yet/.test(await dialog.innerText())), 'the page’s menu has Version history, which says a new page has none yet');
  ok(await dialog.getByRole('button', { name: 'Restore this version' }).isDisabled(), 'and offers nothing to restore');
  await dialog.getByRole('button', { name: 'Close' }).last().click();
  await dialog.waitFor({ state: 'detached' });
  await editor().click();
  await page.keyboard.type('First words on the page');
  ok(await until(async () => (await texts()).includes('First words on the page')), 'what is typed is saved on the server');
  ok(await until(async () => (await versions()).length === 1), 'the first save keeps the page as it was before: one version');
  const first = (await versions())[0];
  ok(first.why === 'edit' && first.by === 'Grace Hopper' && first.blockCount === 1 && !('blocks' in first), 'the version says who changed the page and why, and the list carries no page contents');

  // More typing straight away is the same stretch of editing: no second version.
  await page.keyboard.type(', and a few more');
  ok(await until(async () => (await texts()).includes('First words on the page, and a few more')), 'more typing is saved');
  ok((await versions()).length === 1, 'a burst of typing is one version, not one per save');

  // Later (the kept version is made to look ten minutes old), the text is changed.
  const aged = await api(page, 'POST', '/api/test/pages/age-versions', { page: 'release-notes', minutes: 10 });
  ok(aged.status === 200 && aged.body.aged === 1, 'the test moves the kept version ten minutes into the past');
  await editor().click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Second thoughts entirely');
  ok(await until(async () => (await texts()).join('|') === 'Second thoughts entirely'), 'the changed text is saved');
  ok(await until(async () => (await versions()).length === 2), 'a change after a pause keeps a second version');
  ok((await versions())[0].preview === 'First words on the page, and a few more', 'the newest version holds the text from before the change');

  /* ── Version history: list, preview, restore ── */
  // The same page open in a second tab, to see the restore arrive there without a reload.
  const second = await context.newPage();
  await second.goto(BASE);
  await second.locator('.main').waitFor();
  await openPage(second);
  ok(/Second thoughts entirely/.test(await shown(second)), 'a second tab shows the page as it is now');

  dialog = await openHistory();
  ok(await until(async () => (await dialog.getByRole('radio').count()) === 2), 'Version history lists both versions');
  const rows = await dialog.getByRole('radio').allInnerTexts();
  ok(/Kept before Grace Hopper edited the page/.test(rows[0]) && /First words on the page, and a few more/.test(rows[0]) && /1 block/.test(rows[0]), 'each says when, who and why in plain words, with the first words of the page');
  ok(/100 versions/.test(await dialog.innerText()) && /90 days/.test(await dialog.innerText()), 'the dialog says how many versions are kept and for how long');
  const preview = dialog.locator('.vh-preview');
  ok(await until(async () => /First words on the page, and a few more/.test(await preview.innerText())), 'the newest version is shown as a preview');
  ok((await preview.locator('.nb-editor').getAttribute('contenteditable')) === 'false', 'the preview is read-only');
  // The older version: the page when it was still empty.
  await dialog.getByRole('radio').nth(1).click();
  ok(await until(async () => !/First words/.test(await preview.innerText()) && /The page as it was/.test(await preview.innerText())), 'picking another version shows that one instead');
  await dialog.getByRole('radio').nth(0).click();
  await until(async () => /First words on the page, and a few more/.test(await preview.innerText()));

  await dialog.getByRole('button', { name: 'Restore this version' }).click();
  ok(/Replace what’s on the page with this version\?/.test(await dialog.innerText()), 'restoring asks first');
  ok((await texts()).join('|') === 'Second thoughts entirely', 'and nothing has changed until the answer');
  await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  ok(await until(async () => (await shown()) === 'First words on the page, and a few more'), 'after Restore the page shows the old text');
  ok(await until(async () => (await shown(second)) === 'First words on the page, and a few more'), 'the second tab shows it too, without a reload');
  await second.close();
  ok((await texts()).join('|') === 'First words on the page, and a few more', 'the server holds the restored text');
  const after = await versions();
  ok(after.length === 3 && after[0].why === 'before-restore' && after[0].preview === 'Second thoughts entirely', 'what the restore replaced is kept as a version of its own');
  const audit = (await api(page, 'GET', '/api/v1/audit')).body.entries;
  ok(audit.some((e) => e.action === 'page.version.restored' && e.detail.page === 'release-notes' && e.detail.version === 2), 'the restore is in the audit log');

  // After a reload the page still shows the old text: it came from the server.
  await page.reload();
  await page.locator('.main').waitFor();
  await openPage();
  ok((await shown()) === 'First words on the page, and a few more', 'after a reload the page shows the restored text');
  dialog = await openHistory();
  ok(await until(async () => (await dialog.getByRole('radio').count()) === 3), 'and its history lists the restore');
  ok(/Kept before Grace Hopper restored an older version/.test((await dialog.getByRole('radio').allInnerTexts())[0]), 'in plain words');
  await dialog.getByRole('button', { name: 'Close' }).last().click();
  await dialog.waitFor({ state: 'detached' });

  /* ── A change Timmy makes always keeps a version first ── */
  await editor().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/summ');
  await page.waitForSelector('.nb-slash');
  await page.keyboard.press('Enter');
  ok(await until(async () => (await texts()).some((t) => /^Timmy’s summary/.test(t || '')), 80), 'Summarize with Timmy adds a summary to the page');
  const kept = await versions();
  ok(kept[0].why === 'before-timmy' && kept[0].by === 'Grace Hopper', 'and the page as it was before the summary is kept as a version');

  /* ── The trash says how long it keeps a page ── */
  await page.click('button[aria-label="Docs"]');
  await page.locator('.pt-trash').click();
  const trash = page.getByRole('dialog', { name: 'Trash' });
  await trash.waitFor();
  ok(await until(async () => /Pages stay here for 30 days, then they are deleted for good\./.test(await trash.innerText())), 'the trash dialog says pages are deleted for good after 30 days');
  await page.keyboard.press('Escape');

  ok(errors.filter((e) => !/400|409/.test(e)).length === 0, `no page errors (${errors.join(' | ')})`);
});
