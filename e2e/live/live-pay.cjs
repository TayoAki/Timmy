// Card payments for invoices on a real workspace, with the stand-in Stripe (server/src/payments): the owner connects
// the business's own Stripe account through Stripe's page and comes back with card payments on; an invoice sent then
// carries a "Pay online" link in its email and its PDF; the client pays on Stripe's page, Stripe's signed event marks
// the invoice paid and its email leaves Waiting; a payment whose event never came is found with Check Stripe.
const { ok, open, signUp, api, connectGmail, sentMail, releaseHolds, run, BASE } = require('./lib.cjs');

run('live-pay', async (browser) => {
  const { page, errors } = await open(browser);
  const me = await signUp(page, { name: 'Grace Hopper' });
  await connectGmail(page, 'grace@hopper.test');
  const slices = async () => (await api(page, 'GET', '/api/v1/state')).body.slices;
  const until = async (test) => {
    for (let i = 0; i < 60; i++) {
      const s = await slices();
      if (test(s)) return s;
      await page.waitForTimeout(150);
    }
    return null;
  };

  // Business details: connect Stripe.
  await page.click('button[aria-label="Invoices & quotes"]');
  await page.locator('.nav-item', { hasText: 'Business details' }).click();
  const card = page.getByLabel('Get paid online');
  await card.getByRole('button', { name: 'Connect Stripe' }).waitFor();
  ok(/your own Stripe account/.test(await card.innerText()), 'Business details offers card payments, into the business’s own Stripe account');
  await page.locator('.inv-form label', { hasText: 'How clients pay you' }).locator('textarea').fill('Bank transfer to Hopper Studio, account 0042.');
  await page.getByRole('button', { name: 'Save details' }).click();
  await page.locator('.toast', { hasText: 'Business details saved' }).waitFor();
  await card.getByLabel('Country').selectOption('US');
  await card.getByRole('button', { name: 'Connect Stripe' }).click();
  // Stripe's page (the stand-in's), then back to Timmy.
  await page.waitForURL((u) => u.pathname === '/' && !u.search.includes('payments='), { timeout: 15000 });
  await page.locator('.toast', { hasText: 'Stripe is connected' }).waitFor();
  await card.getByText('Card payments are on.').waitFor();
  ok(true, 'back from Stripe’s page, card payments are on');
  ok((await api(page, 'GET', '/api/v1/payments/status')).body.stripe === 'ready', 'the server says the same');

  // An invoice, sent: its email and PDF carry the link.
  await page.locator('.nav-item', { hasText: 'Invoices' }).first().click();
  await page.locator('.inv-head').getByRole('button', { name: 'New invoice' }).click();
  await page.locator('.inv-paper.editing').waitFor();
  await page.getByLabel('Client name').fill('Sam Rivera');
  await page.getByLabel('Client email').fill('sam@acme.test');
  await page.getByLabel('Line 1 description').fill('Design work, November');
  await page.getByLabel('Line 1 quantity').fill('12');
  await page.getByLabel('Line 1 price').fill('150');
  await page.locator('.pay-row', { hasText: 'Sending it adds a “Pay online” link' }).waitFor();
  ok(true, 'the invoice says sending it adds a payment link');
  const s1 = await until((s) => Object.values(s['ws.invoices'] ?? {}).some((x) => x.items[0]?.unitPrice === 15000 && x.client.email === 'sam@acme.test'));
  const inv = Object.values(s1['ws.invoices']).find((x) => x.number === 'INV-0001');
  await page.locator('.inv-bar').getByRole('button', { name: 'Send', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New message' });
  await dialog.waitFor();
  const body = await dialog.locator('.compose-body').inputValue();
  const url = (body.match(/Pay online by card:\n(https:\/\/\S+)/) || [])[1];
  ok(url && /Or pay:\nBank transfer to Hopper Studio/.test(body), 'the email has the “Pay online” link, and the bank details as the other way');
  const pdf = (await (await page.request.get(new URL(`/api/v1/invoices/${inv.id}/pdf`, BASE).toString())).body()).toString('latin1');
  ok(pdf.includes(url), 'the PDF carries the same link');
  await dialog.getByRole('button', { name: /^Send/ }).first().click();
  await releaseHolds(page);
  let mail;
  for (let i = 0; i < 40 && !mail; i++) {
    mail = (await sentMail(page)).find((m) => m.subject === `Invoice INV-0001 from ${me.company}`);
    if (!mail) await page.waitForTimeout(150);
  }
  ok(mail && mail.body.includes(url), 'the email that went to Sam has the link');
  const row = page.getByLabel('Payment link');
  await row.waitFor();
  ok((await row.locator('a.pay-url').getAttribute('href')) === url && (await row.getByRole('button', { name: 'Check Stripe' }).count()) === 1, 'the invoice shows its link, with Check Stripe');

  // Sam pays on Stripe's page; Stripe's signed event marks it paid.
  const paid = await api(page, 'POST', '/api/test/stripe', { op: 'pay', invoice: inv.id });
  ok(paid.body.delivered?.status === 200 && paid.body.delivered.body.applied === true, 'Stripe’s signed event is taken');
  await page.locator('.pay-row-paid', { hasText: 'Paid online' }).waitFor();
  ok(/\$1,800\.00 through Stripe/.test(await page.locator('.pay-row-paid').innerText()), 'the invoice says it was paid online, how much, and through Stripe');
  const s2 = await until((s) => s['ws.invoices'][inv.id]?.status === 'paid' && s.threads.find((t) => t.id === s['ws.invoices'][inv.id].thread)?.box === 'archived');
  ok(s2, 'it is marked paid and its email leaves Waiting');

  // A payment whose event never came: Check Stripe finds it.
  await page.locator('.inv-bar').getByRole('button', { name: 'Back' }).click();
  await page.locator('.inv-head').getByRole('button', { name: 'New invoice' }).click();
  await page.locator('.inv-paper.editing').waitFor();
  await page.getByLabel('Client name').fill('Dana Whitfield');
  await page.getByLabel('Client email').fill('dana@acme.test');
  await page.getByLabel('Line 1 description').fill('Site visit');
  await page.getByLabel('Line 1 price').fill('400');
  await page.locator('.pay-row').getByRole('button', { name: 'Make the link now' }).click();
  await page.getByLabel('Payment link').waitFor();
  const s3 = await until((s) => Object.values(s['ws.invoices']).some((x) => x.number === 'INV-0002' && x.pay?.active));
  const second = Object.values(s3['ws.invoices']).find((x) => x.number === 'INV-0002');
  ok(second.pay.amount === 40000, 'a link made on its own, for the invoice’s total');
  await page.locator('.inv-bar').getByRole('button', { name: 'Send', exact: true }).click();
  await dialog.waitFor();
  await dialog.getByRole('button', { name: /^Send/ }).first().click();
  await until((s) => s['ws.invoices'][second.id]?.status === 'sent');
  await api(page, 'POST', '/api/test/stripe', { op: 'pay', invoice: second.id, silent: true });
  await page.getByLabel('Payment link').getByRole('button', { name: 'Check Stripe' }).click();
  await page.locator('.pay-row-paid', { hasText: 'Paid online' }).waitFor();
  ok((await slices())['ws.invoices'][second.id].status === 'paid', 'Check Stripe finds the payment and marks it paid');

  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
});
