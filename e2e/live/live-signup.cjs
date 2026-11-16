// Live mode: sign up, name the workspace, land on an empty workspace, change a setting, sign out and back in.
const { BASE, ok, open, signUp, api, run } = require('./lib.cjs');

run('live-signup', async (browser) => {
  const { page, errors } = await open(browser);

  await page.goto(BASE);
  await page.getByRole('heading', { name: 'Sign in to Timmy' }).waitFor();
  ok(true, 'someone who is not signed in sees the sign-in screen, not the app');
  ok((await page.locator('.main').count()) === 0, 'no workspace data is on the page before sign-in');
  ok((await api(page, 'GET', '/api/v1/state')).status === 401, 'the API refuses state without a session');

  // A wrong password says so and stays put.
  await page.getByLabel('Work email').fill('nobody@example.test');
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('.live-error').waitFor();
  ok(/invalid|incorrect|password/i.test(await page.locator('.live-error').innerText()), 'a wrong password shows an error');

  const who = await signUp(page, { name: 'Ada Lovelace' });
  ok(true, 'sign-up and naming the workspace lead into the app');
  await page.getByRole('heading', { name: 'Good morning, Ada.' }).waitFor();
  ok(true, 'the greeting uses the signed-in person’s name');
  const text = await page.locator('body').innerText();
  ok(!/Northpeak|Taylor|Acme|Brightwave|Dana Whitfield/.test(text), 'none of the demo’s sample data is on a new workspace');
  ok(/Connect your mail in Connections/.test(text), 'the brief says to connect mail instead of claiming a morning run');
  ok(!/sorted 33 emails/.test(text), 'no made-up triage numbers');
  ok((await page.locator('.urg-list .urg-row').count()) === 0, 'nothing is listed as urgent yet');
  ok((await page.evaluate(() => localStorage.getItem('timmy-state-v3'))) === null, 'workspace state is not kept in this browser');

  // The workspace's settings: the model, approvals and who is signed in.
  await page.click('button[aria-label="Rules & settings"]');
  await page.getByRole('tab', { name: 'Approvals' }).click();
  const settings = page.locator('.live-settings');
  await settings.waitFor();
  ok(new RegExp(who.email).test(await settings.innerText()), 'settings show who is signed in');
  ok((await settings.locator('select[name="timmy-model"]').inputValue()) === 'anthropic/claude-opus-5.5', 'the model is Claude Opus 5.5 by default');
  ok((await page.locator('.nav-item.demo-only').isVisible()) === false, '“Reset demo data” is hidden on a real workspace');
  const locked = page.locator('.rule', { hasText: 'Never send an email for me without my approval' });
  ok((await locked.count()) === 1, 'the “never send without my approval” rule is there');

  // A change is saved on the server: it survives a reload and a new sign-in.
  await page.getByRole('tab', { name: 'Triage' }).click();
  const before = await page.locator('.rule').count();
  await page.locator('.rule-add input, input[placeholder*="rule" i]').first().fill('Always flag mail from my accountant.');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  ok((await page.locator('.rule').count()) === before + 1, 'a new rule appears');
  await page.reload();
  await page.locator('.main').waitFor();
  await page.click('button[aria-label="Rules & settings"]');
  await page.getByRole('tab', { name: 'Triage' }).click();
  ok(/Always flag mail from my accountant/.test(await page.locator('.main').innerText()), 'the rule is still there after a reload');

  await page.getByRole('tab', { name: 'Approvals' }).click();
  await page.locator('.live-settings').getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('heading', { name: 'Sign in to Timmy' }).waitFor();
  ok((await api(page, 'GET', '/api/v1/state')).status === 401, 'after signing out the API refuses again');

  await page.getByLabel('Work email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('.main').waitFor();
  await page.click('button[aria-label="Rules & settings"]');
  await page.getByRole('tab', { name: 'Triage' }).click();
  ok(/Always flag mail from my accountant/.test(await page.locator('.main').innerText()), 'signing back in opens the same workspace with the rule intact');

  // An email link: asking for one never says whether the address exists.
  await api(page, 'POST', '/api/auth/sign-out', {});
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await page.getByLabel('Work email').fill(who.email);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await page.getByText('a sign-in link is on its way').waitFor();
  const mail = (await api(page, 'GET', `/api/test/outbox?to=${encodeURIComponent(who.email)}`)).body.mail;
  ok(mail && /magic-link/.test(mail.kind), 'the sign-in link was written to the outbox');
  const link = /https?:\/\/\S+/.exec(mail.body)[0];
  await page.goto(link);
  await page.locator('.main').waitFor();
  ok(true, 'opening the link signs the person in');

  ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
});
