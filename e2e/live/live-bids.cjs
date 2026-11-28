// Bids on a real workspace, with Kontract as the engine (here its stand-in): finding notices, tracking one with
// Kontract's own copy and a to-do for its deadline, reading what its documents say, past awards, pricing at a
// markup, finding a sub and their email, a quote request that goes out through the mailbox and marks them asked,
// and the proposal page.
const { ok, open, signUp, api, connectGmail, sentMail, releaseHolds, run } = require('./lib.cjs');

run('live-bids', async (browser) => {
  const { page, errors } = await open(browser);
  await signUp(page, { name: 'Grace Hopper' });
  await connectGmail(page, 'grace@hopper.test');
  const state = async () => (await api(page, 'GET', '/api/v1/state')).body.slices;
  const until = async (test) => {
    for (let i = 0; i < 60; i++) {
      const s = await state();
      if (test(s)) return s;
      await page.waitForTimeout(150);
    }
    return null;
  };
  const bidOf = (s) => Object.values(s['ws.bids'] ?? {}).find((b) => b.notice.id === 'sample-janitorial-va');

  ok((await api(page, 'GET', '/api/v1/bids/status')).body.on === true, 'bids are on where Kontract is set up');
  await page.click('button[aria-label="Bids"]');
  await page.locator('.bd-result').first().waitFor();
  ok((await page.locator('.bd-result').count()) === 4, 'Find lists the open service notices');

  // Track: the server starts the bid with Kontract's copy, and puts the deadline on the to-do list.
  await page.locator('.bd-result', { hasText: 'Janitorial Services' }).getByRole('button', { name: 'Track' }).click();
  await page.locator('.toast', { hasText: 'Tracking this bid' }).waitFor();
  await page.locator('.bd-title', { hasText: 'Janitorial Services, Cascade VA Medical Center' }).waitFor();
  let s = await until((x) => bidOf(x));
  const bid = bidOf(s);
  ok(bid.notice.agency === 'Department of Veterans Affairs' && s['ws.tasks'][bid.task]?.title === 'Submit the bid: Janitorial Services, Cascade VA Medical Center', 'the bid is saved, with its deadline as a to-do');

  // What the documents say, with their words.
  await page.getByRole('button', { name: 'Read the documents' }).click();
  await page.locator('.toast', { hasText: 'Read 3 documents' }).waitFor();
  const budget = page.locator('.bd-fact', { hasText: 'Budget' });
  await budget.waitFor();
  ok(/The estimated annual value is \$180,000 to \$240,000\./.test(await budget.innerText()), 'the budget shows with the words it came from');
  s = await until((x) => bidOf(x)?.pricing.lines.length === 2);
  ok(s && bidOf(s).pricing.periods === 5, 'reading fills two price lines over five years');

  // Pricing.
  await page.getByRole('tab', { name: 'Pricing' }).click();
  await page.getByRole('button', { name: 'Look up past awards' }).click();
  await page.locator('.bd-awards').waitFor();
  ok((await page.locator('.bd-awards .table-row:not(.table-head)').count()) === 4, 'past awards like it are listed');
  await page.getByLabel('Line 1 sub cost').fill('12000');
  await page.getByRole('button', { name: 'Price at markup' }).click();
  s = await until((x) => bidOf(x)?.pricing.lines[0].price === 1440000);
  ok(s, 'a $12,000 sub cost at the usual 20% markup is $14,400.00, saved on the server in cents');

  // Subs: find, add, their email, a quote request through the mailbox.
  await page.getByRole('tab', { name: /Subs/ }).click();
  await page.locator('.bd-subs form', { has: page.getByLabel('Kind of business') }).getByRole('button', { name: 'Search' }).click();
  await page.locator('[aria-label="Businesses found"] .bd-sub').first().waitFor();
  await page.locator('[aria-label="Businesses found"] .bd-sub').first().getByRole('button', { name: 'Add' }).click();
  s = await until((x) => bidOf(x)?.subs.length === 1);
  const sub = bidOf(s).subs[0];
  ok(sub.name === 'Evergreen Commercial Cleaning (sample)' && bidOf(s).stage === 'sourcing', 'a sub is added and the bid is sourcing');
  await page.getByRole('button', { name: `More for ${sub.name}` }).click();
  await page.getByRole('menuitem', { name: /Find their email/ }).click();
  s = await until((x) => bidOf(x)?.subs[0].email === 'bids@evergreen-clean.example');
  ok(s, 'their email is read from their website');
  await page.locator('.bd-sub', { hasText: sub.name }).getByRole('button', { name: 'Ask for a quote' }).click();
  const dialog = page.getByRole('dialog', { name: 'New message' });
  await dialog.waitFor();
  ok((await dialog.locator('.draft-subject').inputValue()) === 'Quote request: Janitorial Services, Cascade VA Medical Center', 'the quote request is written');
  await dialog.getByRole('button', { name: /^Send/ }).first().click();
  await releaseHolds(page);
  let mail;
  for (let i = 0; i < 40 && !mail; i++) {
    mail = (await sentMail(page)).find((m) => m.subject === 'Quote request: Janitorial Services, Cascade VA Medical Center');
    if (!mail) await page.waitForTimeout(150);
  }
  ok(mail && mail.to.includes('bids@evergreen-clean.example') && !/14,400|1440000|markup/i.test(mail.body), 'it goes to the sub, without the bid’s own price');
  s = await until((x) => bidOf(x)?.subs[0].status === 'asked' && bidOf(x)?.subs[0].thread);
  ok(s, 'and marks them asked, with the email kept');

  // The proposal page.
  await page.getByRole('tab', { name: 'Proposal' }).click();
  await page.getByRole('button', { name: 'Start the proposal' }).click();
  await page.locator('.nb-editor').waitFor();
  s = await until((x) => bidOf(x)?.proposal && x['ws.docs']?.[bidOf(x).proposal]);
  ok(s && JSON.stringify(s['ws.docs'][bidOf(s).proposal].blocks).includes('[UEI]'), 'the proposal page is saved, with its blanks bracketed');

  // What it cost is in the usage log with the model's.
  const audit = await api(page, 'GET', '/api/v1/usage');
  const routes = JSON.stringify(audit.body);
  ok(/kontract:subcontractors/.test(routes) && /kontract:websites\/read/.test(routes), 'Kontract calls are in the workspace’s usage log');

  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
});
