// Live mode: the model picker and the monthly limit in Settings.
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

  // The monthly limit: an owner can change it, up to the ceiling the server allows.
  const cap = page.locator('input[name="spend-cap"]');
  await page.waitForFunction(() => document.querySelector('input[name="spend-cap"]')?.value === '50');
  ok(true, 'a new workspace starts with a $50 monthly limit');
  await cap.fill('120');
  await cap.press('Enter');
  await page.locator('.toast', { hasText: 'The monthly limit is now $120.' }).waitFor();
  ok((await api(page, 'GET', '/api/v1/settings')).body.monthlySpendCapUsd === 120, 'changing the monthly limit in Settings saves it');
  await cap.fill('5000');
  await cap.press('Enter');
  await page.locator('.toast', { hasText: /can be anything from \$0 to \$200/ }).waitFor();
  await page.waitForFunction(() => document.querySelector('input[name="spend-cap"]')?.value === '120');
  ok((await api(page, 'GET', '/api/v1/settings')).body.monthlySpendCapUsd === 120, 'a limit above the ceiling is refused, and the field goes back to the limit in force');
  await page.reload();
  await page.locator('.main').waitFor();
  await page.click('button[aria-label="Rules & settings"]');
  await page.getByRole('tab', { name: 'Approvals' }).click();
  await page.waitForFunction(() => document.querySelector('input[name="spend-cap"]')?.value === '120');
  ok(true, 'the limit is still set after a reload');

  // Letting Timmy file mail itself is a choice the owner makes; it is saved, and it says what it does not cover.
  const mode = page.locator('select[name="approval-mode"]');
  ok((await mode.inputValue()) === 'ask', 'by default Timmy asks before it files anything');
  await mode.selectOption('auto');
  await page.locator('.toast', { hasText: /file what you clearly asked for/ }).waitFor();
  ok((await api(page, 'GET', '/api/v1/settings')).body.approvalMode === 'auto', 'the choice is saved');
  ok(/only covers labels and archiving in your own mailbox/.test(await page.locator('.live-settings').innerText()) && /waits for your OK or a rule you wrote/.test(await page.locator('.live-settings').innerText()), 'Settings says it covers filing only, and that sends always need an OK');
  const audit = (await api(page, 'GET', '/api/v1/audit')).body.entries.filter((e) => e.action === 'settings.changed');
  ok(audit.length >= 2, 'setting changes are in the audit log');

  ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
});
