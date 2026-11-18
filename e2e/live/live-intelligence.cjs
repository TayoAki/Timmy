// Live mode, on a server with CopilotKit Intelligence on (CPK_INTELLIGENCE_API_KEY): a conversation with Timmy is kept
// in CopilotKit's cloud, so the same person sees it and can carry on from another browser; deleting it deletes it
// there too. On a server without Intelligence the suite says so and checks nothing.
const { BASE, ok, open, signUp, api, connectGmail, deliver, run } = require('./lib.cjs');

run('live-intelligence', async (browser) => {
  const { page, errors } = await open(browser);
  const who = await signUp(page, { name: 'Mary Jackson' });
  const info = (await api(page, 'GET', '/api/copilotkit/info')).body;
  if (info.mode !== 'intelligence') {
    ok(true, 'this server keeps conversations in its own memory (Intelligence is off): nothing to check');
    return;
  }
  await connectGmail(page, 'mary@nasa.test');
  await deliver(page, { from: 'Dorothy Vaughan <dorothy@nasa.test>', subject: 'Wind tunnel schedule', body: 'The tunnel is free on Thursday.' });
  for (let i = 0; i < 40 && !(await api(page, 'GET', '/api/v1/state')).body.slices.threads.length; i++) await page.waitForTimeout(250);

  const ask = async (p, text) => {
    if (!(await p.locator('.ai-input').isVisible().catch(() => false))) await p.keyboard.press('Control+i');
    await p.locator('.ai-input').fill(text);
    await p.keyboard.press('Enter');
    await p.waitForSelector('.ai-send .ai-spin', { timeout: 5000 }).catch(() => {});
    await p.waitForSelector('.ai-send .ai-spin', { state: 'detached', timeout: 60000 });
  };
  await page.click('button[aria-label="Today & mail"]');
  await page.keyboard.press('Control+i');
  await page.locator('.ai-shell').waitFor();
  await ask(page, 'find the email about the wind tunnel');
  ok(/Wind tunnel schedule/.test(await page.locator('.ai-msg.timmy').last().innerText()), 'Timmy answers through CopilotKit Intelligence');

  // Another browser, the same person: the conversation is there, and opens with its messages.
  const other = await open(browser);
  const p2 = other.page;
  await p2.goto(BASE);
  await p2.getByLabel('Work email').fill(who.email);
  await p2.getByLabel('Password').fill(who.password);
  await p2.getByRole('button', { name: 'Sign in', exact: true }).click();
  await p2.locator('.main').waitFor();
  await p2.keyboard.press('Control+i');
  await p2.locator('.ai-shell').waitFor();
  const saved = p2.locator('.ai-convo', { hasText: 'find the email about the wind tunnel' });
  await saved.waitFor({ timeout: 15000 });
  ok(true, 'in another browser, the conversation is listed');
  await saved.click();
  // CopilotKit files a run's messages a little after it ends; the chat says it is loading and asks again until they are there.
  await p2.locator('.ai-msg.timmy', { hasText: 'Wind tunnel schedule' }).first().waitFor({ timeout: 150000 });
  ok(true, 'and opens with what was said');
  await ask(p2, 'and who sent it?');
  ok((await p2.locator('.ai-error').count()) === 0 && (await p2.locator('.ai-msg.timmy').count()) >= 2, 'the person carries on the same conversation there');

  // Deleting it deletes it where it is kept.
  await p2.locator('.ai-convo-row', { hasText: 'find the email about the wind tunnel' }).getByRole('button', { name: /^Delete/ }).click();
  let gone = false;
  for (let i = 0; i < 20 && !gone; i++) {
    const threads = (await api(p2, 'GET', '/api/copilotkit/threads?agentId=timmy')).body.threads ?? [];
    gone = !threads.some((t) => /wind tunnel/.test(t.name ?? ''));
    if (!gone) await p2.waitForTimeout(500);
  }
  ok(gone, 'deleting the conversation deletes it in CopilotKit Intelligence too');

  // Another person never sees it.
  const third = await open(browser);
  await signUp(third.page, { name: 'Someone Else' });
  ok(((await api(third.page, 'GET', '/api/copilotkit/threads?agentId=timmy')).body.threads ?? []).length === 0, 'another person’s list has none of it');

  const bad = [...errors, ...other.errors].filter((e) => !/WebSocket|websocket/i.test(e));
  ok(bad.length === 0, `no page errors (${bad.join(' | ')})`);
});
