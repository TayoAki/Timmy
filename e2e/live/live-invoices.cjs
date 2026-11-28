// Invoices and quotes on a real workspace (src/areas/invoices, server/src/http/invoices.ts): business details saved,
// a new invoice numbered by the server and edited on the page, sent through the compose window with its PDF attached
// and the payment tracked in Waiting, the PDF itself, marked paid; and "Bill for this" on an email, where Timmy
// drafts only the lines the email prices.
const { ok, open, signUp, api, connectGmail, deliver, sentMail, releaseHolds, run, BASE } = require('./lib.cjs');

run('live-invoices', async (browser) => {
  const { page, errors } = await open(browser);
  const me = await signUp(page, { name: 'Grace Hopper' });
  await connectGmail(page, 'grace@hopper.test');
  const slice = async (name) => (await api(page, 'GET', '/api/v1/state')).body.slices[name] ?? {};
  const until = async (name, test) => {
    for (let i = 0; i < 60; i++) {
      const v = await slice(name);
      if (test(v)) return v;
      await page.waitForTimeout(150);
    }
    return null;
  };

  await page.click('button[aria-label="Invoices & quotes"]');
  await page.locator('.inv-list').waitFor();
  ok(/No invoices yet/.test(await page.locator('.inv-list').innerText()), 'a new workspace has no invoices yet');

  // Business details: what every invoice shows, saved to the workspace.
  await page.locator('.nav-item', { hasText: 'Business details' }).click();
  await page.locator('.inv-form').waitFor();
  ok((await page.locator('.inv-form label', { hasText: 'Business name' }).locator('input').inputValue()) === me.company, 'the business name starts as the workspace’s name');
  await page.locator('.inv-form label', { hasText: 'How clients pay you' }).locator('textarea').fill('Bank transfer to Hopper Studio, account 0042.');
  await page.getByRole('button', { name: 'Save details' }).click();
  await page.locator('.toast', { hasText: 'Business details saved' }).waitFor();
  ok(await until('ws.billing', (b) => b.settings?.payment === 'Bank transfer to Hopper Studio, account 0042.'), 'business details are saved to the workspace');

  // A new invoice, numbered by the server, edited on the page and saved as it is typed.
  await page.locator('.nav-item', { hasText: 'Invoices' }).first().click();
  await page.locator('.inv-head').getByRole('button', { name: 'New invoice' }).click();
  await page.locator('.inv-paper.editing').waitFor();
  ok(/INV-0001/.test(await page.locator('.inv-title').innerText()), 'the first invoice is INV-0001');
  await page.getByLabel('Client name').fill('Sam Rivera');
  await page.getByLabel('Client email').fill('sam@acme.test');
  await page.getByLabel('Line 1 description').fill('Design work, November');
  await page.getByLabel('Line 1 quantity').fill('12');
  await page.getByLabel('Line 1 price').fill('150');
  await page.getByLabel('Line 1 tax').fill('8.25');
  ok((await page.locator('.inv-grand').innerText()).includes('$1,948.50'), '12 × $150 with 8.25% tax is $1,948.50');
  const saved = await until('ws.invoices', (all) => Object.values(all).some((x) => x.number === 'INV-0001' && x.items[0]?.unitPrice === 15000 && x.items[0]?.taxRate === 8.25 && x.client.email === 'sam@acme.test'));
  ok(saved, 'the draft is saved to the workspace as it is typed');
  const inv = Object.values(saved).find((x) => x.number === 'INV-0001');

  // The PDF, as the client will get it.
  const pdf = await page.request.get(new URL(`/api/v1/invoices/${inv.id}/pdf`, BASE).toString());
  const bytes = await pdf.body();
  ok(pdf.status() === 200 && pdf.headers()['content-type'] === 'application/pdf' && bytes.subarray(0, 5).toString() === '%PDF-', 'the PDF downloads');

  // Send: the email opens written, with the PDF attached and the payment tracked; nothing goes until Send.
  await page.locator('.inv-bar').getByRole('button', { name: 'Send', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New message' });
  await dialog.waitFor();
  ok((await dialog.locator('.draft-subject').inputValue()) === `Invoice INV-0001 from ${me.company}`, 'the email is titled with the number and the business');
  ok(/Invoice INV-0001 – .*\.pdf/.test(await dialog.locator('.compose-files').innerText()), 'the PDF is attached to the email');
  ok((await dialog.getByLabel('What they owe you').inputValue()).startsWith('Payment of INV-0001'), 'the email tracks the payment');
  ok((await sentMail(page)).length === 0, 'nothing has gone out before Send');
  await dialog.getByRole('button', { name: /^Send/ }).first().click();
  ok(await until('ws.invoices', (all) => all[inv.id]?.status === 'sent' && all[inv.id]?.thread), 'sending marks the invoice sent');
  await releaseHolds(page);
  let mail;
  for (let i = 0; i < 40 && !mail; i++) {
    mail = (await sentMail(page)).find((m) => m.subject === `Invoice INV-0001 from ${me.company}`);
    if (!mail) await page.waitForTimeout(150);
  }
  ok(mail && mail.to.includes('sam@acme.test') && mail.attachments?.[0]?.mimetype === 'application/pdf' && /^Invoice INV-0001/.test(mail.attachments[0].name), 'the email goes to Sam with the PDF');
  ok(/How to pay:\nBank transfer to Hopper Studio/.test(mail.body), 'the email says how to pay');
  const threadId = (await slice('ws.invoices'))[inv.id].thread;
  ok((await api(page, 'GET', '/api/v1/state')).body.slices.threads.find((t) => t.id === threadId)?.box === 'waiting', 'its email waits in Waiting for the payment');

  // Paid: the wait ends.
  await page.click('button[aria-label="Invoices & quotes"]');
  await page.locator('.inv-row', { hasText: 'INV-0001' }).click();
  await page.locator('.inv-bar').getByRole('button', { name: 'Mark paid' }).click();
  ok(await until('ws.invoices', (all) => all[inv.id]?.status === 'paid'), 'Mark paid makes it paid');
  let archived = false;
  for (let i = 0; i < 40 && !archived; i++) {
    archived = (await api(page, 'GET', '/api/v1/state')).body.slices.threads.find((t) => t.id === threadId)?.box === 'archived';
    if (!archived) await page.waitForTimeout(150);
  }
  ok(archived, 'and its email leaves Waiting');

  // Filed in a project from its page, after it was paid; the project's Invoices tab then lists it.
  const made = await api(page, 'POST', '/api/v1/commands', { id: `pj-${Date.now()}`, action: { type: 'ws', ops: [{ op: 'put', col: 'projects', item: { id: 'apollo', num: '10', name: 'Apollo launch', color: 'var(--c-blue)', status: 'active', folder: 'f02-10', sources: [] } }] } });
  ok(made.body.ok, 'a project to file it in');
  await page.locator('.inv-filed select option[value="apollo"]').waitFor({ state: 'attached' });
  await page.locator('.inv-filed select').selectOption('apollo');
  ok(await until('ws.invoices', (all) => all[inv.id]?.project === 'apollo' && all[inv.id]?.status === 'paid'), 'choosing a project on the paid invoice files it there, on the server');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.click('button[aria-label="Projects"]');
  await page.locator('.pj-list').getByText('Apollo launch').first().click();
  await page.getByRole('tab', { name: /Invoices/ }).click();
  const pjTab = page.getByRole('region', { name: 'Invoices for this project' });
  await pjTab.waitFor();
  ok((await pjTab.locator('.inv-row').count()) === 1 && /INV-0001/.test(await pjTab.innerText()) && /\$1,948\.50/.test(await pjTab.locator('.inv-card', { hasText: 'Paid' }).innerText()), 'the project’s Invoices tab lists it, with what was paid');

  // Bill for this: Timmy drafts the lines the email prices, for the person who wrote, and nothing else.
  await deliver(page, { from: 'Dana Whitfield <dana@acme.test>', subject: 'November work', body: 'Hi Grace,\n\nPlease bill us for November. We agreed 12 design hours at $150. Also 2 site visits at $400.00 each.\n\nDana' });
  for (let i = 0; i < 80 && !(await api(page, 'GET', '/api/v1/state')).body.slices.threads.some((t) => t.subject === 'November work'); i++) await page.waitForTimeout(150);
  await page.click('button[aria-label="Today & mail"]');
  await page.getByRole('tab', { name: /Triage/ }).click();
  await page.locator('.triage-subject', { hasText: 'November work' }).first().click();
  await page.getByRole('button', { name: 'Bill for this' }).click();
  await page.getByRole('menuitem', { name: /Make an invoice/ }).click();
  await page.locator('.toast', { hasText: 'Invoice INV-0002 drafted with 2 lines from this email' }).waitFor();
  await page.locator('.inv-paper.editing').waitFor();
  await page.getByLabel('Line 2 description').waitFor();
  ok((await page.getByLabel('Line 1 description').inputValue()) === 'Design hours' && (await page.getByLabel('Line 2 description').inputValue()) === 'Site visits' && (await page.getByLabel('Line 3 description').count()) === 0, 'Bill for this drafts the two priced lines, and not the one the email doesn’t say');
  ok((await page.locator('.inv-grand').innerText()).includes('$2,600.00'), 'their total is $2,600.00');
  ok((await page.getByLabel('Client email').inputValue()) === 'dana@acme.test', 'for Dana, who wrote');

  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
});
