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
  ok(/Reads\s+Outlook mail and calendar/.test(before) && /events you add, change or delete in Timmy/.test(before) && !/OneDrive/.test(before), 'the Outlook card says it reads Outlook mail and the calendar, and does not promise OneDrive');

  // An account connected before Timmy asked Microsoft for the calendar allows mail only. Timmy finds out on its first
  // read of the calendar, stops asking, and the card says what to do.
  const refusedWords = /Outlook was connected without permission to read your calendar\. Disconnect it and connect it again so Timmy can read the calendar\./;
  await api(page, 'POST', '/api/test/fake', { op: 'scopes', scopes: ['Mail.ReadWrite', 'Mail.Send', 'User.Read', 'offline_access'] });
  await connectApp(page, 'Outlook and Microsoft 365', 'katherine@contoso.test');
  await page.click('button[aria-label="Connections"]');
  await card.getByRole('button', { name: 'Disconnect' }).waitFor();
  ok(await until(async () => refusedWords.test(await card.innerText())), 'connected without the calendar, the Outlook card says to connect it again so Timmy can read the calendar');
  ok(/Connected · katherine@contoso\.test/.test(await card.innerText()), 'its mail is still connected');
  await card.getByRole('button', { name: 'Disconnect' }).click();
  await card.getByRole('button', { name: 'Connect', exact: true }).waitFor({ timeout: 10000 });
  ok(await until(async () => !refusedWords.test(await card.innerText())), 'disconnected, the card no longer says it');

  await connectApp(page, 'Outlook and Microsoft 365', 'katherine@contoso.test');
  await page.click('button[aria-label="Connections"]');
  await card.getByRole('button', { name: 'Disconnect' }).waitFor();
  ok(/Connected · katherine@contoso\.test/.test(await card.innerText()), 'Outlook shows as connected, with the address Outlook gave');
  await page.waitForTimeout(1500);
  ok(!refusedWords.test(await card.innerText()), 'connected again with the calendar allowed, the card says nothing about it');
  ok((await sentMail(page)).length === 0, 'connecting sent nothing');
  const second = await api(page, 'POST', '/api/v1/connections/gmail/connect', {});
  ok(second.status === 409 && /katherine@contoso\.test/.test(JSON.stringify(second.body)), 'Gmail cannot be added beside it: a workspace has one mailbox');

  // The same account is a calendar. An event made in Outlook is announced, read, and shown on Timmy's calendar.
  const events = async () => Object.values((await api(page, 'GET', '/api/v1/state')).body.slices['ws.events']);
  const noon = new Date();
  noon.setHours(13, 0, 0, 0);
  const made = await api(page, 'POST', '/api/test/fake', { op: 'calendar-event', event: { id: 'AAMkAGNhbGVuZGFyLWV2ZW50LTE_AAA=', summary: 'Launch readiness review', start: noon.toISOString(), end: new Date(noon.getTime() + 3600000).toISOString(), attendees: ['john@nasa.test'] } });
  ok(made.body.ok && (await until(async () => (await events()).some((e) => e.title === 'Launch readiness review'))), 'an event made in Outlook’s calendar appears on Timmy’s calendar');
  const review = (await events()).find((e) => e.title === 'Launch readiness review');
  ok(/^ocal-[a-z0-9]{6}-[0-9a-f]{24}$/.test(review.id) && review.with.join() === 'mail:john@nasa.test', 'as an Outlook event, with its guest');
  await page.click('button[aria-label="Calendar"]');
  await page.getByRole('tab', { name: 'Day' }).click();
  await page.locator('.cal-ev', { hasText: 'Launch readiness review' }).first().waitFor({ timeout: 10000 });
  ok(true, 'and it is on the calendar screen');

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

  // A colleague who files with Timmy too replies, and Outlook keeps their “Timmy Waiting” category on mail sent within
  // one company. A mark already there when Timmy first sees a message is not the person's doing: the reply brings the
  // thread back to the inbox, as any reply does, and nothing files it under Waiting.
  const box = async () => (await threads()).find((t) => t.subject === 'Trajectory check').box;
  await deliver(page, {
    from: 'Dorothy Vaughan <dorothy@contoso.test>',
    subject: 'Re: Trajectory check',
    threadId: thread.ext.threadKey,
    body: 'The tables are attached.',
    categories: ['Timmy Waiting'],
    attachments: [
      { name: 'Re-entry tables.pdf', mimetype: 'application/pdf', size: 2048, sha256: 'x' },
      { name: 'contoso-logo.png', mimetype: 'image/png', size: 300, sha256: 'y', inline: true },
    ],
  });
  ok(await until(async () => (await box()) === 'inbox'), 'a colleague’s reply that arrives marked “Timmy Waiting” brings the thread back to the inbox, not to Waiting');
  const looked = (await api(page, 'POST', '/api/test/fake', { op: 'check-mailbox' })).body.checked;
  ok(looked.moved === 0 && (await box()) === 'inbox', 'and a look at the mailbox does not move it there either');
  // The reply's file is named on the message, as a Gmail message's are; the picture in the signature is not a file.
  await page.click('button[aria-label="Today & mail"]');
  await page.getByRole('tab', { name: /Triage/ }).click();
  await page.locator('.main').getByText('Trajectory check').first().click();
  await page.locator('.main .chip', { hasText: 'Re-entry tables.pdf' }).first().waitFor({ timeout: 10000 });
  ok((await page.locator('.main .chip', { hasText: 'contoso-logo.png' }).count()) === 0, 'the reply shows the name of the file it carries, and not the picture in its signature');
  await page.keyboard.press('Escape');

  // A mailbox with no Archive folder (some older Microsoft 365 mailboxes have none) gets one the first time a thread is archived.
  await deliver(page, { from: 'John Glenn <john@nasa.test>', subject: 'Launch window', body: 'Katherine, can you confirm the launch window?' });
  ok(await until(async () => (await threads()).some((t) => t.subject === 'Launch window')), 'a second thread arrives');
  ok((await api(page, 'POST', '/api/test/fake', { op: 'no-archive' })).body.ok, 'the mailbox has no Archive folder');
  const launch = (await threads()).find((t) => t.subject === 'Launch window');
  ok((await api(page, 'POST', '/api/v1/commands', { id: `arch2-${Date.now()}`, action: { type: 'move', id: launch.id, box: 'archived' } })).body.ok, 'archiving it in Timmy is accepted');
  ok(await until(async () => (await labels('Launch window')).includes('ARCHIVE')), 'it is filed in Outlook all the same');
  ok(Object.keys((await api(page, 'POST', '/api/test/fake', { op: 'folders' })).body.folders).join() === 'Archive', 'in an Archive folder Timmy made for it, the one folder made');

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
  // And reads it: the words come through the Drive connection at that moment.
  ok((await api(page, 'POST', '/api/test/fake', { op: 'file', file: { name: 'Re-entry checklist', text: 'Retro pack stays on.\nConfirm heat shield.' } })).body.ok, 'a second file, with contents, is announced');
  await page.locator('.ai-input').fill('what does the file re-entry checklist say');
  await page.keyboard.press('Enter');
  await page.locator('.ai-msg.timmy', { hasText: 'It says: Retro pack stays on.' }).waitFor({ timeout: 30000 });
  ok(true, 'Ask reads what a Google Doc says');
  await page.keyboard.press('Escape');

  // Disconnecting Outlook takes its mail off the screens.
  await page.click('button[aria-label="Connections"]');
  await card.getByRole('button', { name: 'Disconnect' }).click();
  await card.getByRole('button', { name: 'Connect' }).waitFor({ timeout: 10000 });
  ok(await until(async () => !(await threads()).some((t) => t.subject === 'Trajectory check')), 'after disconnecting Outlook its thread is gone from Timmy');
  ok(!(await events()).some((e) => e.title === 'Launch readiness review'), 'and so is its calendar event');

  // The one 409 above is this test's doing; nothing else should be reported.
  ok(errors.filter((e) => !/409/.test(e)).length === 0, `no page errors (${errors.join(' | ')})`);
});
