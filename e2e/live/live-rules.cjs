// Putting an email in a project (components/ProjectPicker.tsx) and sorting rules (views/SortingRules.tsx,
// src/state/mail-rules.ts, server/src/sync/mail-rules.ts): from the email, from Triage, with a new project made on
// the spot; "always" for the sender saves a rule; a rule written in Rules › Triage shows what it would match, gives
// the mail already waiting a sure suggestion, and files new mail by itself.
const { ok, open, signUp, api, connectGmail, run } = require('./lib.cjs');

const SHOTS = process.env.SHOTS;

const slices = async (page) => (await api(page, 'GET', '/api/v1/state')).body.slices;
const threadBy = async (page, subject) => (await slices(page)).threads.find((t) => t.subject === subject);
const until = async (page, test, tries = 80) => {
  for (let i = 0; i < tries; i++) {
    const v = await test();
    if (v) return v;
    await page.waitForTimeout(150);
  }
  return null;
};

run('live-rules', async (browser) => {
  const { page, errors } = await open(browser, SHOTS ? { viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 } : {});
  await signUp(page, { name: 'Grace Hopper' });
  await connectGmail(page, 'grace@mycompany.test');
  const mails = [
    ['Dana Whitfield <dana@acme.test>', 'Homepage wireframes'],
    ['Sam Rivera <sam@acme.test>', 'Copy for the about page'],
    ['LinkedIn <news@linkedin.test>', 'You appeared in 9 searches'],
    ['Lee Park <lee@northwind.test>', 'Renewal terms'],
  ];
  for (const [from, subject] of mails) await api(page, 'POST', '/api/test/fake', { op: 'deliver', message: { from, subject, body: 'Could you take a look at this?' } });
  ok(!!(await until(page, async () => (await slices(page)).threads.length >= 4)), 'the mail is in');
  await page.reload();
  await page.locator('.main').waitFor();

  // From the email: make a project on the spot and put the email in it.
  await page.getByRole('tab', { name: /Triage/ }).click();
  await page.locator('.triage-subject', { hasText: 'Homepage wireframes' }).first().click();
  await page.getByRole('button', { name: 'Add to project' }).click();
  const picker = page.getByRole('dialog', { name: 'Put this email in a project' });
  await picker.getByLabel('Find or make a project').fill('Acme website');
  await picker.getByLabel('Find or make a project').press('Enter');
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await dialog.waitFor();
  // The dialog fills in the name as it opens.
  ok(!!(await until(page, async () => (await dialog.getByLabel('Name').inputValue()) === 'Acme website', 20)), 'a project that doesn’t exist yet can be made from the picker, named as typed');
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await page.locator('.thread-head .pp-chip', { hasText: 'Acme website' }).waitFor();
  ok(true, 'the email shows its new project');
  const acme = await until(page, async () => (await threadBy(page, 'Homepage wireframes'))?.project);
  ok(!!acme, 'and it is saved');

  // "Always" for the sender: a rule, and the other mail from Acme goes in the project too.
  const offer = page.getByRole('group', { name: 'Always for this sender' });
  ok(/Put new mail from anyone at acme\.test in Acme website too\?/.test(await offer.innerText()), 'Timmy offers to do the same for the sender’s company');
  await offer.getByRole('button', { name: 'Always' }).click();
  ok(!!(await until(page, async () => (await threadBy(page, 'Copy for the about page'))?.project === acme)), 'the other email from Acme goes in the project too');
  const rules = (await slices(page)).rules.filter((r) => r.mail);
  ok(rules.length === 1 && rules[0].text === 'Mail from anyone at acme.test: put it in Acme website.', 'saved as a sorting rule, in plain words');
  await api(page, 'POST', '/api/test/fake', { op: 'deliver', message: { from: 'Jo Patel <jo@acme.test>', subject: 'Launch date', body: 'When do we go live?' } });
  ok(!!(await until(page, async () => (await threadBy(page, 'Launch date'))?.project === acme)), 'new mail from Acme lands in the project by itself');

  // P on an open email opens the picker; picking takes it out of one project and into another.
  await page.locator('.crumbs').getByRole('button', { name: 'Back' }).click();
  await page.getByRole('tab', { name: /Triage/ }).click();
  await page.locator('.triage-subject', { hasText: 'Renewal terms' }).first().click();
  await page.locator('.thread-head').waitFor();
  await page.keyboard.press('p');
  await picker.waitFor();
  ok(true, 'P opens the picker on the open email');
  await picker.getByRole('option', { name: /Acme website/ }).click();
  await page.locator('.thread-head .pp-chip', { hasText: 'Acme website' }).waitFor();
  await page.getByRole('group', { name: 'Always for this sender' }).getByRole('button', { name: 'Just this one' }).click();
  await page.locator('.thread-head .pp-chip').click();
  await picker.getByRole('button', { name: 'Take out of Acme website' }).click();
  await page.getByRole('button', { name: 'Add to project' }).waitFor();
  ok(!!(await until(page, async () => (await threadBy(page, 'Renewal terms'))?.project === undefined)), 'an email can be taken out of a project again');

  // From a Triage row.
  await page.locator('.crumbs').getByRole('button', { name: 'Back' }).click();
  await page.getByRole('tab', { name: /Triage/ }).click();
  const row = page.locator('.triage-item', { hasText: 'Renewal terms' });
  await row.getByRole('button', { name: 'Project' }).click();
  await row.getByRole('option', { name: /Acme website/ }).click();
  ok(!!(await until(page, async () => (await threadBy(page, 'Renewal terms'))?.project === acme)), 'a Triage row can be put in a project without opening it');
  await row.getByRole('button', { name: 'Just this one' }).click();

  // Filing the same sender's mail the same way twice: Timmy offers it as a rule, in Triage.
  for (const n of [1, 2]) await api(page, 'POST', '/api/test/fake', { op: 'deliver', message: { from: 'Medium Writers <stories@medium.test>', subject: `Stories for you ${n}`, body: 'Stories picked for you.' } });
  ok(!!(await until(page, async () => (await slices(page)).threads.filter((t) => /^Stories for you/.test(t.subject)).length === 2)), 'two emails from Medium arrive');
  for (const n of [1, 2]) {
    const item = page.locator('.triage-item', { hasText: `Stories for you ${n}` });
    await item.getByRole('group', { name: 'Or move to' }).getByRole('button', { name: 'Archive' }).click();
    await item.waitFor({ state: 'detached' });
  }
  const learnedOffer = page.getByRole('region', { name: 'A rule Timmy could follow' });
  await learnedOffer.waitFor();
  ok(/You moved 2 emails from anyone at medium\.test to the archive yourself\. Make it a rule\?/.test(await learnedOffer.innerText()), 'after two, Timmy offers to make it a rule');
  await learnedOffer.getByRole('button', { name: 'Make it a rule' }).click();
  await learnedOffer.waitFor({ state: 'detached' });
  ok(!!(await until(page, async () => (await slices(page)).rules.some((r) => r.mail && r.text === 'Mail from anyone at medium.test: archive it.'))), 'one click makes it a rule');

  // Rules › Triage: write a rule, see what it matches, save it.
  await page.click('button[aria-label="Rules & settings"]');
  const form = page.getByRole('form', { name: 'New sorting rule' });
  await form.getByLabel('From').fill('linkedin.test');
  await form.getByLabel('Then').selectOption('archived');
  const preview = form.getByRole('status');
  await page.waitForFunction(() => /matches 1 email you have now, 1 waiting in Triage/.test(document.querySelector('.sr-preview')?.textContent ?? ''));
  ok(/Mail from anyone at linkedin\.test: archive it\./.test(await preview.innerText()), 'the form says in words what the rule does, and what it matches today');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sorting-rules.png` });
  await form.getByRole('button', { name: 'Save rule' }).click();
  const saved = page.locator('.sr-list .rule', { hasText: 'Mail from anyone at linkedin.test: archive it.' });
  await saved.waitFor();
  ok(/Files new mail in your mailbox too/.test(await saved.innerText()), 'the rule is listed, saying it files new mail in the mailbox');
  ok(!!(await until(page, async () => (await threadBy(page, 'You appeared in 9 searches'))?.suggestion?.confidence === 'high')), 'the LinkedIn email already waiting gets it as Timmy’s sure suggestion');
  await api(page, 'POST', '/api/test/fake', { op: 'deliver', message: { from: 'LinkedIn <jobs@linkedin.test>', subject: 'Jobs you may like', body: 'Jobs picked for you this week.' } });
  ok(!!(await until(page, async () => (await threadBy(page, 'Jobs you may like'))?.box === 'archived')), 'new LinkedIn mail is archived as it arrives');

  // A rule the form can't make sense of says why, and can't be saved.
  await form.getByLabel('From').fill('not an address');
  ok(/isn’t an email address or a domain/.test(await preview.innerText()) && (await form.getByRole('button', { name: 'Save rule' }).isDisabled()), 'a rule that makes no sense says why and can’t be saved');

  // Deleting a rule.
  await saved.getByRole('button', { name: /Delete rule/ }).click();
  await saved.waitFor({ state: 'detached' });
  ok(!!(await until(page, async () => !(await slices(page)).rules.some((r) => r.mail && r.text.includes('linkedin')))), 'a rule can be deleted');

  // Telling Timmy in Ask: the rule as understood, saved with one click.
  await page.keyboard.press('Control+i');
  await page.locator('.ai-input').waitFor();
  await page.locator('.ai-input').fill('Always archive mail from newsletters.test');
  await page.keyboard.press('Enter');
  const card = page.locator('.ai-msg.timmy').last();
  await card.getByRole('button', { name: 'Save rule' }).waitFor();
  const shown = await card.innerText();
  ok(/Mail from anyone at newsletters\.test: archive it\./.test(shown) && /Nothing changes until you save it/.test(shown), 'Ask writes the rule down in words and waits');
  ok(!(await slices(page)).rules.some((r) => r.mail && r.text.includes('newsletters')), 'nothing is saved by asking');
  await card.getByRole('button', { name: 'Save rule' }).click();
  ok(!!(await until(page, async () => (await slices(page)).rules.some((r) => r.mail && r.text === 'Mail from anyone at newsletters.test: archive it.'))), 'pressing Save rule saves it');
  await page.keyboard.press('Escape');
  await page.click('button[aria-label="Rules & settings"]');
  await page.locator('.sr-list .rule', { hasText: 'Mail from anyone at newsletters.test: archive it.' }).waitFor();
  ok(true, 'and it is listed with the others in Rules › Triage');

  ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
});
