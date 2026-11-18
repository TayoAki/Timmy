// A new workspace's setup (src/live/Setup.tsx), sorting junk automatically, Triage newest first with
// "Accept all" in batches, and the files from a connected Drive on the Files screen.
const { BASE, ok, open, signUp, api, connectApp, run } = require('./lib.cjs');

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
  ok(/0 of 5 done/.test(await setup.innerText()), 'a new workspace opens on its setup, with nothing done yet');
  ok(/never sends, deletes or changes anything without your OK/.test(await setup.innerText()), 'it says up front that nothing happens without the person’s OK');
  ok((await setup.locator('.setup-step[data-state="open"]').getAttribute('data-step')) === 'mail', 'connecting email comes first');

  // Junk that arrives before anything is connected is impossible; connect Gmail from the setup.
  await connectFromSetup(page, 'Connect Gmail', 'grace@navy.test');
  await setup.waitFor();
  ok(/Gmail is connected\./.test(await setup.innerText()), 'back from Google, the setup opens again and says Gmail is connected');
  ok(!/connect=/.test(page.url()), 'the address bar is cleaned up, so a reload says nothing twice');
  ok(/1 of 5 done/.test(await setup.innerText()), 'one step done');
  ok((await setup.locator('.setup-step[data-state="open"]').getAttribute('data-step')) === 'sorting', 'choosing how Timmy sorts comes next');
  ok(/Gmail · grace@navy\.test/.test(await setup.locator('.setup-step[data-step="mail"]').innerText()), 'the email step shows the connected account');
  await setup.locator('.setup-status').waitFor();
  ok(true, 'it shows how much mail has come in so far');

  // Junk already waiting is sorted inside Timmy when the rule is switched on; mail a person wrote waits.
  await promo(page, 'Spring sale');
  await deliver(page, { from: 'Ada Lovelace <ada@engine.test>', subject: 'Notes on the engine', body: 'Could you read my notes by Friday?' });
  await setup.getByRole('button', { name: 'Sort junk automatically' }).click();
  await page.getByText(/Timmy archived 1 in Timmy/).waitFor();
  ok(true, 'switching sorting on says what it sorted, and that the mailbox was left as it was');
  let t = await threads(page);
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

  // The calendar, then files skipped, then the morning run.
  ok((await setup.locator('.setup-step[data-state="open"]').getAttribute('data-step')) === 'calendar', 'the calendar comes next');
  await connectFromSetup(page, 'Connect Google Calendar', 'grace@navy.test');
  await setup.waitFor();
  ok(/Google Calendar is connected\./.test(await setup.innerText()), 'back from Google again, the setup says the calendar is connected');
  ok((await setup.locator('.setup-step[data-state="open"]').getAttribute('data-step')) === 'files', 'files come next, marked optional');
  await setup.getByRole('button', { name: 'Skip for now' }).click();
  ok(/Skipped for now/.test(await setup.locator('.setup-step[data-step="files"]').innerText()), 'files can be skipped for now');
  await setup.getByRole('button', { name: /^Use / }).click();
  const done = page.getByRole('dialog', { name: 'Timmy is set up' });
  await done.waitFor();
  ok(/5 of 5 done/.test(await done.innerText()), 'every step done: Timmy is set up');
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
  ok(/Google Doc · Google Drive · read only/.test(await viewer.innerText()), 'clicking a file opens it inside Timmy, read only');
  ok((await viewer.getByRole('link', { name: 'Open in Google Drive' }).getAttribute('target')) === '_blank', 'with Open in Google Drive beside it');
  await viewer.getByRole('button', { name: 'Close', exact: true }).first().click();
  await p2.getByLabel('Find a file by name').fill('nothing like it');
  await p2.getByText('No file names match.').waitFor();
  ok(true, 'and finds them by name');

  ok(errors.length === 0 && second.errors.length === 0, `no page errors (${[...errors, ...second.errors].join(' | ')})`);
});
