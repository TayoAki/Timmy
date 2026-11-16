// Live mode with address confirmation required (the setting production uses once Timmy can deliver mail):
// a new account is not signed in until the link sent to its address is opened.
// Needs a server started with TIMMY_REQUIRE_EMAIL_VERIFICATION=1; `scripts/dev.sh live` starts one for this suite.
const { BASE, ok, open, api, run, stamp } = require('./lib.cjs');

run('live-verify', async (browser) => {
  const { page, errors } = await open(browser);
  const email = `grace.${stamp()}@example.test`;
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Your name').fill('Grace Hopper');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery-9');
  await page.getByRole('button', { name: 'Create account' }).click();

  await page.getByText(/Confirm your address to finish/).waitFor();
  ok(new RegExp(email.replace(/\./g, '\\.')).test(await page.locator('.live-card').innerText()), 'after creating an account the person is told to confirm their address, and which one');
  ok((await page.locator('.main').count()) === 0 && (await api(page, 'GET', '/api/v1/me')).status === 401, 'they are not signed in yet');

  // Signing in with the right password before confirming does not get in either; it sends the link again.
  await page.getByRole('button', { name: 'Sign in with a password' }).click();
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery-9');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByText(/Confirm your address to finish/).waitFor();
  ok((await api(page, 'GET', '/api/v1/me')).status === 401, 'the right password alone does not sign in an unconfirmed address');

  const mail = (await api(page, 'GET', `/api/test/outbox?to=${encodeURIComponent(email)}`)).body.mail;
  ok(mail && mail.kind === 'verify' && /Confirm this address/.test(mail.body), 'a confirmation link was sent to the address');
  const link = /https?:\/\/\S+/.exec(mail.body)[0];
  await page.goto(link);
  await page.getByRole('heading', { name: 'Name your workspace' }).waitFor();
  const me = (await api(page, 'GET', '/api/v1/me')).body;
  ok(me.user && me.user.email === email, 'opening the link confirms the address and signs the person in');

  // The few 401s and the 403 above are this test's doing; nothing else should be reported.
  ok(errors.filter((e) => !/40[13]/.test(e)).length === 0, `no page errors (${errors.join(' | ')})`);
});
