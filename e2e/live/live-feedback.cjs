// The Feedback button (src/live/Feedback.tsx, server/src/http/feedback.ts): from the rail, a few words to the Timmy team.
const { ok, open, signUp, run } = require('./lib.cjs');

run('live-feedback', async (browser) => {
  const { page, errors } = await open(browser);
  await signUp(page, { name: 'Grace Hopper' });
  await page.getByRole('tab', { name: /Triage/ }).click();
  await page.getByRole('button', { name: 'Send feedback' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send feedback' });
  await dialog.waitFor();
  ok(/name of the screen you're on goes with it, nothing that's on it/.test(await dialog.innerText()), 'the dialog says what goes with the feedback');
  ok(await dialog.getByRole('button', { name: 'Send', exact: true }).isDisabled(), 'it can’t be sent empty');
  await dialog.getByLabel('Your feedback').fill('The triage list is great, but I want a dark mode toggle here.');
  const sent = page.waitForResponse((r) => r.url().endsWith('/api/v1/feedback') && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  const res = await sent;
  const body = JSON.parse((await res.request().postData()) || '{}');
  ok(res.status() === 200 && body.page === 'today/triage', 'it is sent, with the screen’s name');
  await page.getByText('Thanks! Your feedback reached the Timmy team.').waitFor();
  ok((await dialog.count()) === 0, 'and the dialog closes with a thank-you');
  ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
});
