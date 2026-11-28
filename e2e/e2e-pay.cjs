// Getting paid online, in the sample demo: Business details says Stripe counts as connected; a new invoice says
// sending it adds a "Pay online" link; the email it opens carries the (sample) link; the sent invoice shows it; the
// sample client pays and the invoice is paid online, with its email out of Waiting; and it can't be opened again.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:5173/';
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };
const KEY = 'timmy-state-v3';
const saved = (p) => p.evaluate((KEY) => JSON.parse(localStorage.getItem(KEY) || '{}'), KEY);
const until = async (p, test) => {
  for (let i = 0; i < 40; i++) {
    if (test(await saved(p))) return true;
    await p.waitForTimeout(100);
  }
  return false;
};

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE);
  await p.evaluate(() => localStorage.clear());
  await p.reload();
  await p.waitForTimeout(600);

  await p.locator('.rail [aria-label="Invoices & quotes"]').click();
  await p.locator('.nav-item', { hasText: 'Business details' }).click();
  const card = p.getByLabel('Get paid online');
  await card.waitFor();
  assert(/Stripe counts as connected/.test(await card.innerText()), 'Business details says that in the sample, Stripe counts as connected');

  await p.locator('.nav-item', { hasText: 'Invoices' }).first().click();
  await p.locator('.inv-head button:has-text("New invoice")').click();
  await p.waitForSelector('.inv-paper.editing');
  let id;
  for (let i = 0; i < 40 && !id; i++) {
    const r = (await saved(p)).route;
    if (r && r.view === 'invoice') id = r.id;
    else await p.waitForTimeout(100);
  }
  assert(id, 'a new invoice opens');
  await p.locator('select[aria-label="Choose a contact"]').selectOption({ label: 'Marcus Lee · Northwind Health' });
  await p.locator('textarea[aria-label="Line 1 description"]').fill('Design work, November');
  await p.locator('input[aria-label="Line 1 price"]').fill('1200');
  assert(/Sending it adds a “Pay online” link/.test(await p.locator('.pay-row').innerText()), 'a new invoice says sending it adds a payment link');

  await p.locator('.inv-bar button:has-text("Send")').click();
  await p.waitForSelector('.compose[aria-label="New message"]');
  const body = await p.locator('textarea[aria-label="Message"]').inputValue();
  const url = (body.match(/Pay online by card:\n(https:\/\/\S+)/) || [])[1];
  assert(url && url.startsWith('https://pay.stripe-standin.example/'), 'the email carries the invoice’s (sample) payment link');
  await p.locator('.compose-foot button.btn-primary:has-text("Send")').click();
  assert(await until(p, (s) => s.ws.invoices[id]?.status === 'sent' && s.ws.invoices[id]?.pay?.url === url), 'sent, the invoice keeps its link');
  const row = p.getByLabel('Payment link');
  await row.waitFor();
  assert((await row.locator('a.pay-url').getAttribute('href')) === url, 'the invoice shows its link');

  await row.getByRole('button', { name: 'Sample: the client pays' }).click();
  await p.locator('.pay-row-paid').waitFor();
  assert(/Paid online .*: \$1,200\.00 through Stripe/.test(await p.locator('.pay-row-paid').innerText()), 'paid: it says it was paid online, how much, and through Stripe');
  assert(await until(p, (s) => s.ws.invoices[id]?.status === 'paid' && s.threads.find((t) => t.id === s.ws.invoices[id].thread)?.box === 'archived'), 'it is marked paid and its email leaves Waiting');
  assert((await p.locator('.inv-bar .inv-status').innerText()) === 'Paid', 'the bar says Paid');

  // Paid online can't be opened again here.
  await p.locator('.inv-bar').getByRole('button', { name: /More for/ }).click();
  await p.getByRole('menuitem', { name: 'Open it again' }).click();
  await p.locator('.toast', { hasText: 'paid online through Stripe' }).waitFor();
  assert((await saved(p)).ws.invoices[id].status === 'paid', 'an invoice paid online can’t be opened again: a refund is made in Stripe');

  assert(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await b.close();
})().catch((e) => { console.error(e.message || e); process.exit(1); });
