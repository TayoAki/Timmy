// Live mode: asking Timmy in the chat to file mail. By default it shows the change and waits; with the setting
// switched on it files what was clearly asked for. Either way an email still needs the Send button.
const { ok, open, signUp, api, connectGmail, deliver, sentMail, run } = require('./lib.cjs');

run('live-filing', async (browser) => {
  const { page, errors } = await open(browser);
  await signUp(page, { name: 'Dorothy Vaughan' });
  await connectGmail(page, 'dorothy@nasa.test');
  await deliver(page, { from: 'Deals <newsletter@shop.test>', subject: 'Weekly deals', body: 'Big savings this week. Unsubscribe here.' });
  await deliver(page, { from: 'Mary Jackson <mary@nasa.test>', subject: 'Wind tunnel slot', body: 'Dorothy, can I have the tunnel on Tuesday?' });
  await deliver(page, { from: 'Christine Darden <christine@nasa.test>', subject: 'Budget memo', body: 'Dorothy, the budget memo is attached for your review.' });
  await page.click('button[aria-label="Today & mail"]');
  let threads = [];
  for (let i = 0; i < 40 && threads.length < 3; i++) {
    threads = (await api(page, 'GET', '/api/v1/state')).body.slices.threads;
    await page.waitForTimeout(250);
  }
  const deals = threads.find((t) => t.subject === 'Weekly deals');
  const tunnel = threads.find((t) => t.subject === 'Wind tunnel slot');
  const memo = threads.find((t) => t.subject === 'Budget memo');
  const boxOf = async (id) => (await api(page, 'GET', '/api/v1/state')).body.slices.threads.find((t) => t.id === id).box;
  const labels = async (subject) => (await api(page, 'POST', '/api/test/fake', { op: 'labels' })).body.threads[subject] || [];

  const ask = async (text) => {
    if (!(await page.locator('.ai-input').isVisible().catch(() => false))) await page.keyboard.press('Control+i');
    await page.locator('.ai-input').waitFor();
    await page.locator('.ai-input').fill(text);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.ai-send .ai-spin', { timeout: 5000 }).catch(() => {});
    await page.waitForSelector('.ai-send .ai-spin', { state: 'detached', timeout: 30000 });
    await page.waitForTimeout(300);
  };
  const until = async (fn) => {
    for (let i = 0; i < 40; i++) {
      if (await fn()) return true;
      await page.waitForTimeout(250);
    }
    return false;
  };

  // The default: Timmy shows the filing and waits.
  await page.keyboard.press('Control+i');
  await page.locator('.ai-shell').waitFor();
  await ask(`archive thread ${deals.id}`);
  const card = page.locator('.ai-msg.timmy').last();
  await card.getByRole('button', { name: 'File it', exact: true }).waitFor();
  const shown = await card.innerText();
  ok(/“Weekly deals” to the archive/.test(shown) && /Nothing moves until you say so/.test(shown), 'the chat shows what would be filed where, and that nothing has moved');
  ok((await card.getByRole('button', { name: 'Send', exact: true }).count()) === 0, 'a filing has no Send button');
  ok((await boxOf(deals.id)) === 'inbox' && (await labels('Weekly deals')).includes('INBOX'), 'nothing has moved, in Timmy or in the mailbox');
  await card.getByRole('button', { name: 'File it', exact: true }).click();
  ok(await until(async () => (await boxOf(deals.id)) === 'archived'), 'after “File it” the thread is archived in Timmy');
  ok(await until(async () => !(await labels('Weekly deals')).includes('INBOX')), 'and out of the inbox in the mailbox');

  // Switch the setting on: the thread that is open on screen is filed without a second step when asked.
  await page.keyboard.press('Escape');
  await page.click('button[aria-label="Rules & settings"]');
  await page.getByRole('tab', { name: 'Approvals' }).click();
  await page.locator('select[name="approval-mode"]').selectOption('auto');
  await page.locator('.toast', { hasText: /file the thread you have open/ }).waitFor();
  await page.click('button[aria-label="Today & mail"]');
  await page.getByRole('tab', { name: /Triage/ }).click();
  await page.locator('.main').getByText('Wind tunnel slot').first().click();
  await page.locator('.main').getByText('can I have the tunnel on Tuesday?').first().waitFor();
  await ask(`archive thread ${tunnel.id}`);
  const second = page.locator('.ai-msg.timmy').last();
  ok(/You let Timmy decide routine filing, so it is filing this now/.test(await second.innerText()), 'with the setting on, the chat says Timmy is filing it itself');
  ok((await second.getByRole('button', { name: 'File it', exact: true }).count()) === 0, 'and asks for no second step');
  ok(await until(async () => (await boxOf(tunnel.id)) === 'archived'), 'the thread is archived');

  // The setting reaches no further than the open thread: asked about another one, Timmy still shows it and waits.
  await ask(`archive thread ${memo.id}`);
  const third = page.locator('.ai-msg.timmy').last();
  await third.getByRole('button', { name: 'File it', exact: true }).waitFor();
  await page.waitForTimeout(1500);
  ok((await boxOf(memo.id)) === 'inbox', 'with the setting on, a thread that is not the one open is not filed without the person’s OK');
  const audit = (await api(page, 'GET', '/api/v1/audit')).body.entries;
  ok(audit.some((e) => e.action === 'effect.approved' && e.actor === 'auto') && audit.some((e) => e.action === 'effect.approved' && e.actor !== 'auto'), 'the audit log shows which filing a person approved and which Timmy decided');

  // The setting changes nothing about email: a send still waits for the Send button.
  await ask('send to mary@nasa.test saying The tunnel is yours on Tuesday.');
  const send = page.locator('.ai-msg.timmy').last();
  await send.getByRole('button', { name: 'Send', exact: true }).waitFor();
  await page.waitForTimeout(6000);
  ok((await sentMail(page)).length === 0, 'with the setting on, an email is still not sent until Send is pressed');

  ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
});
