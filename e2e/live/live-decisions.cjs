// Live mode: a question in the mail becomes a decision card; choosing an answer has Timmy draft the reply,
// which still needs Send. People from the mail show up on the People screen, and Ask knows who they are.
const { ok, open, signUp, api, connectGmail, deliver, sentMail, run } = require('./lib.cjs');

run('live-decisions', async (browser) => {
  const { page, errors } = await open(browser);
  await signUp(page, { name: 'Taylor Brooks' });
  await connectGmail(page, 'taylor@northpeak.test');
  const state = async () => (await api(page, 'GET', '/api/v1/state')).body.slices;
  const until = async (fn) => {
    for (let i = 0; i < 60; i++) {
      if (await fn()) return true;
      await page.waitForTimeout(250);
    }
    return false;
  };

  await deliver(page, { from: 'Dana Whitfield <dana@acme.test>', subject: 'Pricing for next year', body: 'Hi Taylor,\n\nIt is $62 per seat today. Should we hold the price or drop it to match the competitor?\n\nI\'ll send the usage numbers by 2026-11-20.\n\nDana' });
  ok(await until(async () => (await state()).decisions.some((d) => /^Should we hold the price/.test(d.title))), 'a question in the mail becomes a decision');

  // The card shows the question, the answers and the figure the email gives. Nothing has been drafted or sent.
  await page.click('button[aria-label="Approvals"]');
  const card = page.locator('.ap-card', { hasText: 'Should we hold the price or drop it to match the competitor?' });
  await card.waitFor({ timeout: 15000 });
  const text = await card.innerText();
  ok(/Hold the price/.test(text) && /Drop it to match the competitor/.test(text), 'the card offers the answers the email asks for');
  ok(/\$62/.test(text) && !/Made up/.test(text), 'it shows the figure the email gives, and not one the email never stated');
  ok((await sentMail(page)).length === 0 && !(await state()).threads.find((t) => t.subject === 'Pricing for next year').draft, 'nothing was drafted or sent by reading it');

  // Choosing an answer: Timmy drafts the reply; it waits in Approvals; nothing is sent.
  await card.getByRole('button', { name: 'Hold the price', exact: true }).click();
  await page.locator('.toast', { hasText: /drafting the reply/ }).waitFor();
  ok(await until(async () => !!(await state()).decisions.find((d) => /^Should we hold the price/.test(d.title))?.chosen), 'choosing an answer records the decision');
  const draft = page.locator('.ap-card', { hasText: 'Re: Pricing for next year' });
  await draft.waitFor({ timeout: 20000 });
  ok((await draft.getByRole('button', { name: 'Send', exact: true }).count()) === 1 && (await sentMail(page)).length === 0, 'the reply is a draft with a Send button; nothing has gone out');
  ok((await page.locator('.ap-card', { hasText: 'Should we hold the price or drop it to match the competitor?' }).getByRole('button', { name: 'Drop it to match the competitor', exact: true }).count()) === 0, 'the decided card no longer asks');

  // The same question from someone else: no second card, and the thread says what was decided.
  await deliver(page, { from: 'Sam Rivera <sam@acme.test>', subject: 'Pricing, again', body: 'Should we hold the price or drop it to match the competitor?' });
  ok(await until(async () => /^You decided this on \d{4}-\d{2}-\d{2}: Hold the price\.$/.test((await state()).threads.find((t) => t.subject === 'Pricing, again')?.context || '')), 'asked again, the thread says what was already decided');
  ok((await state()).decisions.filter((d) => /^Should we hold the price/.test(d.title)).length === 1, 'and no second card is made');

  // People from the mail are on the People screen as suggestions, with their company.
  await page.click('button[aria-label="People"]');
  await page.getByRole('tab', { name: /Suggest/ }).click();
  await page.locator('.main').getByText('Dana Whitfield').first().waitFor({ timeout: 10000 });
  ok(/Acme/.test(await page.locator('.main').innerText()), 'People suggests the people who wrote, with the company their address belongs to');

  // Ask knows who she is and what she promised, from the mail.
  await page.keyboard.press('Control+i');
  await page.locator('.ai-input').waitFor();
  await page.locator('.ai-input').fill('who is Dana');
  await page.keyboard.press('Enter');
  await page.locator('.ai-msg.timmy', { hasText: 'Dana Whitfield' }).waitFor({ timeout: 30000 });
  ok(/Dana Whitfield \(dana@acme\.test\) works at Acme\./.test(await page.locator('.ai-msg.timmy').last().innerText()), 'Ask says who a person is and where they work');
  await page.locator('.ai-input').fill('what am I waiting on');
  await page.keyboard.press('Enter');
  // The earlier answer mentions the promise too, so the wait is for the one that carries the date.
  await page.locator('.ai-msg.timmy', { hasText: 'due 2026-11-20' }).waitFor({ timeout: 30000 });
  ok(/Open: send the usage numbers, due 2026-11-20/.test(await page.locator('.ai-msg.timmy').last().innerText()), 'and what has been promised, with its date');

  ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
});
