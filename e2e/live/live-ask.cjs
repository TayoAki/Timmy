// Live mode: Ask Timmy over real (test) mail, and a send proposed in chat that needs the Send button.
const { ok, open, signUp, api, connectGmail, deliver, sentMail, run } = require('./lib.cjs');

run('live-ask', async (browser) => {
  const { page, errors } = await open(browser);
  await signUp(page, { name: 'Katherine Johnson' });
  await connectGmail(page, 'katherine@nasa.test');
  await deliver(page, { from: 'John Glenn <john@nasa.test>', subject: 'Trajectory numbers', body: 'Please check the trajectory numbers before Friday.' });
  await page.click('button[aria-label="Today & mail"]');
  // The message is stored by a background job; wait until it has landed.
  for (let i = 0; i < 40; i++) {
    if ((await api(page, 'GET', '/api/v1/state')).body.slices.threads.length) break;
    await page.waitForTimeout(250);
  }

  const ask = async (text) => {
    // Pressing a choice can open another screen and close the chat; open it again if so.
    if (!(await page.locator('.ai-input').isVisible().catch(() => false))) await page.keyboard.press('Control+i');
    await page.locator('.ai-input').waitFor();
    await page.locator('.ai-input').fill(text);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.ai-send .ai-spin', { timeout: 5000 }).catch(() => {});
    await page.waitForSelector('.ai-send .ai-spin', { state: 'detached', timeout: 30000 });
    await page.waitForTimeout(300);
  };

  await page.keyboard.press('Control+i');
  await page.locator('.ai-shell').waitFor();
  await ask('find the email about trajectory');
  const answer = await page.locator('.ai-msg.timmy').last().innerText();
  ok(/Trajectory numbers/.test(answer), `Ask answered from the synced mail (“${answer.replace(/\s+/g, ' ').slice(0, 80)}”)`);
  ok((await page.locator('.ai-error').count()) === 0, 'no error in the chat');

  // A send proposed in chat shows the exact email and waits for the button.
  await ask('send to john@nasa.test saying The numbers check out.');
  const card = page.locator('.ai-msg.timmy').last();
  await card.getByRole('button', { name: 'Send', exact: true }).waitFor();
  const shown = await card.innerText();
  ok(/To: john@nasa\.test/.test(shown) && /The numbers check out\./.test(shown), 'the chat shows who it goes to and the exact text');
  ok(/Nothing is sent until you press Send/.test(shown), 'the chat says nothing is sent yet');
  await page.waitForTimeout(1500);
  ok((await sentMail(page)).length === 0, 'nothing was sent by asking');
  const pending = (await api(page, 'GET', '/api/v1/state')).body.slices.pending;
  ok(pending.length === 1 && pending[0].status === 'waiting' && pending[0].waitingOn === 'you', 'the email is waiting for this person’s OK');

  await card.getByRole('button', { name: 'Send', exact: true }).click();
  let sent = [];
  for (let i = 0; i < 40 && sent.length === 0; i++) {
    await page.waitForTimeout(500);
    sent = await sentMail(page);
  }
  ok(sent.length === 1 && sent[0].to[0] === 'john@nasa.test' && sent[0].body === 'The numbers check out.', 'after Send and the undo window, exactly that email went out');
  const audit = (await api(page, 'GET', '/api/v1/audit')).body.entries;
  const approved = audit.find((e) => e.action === 'effect.approved');
  ok(approved && approved.detail.via === 'click', 'the audit log records that a person approved it');

  // Turning one down: nothing goes out.
  await ask('send to john@nasa.test saying Second message.');
  const second = page.locator('.ai-msg.timmy').last();
  await second.getByRole('button', { name: 'Don’t send' }).click();
  await page.waitForTimeout(6000);
  ok((await sentMail(page)).length === 1, 'a declined email is never sent');
  ok((await api(page, 'GET', '/api/v1/state')).body.slices.pending.length === 0, 'nothing is left waiting');

  // The conversation quotes mail. It is kept under this person's own key, and signing out removes it from the browser.
  const keys = () => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('timmy-agent-v1')));
  const kept = await keys();
  ok(kept.length === 1 && /^timmy-agent-v1:.+:.+$/.test(kept[0]), `the chat history is stored per person and workspace (${kept.join(', ')})`);
  await page.keyboard.press('Escape');
  await page.click('button[aria-label="Rules & settings"]');
  await page.getByRole('tab', { name: 'Approvals' }).click();
  await page.locator('.live-settings').getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('heading', { name: 'Sign in to Timmy' }).waitFor();
  ok((await keys()).length === 0, 'after signing out no conversation is left in this browser');

  ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
});
