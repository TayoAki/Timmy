// Live mode: Outlook and Google Drive, connected through Composio like Gmail.
// Outlook mail arrives, is filed and answered under the same approval rules; Drive's files can be found from Ask.
const { ok, open, signUp, api, connectApp, deliver, sentMail, run } = require('./lib.cjs');
const HOLD = Number(process.env.TIMMY_SEND_HOLD_SECONDS || 4) * 1000;

run('live-outlook', async (browser) => {
  const { page, errors } = await open(browser);
  await signUp(page, { name: 'Katherine Johnson' });
  const until = async (fn) => {
    for (let i = 0; i < 40; i++) {
      if (await fn()) return true;
      await page.waitForTimeout(250);
    }
    return false;
  };
  const threads = async () => (await api(page, 'GET', '/api/v1/state')).body.slices.threads;
  const labels = async (subject) => (await api(page, 'POST', '/api/test/fake', { op: 'labels' })).body.threads[subject] || [];

  // The card says what Timmy really does with Outlook today, not what the preview promises.
  await page.click('button[aria-label="Connections"]');
  const card = page.locator('li.conn-card', { has: page.getByText('Outlook and Microsoft 365', { exact: true }) }).first();
  await card.waitFor();
  const before = await card.innerText();
  ok(/Reads\s+Outlook mail/.test(before) && !/OneDrive/.test(before), 'the Outlook card says it reads Outlook mail, and does not promise the calendar or OneDrive');

  await connectApp(page, 'Outlook and Microsoft 365', 'katherine@contoso.test');
  await page.click('button[aria-label="Connections"]');
  await card.getByRole('button', { name: 'Disconnect' }).waitFor();
  ok(/Connected · katherine@contoso\.test/.test(await card.innerText()), 'Outlook shows as connected, with the address Outlook gave');
  ok((await sentMail(page)).length === 0, 'connecting sent nothing');
  const second = await api(page, 'POST', '/api/v1/connections/gmail/connect', {});
  ok(second.status === 409 && /katherine@contoso\.test/.test(JSON.stringify(second.body)), 'Gmail cannot be added beside it: a workspace has one mailbox');

  await page.click('button[aria-label="Rules & settings"]');
  const side = page.locator('.side-group', { has: page.locator('.side-title', { hasText: 'Connected' }) }).first();
  await side.waitFor();
  ok(/Outlook and Microsoft 365/.test(await side.innerText()) && !/Gmail|Google/.test(await side.innerText()), 'the settings sidebar lists Outlook as connected, and nothing that is not');

  // A new email arrives while the app is open. Outlook hands it over as HTML; what is shown is its words.
  await page.click('button[aria-label="Today & mail"]');
  await deliver(page, { from: 'John Glenn <john@nasa.test>', subject: 'Trajectory check', body: 'Katherine,\n\nCan you check the <re-entry> numbers & confirm by Friday?\n\nJohn' });
  await page.getByRole('tab', { name: /Triage/ }).click();
  const row = page.locator('.main').getByText('Trajectory check').first();
  await row.waitFor({ timeout: 10000 });
  ok(/John Glenn/.test(await page.locator('.main').innerText()), 'the new Outlook thread appears on its own, with the sender by name');
  await row.click();
  await page.locator('.main').getByText('Can you check the <re-entry> numbers & confirm by Friday?').first().waitFor();
  ok(!/<p>|<\/p>|<html|&lt;|&amp;/.test(await page.locator('.main').innerText()), 'the message reads as plain words: no markup and no escape codes');
  const thread = (await threads()).find((t) => t.subject === 'Trajectory check');
  ok(/^o-[0-9a-f]{20}$/.test(thread.id) && thread.ext.app === 'outlook', 'the thread is known as an Outlook thread');

  // Sorting it in Timmy puts a category on it in Outlook and leaves it in the inbox.
  await page.keyboard.press('Escape');
  await page.click('button[aria-label="Today & mail"]');
  await page.getByRole('tab', { name: /Triage/ }).click();
  await page.locator('.suggest-pill').first().click();
  ok(await until(async () => (await labels('Trajectory check')).includes('Timmy Follow Up')), 'accepting Timmy’s suggestion puts the “Timmy Follow Up” category on it in Outlook');
  ok((await labels('Trajectory check')).includes('INBOX') && (await sentMail(page)).length === 0, 'it stays in Outlook’s inbox, and filing sends nothing');

  // Timmy drafts a reply; approving it sends it once, from the Outlook mailbox, in the same conversation.
  ok((await api(page, 'POST', '/api/v1/commands', { id: `draft-${Date.now()}`, action: { type: 'makeDraft', id: thread.id } })).body.ok, 'asking for a draft is accepted');
  await page.click('button[aria-label="Approvals"]');
  const drafted = page.locator('.ap-card', { hasText: 'Re: Trajectory check' });
  await drafted.waitFor({ timeout: 15000 });
  ok((await sentMail(page)).length === 0, 'writing a draft sends nothing');
  await drafted.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('.toast', { hasText: /Sending in \d+ seconds/ }).waitFor();
  ok((await sentMail(page)).length === 0, 'approving the draft does not send it before the undo window ends');
  let sent = [];
  for (let i = 0; i < 30 && sent.length === 0; i++) {
    await page.waitForTimeout(500);
    sent = await sentMail(page);
  }
  ok(sent.length === 1 && sent[0].from === 'katherine@contoso.test', 'when the window ends the reply leaves from the Outlook mailbox');
  ok(sent[0].to.join() === 'john@nasa.test' && /^Thanks for your message/.test(sent[0].body), 'it goes to the person who wrote, with the words that were approved');
  ok(sent[0].threadId === thread.ext.threadKey, 'as a reply in the same Outlook conversation');
  await page.waitForTimeout(HOLD + 2000);
  ok((await sentMail(page)).length === 1, 'it is sent once, not again');

  // Archiving moves it to Outlook's Archive folder and takes Timmy's category off.
  ok((await api(page, 'POST', '/api/v1/commands', { id: `arch-${Date.now()}`, action: { type: 'move', id: thread.id, box: 'archived' } })).body.ok, 'archiving the thread is accepted');
  ok(await until(async () => (await labels('Trajectory check')).includes('ARCHIVE')), 'archiving in Timmy moves the message to Outlook’s Archive folder');
  ok(!(await labels('Trajectory check')).some((l) => /^Timmy/.test(l) || l === 'INBOX'), 'and it no longer carries Timmy’s category or sits in the inbox');

  // Google Drive sits beside the mailbox. Timmy keeps a list of files; Ask finds them by name.
  await connectApp(page, 'Google Drive', 'katherine@contoso.test');
  await page.click('button[aria-label="Connections"]');
  const driveCard = page.locator('li.conn-card', { has: page.getByText('Google Drive', { exact: true }) }).first();
  await driveCard.getByRole('button', { name: 'Disconnect' }).waitFor();
  ok(/Connected · katherine@contoso\.test/.test(await driveCard.innerText()) && /Writes\s+Nothing/.test(await driveCard.innerText()), 'Drive shows as connected, and says Timmy writes nothing to it');
  ok((await api(page, 'POST', '/api/test/fake', { op: 'file', file: { name: 'Friendship 7 launch plan' } })).body.ok, 'a new file in Drive is announced to Timmy');
  await page.keyboard.press('Control+i');
  await page.locator('.ai-input').waitFor();
  await page.locator('.ai-input').fill('find the file launch plan');
  await page.keyboard.press('Enter');
  await page.locator('.ai-msg.timmy', { hasText: 'Friendship 7 launch plan' }).waitFor({ timeout: 30000 });
  ok(/I found a file: “Friendship 7 launch plan” \(Google Doc\)/.test(await page.locator('.ai-msg.timmy').last().innerText()), 'Ask finds the Drive file by the words of its name');
  await page.keyboard.press('Escape');

  // Disconnecting Outlook takes its mail off the screens.
  await page.click('button[aria-label="Connections"]');
  await card.getByRole('button', { name: 'Disconnect' }).click();
  await card.getByRole('button', { name: 'Connect' }).waitFor({ timeout: 10000 });
  ok(await until(async () => !(await threads()).some((t) => t.subject === 'Trajectory check')), 'after disconnecting Outlook its thread is gone from Timmy');

  // The one 409 above is this test's doing; nothing else should be reported.
  ok(errors.filter((e) => !/409/.test(e)).length === 0, `no page errors (${errors.join(' | ')})`);
});
