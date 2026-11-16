// Live mode: the kinds of thing Timmy tracks beyond people and companies. A kind proposed for the workspace's
// trade is accepted on People › What Timmy tracks; an email that mentions one is listed there with its fields,
// its sentence and the email it came from; Ask finds it; and a kind can be renamed, trimmed, dismissed and stopped.
const { ok, open, signUp, api, connectGmail, deliver, run } = require('./lib.cjs');

run('live-types', async (browser) => {
  const { page, errors } = await open(browser);
  await signUp(page, { name: 'Taylor Brooks', trade: 'sales' });
  await connectGmail(page, 'taylor@northpeak.test');
  const tracked = async () => (await api(page, 'GET', '/api/v1/tracked')).body;
  const until = async (fn) => {
    for (let i = 0; i < 80; i++) {
      if (await fn()) return true;
      await page.waitForTimeout(250);
    }
    return false;
  };
  const sentence = 'Deal: company Acme Corp; value $40,000; stage negotiation.';

  // The review screen is a tab on People. A sales workspace is offered deals and leads; nothing is tracked yet.
  await page.click('button[aria-label="People"]');
  await page.getByRole('tab', { name: 'What Timmy tracks' }).click();
  await page.getByRole('heading', { name: 'What Timmy tracks' }).waitFor();
  const offer = page.getByRole('article', { name: 'Suggestion: deals' });
  await offer.waitFor({ timeout: 15000 });
  ok(/Track deals\?/.test(await offer.innerText()) && /For each one Timmy would keep: company, value, stage, close date\./.test(await offer.innerText()), 'the trade’s kinds are offered, each with its fields');
  ok((await page.getByRole('article', { name: 'Suggestion: leads' }).count()) === 1 && /Nothing is tracked yet/.test(await page.locator('.main').innerText()), 'and nothing is tracked until someone accepts');

  // An email about a deal before anyone accepted: nothing is read out of it as a deal.
  await deliver(page, { from: 'Sam Rivera <sam@globex.test>', subject: 'Before accepting', body: 'Deal: company Globex; value $5,000.' });
  ok(await until(async () => (await tracked()).proposals.find((p) => p.key === 'deal')?.threads === 1), 'before accepting, a mention is only counted');
  ok((await tracked()).tracked.length === 0, 'and makes nothing tracked');

  // Accept it. What was counted becomes the first deal known.
  await offer.getByRole('button', { name: 'Track deals' }).click();
  await page.locator('.toast', { hasText: 'Timmy now tracks deals.' }).waitFor();
  const kind = page.getByRole('article', { name: 'Deal', exact: true });
  await kind.waitFor();
  ok((await page.getByRole('article', { name: 'Suggestion: deals' }).count()) === 0 && /1 known/.test(await kind.innerText()), 'accepting moves it from suggested to tracked');
  ok((await kind.locator('.chip').allInnerTexts()).map((t) => t.trim()).join() === 'company,value,stage,close date', 'with the fields it keeps');

  // An email that mentions a deal: the screen picks it up on its own.
  await deliver(page, { from: 'Dana Whitfield <dana@acme.test>', subject: 'Renewal terms', body: `Hi Taylor,\n\n${sentence}\n\nDana` });
  ok(await until(async () => (await tracked()).tracked[0]?.known === 2), 'an email that mentions a deal is read into one');
  await kind.getByText('2 known').waitFor({ timeout: 15000 });
  await kind.locator('.trk-kind-toggle').click();
  const list = page.getByRole('list', { name: 'The deals Timmy knows' });
  await list.waitFor({ timeout: 15000 });
  const acme = list.locator('li.trk-thing', { hasText: 'Acme Corp' });
  await acme.waitFor({ timeout: 15000 });
  const row = await acme.innerText();
  ok(/Acme Corp/.test(row) && /value\s*\$40,000/.test(row) && /stage\s*negotiation/.test(row), 'it is listed with its fields');
  ok(row.includes(sentence) && /Dana Whitfield/.test(row) && /Renewal terms/.test(row), 'with the sentence it rests on and the email it came from');
  // The stand-in model also offered a close date the email never gave, and a deal named after the subject line
  // with a sentence that is nowhere in the email. Neither is on the screen.
  ok(!/close date/.test(row) && !/made up/i.test(await list.innerText()) && (await list.locator('li.trk-thing').count()) === 2, 'and nothing the email did not say');

  // The email can be opened from the list.
  await acme.getByRole('button', { name: 'Open email' }).click();
  await page.locator('.main').getByText('Renewal terms').first().waitFor({ timeout: 10000 });
  ok(true, 'the email behind a deal opens from the list');

  // Ask finds it, with the sentence behind it.
  await page.keyboard.press('Control+i');
  await page.locator('.ai-input').waitFor();
  await page.locator('.ai-input').fill('which deals do you know about');
  await page.keyboard.press('Enter');
  await page.locator('.ai-msg.timmy', { hasText: 'Acme Corp' }).waitFor({ timeout: 30000 });
  const answer = await page.locator('.ai-msg.timmy').last().innerText();
  ok(answer.includes('Deal: Acme Corp (company Acme Corp, value $40,000, stage negotiation). It rests on “' + sentence + '”'), 'Ask finds the deal, with its fields and the sentence it rests on');
  await page.keyboard.press('Escape');

  // Dismissing a suggestion: it goes and does not come back.
  await page.click('button[aria-label="People"]');
  await page.getByRole('tab', { name: 'What Timmy tracks' }).click();
  await page.getByRole('article', { name: 'Suggestion: leads' }).getByRole('button', { name: 'Dismiss' }).click();
  await page.locator('.toast', { hasText: 'Timmy won’t suggest leads again.' }).waitFor();
  ok(await until(async () => (await page.getByRole('article', { name: 'Suggestion: leads' }).count()) === 0), 'a dismissed suggestion leaves the screen');

  // Rename it, and remove a field.
  const menu = () => page.getByRole('button', { name: /^More actions for/ });
  await menu().click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename deals' });
  await dialog.getByLabel('Name, for one of them').fill('<b>Opportunity</b>');
  await dialog.getByRole('button', { name: 'Rename' }).click();
  await page.locator('.toast', { hasText: 'A name is up to four plain words' }).waitFor();
  ok((await tracked()).tracked[0].name === 'Deal', 'a name that is not plain words is refused');
  await dialog.getByLabel('Name, for one of them').fill('Opportunity');
  await dialog.getByRole('button', { name: 'Rename' }).click();
  const renamed = page.getByRole('article', { name: 'Opportunity', exact: true });
  await renamed.waitFor({ timeout: 10000 });
  ok((await tracked()).tracked[0].name === 'Opportunity' && /2 known/.test(await renamed.innerText()), 'a tracked kind can be renamed and keeps what it knows');
  await renamed.getByRole('button', { name: 'Remove the field stage from opportunities' }).click();
  await page.locator('.toast', { hasText: '“stage” is no longer kept for opportunities.' }).waitFor();
  ok(await until(async () => (await tracked()).tracked[0].fields.map((f) => f.key).join() === 'company,value,close_date'), 'a field can be removed');
  await renamed.locator('.trk-kind-toggle').click();
  await page.getByRole('list', { name: 'The opportunities Timmy knows' }).locator('li.trk-thing', { hasText: 'Acme Corp' }).waitFor({ timeout: 15000 });
  ok(!/negotiation/.test(await page.getByRole('list', { name: 'The opportunities Timmy knows' }).locator('li.trk-thing', { hasText: 'Acme Corp' }).locator('.trk-fields').innerText()), 'and what was learned for it is forgotten');

  // After a reload everything is as it was left: the server holds it, not the page.
  await page.reload();
  await page.locator('.main').waitFor();
  await page.click('button[aria-label="People"]');
  await page.getByRole('tab', { name: 'What Timmy tracks' }).click();
  await page.getByRole('article', { name: 'Opportunity', exact: true }).waitFor({ timeout: 15000 });
  ok((await page.getByRole('article', { name: /^Suggestion:/ }).count()) === 0, 'after a reload the dismissed suggestion is still gone and the kind is still tracked');

  // Stop tracking: asks first, then forgets what was learned.
  await menu().click();
  await page.getByRole('menuitem', { name: 'Stop tracking' }).click();
  const confirm = page.getByRole('dialog', { name: 'Stop tracking opportunities?' });
  ok(/forgets the 2 opportunities it knows/.test(await confirm.innerText()), 'stopping says what will be forgotten and asks first');
  await confirm.getByRole('button', { name: 'Stop tracking' }).click();
  await page.locator('.toast', { hasText: 'Timmy stopped tracking opportunities' }).waitFor();
  ok(await until(async () => (await tracked()).tracked.length === 0), 'stopping removes the kind');
  // The screen shows the list as the server now has it, a moment after the answer.
  await page.locator('.main').getByText('Nothing is tracked yet').waitFor({ timeout: 10000 });
  ok((await page.getByRole('article', { name: /^Suggestion:/ }).count()) === 0 && (await tracked()).proposals.length === 0, 'and it is not suggested again');

  // The refused name was answered with a 400, which the browser also writes to its console. That one is expected.
  const unexpected = errors.filter((e) => !/status of 400/.test(e));
  ok(unexpected.length === 0, `no page errors (${unexpected.join(' | ')})`);
});
