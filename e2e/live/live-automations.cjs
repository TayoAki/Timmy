// Live mode: an automation drawn on the canvas really runs. The owner draws one, the server refuses to switch it
// on until what it needs is connected (and says why), then it is switched on, an email arrives, the run and what
// each step did show in the editor's Runs tab, and its Send step waits in Approvals until a person approves it.
const { ok, open, signUp, api, connectGmail, deliver, sentMail, run } = require('./lib.cjs');
const HOLD = Number(process.env.TIMMY_SEND_HOLD_SECONDS || 4) * 1000;

run('live-automations', async (browser) => {
  const { page, errors } = await open(browser);
  await signUp(page, { name: 'Katherine Johnson' });
  const slices = async () => (await api(page, 'GET', '/api/v1/state')).body.slices;
  const drawn = async () => Object.values((await slices())['ws.automations']).find((a) => a.name === 'Answer new leads');
  const until = async (fn, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      if (await fn()) return true;
      await page.waitForTimeout(250);
    }
    return false;
  };
  const openAutomation = async () => {
    await page.click('button[aria-label="AI library"]');
    await page.getByRole('tab', { name: /Automations/ }).click();
    await page.locator('.au-card', { hasText: 'Answer new leads' }).locator('.au-open').click();
    await page.waitForSelector('.ae');
  };
  const addStep = async (name) => {
    await page.locator('.ae-tabs [role="tab"]', { hasText: 'Blocks' }).click();
    await page.locator('.ae-card', { hasText: name }).click();
    await page.locator('.ae-settings').waitFor();
  };
  const onSwitch = page.locator('.ae-top button[role="switch"]');

  /* ── Draw it ── */
  await page.click('button[aria-label="AI library"]');
  await page.getByRole('tab', { name: /Automations/ }).click();
  await page.locator('button', { hasText: 'New automation' }).first().click();
  await page.waitForSelector('.au-sheet');
  await page.locator('.au-sheet input').first().fill('Answer new leads');
  await page.locator('.au-sheet button[type="submit"]').click();
  await page.waitForSelector('.ae');
  const canvas = await page.locator('.ae-canvas').boundingBox();
  await page.locator('.ae-card', { hasText: 'New email' }).dragTo(page.locator('.ae-canvas'), { targetPosition: { x: canvas.width / 2, y: 90 } });
  await page.waitForTimeout(300);
  ok((await page.locator('.ae-node').count()) === 1, 'the “New email” trigger is on the canvas');
  await page.getByPlaceholder('Any subject').fill('quote');

  // A block the engine can't run yet says so before anyone tries to switch it on.
  await page.locator('.ae-tabs [role="tab"]', { hasText: 'Blocks' }).click();
  ok(/can’t run on a real workspace yet/.test(await page.locator('.ae-card', { hasText: 'Update the CRM' }).innerText()), 'a block that can’t run on a real workspace yet says so in the list of blocks');
  ok(!/can’t run on a real workspace yet/.test(await page.locator('.ae-card', { hasText: 'Create a task' }).innerText()), 'and a block that does run carries no such note');

  await addStep('Create a task');
  await page.locator('.ae-template').fill('Follow up with {{name}}');
  await page.locator('.ae-settings select').selectOption('Tomorrow');
  await addStep('Draft a reply');
  await page.locator('.ae-settings select').selectOption('Brief');
  await addStep('Send the email');
  await page.locator('.ae-settings select').selectOption('Right away');
  await page.locator('.ae-top button', { hasText: 'Save' }).click();
  ok(await until(async () => (await drawn())?.nodes.length === 4 && (await drawn()).edges.length === 3), 'Save keeps the four steps and their connections on the server');
  ok((await drawn()).on === false, 'a new automation starts switched off');

  /* ── The On switch: refused with the server's reason, then accepted ── */
  await onSwitch.click();
  await page.locator('.toast', { hasText: '“New email” needs a mailbox' }).waitFor({ timeout: 8000 });
  ok(/can’t be switched on yet\. “New email” needs a mailbox\. Connect Gmail or Outlook in Connections first\./.test(await page.locator('.toast').first().innerText()), 'with no mailbox connected, switching it on is refused and the notice says why');
  ok(await until(async () => (await onSwitch.getAttribute('aria-checked')) === 'false'), 'the switch goes back to Off');
  ok((await drawn()).on === false, 'and the server has it switched off');

  // A change still on the canvas when the switch is refused isn't lost, and isn't called saved.
  await page.locator('.ae-node', { hasText: 'Create a task' }).click();
  await page.locator('.ae-template').fill('Follow up with {{name}} today');
  const answered = page.waitForResponse((r) => r.url().includes('/api/v1/commands') && r.request().method() === 'POST');
  await onSwitch.click();
  await answered;
  ok(await until(async () => /Unsaved changes/.test(await page.locator('.ae-saved').innerText())), 'a change that was on the canvas when the switch was refused shows as unsaved');
  ok((await drawn()).nodes[1].config.title === 'Follow up with {{name}}' && (await drawn()).on === false, 'the server still has the drawing as it was last saved');
  await page.locator('.ae-top button', { hasText: 'Save' }).click();
  ok(await until(async () => (await drawn()).nodes[1].config.title === 'Follow up with {{name}} today'), 'and Save then keeps the change');

  await connectGmail(page, 'katherine@langley.test');
  await openAutomation();
  ok((await page.locator('.ae-node').count()) === 4, 'after connecting the mailbox the drawing is still there, from the server');
  await onSwitch.click();
  ok(await until(async () => (await drawn()).on === true), 'with the mailbox connected, the owner switches it on and the server agrees');
  ok((await onSwitch.getAttribute('aria-checked')) === 'true', 'the switch shows On');
  ok((await sentMail(page)).length === 0, 'switching it on sent nothing');

  /* ── An email arrives: the run shows in the Runs tab ── */
  await page.locator('.ae-tabs [role="tab"]', { hasText: 'Runs' }).click();
  await page.locator('.ar', { hasText: 'No runs yet.' }).waitFor({ timeout: 8000 });
  ok(true, 'the Runs tab starts empty');
  await deliver(page, { from: 'Dorothy Vaughan <dorothy@westcomputing.test>', subject: 'Lunch on Friday?', body: 'Are you free?' });
  const got = await deliver(page, { from: 'Jamie Lee <jamie@brightwave.co>', subject: 'Quote for 40 seats?', body: 'Hi Katherine,\n\nCould you send pricing for 40 seats?\n\nJamie' });
  ok(got.body.ok, 'the test mailbox accepted the email and the signed webhook was taken');
  const runCard = page.locator('.ar-run', { hasText: 'An email from Jamie Lee: “Quote for 40 seats?”' });
  await runCard.waitFor({ timeout: 20000 });
  ok(true, 'the run appears in the Runs tab on its own, named for the email that started it');
  await runCard.locator('.ar-steps li.waiting', { hasText: 'Send the email' }).waitFor({ timeout: 20000 });
  const steps = await runCard.locator('.ar-steps li').allInnerTexts();
  ok(steps.length === 4 && /^New email/.test(steps[0]) && /Added the task “Follow up with Jamie Lee today”/.test(steps[1]) && /Drafted a reply to jamie@brightwave\.co/.test(steps[2]), `each step says what it did (${steps.join(' | ')})`);
  ok(/Waiting in Approvals: a reply to jamie@brightwave\.co\. Nothing is sent until someone approves it/.test(steps[3]) && /Waiting for an OK/.test(await runCard.innerText()), 'the Send step says it is waiting for a person');
  ok((await page.locator('.ar-run').count()) === 1, 'the email that didn’t match started no run');
  ok((await sentMail(page)).length === 0, 'the run has sent nothing');

  // What the run did inside Timmy is in the app: the task it added.
  const tasks = Object.values((await slices())['ws.tasks']);
  ok(tasks.length === 1 && tasks[0].title === 'Follow up with Jamie Lee today', 'the task the run added is in the workspace');
  await page.click('button[aria-label="Tasks"]');
  await page.locator('.main').getByText('Follow up with Jamie Lee today').first().waitFor({ timeout: 8000 });
  ok(true, 'and shows on the Tasks page');

  /* ── The Send step waits in Approvals ── */
  await page.click('button[aria-label="Approvals"]');
  const card = page.locator('.ap-card', { hasText: 'Reply “Re: Quote for 40 seats?” to jamie@brightwave.co' });
  await card.waitFor({ timeout: 10000 });
  const cardText = await card.innerText();
  ok(/The automation “Answer new leads” wants to send the reply Timmy drafted/.test(cardText) && /Thanks for your message/.test(cardText), 'the Send step is waiting in Approvals, showing the reply exactly as it would go out');
  await page.waitForTimeout(HOLD + 1500);
  ok((await sentMail(page)).length === 0, 'however long it waits, nothing is sent without an approval');

  await card.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('.toast', { hasText: /Approved\. It goes out in \d+ seconds/ }).waitFor();
  ok((await sentMail(page)).length === 0, 'approving it starts the undo window; nothing has left yet');
  let sent = [];
  for (let i = 0; i < 40 && sent.length === 0; i++) {
    await page.waitForTimeout(500);
    sent = await sentMail(page);
  }
  ok(sent.length === 1 && sent[0].to.length === 1 && sent[0].to[0] === 'jamie@brightwave.co' && /^Thanks for your message/.test(sent[0].body), 'when the window ends the reply goes out, to the person who wrote and nobody else');
  await page.waitForTimeout(HOLD + 2000);
  ok((await sentMail(page)).length === 1, 'it is sent once, not again');

  // Back in the editor, the run has finished.
  await openAutomation();
  await page.locator('.ae-tabs [role="tab"]', { hasText: 'Runs' }).click();
  await page.locator('.ar-run .ar-status.done').waitFor({ timeout: 15000 });
  ok(/Approved in Approvals, and sent to jamie@brightwave\.co/.test(await page.locator('.ar-run').first().innerText()), 'the Runs tab shows the run finished, and that the email went out after approval');
  const audit = (await api(page, 'GET', '/api/v1/audit')).body.entries.map((e) => e.action);
  ok(audit.includes('automation.on') && audit.includes('automation.run') && audit.includes('effect.approved') && audit.includes('effect.completed'), 'switching it on, the run and the approved send are all in the audit log');

  ok(errors.filter((e) => !/400|404|409/.test(e)).length === 0, `no page errors (${errors.join(' | ')})`);
});
