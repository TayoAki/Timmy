// Invoices and quotes in the sample demo: the list and its sums, a new invoice edited on the page (lines, tax,
// a discount, totals in whole cents), kept after a reload, sent through the compose window and tracked in Waiting,
// marked paid; a quote's optional line, accepted and turned into an invoice; "Bill for this" on an email; and the
// page on a phone.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:5173/';
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };
const KEY = 'timmy-state-v3';
const saved = (p) => p.evaluate((KEY) => JSON.parse(localStorage.getItem(KEY) || '{}'), KEY);
// Opens a screen by writing the saved route and reloading. The app's own save, a moment after its last change, can
// land after the write and put the old route back, so it is tried again until the page is the one asked for.
const go = async (p, route) => {
  for (let i = 0; i < 4; i++) {
    await p.waitForTimeout(500);
    await p.evaluate(([KEY, route]) => { const s = JSON.parse(localStorage.getItem(KEY) || '{}'); s.route = route; localStorage.setItem(KEY, JSON.stringify(s)); }, [KEY, route]);
    await p.reload();
    await p.waitForTimeout(500);
    const now = await p.evaluate((KEY) => JSON.parse(localStorage.getItem(KEY) || '{}').route, KEY);
    if (now && now.view === route.view && now.tab === route.tab && now.id === route.id) return;
  }
};
// The app saves to the browser shortly after each change; wait until the saved route is an invoice's page.
const openId = async (p, not) => {
  for (let i = 0; i < 40; i++) {
    const r = (await saved(p)).route;
    if (r && r.view === 'invoice' && r.id !== not) return r.id;
    await p.waitForTimeout(100);
  }
  throw new Error('FAIL: the invoice page was never saved as the route');
};
// Polls the saved copy until it shows what a step changed.
const until = async (p, test) => {
  for (let i = 0; i < 40; i++) {
    const st = await saved(p);
    if (test(st)) return true;
    await p.waitForTimeout(100);
  }
  return false;
};
const text = (p, sel) => p.locator(sel).first().innerText();
const grand = (p) => text(p, '.inv-grand > span:last-child');
// The page saves typing shortly after it stops; wait for the saved copy to show it.
const savedInvoice = async (p, id, test) => {
  for (let i = 0; i < 30; i++) {
    const inv = (await saved(p)).ws?.invoices?.[id];
    if (inv && test(inv)) return inv;
    await p.waitForTimeout(150);
  }
  return (await saved(p)).ws?.invoices?.[id];
};

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));

  await p.goto(BASE);
  await p.evaluate(() => localStorage.clear());
  await p.reload();
  await p.waitForTimeout(600);

  // The rail has the section; the list shows the sample invoices and what is owed.
  await p.locator('.rail [aria-label="Invoices & quotes"]').click();
  await p.waitForSelector('.inv-list');
  assert(await p.locator('.inv-list h1').innerText() === 'Invoices', 'the rail opens Invoices & quotes on the invoices');
  assert(await p.locator('.inv-row').count() === 2, 'the two sample invoices are listed');
  const overdueCard = p.locator('.inv-card.warn');
  assert((await overdueCard.innerText()).includes('$6,820.00'), 'the overdue card shows the Northwind invoice’s $6,820.00');
  assert((await p.locator('.inv-row:has-text("INV-1042") .inv-status').innerText()) === 'Overdue', 'a sent invoice past its due date reads Overdue');
  await p.locator('.inv-filters button:has-text("Paid")').click();
  assert(await p.locator('.inv-row').count() === 1 && (await text(p, '.inv-row')).includes('INV-1041'), 'the Paid filter shows only the paid one');
  assert((await text(p, '.rp-section')).includes('INV-1042'), 'the side panel lists what is overdue');

  // A new invoice: numbered from the business details, edited on the page.
  await p.locator('.inv-head button:has-text("New invoice")').click();
  await p.waitForSelector('.inv-paper.editing');
  const id = await openId(p);
  assert((await p.locator('.inv-title').innerText()).includes('INV-1043'), 'the new invoice takes the next number, INV-1043');
  assert((await text(p, '.inv-biz')) === 'Northpeak', 'the page carries the business name');
  await p.locator('select[aria-label="Choose a contact"]').selectOption({ label: 'Marcus Lee · Northwind Health' });
  assert((await p.locator('input[aria-label="Client email"]').inputValue()).includes('@'), 'choosing a contact fills the client’s name and email');
  await p.locator('textarea[aria-label="Line 1 description"]').fill('Design work, November');
  await p.locator('input[aria-label="Line 1 quantity"]').fill('12');
  await p.locator('input[aria-label="Line 1 price"]').fill('150');
  await p.locator('input[aria-label="Line 1 tax"]').fill('10');
  assert(await grand(p) === '$1,980.00', '12 × $150 with 10% tax is $1,980.00');
  await p.locator('.inv-add').click();
  await p.locator('textarea[aria-label="Line 2 description"]').fill('Site visit');
  await p.locator('input[aria-label="Line 2 price"]').fill('$1,250.50');
  assert(await grand(p) === '$3,230.50', 'a second line, typed with a $ and a comma, adds $1,250.50');
  await p.locator('select[aria-label="Discount kind"]').selectOption('percent');
  await p.locator('input[aria-label="Discount percent"]').fill('10');
  // Subtotal 3,050.50; discount 305.05; tax 180 × 0.9 = 162; total 2,907.45.
  assert(await grand(p) === '$2,907.45', 'a 10% discount comes off the subtotal and lowers the tax with it');
  const kept = await savedInvoice(p, id, (x) => x.items.length === 2 && x.discount?.value === 10);
  assert(kept && kept.items[1].unitPrice === 125050 && kept.items[0].qty === 12, 'what was typed is saved, in whole cents');
  await p.reload();
  await p.waitForSelector('.inv-paper');
  assert(await grand(p) === '$2,907.45' && (await p.locator('textarea[aria-label="Line 2 description"]').inputValue()) === 'Site visit', 'a reload keeps the draft as it was');

  // Send: the compose window opens with the email written, tracking the payment.
  await p.locator('.inv-bar button:has-text("Send")').click();
  await p.waitForSelector('.compose[aria-label="New message"]');
  assert((await p.locator('.draft-subject').inputValue()) === 'Invoice INV-1043 from Northpeak', 'the email is titled with the number and the business');
  const body = await p.locator('textarea[aria-label="Message"]').inputValue();
  assert(body.includes('$2,907.45') && body.includes('INV-1043'), 'the email says the amount and the number');
  assert((await p.locator('.compose input[aria-label="What they owe you"]').inputValue()).startsWith('Payment of INV-1043'), 'the email tracks the payment in Waiting');
  await p.locator('.compose-foot button.btn-primary:has-text("Send")').click();
  await until(p, (st) => st.ws.invoices[id].status === 'sent');
  const sent = (await saved(p)).ws.invoices[id];
  assert(sent.status === 'sent' && sent.thread, 'sending the email marks the invoice sent and links its email');
  const thread = (await saved(p)).threads.find((t) => t.id === sent.thread);
  assert(thread && thread.box === 'waiting', 'the email waits for the payment in Waiting');
  await go(p, { view: 'invoice', id });
  assert(await p.locator('.inv-paper.editing').count() === 0 && (await text(p, '.inv-note')).startsWith('Sent'), 'a sent invoice is read-only and says when it was sent');
  await p.locator('.inv-bar button:has-text("Mark paid")').click();
  await p.waitForTimeout(300);
  assert((await text(p, '.inv-bar .inv-status')) === 'Paid', 'Mark paid makes it Paid');
  assert(await until(p, (st) => st.threads.find((t) => t.id === sent.thread).box === 'archived'), 'once paid, its email leaves Waiting');

  // A quote with an optional line: chosen, accepted, turned into an invoice.
  await go(p, { view: 'invoices', tab: 'quotes' });
  assert(await p.locator('.inv-list h1').innerText() === 'Quotes', 'the Quotes tab lists the quotes');
  await p.locator('.inv-row:has-text("Q-217")').click();
  await p.waitForSelector('.inv-paper');
  const before = await grand(p);
  const opt = p.locator('.inv-optional input[type=checkbox]').first();
  await opt.check();
  assert((await grand(p)) !== before, 'choosing the optional line changes the total');
  await opt.uncheck();
  assert((await grand(p)) === before, 'leaving it out puts the total back');
  const qid = await openId(p);
  await until(p, (st) => st.ws.invoices[qid].items.every((l) => !l.chosen));
  await p.evaluate(([KEY, qid]) => { const s = JSON.parse(localStorage.getItem(KEY)); s.ws.invoices[qid].status = 'sent'; s.ws.invoices[qid].sentAt = new Date().toISOString(); localStorage.setItem(KEY, JSON.stringify(s)); }, [KEY, qid]);
  await p.reload();
  await p.waitForSelector('.inv-paper');
  await p.locator('.inv-bar button:has-text("Mark accepted")').click();
  await p.waitForTimeout(300);
  assert((await text(p, '.inv-bar .inv-status')) === 'Accepted', 'a sent quote can be marked accepted');
  await p.locator('.inv-bar button:has-text("Turn into an invoice")').click();
  await p.waitForSelector('.inv-paper.editing');
  const fid = await openId(p, qid);
  const fromQuote = (await saved(p)).ws.invoices[fid];
  assert(fromQuote.fromQuote === qid && fromQuote.number === 'INV-1044', 'the accepted quote becomes the next invoice, INV-1044');
  assert(await grand(p) === before, 'with the lines the client chose, so the same total');

  // "Bill for this" on an email starts a draft for the person who wrote.
  await go(p, { view: 'thread', id: 'acme-quote', tab: 'conversation' });
  await p.locator('button[aria-label="Bill for this"]').click();
  await p.locator('[role=menuitem]:has-text("Make a quote")').click();
  await p.waitForSelector('.inv-paper.editing');
  const bid = await openId(p, fid);
  const billed = (await saved(p)).ws.invoices[bid];
  assert(billed.kind === 'quote' && billed.thread === 'acme-quote' && billed.project === 'acme' && /Dana/.test(billed.client.name), 'Bill for this on Dana’s email starts a quote for Dana, in the Acme project');

  // Business details: saved, and the next number follows them.
  await go(p, { view: 'invoices', tab: 'details' });
  await p.locator('.inv-form label:has-text("How clients pay you") textarea').fill('Bank transfer to Northpeak LLC, account 0042.');
  await p.locator('.inv-form button:has-text("Save details")').click();
  assert(await until(p, (st) => (st.ws.billing.settings.payment || '').startsWith('Bank transfer')), 'business details are saved');
  await go(p, { view: 'invoice', id });
  assert((await text(p, '.inv-foot')).includes('Bank transfer to Northpeak LLC'), 'how to pay shows on the invoice');

  // On a phone, the page fits the screen.
  // The phone starts with this browser's saved state, so it opens on the same invoice.
  await go(p, { view: 'invoice', id: fid });
  const phone = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const q = await phone.newPage();
  q.on('pageerror', (e) => errors.push(e.message));
  await q.goto(BASE);
  await q.waitForSelector('.inv-paper');
  const wide = await q.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(wide <= 1, 'the invoice fits a phone screen without sideways scrolling');
  await q.screenshot({ path: __dirname + '/shots/invoice-phone.png' });
  await p.screenshot({ path: __dirname + '/shots/invoice.png' });

  assert(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await b.close();
})().catch((e) => { console.error(e.message || e); process.exit(1); });
