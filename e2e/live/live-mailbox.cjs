// Live mode: what the person does in Gmail itself shows up in Timmy. A thread archived, labelled, read, put back
// or deleted in the mailbox moves to match in the open app, and Timmy writes nothing back to the mailbox for it.
const { ok, open, signUp, api, connectGmail, deliver, sentMail, run } = require('./lib.cjs');

run('live-mailbox', async (browser) => {
  const { page, errors } = await open(browser);
  await signUp(page, { name: 'Annie Easley' });
  await connectGmail(page, 'annie@nasa.test');
  const main = page.locator('.main');
  const until = async (fn) => {
    for (let i = 0; i < 40; i++) {
      if (await fn()) return true;
      await page.waitForTimeout(250);
    }
    return false;
  };
  const threadOf = async (subject) => (await api(page, 'GET', '/api/v1/state')).body.slices.threads.find((t) => t.subject === subject);
  const labels = async (subject) => (await api(page, 'POST', '/api/test/fake', { op: 'labels' })).body.threads[subject] || [];
  const effectRecords = async () => (await api(page, 'GET', '/api/v1/audit')).body.entries.filter((e) => e.action === 'effect.proposed');
  /** The person does something to a thread in Gmail itself. */
  const inGmail = (subject, change) => api(page, 'POST', '/api/test/fake', { op: 'in-mailbox', subject, ...change });
  /** Timmy looks at the mailbox now: the same look that runs with the nightly check, in the morning run, and while the app is open. */
  const look = async () => (await api(page, 'POST', '/api/test/fake', { op: 'check-mailbox' })).body.checked;

  await page.click('button[aria-label="Today & mail"]');
  await deliver(page, { from: 'Dana Whitfield <dana@client.test>', subject: 'Venue contract', body: 'Annie, can you sign the venue contract this week?' });
  await deliver(page, { from: 'Sam Rivera <sam@client.test>', subject: 'Catering menu', body: 'Annie, which menu do you want for the launch?' });
  await page.getByRole('tab', { name: /Triage/ }).click();
  await main.getByText('Venue contract').first().waitFor({ timeout: 10000 });
  await main.getByText('Catering menu').first().waitFor({ timeout: 10000 });
  ok(true, 'two new threads are in Triage');

  // Archived in Gmail. Until Timmy looks at the mailbox nothing has changed here.
  ok((await inGmail('Venue contract', { remove: ['INBOX'] })).body.ok, 'the person archives one of them in Gmail itself');
  ok(!(await labels('Venue contract')).includes('INBOX') && (await threadOf('Venue contract')).box === 'inbox', 'it is out of Gmail’s inbox, and Timmy has not looked yet');
  const first = await look();
  ok(first.ran && first.calls === 1 && first.moved === 1, `one look costs one call to the mailbox and finds the one change (${JSON.stringify(first)})`);
  await main.getByText('Venue contract').first().waitFor({ state: 'detached', timeout: 10000 });
  ok(true, 'the thread leaves Triage in the open app, without a reload');
  await page.locator('.side-foot .nav-item', { hasText: 'Archived' }).click();
  await main.getByText('Venue contract').first().waitFor({ timeout: 10000 });
  ok(true, 'and is listed under Archived');
  await main.getByText('Venue contract').first().click();
  await page.getByRole('tab', { name: /Timmy’s log/ }).click();
  await main.getByText('Archived in Gmail').first().waitFor({ timeout: 10000 });
  ok(true, 'its log says it was archived in Gmail');
  ok((await effectRecords()).length === 0, 'picking it up made no effect record');
  const after = await labels('Venue contract');
  ok(!after.includes('INBOX') && !after.some((l) => /^Timmy/.test(l)) && (await sentMail(page)).length === 0, 'nothing was written back: the mailbox is as the person left it, and nothing was sent');

  // One of Timmy's labels put on in Gmail.
  await page.keyboard.press('Escape');
  await inGmail('Catering menu', { add: ['Timmy Waiting'] });
  ok((await look()).moved === 1, 'the look finds the label');
  await page.click('button[aria-label="Today & mail"]');
  await page.locator('button.nav-item', { hasText: 'Waiting' }).first().click();
  await main.getByText('Catering menu').first().waitFor({ timeout: 10000 });
  ok(true, 'a thread labelled “Timmy Waiting” in Gmail is listed under Waiting');
  const waiting = await threadOf('Catering menu');
  ok(waiting.history.at(-1).text === 'Filed under Waiting in Gmail' && waiting.unread === true, 'its log says where that was done, and it is still unread, as in Gmail');

  // Read in Gmail.
  await inGmail('Catering menu', { remove: ['UNREAD'] });
  const read = await look();
  ok(read.marked === 1 && read.moved === 0, 'reading it in Gmail is found as a change to the unread mark only');
  ok(await until(async () => (await threadOf('Catering menu')).unread === false), 'it is no longer marked unread in Timmy');

  // Back in Gmail's inbox.
  await inGmail('Venue contract', { add: ['INBOX'] });
  await look();
  await page.click('button[aria-label="Today & mail"]');
  await page.getByRole('tab', { name: /Triage/ }).click();
  await main.getByText('Venue contract').first().waitFor({ timeout: 10000 });
  ok(true, 'moved back to the inbox in Gmail, the thread is back in Triage');

  // A move made in Timmy is still written to Gmail, once, and the next look does not take it for a change made there.
  const venue = await threadOf('Venue contract');
  ok((await api(page, 'POST', '/api/v1/commands', { id: `move-${Date.now()}`, action: { type: 'move', id: venue.id, box: 'follow-up' } })).body.ok, 'the thread is moved to Follow Up in Timmy');
  ok(await until(async () => (await labels('Venue contract')).includes('Timmy Follow Up')), 'that move is written to Gmail as a label');
  const own = await look();
  ok(own.moved === 0 && (await threadOf('Venue contract')).box === 'follow-up', 'the next look leaves the thread where the person put it');
  ok((await effectRecords()).length === 1, 'the only effect record is the one for the move made in Timmy');

  // Deleted in Gmail.
  await inGmail('Catering menu', { remove: ['INBOX'], add: ['TRASH'] });
  ok((await look()).removed === 1, 'the look finds the thread in Gmail’s trash');
  await page.locator('button.nav-item', { hasText: 'Waiting' }).first().click();
  ok(await until(async () => (await main.getByText('Catering menu').count()) === 0), 'deleted in Gmail, the thread is gone from Timmy’s screens');
  ok((await threadOf('Catering menu')) === undefined, 'and from the workspace’s list of threads');
  await page.click('button[aria-label="Timmy’s activity"]');
  await main.getByText('“Catering menu” was deleted in Gmail, so it is no longer shown in Timmy').first().waitFor({ timeout: 10000 });
  ok(true, 'the activity log says what happened to it');
  ok((await effectRecords()).length === 1 && (await sentMail(page)).length === 0, 'through all of it, nothing but the person’s own move was written to the mailbox, and nothing was sent');

  // Opening the app is itself a reason to look: this time nothing asks for the look but the page being opened.
  // It looks at most every five minutes, however often the page is reloaded.
  await page.click('button[aria-label="Today & mail"]');
  await deliver(page, { from: 'Dana Whitfield <dana@client.test>', subject: 'Parking permits', body: 'Annie, how many parking permits do you need?' });
  await page.getByRole('tab', { name: /Triage/ }).click();
  await main.getByText('Parking permits').first().waitFor({ timeout: 10000 });
  await inGmail('Parking permits', { remove: ['INBOX'] });
  // The mailbox was looked at a moment ago (above). Reloaded now, and again, the page asks for a look that is not made.
  for (let i = 0; i < 2; i++) {
    await page.reload();
    await main.waitFor();
    await page.waitForTimeout(3000);
  }
  await page.getByRole('tab', { name: /Triage/ }).click();
  // Asked of the page itself first: loading the state through the API is what an opening page does, and would count as one.
  await main.getByText('Parking permits').first().waitFor({ timeout: 10000 });
  ok(true, 'reloaded twice within five minutes of the last look, the page has not looked again: the thread archived in Gmail is still in Triage');
  ok((await threadOf('Parking permits')).box === 'inbox', 'and the workspace still has it in the inbox');
  // Six minutes later (only the record of the last look is moved back), opening the app looks again.
  await api(page, 'POST', '/api/test/fake', { op: 'looked-ago', minutes: 6 });
  await page.reload();
  await main.waitFor();
  ok(await until(async () => (await threadOf('Parking permits')).box === 'archived'), 'opening the app again picks it up, with nothing else asking for a look');
  await page.getByRole('tab', { name: /Triage/ }).click();
  ok(await until(async () => (await main.getByText('Parking permits').count()) === 0), 'and the thread is gone from Triage');

  ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
});
