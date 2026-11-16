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

  ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
});
