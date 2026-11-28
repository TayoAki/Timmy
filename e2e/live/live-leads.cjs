// Leads that fit the offer, through Treg (here its stand-in), on a real workspace: the offer filled in from the
// business's website, leads suggested with checked emails and why they fit, a sequence written by Timmy's model,
// and its first step opened for a lead in the person's own mail app. Nobody is contacted by Timmy.
const { ok, open, signUp, api, connectGmail, sentMail, run } = require('./lib.cjs');

run('live-leads', async (browser) => {
  const { page, errors } = await open(browser);
  await page.addInitScript(() => {
    window.__opened = [];
    window.open = (url) => {
      window.__opened.push(String(url));
      return null;
    };
  });
  await signUp(page, { name: 'Morgan Lee' });
  await connectGmail(page, 'morgan@chair.test');
  const slices = async () => (await api(page, 'GET', '/api/v1/state')).body.slices;
  const until = async (test) => {
    for (let i = 0; i < 60; i++) {
      const s = await slices();
      if (test(s)) return s;
      await page.waitForTimeout(150);
    }
    return null;
  };
  ok((await api(page, 'GET', '/api/v1/leads/status')).body.on === true, 'lead suggestions are on where Treg is set up');

  // The offer, from the business's own website.
  await page.click('button[aria-label="Outbound"]');
  await page.getByRole('tab', { name: 'Templates & offer' }).click();
  await page.getByLabel('Your website').fill('brightreminders.example');
  await page.getByRole('button', { name: 'Draft from my website' }).click();
  await page.locator('.toast', { hasText: 'Filled in from your website' }).waitFor();
  const card = page.locator('.offer-card');
  ok((await card.locator('.field', { hasText: 'Proof' }).locator('input').inputValue()) === 'Clinics that switched to Brightreminders cut missed appointments by 30% in three months.', 'the proof is copied from the page');
  await card.getByRole('button', { name: 'Save offer' }).click();
  const s1 = await until((s) => s['out.offer']?.icp?.industries?.includes('Dental'));
  ok(s1 && s1['out.offer'].icp.titles[0] === 'Practice Manager', 'the offer and its ideal customer are saved');

  // Leads that fit it.
  await page.getByRole('tab', { name: /^Leads/ }).click();
  await page.getByRole('button', { name: 'Suggest leads' }).click();
  const modal = page.locator('.modal', { hasText: 'Find leads that fit your offer' });
  await modal.waitFor();
  ok(/checks each email/.test(await modal.innerText()) && /left today/.test(await modal.innerText()), 'the dialog says each email is checked, and how many are left today');
  await modal.locator('input').fill('dental practices in Portland');
  await modal.getByRole('button', { name: 'Find and add' }).click();
  await page.locator('.toast', { hasText: /Added 10 leads to “Suggested by Timmy”, each with a checked email/ }).waitFor();
  const s2 = await until((s) => Object.values(s['out.leads'] ?? {}).filter((l) => l.list === 'list-suggested').length === 10);
  ok(s2, 'ten leads are saved in Suggested by Timmy');
  const lead = Object.values(s2['out.leads']).find((l) => l.company === 'Cedar Dental Studio');
  ok(lead && lead.suggested.sources.some((x) => /checked: takes mail/.test(x.from)) && /^Running \d locations in Portland/.test(lead.opener ?? ''), 'each has a checked email, where it came from, and a first line from what was found');
  await page.locator('button.lead-name', { hasText: `${lead.first} ${lead.last}` }).click();
  const why = page.locator('.rp-section', { hasText: 'Why Timmy suggested them' });
  await why.waitFor();
  ok(/Nobody was contacted/.test(await why.innerText()) && /takes mail/.test(await why.innerText()), 'the lead panel says why Timmy suggested them');

  // A sequence written by Timmy's model, for the list.
  await page.getByRole('tab', { name: /^Campaigns/ }).click();
  await page.getByRole('button', { name: 'New campaign' }).first().click();
  const dlg = page.locator('.modal', { hasText: 'New campaign' });
  await dlg.waitFor();
  await dlg.getByRole('radio', { name: 'A whole list' }).click();
  await dlg.locator('select[aria-label="List"]').selectOption('list-suggested');
  await dlg.getByRole('button', { name: 'Write the sequence' }).click();
  const s3 = await until((s) => Object.values(s['out.campaigns'] ?? {}).some((c) => c.leads.length === 10));
  const camp = s3 && Object.values(s3['out.campaigns']).find((c) => c.leads.length === 10);
  ok(camp && camp.steps.length === 4 && camp.steps[0].variants[0].body.startsWith('{{opener}}'), 'Timmy wrote four steps that open with the lead’s own first line');
  ok(!JSON.stringify(camp.steps).includes('45%') && !JSON.stringify(camp.steps).includes('{{revenue}}'), 'a step with a made-up figure or field was replaced');

  // The first step, for one lead, opened in the person's own mail app.
  await page.getByRole('tab', { name: /^Leads/ }).click();
  await page.locator('button.lead-name', { hasText: `${lead.first} ${lead.last}` }).click();
  await page.getByRole('button', { name: 'Email', exact: true }).first().click();
  const form = page.locator('.msg-form');
  await form.waitFor();
  const body = await form.locator('textarea.msg-body').inputValue();
  ok(body.startsWith(lead.opener) && !/\{\{/.test(body), 'the email starts as their first step, filled in, with their first line');
  await page.locator('.modal').last().getByRole('button', { name: 'Open in Gmail' }).click();
  await page.locator('.toast', { hasText: /Opened in Gmail/ }).waitFor();
  const opened = await page.evaluate(() => window.__opened);
  ok(opened.length === 1 && new URL(opened[0]).searchParams.get('to') === lead.email, 'it opens in Gmail, to them');
  ok((await sentMail(page)).length === 0, 'Timmy sent nothing itself');

  // Due today: every lead's first step, written for them; the one opened in Gmail says so until it is in Sent.
  await page.getByRole('tab', { name: /^Due today/ }).click();
  const list = page.getByRole('list', { name: 'Steps due' });
  await list.waitFor();
  ok((await list.locator('.due-row').count()) === 10, 'Due today lists the first step for each of the ten leads');
  const mine = list.locator('.due-row', { hasText: `${lead.first} ${lead.last}` });
  await mine.locator('.due-opened').waitFor();
  ok(/Opened in Gmail/.test(await mine.innerText()) && (await mine.getByRole('button', { name: 'Open again' }).count()) === 1, 'the step opened in Gmail says so until it is in Sent');
  await api(page, 'POST', '/api/test/fake', { op: 'deliver', message: { from: 'morgan@chair.test', to: [lead.email], subject: 'no-shows at Cedar Dental Studio', body: 'Hi, a quick idea.', labels: ['SENT'] } });
  const moved = await until((s) => s['out.leads'][lead.id]?.step === 1 && !s['out.leads'][lead.id]?.openedStep);
  ok(moved, 'once it is in Sent, the lead moves on to their next step');
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Steps due"] .due-row').length === 9, null, { timeout: 15000 });
  ok(true, 'and leaves Due today until their next step is due');
  const other = list.locator('.due-row').first();
  const otherName = (await other.locator('strong').innerText()).trim();
  await other.getByRole('button', { name: 'Skip this step' }).click();
  await page.locator('.toast', { hasText: /Skipped step 1 for/ }).waitFor();
  const skipped = await until((s) => Object.values(s['out.leads']).some((l) => `${l.first} ${l.last}` === otherName && l.step === 1));
  ok(skipped && (await list.locator('.due-row').count()) === 8, 'a step can be skipped, and the lead waits for their next');

  ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
});
