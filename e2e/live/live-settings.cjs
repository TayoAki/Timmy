// Live mode: the model picker and approval mode in Settings.
const { ok, open, signUp, api, run } = require('./lib.cjs');

run('live-settings', async (browser) => {
  const { page, errors } = await open(browser);
  await signUp(page, { name: 'Margaret Hamilton' });
  await page.click('button[aria-label="Rules & settings"]');
  await page.getByRole('tab', { name: 'Approvals' }).click();
  const model = page.locator('select[name="timmy-model"]');
  await model.waitFor();
  const options = await model.locator('option').evaluateAll((els) => els.map((e) => [e.value, e.textContent]));
  ok(options.length >= 1 && options[0][0] === 'anthropic/claude-opus-5.5', `only tested models are offered (${options.map((o) => o[1]).join(', ')})`);
  ok((await api(page, 'PATCH', '/api/v1/settings', { model: 'some/untested-model' })).status === 400, 'a model that is not on the list is refused by the API');
  ok((await api(page, 'GET', '/api/v1/settings')).body.model === 'anthropic/claude-opus-5.5', 'the workspace still runs on the listed model');

  // Choosing a model saves it for the workspace.
  await model.selectOption(options[options.length - 1][0]);
  await page.locator('.toast', { hasText: /Timmy now runs on/ }).waitFor();
  ok((await api(page, 'GET', '/api/v1/settings')).body.model === options[options.length - 1][0], 'choosing a model in Settings saves it');

  const mode = page.locator('select[name="approval-mode"]');
  await mode.selectOption('auto');
  await page.locator('.toast', { hasText: /decide routine filing/ }).waitFor();
  await page.reload();
  await page.locator('.main').waitFor();
  await page.click('button[aria-label="Rules & settings"]');
  await page.getByRole('tab', { name: 'Approvals' }).click();
  await page.locator('select[name="approval-mode"]').waitFor();
  await page.waitForTimeout(500);
  ok((await page.locator('select[name="approval-mode"]').inputValue()) === 'auto', 'the approval mode is still set after a reload');
  ok(/waits for your OK or a rule you wrote/.test(await page.locator('.live-settings').innerText()), 'Settings says sends always need an OK, whatever the mode');
  const audit = (await api(page, 'GET', '/api/v1/audit')).body.entries.filter((e) => e.action === 'settings.changed');
  ok(audit.length >= 2, 'setting changes are in the audit log');

  ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
});
