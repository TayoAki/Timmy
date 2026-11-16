// Live mode: the scheduled morning run. It drafts replies to mail that needs an answer, says what it did on Today,
// and sends nothing. No run time is claimed before a mailbox is connected.
const { ok, open, signUp, api, connectGmail, deliver, sentMail, run } = require('./lib.cjs');

run('live-morning', async (browser) => {
  const { page, errors } = await open(browser);
  await signUp(page, { name: 'Katherine Johnson' });

  const claims = /Last run|First morning run|next (today|tomorrow|\w+day) at/i;
  ok(!claims.test(await page.locator('body').innerText()), 'before a mailbox is connected, no morning run time is claimed');
  ok((await page.locator('.run-control').count()) === 0, 'and there is no run-time control yet');

  await connectGmail(page, 'katherine@nasa.test');
  await page.click('button[aria-label="Today & mail"]');
  await page.locator('.run-control').waitFor();
  ok(/First morning run (today|tomorrow|\w+day) at/.test(await page.locator('body').innerText()), 'once mail is connected, the bottom bar says when the first run is');
  const settings = (await api(page, 'GET', '/api/v1/settings')).body;
  const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  ok(zone === 'UTC' || settings.timezone === zone, `the workspace runs on its owner’s clock (${settings.timezone})`);

  await deliver(page, { from: 'John Glenn <john@nasa.test>', subject: 'Trajectory numbers', body: 'Katherine,\n\nCan you check the trajectory numbers before Friday?\n\nJohn' });
  await deliver(page, { from: 'Deals <newsletter@shop.test>', subject: 'Weekly deals', body: 'Big savings this week. Unsubscribe here.' });
  await page.getByRole('tab', { name: /Triage/ }).click();
  await page.locator('.main').getByText('Trajectory numbers').first().waitFor({ timeout: 10000 });

  // The run happens (a test hook stands in for the clock reaching the scheduled time).
  const ran = (await api(page, 'POST', '/api/test/morning-run', {})).body.run;
  ok(ran && ran.sorted === 2 && ran.drafted === 1, `the run found both new threads and drafted one reply (${JSON.stringify(ran)})`);
  await page.getByRole('tab', { name: /Daily brief/ }).click();
  await page.getByText(/Timmy’s morning run at .+ found 2 threads with new mail and drafted 1 reply\./).waitFor({ timeout: 10000 });
  ok(true, 'Today says what the morning run did, without a reload');
  ok(/Last run \d/.test(await page.locator('body').innerText()), 'the bottom bar shows when the last run was');

  await page.click('button[aria-label="Approvals"]');
  const drafted = page.locator('.ap-card', { hasText: 'Re: Trajectory numbers' });
  await drafted.waitFor({ timeout: 10000 });
  ok(/Thanks for your message/.test(await drafted.innerText()), 'the reply it drafted is waiting in Approvals');
  ok((await page.locator('.ap-card', { hasText: 'Weekly deals' }).count()) === 0, 'the newsletter got no draft');
  ok((await sentMail(page)).length === 0, 'the morning run sent nothing');
  const state = (await api(page, 'GET', '/api/v1/state')).body.slices;
  ok(state.threads.find((t) => t.subject === 'Trajectory numbers').box === 'inbox', 'and it moved nothing: the thread is still in the inbox for the person to sort');
  ok(/Morning run: 2 threads with new mail, 1 reply drafted\./.test(state.activity[0].text), 'the run is in Timmy’s activity log');

  // A second start the same day does nothing.
  ok((await api(page, 'POST', '/api/test/morning-run', {})).body.run === null, 'the run happens once a day');

  ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
});
