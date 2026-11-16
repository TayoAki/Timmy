// Live mode: two people in two workspaces, in two browsers. Neither ever sees the other's data.
const { ok, open, signUp, api, connectGmail, deliver, run } = require('./lib.cjs');

run('live-isolation', async (browser) => {
  const a = await open(browser);
  const b = await open(browser);
  await signUp(a.page, { name: 'Alice Alpha', company: 'Alpha Works' });
  await signUp(b.page, { name: 'Bob Bravo', company: 'Bravo Works' });
  await connectGmail(a.page, 'alice@alpha.test');
  await connectGmail(b.page, 'bob@bravo.test');
  await deliver(a.page, { from: 'Carol <carol@client.test>', subject: 'Alpha launch plan', body: 'The alpha code word is PINEAPPLE.' });
  await deliver(b.page, { from: 'Dave <dave@client.test>', subject: 'Bravo launch plan', body: 'The bravo code word is MANGO.' });
  await api(a.page, 'POST', '/api/v1/commands', { id: `a-${Date.now()}`, action: { type: 'addRule', group: 'triage', text: 'Alpha-only rule about pineapples.' } });

  for (const [me, mine, theirs] of [[a, 'Alpha', 'Bravo'], [b, 'Bravo', 'Alpha']]) {
    await me.page.click('button[aria-label="Today & mail"]');
    await me.page.getByRole('tab', { name: /Triage/ }).click();
    await me.page.locator('.main').getByText(`${mine} launch plan`).first().waitFor({ timeout: 10000 });
    const text = await me.page.locator('body').innerText();
    ok(!new RegExp(`${theirs} launch plan|${theirs} Works`).test(text), `${mine} does not see ${theirs}'s mail or name on screen`);
    const state = JSON.stringify((await api(me.page, 'GET', '/api/v1/state')).body);
    ok(!new RegExp(theirs === 'Bravo' ? 'MANGO|Bravo|bravo' : 'PINEAPPLE|Alpha|alpha|pineapples').test(state), `${mine}'s state from the API holds nothing of ${theirs}'s`);
    const audit = JSON.stringify((await api(me.page, 'GET', '/api/v1/audit')).body);
    ok(!new RegExp(theirs === 'Bravo' ? 'bob@bravo' : 'alice@alpha').test(audit), `${mine}'s audit log holds nothing of ${theirs}'s`);
  }

  // Ask in one workspace cannot find the other's mail.
  await b.page.keyboard.press('Control+i');
  await b.page.locator('.ai-input').fill('find the email about alpha launch');
  await b.page.keyboard.press('Enter');
  await b.page.waitForSelector('.ai-send .ai-spin', { timeout: 5000 }).catch(() => {});
  await b.page.waitForSelector('.ai-send .ai-spin', { state: 'detached', timeout: 30000 });
  const answer = await b.page.locator('.ai-msg.timmy').last().innerText();
  ok(!/Alpha launch plan|PINEAPPLE/.test(answer), `Ask in Bravo finds nothing from Alpha (“${answer.replace(/\s+/g, ' ').slice(0, 70)}”)`);

  // One workspace's ids mean nothing in the other.
  const aThread = (await api(a.page, 'GET', '/api/v1/state')).body.slices.threads[0];
  const before = JSON.stringify((await api(a.page, 'GET', '/api/v1/state')).body.slices.threads);
  await api(b.page, 'POST', '/api/v1/commands', { id: `x-${Date.now()}`, action: { type: 'move', id: aThread.id, box: 'archived' } });
  await api(b.page, 'POST', '/api/v1/commands', { id: `y-${Date.now()}`, action: { type: 'reply', id: aThread.id, body: 'hijack' } });
  ok(JSON.stringify((await api(a.page, 'GET', '/api/v1/state')).body.slices.threads) === before, 'commands from Bravo aimed at Alpha’s thread change nothing in Alpha');
  ok((await api(b.page, 'POST', '/api/test/fake', { op: 'sent' })).body.sent.length === 0, 'and nothing was sent');

  // A change in Alpha reaches Alpha's open tab on its own, and never Bravo's.
  await a.page.click('button[aria-label="Rules & settings"]');
  await a.page.getByRole('tab', { name: 'Triage' }).click();
  await b.page.keyboard.press('Escape');
  await b.page.click('button[aria-label="Rules & settings"]');
  await b.page.getByRole('tab', { name: 'Triage' }).click();
  const a2 = await a.context.newPage();
  await a2.goto(a.page.url());
  await a2.locator('.main').waitFor();
  await api(a2, 'POST', '/api/v1/commands', { id: `z-${Date.now()}`, action: { type: 'addRule', group: 'triage', text: 'Pushed live to Alpha tabs.' } });
  await a.page.locator('.main').getByText('Pushed live to Alpha tabs.').waitFor({ timeout: 10000 });
  ok(true, 'a change made in another Alpha tab shows up without a reload');
  await b.page.waitForTimeout(1500);
  ok(!/Pushed live to Alpha tabs|pineapples/.test(await b.page.locator('.main').innerText()), 'Bravo’s open tab never receives it');

  ok(a.errors.length === 0 && b.errors.length === 0, `no page errors (${[...a.errors, ...b.errors].join(' | ')})`);
});
