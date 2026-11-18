// A new workspace's setup (src/live/Setup.tsx, SetupSteps.tsx): email, then Drive, then the projects Timmy finds in
// them, then a tour on the person's own mail and files (an email into a project, a to-do from an email in a project, a
// Drive document in Timmy's editor), then sorting junk, the calendar and the morning run. Then Triage newest first
// with "Accept all" in batches, and the files from a connected Drive on the Files screen.
const { BASE, ok, open, signUp, api, connectApp, run } = require('./lib.cjs');

/** With SHOTS set to a folder, pictures of the new steps are kept there. */
const shot = async (locator, name) => process.env.SHOTS && locator.screenshot({ path: `${process.env.SHOTS}/${name}.png` });

const threads = async (page) => (await api(page, 'GET', '/api/v1/state')).body.slices.threads;
/** Delivers an email and waits until Timmy has taken it in (new mail is taken in by a background job). */
const deliver = async (page, message) => {
  const r = await api(page, 'POST', '/api/test/fake', { op: 'deliver', message });
  for (let i = 0; i < 80; i++) {
    if ((await threads(page)).some((t) => t.subject === message.subject)) return r;
    await page.waitForTimeout(150);
  }
  throw new Error(`FAIL: ${message.subject} never arrived`);
};
const promo = (page, subject) => deliver(page, { from: 'Shop <deals@shop.test>', subject, body: 'Everything is 40% off.', labels: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'] });

/** Presses a Connect button inside the setup and waits for the trip to the app's sign-in page and back. */
async function connectFromSetup(page, button, address) {
  await api(page, 'POST', '/api/test/fake', { op: 'address', address });
  const back = page.waitForResponse((r) => r.url().includes('/api/v1/connections/callback'), { timeout: 30000 });
  await page.getByRole('dialog', { name: 'Set up Timmy' }).getByRole('button', { name: button }).click();
  await back;
  await page.waitForLoadState('load');
  await page.locator('.main').waitFor();
}

run('live-setup', async (browser) => {
  const { page, errors } = await open(browser);
  await signUp(page, { name: 'Grace Hopper', keepSetup: true });

  // A new workspace opens on its setup.
  const setup = page.getByRole('dialog', { name: 'Set up Timmy' });
  await setup.waitFor();
  ok(/0 of 7 done/.test(await setup.innerText()), 'a new workspace opens on its setup, with nothing done yet');
  ok(/never sends, deletes or changes anything without your OK/.test(await setup.innerText()), 'it says up front that nothing happens without the person’s OK');
  ok((await setup.locator('.setup-step[data-state="open"]').getAttribute('data-step')) === 'mail', 'connecting email comes first');
  const openStep = async () => setup.locator('.setup-step[data-state="open"]').getAttribute('data-step');

  // 1. Email.
  await connectFromSetup(page, 'Connect Gmail', 'grace@navy.test');
  await setup.waitFor();
  ok(/Gmail is connected\./.test(await setup.innerText()), 'back from Google, the setup opens again and says Gmail is connected');
  ok(!/connect=/.test(page.url()), 'the address bar is cleaned up, so a reload says nothing twice');
  ok(/1 of 7 done/.test(await setup.innerText()), 'one step done');
  ok((await openStep()) === 'files', 'connecting files comes next');
  ok(/Gmail · grace@navy\.test/.test(await setup.locator('.setup-step[data-step="mail"]').innerText()), 'the email step shows the connected account');
  await setup.locator('.setup-status').waitFor();
  ok(true, 'it shows how much mail has come in so far');

  // Mail comes in: two people at Acme about one piece of work, a colleague, and a promotion.
  await promo(page, 'Spring sale');
  await deliver(page, { from: 'Dana Whitfield <dana@acme.test>', subject: 'Website redesign kickoff', body: 'Could you take a look at the plan?' });
  await deliver(page, { from: 'Sam Rivera <sam@acme.test>', subject: 'Homepage wireframes', body: 'Here are the wireframes. Please send the brand guide by 2026-11-25.' });
  await deliver(page, { from: 'Ada Lovelace <ada@engine.test>', subject: 'Notes on the engine', body: 'Could you read my notes by Friday?' });

  // 2. Files: Google Drive, with a document from Acme in it.
  await connectFromSetup(page, 'Connect Google Drive', 'grace@navy.test');
  await setup.waitFor();
  ok(/Google Drive is connected\./.test(await setup.innerText()), 'Drive connects from the setup too');
  ok((await api(page, 'POST', '/api/test/fake', { op: 'file', file: { name: 'Acme redesign brief', owner: 'dana@acme.test', mimeType: 'application/vnd.google-apps.document', text: 'The Acme website redesign: goals and timeline.' } })).body.ok, 'a document from Acme is in the Drive');
  ok(/2 of 7 done/.test(await setup.innerText()), 'two steps done');

  // 3. Projects: the scan starts by itself and lists what it found, ticked; one click creates them.
  ok((await openStep()) === 'projects', 'finding projects comes next');
  const found = setup.getByRole('list', { name: 'Projects Timmy found' });
  await found.waitFor({ timeout: 60000 });
  ok(true, 'the scan starts by itself once mail is in, and lists the projects it found');
  const firstBox = found.locator('input[type="checkbox"]').first();
  ok(await firstBox.isChecked(), 'each project found starts out ticked');
  await shot(setup, 'setup-projects');
  ok(/2 emails/.test(await found.locator('li').first().innerText()), 'with how many emails it holds');
  await setup.getByRole('button', { name: /^Create 1 project$/ }).click();
  await page.locator('.toast', { hasText: /New mail and files go in them on their own/ }).waitFor();
  ok(true, 'creating them says what went in, and that new mail and files follow');
  const project = Object.values((await api(page, 'GET', '/api/v1/state')).body.slices['ws.projects']).find((p) => p.status === 'active');
  ok(!!project, 'the project exists');
  let t = await threads(page);
  ok(t.filter((x) => x.project === project.id).map((x) => x.subject).sort().join('|') === 'Homepage wireframes|Website redesign kickoff', 'its emails are in it');
  for (let i = 0; i < 40 && (await openStep()) !== 'tour'; i++) await page.waitForTimeout(150);
  ok(/3 of 7 done/.test(await setup.innerText()) && (await openStep()) === 'tour', 'the tour comes next');

  // 4. The tour, on the person's own mail and files.
  const tour = setup.locator('.setup-step[data-step="tour"]');
  const card = (title) => tour.locator('.setup-tour-card', { hasText: title });
  // An email into a project.
  const emailCard = card('Put an email in a project');
  ok(/“Notes on the engine” from Ada Lovelace/.test(await emailCard.innerText()), 'the tour picks an email that is in no project yet');
  await emailCard.getByRole('button', { name: 'Add to project' }).click();
  await emailCard.getByRole('dialog', { name: 'Put this email in a project' }).getByRole('option', { name: new RegExp(project.name) }).click();
  await emailCard.locator('[data-done="true"], .setup-tour-icon').first().waitFor();
  for (let i = 0; i < 40 && !(await emailCard.getAttribute('data-done')); i++) await page.waitForTimeout(150);
  ok((await emailCard.getAttribute('data-done')) === 'true', 'putting it in a project ticks the first part');
  t = await threads(page);
  ok(t.find((x) => x.subject === 'Notes on the engine').project === project.id, 'the email is in the project');
  // A to-do Timmy made from an email, already in the email's project.
  const todoCard = card('A to-do from an email, in a project');
  ok(/Timmy made “Send the brand guide” from “Homepage wireframes”, due Nov 25/.test(await todoCard.innerText()), 'the tour shows the to-do Timmy made from what an email asked');
  ok((await todoCard.getByRole('combobox', { name: 'The to-do’s project' }).inputValue()) === project.id, 'and it is in the email’s project already');
  ok((await todoCard.getAttribute('data-done')) === 'true', 'which ticks the second part');
  // A Drive document opened in Timmy's own editor.
  const docCard = card('Open a Drive document in Timmy');
  await docCard.getByText('“Acme redesign brief” · Google Doc').waitFor();
  await shot(setup, 'setup-tour');
  ok(new RegExp(`in ${project.name}`).test(await docCard.innerText()), 'the tour picks a document, one already in a project');
  await docCard.getByRole('button', { name: 'Open in Timmy’s editor' }).click();
  const editor = page.getByRole('dialog', { name: 'Acme redesign brief in Timmy’s editor' });
  await editor.waitFor();
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = /Saves go to this file in Google Drive/.test(await editor.locator('.craft-state').innerText().catch(() => ''));
    if (!ready) await page.waitForTimeout(1000);
  }
  ok(ready, 'it opens in the document editor, which saves back to Drive');
  await editor.getByRole('button', { name: 'Close' }).click();
  ok((await docCard.getAttribute('data-done')) === 'true', 'closing it ticks the third part');
  ok(/3 of 3 tried/.test(await tour.innerText()), 'all three tried');
  await tour.getByRole('button', { name: 'Done' }).click();
  ok(/4 of 7 done/.test(await setup.innerText()), 'the tour is done');

  // 5. Sorting: junk already waiting is sorted inside Timmy when the rule is switched on; mail a person wrote waits.
  ok((await openStep()) === 'sorting', 'choosing how Timmy sorts comes next');
  await setup.getByRole('button', { name: 'Sort junk automatically' }).click();
  await page.getByText(/Timmy archived 1 in Timmy/).waitFor();
  ok(true, 'switching sorting on says what it sorted, and that the mailbox was left as it was');
  t = await threads(page);
  ok(t.find((x) => x.subject === 'Spring sale').box === 'archived', 'the promotion already waiting is archived');
  ok(t.find((x) => x.subject === 'Notes on the engine').box === 'inbox', 'the email a person wrote still waits in Triage');
  const labels = (await api(page, 'POST', '/api/test/fake', { op: 'labels' })).body.threads;
  ok(labels['Spring sale'].includes('INBOX'), 'the promotion that was already there is left as it was in Gmail');

  // New junk is filed as it arrives, in Gmail too.
  await promo(page, 'Summer sale');
  let filed = false;
  for (let i = 0; i < 40 && !filed; i++) {
    filed = !(await api(page, 'POST', '/api/test/fake', { op: 'labels' })).body.threads['Summer sale'].includes('INBOX');
    if (!filed) await page.waitForTimeout(250);
  }
  ok((await threads(page)).find((x) => x.subject === 'Summer sale').box === 'archived' && filed, 'junk that arrives afterwards is archived in Timmy and in Gmail');

  // 6. The calendar, then 7. the morning run.
  ok((await openStep()) === 'calendar', 'the calendar comes next');
  await connectFromSetup(page, 'Connect Google Calendar', 'grace@navy.test');
  await setup.waitFor();
  ok(/Google Calendar is connected\./.test(await setup.innerText()), 'back from Google again, the setup says the calendar is connected');
  // Back from Google the page has reloaded, and whether sorting is on is asked of the server again: the open step
  // settles once it has answered.
  for (let i = 0; i < 40 && (await openStep()) !== 'morning'; i++) await page.waitForTimeout(150);
  ok((await openStep()) === 'morning', 'the morning run comes last');
  await setup.getByRole('button', { name: /^Use / }).click();
  const done = page.getByRole('dialog', { name: 'Timmy is set up' });
  await done.waitFor();
  ok(/7 of 7 done/.test(await done.innerText()), 'every step done: Timmy is set up');
  await done.getByRole('button', { name: 'Open Triage' }).click();
  await page.getByRole('heading', { name: 'Triage' }).waitFor();
  ok(true, 'Open Triage goes to Triage');

  // With everything done, the brief offers no setup; a reload opens nothing by itself.
  await page.click('button[aria-label="Today & mail"]');
  await page.getByRole('heading', { name: /Good morning/ }).waitFor();
  ok((await page.getByRole('button', { name: /Set up Timmy/ }).count()) === 0, 'the brief no longer offers the setup');
  ok((await page.getByRole('button', { name: 'Watch the story' }).count()) === 0, 'a real workspace has no “Watch the story” button');
  await page.reload();
  await page.locator('.main').waitFor();
  await page.waitForTimeout(500);
  ok((await page.getByRole('dialog').count()) === 0, 'reloading opens nothing by itself');

  // A second person: the connect fails, then succeeds from Connections; Triage, Accept all and Drive.
  const second = await open(browser);
  const p2 = second.page;
  await signUp(p2, { name: 'Katherine Johnson', keepSetup: true });
  const setup2 = p2.getByRole('dialog', { name: 'Set up Timmy' });
  await setup2.waitFor();
  // Google's page is left without allowing access: Composio sends the person back with nothing connected.
  await p2.route('**/api/test/fake-connect**', (route) => {
    const to = new URL(route.request().url()).searchParams.get('to');
    return route.fulfill({ status: 302, headers: { location: to } });
  });
  await api(p2, 'POST', '/api/test/fake', { op: 'address', address: 'katherine@nasa.test' });
  await setup2.getByRole('button', { name: 'Connect Gmail' }).click();
  await p2.waitForURL((u) => !u.searchParams.has('connect') && !u.pathname.includes('/api/'), { timeout: 30000 });
  await setup2.waitFor();
  await setup2.getByText(/Connecting Gmail didn’t finish, so nothing was connected\. Try again\./).waitFor();
  ok(true, 'a connect that did not finish brings the setup back with a plain warning');
  await p2.unroute('**/api/test/fake-connect**');
  await setup2.getByRole('button', { name: 'Finish later' }).click();

  // The brief offers the setup until it is done.
  ok((await p2.getByRole('button', { name: /Set up Timmy/ }).count()) >= 1, 'the brief offers the setup again');
  ok(/Connect your email to get started/.test(await p2.locator('.setup-card').innerText()), 'and an empty brief says to connect email first');

  // Connecting from Connections, not from the setup, says so in a notice and opens nothing.
  await connectApp(p2, 'Gmail', 'katherine@nasa.test');
  await p2.getByText('Gmail is connected. Timmy is bringing in your mail.').waitFor();
  await p2.waitForTimeout(300);
  ok((await p2.getByRole('dialog', { name: 'Set up Timmy' }).count()) === 0, 'connecting from Connections shows a notice and does not open the setup');

  // Triage: newest first, and more sure suggestions than one command may file are accepted in batches.
  for (let i = 0; i < 104; i++) await deliver(p2, { from: 'Billing <receipts@saas.test>', subject: `Your receipt #${1000 + i}`, body: 'Thanks for your payment.' });
  await deliver(p2, { from: 'Ada Lovelace <ada@engine.test>', subject: 'Newest from a person', body: 'Are you free Thursday?' });
  await p2.click('button[aria-label="Today & mail"]');
  await p2.getByRole('tab', { name: /Triage/ }).click();
  await p2.getByRole('heading', { name: 'Triage' }).waitFor();
  await p2.locator('.triage-item').first().waitFor();
  ok(/Newest from a person/.test(await p2.locator('.triage-item').first().innerText()), 'Triage lists the newest email first');
  const offer = p2.locator('.autosort-offer');
  ok(/104 of these are promotions, receipts, notices or newsletters/.test(await offer.innerText()), 'Triage offers to sort the junk automatically, with how many');
  await p2.getByRole('button', { name: 'Accept all 104 Timmy is sure about' }).click();
  const confirm = p2.getByRole('dialog', { name: 'Accept 104 suggestions?' });
  await confirm.waitFor();
  ok(/104 emails archived in Gmail/.test(await confirm.innerText()), 'accepting many asks first and says what happens in Gmail');
  await confirm.getByRole('button', { name: 'Accept 104' }).click();
  let left = 104;
  for (let i = 0; i < 60 && left > 0; i++) {
    left = (await threads(p2)).filter((x) => /^Your receipt/.test(x.subject) && x.box !== 'archived').length;
    if (left) await p2.waitForTimeout(250);
  }
  ok(left === 0, 'all 104 are archived, though one command may file at most 100');
  ok((await p2.getByText(/That would file \d+ threads at once/).count()) === 0, 'and nobody is told to do it in smaller batches');

  // Files: what a connected Drive holds is listed, and found by name.
  await connectApp(p2, 'Google Drive', 'katherine@nasa.test');
  const added = await api(p2, 'POST', '/api/test/fake', { op: 'file', file: { name: 'Trajectory calculations', mimeType: 'application/vnd.google-apps.document', text: 'Orbit insertion at 14:02.\nBurn for 312 seconds.' } });
  ok(added.body.ok, 'a file is put in the stand-in Drive');
  // On a real workspace, Drive opens on the files from the connected Google Drive or OneDrive.
  await p2.click('button[aria-label="Drive"]');
  await p2.getByRole('heading', { name: 'Google Drive' }).waitFor();
  ok((await p2.getByRole('tab', { name: 'Drive & OneDrive' }).getAttribute('aria-selected')) === 'true', 'Drive opens on the connected files');
  await p2.getByText('Trajectory calculations').waitFor();
  ok(/Google Doc · Google Drive/.test(await p2.locator('.cf-row').first().innerText()), 'the Files screen lists the Drive’s files with their kind and app');
  // A file opens inside Timmy, read only, with the way to its own app beside it.
  await p2.getByRole('button', { name: 'Trajectory calculations' }).click();
  const viewer = p2.getByRole('dialog', { name: 'Trajectory calculations' });
  await viewer.waitFor();
  await viewer.frameLocator('iframe.mail-frame').getByText('Orbit insertion at 14:02.').waitFor();
  ok(/Google Doc · Google Drive/.test(await viewer.innerText()) && (await viewer.getByRole('button', { name: 'Edit in Timmy' }).count()) === 1, 'clicking a file opens it inside Timmy, with Edit in Timmy to change it');
  ok((await viewer.getByRole('link', { name: 'Open in Google Drive' }).getAttribute('target')) === '_blank', 'with Open in Google Drive beside it');
  await viewer.getByRole('button', { name: 'Close', exact: true }).first().click();
  await p2.getByLabel('Find a file by name').fill('nothing like it');
  await p2.getByText('No file names match.').waitFor();
  ok(true, 'and finds them by name');

  ok(errors.length === 0 && second.errors.length === 0, `no page errors (${[...errors, ...second.errors].join(' | ')})`);
});
