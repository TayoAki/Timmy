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
  ok(!/2,4\d\d/.test(text), 'the Archived count is this workspace’s own, not the demo’s');

  // Screens that used to borrow from the demo's sample day show this workspace's own (empty) record instead.
  await page.click('button[aria-label="Approvals"]');
  await page.getByText('Done without asking').first().waitFor();
  const approvals = await page.locator('body').innerText();
  ok(/Nothing yet\. Timmy asks before every change/.test(approvals), 'Approvals does not list sample work as done without asking');
  ok(!/Last run|First morning run|next (today|tomorrow|\w+day) at/i.test(approvals), 'and no morning run time is claimed while no mailbox is connected');
  await page.click('button[aria-label="Connections"]');
  const hubspot = page.locator('li.conn-card', { hasText: 'HubSpot' }).first();
  await hubspot.waitFor();
  ok(/Coming soon/.test(await hubspot.innerText()) && (await hubspot.getByRole('button', { name: 'Connect', exact: true }).count()) === 0, 'an app Timmy cannot read yet is shown as coming soon, with no Connect button');
  for (const name of ['Outlook and Microsoft 365', 'Google Drive', 'Google Calendar']) {
    const card = page.locator('li.conn-card', { has: page.getByText(name, { exact: true }) }).first();
    ok((await card.getByRole('button', { name: 'Connect', exact: true }).count()) === 1 && !/Coming soon/.test(await card.innerText()), `${name} can be connected`);
  }
  const gmail = page.locator('li.conn-card', { has: page.getByText('Gmail', { exact: true }) }).first();
  ok((await gmail.getByRole('button', { name: 'Connect', exact: true }).count()) === 1, 'Gmail can be connected');

  // The workspace's settings: the model, approvals and who is signed in.
  await page.click('button[aria-label="Rules & settings"]');
  // The settings sidebar lists what is connected. On a new workspace that is nothing, and it says so.
  const side = page.locator('.side-group', { has: page.locator('.side-title', { hasText: 'Connected' }) }).first();
  await side.waitFor();
  ok(/Nothing connected yet/.test(await side.innerText()) && !/synced|Gmail/.test(await side.innerText()), 'the sidebar does not say any app is connected before one is');
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
  // The first attempt to save it is lost on the way, as a dropped connection would lose it. The app sends it again,
  // and because the server knows a command by its id, the rule is saved once.
  const lost = { command: 0, signOut: 0 };
  await page.route('**/api/v1/commands', (route) => (lost.command++ === 0 ? route.abort('connectionreset') : route.continue()));
  await page.locator('.rule-add input, input[placeholder*="rule" i]').first().fill('Always flag mail from my accountant.');
  await page.keyboard.press('Enter');
  // On a deployed server the answer takes longer than on one machine, so this waits for the settled state
  // (the rule there exactly once) instead of looking after a fixed pause, and says what it saw if it never settles.
  const added = page.locator('.rule', { hasText: 'Always flag mail from my accountant.' });
  let seen = [];
  for (let i = 0; i < 25; i++) {
    seen = [await page.locator('.rule').count(), await added.count()];
    if (seen[0] === before + 1 && seen[1] === 1) break;
    await page.waitForTimeout(200);
  }
  const notice = await page.locator('.toast').allInnerTexts();
  ok(seen[0] === before + 1 && seen[1] === 1, `a new rule appears, once (rules before ${before}, now ${seen[0]}, the new one ${seen[1]} time(s); notices: ${notice.join(' | ') || 'none'})`);
  ok(lost.command === 2, `the save was sent again after the first attempt was lost (${lost.command} attempts)`);
  await page.unroute('**/api/v1/commands');
  // Reloading straight away, before the server has answered: the change must not be lost with the old page.
  await page.reload();
  await page.locator('.main').waitFor();
  await page.click('button[aria-label="Rules & settings"]');
  await page.getByRole('tab', { name: 'Triage' }).click();
  const kept = await page.locator('.rule', { hasText: 'Always flag mail from my accountant.' }).waitFor({ timeout: 8000 }).then(() => true, () => false);
  ok(kept, 'the rule is still there after an immediate reload');
  ok((await page.locator('.rule', { hasText: 'Always flag mail from my accountant.' }).count()) === 1, 'and it is there once');

  await page.getByRole('tab', { name: 'Approvals' }).click();
  // Signing out survives a lost request too: the person is not left signed in behind a sign-in page.
  await page.route('**/api/auth/sign-out', (route) => (lost.signOut++ === 0 ? route.abort('connectionreset') : route.continue()));
  await page.locator('.live-settings').getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('heading', { name: 'Sign in to Timmy' }).waitFor();
  await page.unroute('**/api/auth/sign-out');
  ok(lost.signOut === 2 && (await api(page, 'GET', '/api/v1/state')).status === 401, 'after signing out the API refuses again, even though the first attempt was lost');
  // The two lost requests were this test's doing; the browser reports each one, and nothing else should be reported.
  errors.splice(0, errors.length, ...errors.filter((e) => !/ERR_CONNECTION_RESET/.test(e)));

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
