// Live mode: cold email is sent by hand. Timmy opens Gmail's compose window; nothing goes through the provider;
// the lead is marked contacted only when the email shows up in Sent, and a reply lands in the Unibox.
const { ok, open, signUp, api, connectGmail, deliver, sentMail, run } = require('./lib.cjs');

run('live-coldmail', async (browser) => {
  const { page, errors } = await open(browser);
  // Record what the app tries to open in a new tab instead of opening it.
  await page.addInitScript(() => {
    window.__opened = [];
    window.open = (url) => {
      window.__opened.push(String(url));
      return null;
    };
  });
  await signUp(page, { name: 'Ada Seller' });
  await connectGmail(page, 'ada@sellco.test');
  const lead = { id: 'lead-lee', first: 'Lee', last: 'Lead', email: 'lee@leadco.test', company: 'LeadCo', title: 'VP Operations', status: 'new', source: 'csv', fit: 70, added: new Date().toISOString() };
  ok((await api(page, 'POST', '/api/v1/commands', { id: `lead-${Date.now()}`, action: { type: 'out', op: { op: 'addLead', lead } } })).body.ok, 'a lead can be added to a real workspace');

  await page.click('button[aria-label="Outbound"]');
  await page.locator('button.lead-name', { hasText: 'Lee Lead' }).click();
  await page.getByRole('button', { name: 'Email', exact: true }).first().click();
  const form = page.locator('.msg-form');
  await form.waitFor();
  // The starting template is signed by the person using the workspace, not by the demo's sample persona.
  const starting = await form.locator('textarea.msg-body').inputValue();
  ok(/\nAda$/.test(starting.trim()) && !/Taylor|Northpeak/.test(starting), `the template signs as the signed-in person (${JSON.stringify(starting.trim().slice(-20))})`);
  await form.locator('input.input').first().fill('Quick idea for LeadCo');
  await form.locator('textarea.msg-body').fill('Hi Lee,\n\nA quick idea for LeadCo.\n\nAda');
  ok(/Timmy never sends cold email itself/.test(await page.locator('.modal').last().innerText()), 'the dialog says the email is sent by hand');
  await page.locator('.modal').last().getByRole('button', { name: 'Open in Gmail' }).click();

  await page.locator('.toast', { hasText: /Opened in Gmail/ }).waitFor();
  const opened = await page.evaluate(() => window.__opened);
  ok(opened.length === 1 && opened[0].startsWith('https://mail.google.com/mail/?view=cm'), 'pressing Send opens Gmail’s own compose window');
  const u = new URL(opened[0]);
  ok(u.searchParams.get('to') === 'lee@leadco.test' && u.searchParams.get('su') === 'Quick idea for LeadCo' && /A quick idea for LeadCo\./.test(u.searchParams.get('body')), 'the compose window is filled in with the recipient, subject and text');
  ok(u.searchParams.get('authuser') === 'ada@sellco.test', 'it opens in the connected mailbox');
  ok((await sentMail(page)).length === 0, 'Timmy sent nothing through the provider');
  let state = (await api(page, 'GET', '/api/v1/state')).body.slices;
  ok(state['out.messages'].length === 0 && state['out.leads']['lead-lee'].status === 'new', 'the lead is not shown as contacted just because the window opened');
  ok((await api(page, 'GET', '/api/v1/audit')).body.entries.every((e) => !/^effect\./.test(e.action)), 'no send was recorded, because none happened');

  // The person presses Send in Gmail. Sync sees it in Sent.
  await api(page, 'POST', '/api/test/fake', { op: 'sent-by-hand', message: { to: 'lee@leadco.test', subject: 'Quick idea for LeadCo', body: 'Hi Lee,\n\nA quick idea for LeadCo.\n\nAda' } });
  for (let i = 0; i < 40; i++) {
    state = (await api(page, 'GET', '/api/v1/state')).body.slices;
    if (state['out.leads']['lead-lee'].status === 'contacted') break;
    await page.waitForTimeout(250);
  }
  ok(state['out.leads']['lead-lee'].status === 'contacted' && state['out.messages'].length === 1 && state['out.messages'][0].dir === 'out', 'once the email is in Sent, the lead is contacted and the email is in its history');

  // The lead replies.
  await deliver(page, { from: 'Lee Lead <lee@leadco.test>', subject: 'Re: Quick idea for LeadCo', body: 'Interested. Thursday?' });
  for (let i = 0; i < 40; i++) {
    state = (await api(page, 'GET', '/api/v1/state')).body.slices;
    if (state['out.leads']['lead-lee'].status === 'replied') break;
    await page.waitForTimeout(250);
  }
  ok(state['out.leads']['lead-lee'].status === 'replied' && state['out.messages'].some((m) => m.dir === 'in' && /Thursday/.test(m.body)), 'the reply is recorded against the lead');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: /Unibox/ }).click();
  await page.locator('.main').getByText('Interested. Thursday?').first().waitFor({ timeout: 10000 });
  ok(true, 'and it shows in the Unibox');

  // Answering a lead who wrote back is an ordinary reply: it waits out the undo window, goes once, and no mail app opens.
  const HOLD = Number(process.env.TIMMY_SEND_HOLD_SECONDS || 4) * 1000;
  await page.locator('button.ubx-row', { hasText: 'Lee Lead' }).click();
  const convo = page.getByRole('region', { name: 'Conversation with Lee Lead' });
  await convo.waitFor();
  const windowsBefore = (await page.evaluate(() => window.__opened)).length;
  const sentBefore = (await sentMail(page)).length;
  await convo.getByRole('textbox', { name: 'Reply' }).fill('Thursday at 10 works. Talk then.');
  await convo.getByRole('button', { name: 'Send' }).click();
  const notice = page.locator('.toast', { hasText: /Sending in \d+ seconds/ });
  await notice.waitFor();
  ok((await page.evaluate(() => window.__opened)).length === windowsBefore, 'replying to a lead who wrote back opens no mail app');
  ok((await notice.getByRole('button', { name: 'Undo' }).count()) === 1, 'it waits out the undo window, with Undo on the notice');
  await convo.locator('[data-reply="holding"]', { hasText: 'Thursday at 10 works. Talk then.' }).waitFor({ timeout: 10000 });
  ok((await sentMail(page)).length === sentBefore, 'the Unibox shows it on its way, and nothing has gone yet');
  let replied;
  for (let i = 0; i < 40 && !replied; i++) {
    await page.waitForTimeout(500);
    replied = (await sentMail(page)).find((m) => m.body === 'Thursday at 10 works. Talk then.');
  }
  const leeThread = (await api(page, 'GET', '/api/v1/state')).body.slices.threads.find((t) => t.subject === 'Quick idea for LeadCo');
  ok(replied && replied.to.includes('lee@leadco.test') && leeThread && replied.threadId === leeThread.ext.threadKey, 'when the window ends it goes out as a reply in Lee’s own thread, through the connected mailbox');
  await convo.locator('[data-reply="sent"]', { hasText: 'Thursday at 10 works. Talk then.' }).waitFor({ timeout: 10000 });
  ok(true, 'and the Unibox shows it as sent');
  await page.waitForTimeout(HOLD + 1500);
  ok((await sentMail(page)).filter((m) => m.body === 'Thursday at 10 works. Talk then.').length === 1, 'it is sent once');
  const audit = (await api(page, 'GET', '/api/v1/audit')).body.entries;
  // Replying also files the thread in the mailbox, as any reply does: that is a second effect. Each ran once.
  const ran = audit.filter((e) => e.action === 'effect.executing');
  ok(ran.length >= 1 && new Set(ran.map((e) => e.effect_id)).size === ran.length && audit.some((e) => e.action === 'effect.completed'), 'the audit log shows each effect run once');

  // A second reply, taken back with Undo before its window ends: nothing goes.
  await convo.getByRole('textbox', { name: 'Reply' }).fill('Actually, could we make it Friday?');
  await convo.getByRole('button', { name: 'Send' }).click();
  const second = page.locator('.toast', { hasText: /Sending in \d+ seconds/ });
  await second.waitFor();
  await second.getByRole('button', { name: 'Undo' }).click();
  await page.locator('.toast', { hasText: 'Undone. Nothing was sent.' }).waitFor();
  await page.waitForTimeout(HOLD + 1500);
  ok(!(await sentMail(page)).some((m) => /Friday/.test(m.body)), 'Undo inside the window stops the reply: nothing is sent');
  ok((await convo.locator('[data-reply]', { hasText: 'Friday' }).count()) === 0, 'and it is gone from the conversation');

  ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
});
