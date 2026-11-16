// Live mode: connect a mailbox, receive an email, see it arrive, have Timmy draft a reply and send it from Approvals,
// send with undo, send for real, check the audit log.
const { ok, open, signUp, api, connectGmail, compose, deliver, sentMail, run } = require('./lib.cjs');
const HOLD = Number(process.env.TIMMY_SEND_HOLD_SECONDS || 4) * 1000;

run('live-mail', async (browser) => {
  const { page, errors } = await open(browser);
  await signUp(page, { name: 'Grace Hopper' });

  // Nothing can be sent before a mailbox is connected.
  await compose(page, { to: 'dana@client.test', subject: 'Too early', body: 'This should not go anywhere.' });
  await page.locator('.toast', { hasText: 'Connect Gmail or Outlook first' }).waitFor();
  ok(true, 'sending without a mailbox is refused with a plain reason');
  await page.keyboard.press('Escape');

  await connectGmail(page, 'grace@navy.test');
  await page.click('button[aria-label="Connections"]');
  const card = page.locator('li', { has: page.getByText('Gmail', { exact: true }) }).first();
  await card.getByRole('button', { name: 'Disconnect' }).waitFor();
  ok(/grace@navy\.test/.test(await card.innerText()), 'Gmail shows as connected, with the address');
  ok((await sentMail(page)).length === 0, 'connecting sent nothing');

  // A new email arrives while the app is open: it appears without a reload.
  await page.click('button[aria-label="Today & mail"]');
  const got = await deliver(page, { from: 'Dana Whitfield <dana@client.test>', subject: 'Revised quote for 120 seats', body: 'Hi Grace,\n\nCould you send the revised quote by Friday?\n\nThanks,\nDana' });
  ok(got.body.ok, 'the test mailbox accepted the message and the signed webhook was taken');
  await page.getByRole('tab', { name: /Triage/ }).click();
  const row = page.locator('.main').getByText('Revised quote for 120 seats').first();
  await row.waitFor({ timeout: 10000 });
  ok(true, 'the new thread appears on its own');
  ok(/Dana Whitfield/.test(await page.locator('.main').innerText()), 'the sender shows by name, from the mailbox');

  await row.click();
  await page.locator('.main').getByText('Could you send the revised quote by Friday?').first().waitFor();
  ok(true, 'opening the thread shows the message');

  // Sorting it in Timmy files it in the mailbox too: a label for Follow Up, and it stays in Gmail's inbox.
  const labels = async () => (await api(page, 'POST', '/api/test/fake', { op: 'labels' })).body.threads['Revised quote for 120 seats'] || [];
  ok(!(await labels()).some((l) => /^Timmy/.test(l)), 'before it is sorted the thread has none of Timmy’s labels in the mailbox');
  await page.keyboard.press('Escape');
  await page.click('button[aria-label="Today & mail"]');
  await page.getByRole('tab', { name: /Triage/ }).click();
  await page.locator('.suggest-pill').first().click();
  let filed = [];
  for (let i = 0; i < 30 && !filed.includes('Timmy Follow Up'); i++) {
    await page.waitForTimeout(300);
    filed = await labels();
  }
  ok(filed.includes('Timmy Follow Up') && filed.includes('INBOX'), `accepting Timmy’s suggestion labels the thread in Gmail (${filed.join(', ')})`);
  ok((await sentMail(page)).length === 0, 'filing sends nothing');

  // The Draft button: Timmy writes a draft on the server; it shows up in Approvals and nothing is sent.
  const forDraft = (await api(page, 'GET', '/api/v1/state')).body.slices.threads.find((t) => t.subject === 'Revised quote for 120 seats');
  ok((await api(page, 'POST', '/api/v1/commands', { id: `draft-${Date.now()}`, action: { type: 'makeDraft', id: forDraft.id } })).body.ok, 'asking for a draft is accepted');
  await page.click('button[aria-label="Approvals"]');
  const drafted = page.locator('.ap-card', { hasText: 'Re: Revised quote for 120 seats' });
  await drafted.waitFor({ timeout: 15000 });
  ok(/Thanks for your message/.test(await drafted.innerText()), 'the draft Timmy wrote appears in Approvals on its own');
  ok((await sentMail(page)).length === 0, 'writing a draft sends nothing');

  // Approve the draft from Approvals: it waits out the undo window, then goes out once, as written, in Dana's thread.
  await drafted.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('.toast', { hasText: /Sending in \d+ seconds/ }).waitFor();
  ok((await sentMail(page)).length === 0, 'approving the draft does not send it before the undo window ends');
  let sent = [];
  for (let i = 0; i < 30 && sent.length === 0; i++) {
    await page.waitForTimeout(500);
    sent = await sentMail(page);
  }
  ok(sent.length === 1, 'when the window ends the approved draft is sent');
  ok(sent[0].to[0] === 'dana@client.test' && /^Thanks for your message/.test(sent[0].body), 'what went out is the draft that was approved, to the person who wrote');
  ok(sent[0].threadId === forDraft.ext.threadKey, 'it went out as a reply in the same mail thread');
  await page.waitForTimeout(HOLD + 2000);
  ok((await sentMail(page)).length === 1, 'the approved draft is sent once, not again');
  ok((await page.locator('.ap-card', { hasText: 'Re: Revised quote for 120 seats' }).count()) === 0, 'the sent draft has left Approvals');

  // Send a new email, then undo inside the window: nothing goes out.
  await compose(page, { to: 'dana@client.test', subject: 'Quote attached', body: 'Hi Dana, the revised quote is attached.' });
  const holding = page.locator('.toast', { hasText: /Sending in \d+ seconds/ });
  await holding.waitFor();
  ok(true, 'pressing Send starts the undo window instead of sending at once');
  ok((await sentMail(page)).length === 1, 'nothing has left during the window');
  await page.click('button[aria-label="Approvals"]');
  await page.locator('.ap-card', { hasText: 'Quote attached' }).waitFor();
  ok(/goes out when the undo window ends/.test(await page.locator('.ap-card', { hasText: 'Quote attached' }).innerText()), 'the held send is visible in Approvals');
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await page.locator('.toast', { hasText: 'Undone. Nothing was sent.' }).waitFor();
  await page.waitForTimeout(HOLD + 2500);
  ok((await sentMail(page)).length === 1, 'after Undo, the email never goes out');
  ok((await page.locator('.ap-card', { hasText: 'Quote attached' }).count()) === 0, 'the held send is gone from Approvals');

  // Send again and let the window pass: it goes out once.
  await compose(page, { to: 'dana@client.test', subject: 'Quote attached', body: 'Hi Dana, the revised quote is attached.' });
  await page.locator('.toast', { hasText: /Sending in \d+ seconds/ }).waitFor();
  for (let i = 0; i < 30 && sent.length === 1; i++) {
    await page.waitForTimeout(500);
    sent = await sentMail(page);
  }
  ok(sent.length === 2, 'when the window ends the email is sent');
  ok(sent[1].to[0] === 'dana@client.test' && sent[1].subject === 'Quote attached' && sent[1].body === 'Hi Dana, the revised quote is attached.', 'what was sent is exactly what was written');
  await page.waitForTimeout(HOLD + 2000);
  ok((await sentMail(page)).length === 2, 'it is sent once, not again');

  // The audit log has the whole story, in order.
  const audit = (await api(page, 'GET', '/api/v1/audit')).body.entries.map((e) => e.action).reverse();
  const last = audit.slice(audit.lastIndexOf('effect.proposed'));
  ok(last.join(',') === 'effect.proposed,effect.approved,effect.executing,effect.completed', `the audit log shows proposed, approved, executing, completed (${last.join(',')})`);
  ok(audit.includes('effect.cancelled'), 'the undone send is in the audit log as cancelled');
  ok(audit.includes('connection.active'), 'connecting the mailbox is in the audit log');

  // Reply on the thread: it goes out in the same thread, and the reply that comes back lands there too.
  const me = (await api(page, 'GET', '/api/v1/state')).body;
  const thread = me.slices.threads.find((t) => t.subject === 'Revised quote for 120 seats');
  const r = await api(page, 'POST', '/api/v1/commands', { id: `reply-${Date.now()}`, action: { type: 'reply', id: thread.id, body: 'It is $58 per seat.' } });
  ok(r.body.ok && r.body.holding, 'a reply also waits out the undo window');
  for (let i = 0; i < 30 && sent.length < 3; i++) {
    await page.waitForTimeout(500);
    sent = await sentMail(page);
  }
  ok(sent.length === 3 && sent[2].threadId === thread.ext.threadKey, 'the reply went out in the same mail thread');

  ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
});
