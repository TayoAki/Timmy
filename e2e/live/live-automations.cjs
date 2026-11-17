// Live mode: an automation drawn on the canvas really runs. The owner draws one, the server refuses to switch it
// on until what it needs is connected (and says why), then it is switched on, an email arrives, the run and what
// each step did show in the editor's Runs tab, and its Send step waits in Approvals until a person approves it.
// The editor's Test run is the server's: it walks the drawing with sample data or a recent email and does nothing.
// Draft then Send is one card in Approvals. With the mailbox disconnected the automation shows as paused, and it
// carries on once one is connected. A page open in the editor keeps a line an automation adds to it.
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

  /* ── Test run: the server walks the drawing as it is on the canvas, and does nothing ── */
  const testPanel = page.locator('.ae-test');
  await page.locator('.ae-top button', { hasText: 'Test run' }).click();
  await testPanel.locator('.ae-test-verdict').waitFor({ timeout: 10000 });
  const firstTest = await testPanel.innerText();
  ok(/With sample data:/.test(firstTest) && /Task “Follow up with Jamie Lee today”, due tomorrow/.test(firstTest), `the test run walks the steps as drawn, unsaved change included, with sample data (${firstTest.replace(/\n/g, ' | ')})`);
  ok(/Would wait in Approvals for someone to send it/.test(firstTest) && /To jamie@brightwave\.co/.test(firstTest) && /Subject: Re: Quote for 40 seats\?/.test(firstTest), 'it shows what the Send step would put forward in Approvals, and to whom');
  ok(/What stops it being switched on/.test(firstTest) && /“New email” needs a mailbox\. Connect Gmail or Outlook in Connections first\./.test(firstTest), 'and what would stop it being switched on');
  ok((await page.locator('.ae-node.done').count()) === 4, 'the steps it reached are marked on the canvas');
  ok((await drawn()).nodes[1].config.title === 'Follow up with {{name}}' && Object.keys((await slices())['ws.tasks'] || {}).length === 0 && (await slices()).pending.length === 0, 'the test run saved nothing, added no task and put nothing in Approvals');
  ok(/Unsaved changes/.test(await page.locator('.ae-saved').innerText()), 'and the change on the canvas is still unsaved');
  await testPanel.getByRole('button', { name: 'Close the test run' }).click();
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
  ok((await page.locator('.ap-card', { hasText: 'Quote for 40 seats?' }).count()) === 1, 'it is the one card for that email: the draft it sends has no second card of its own');
  ok(/turn it down and the draft is discarded too/.test(cardText), 'the card says what turning it down does to the draft');
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

  /* ── Test run with a real email that arrived ── */
  const runCount = async () => (await api(page, 'GET', `/api/v1/automations/${(await drawn()).id}/runs`)).body.runs.length;
  const before = { runs: await runCount(), tasks: Object.keys((await slices())['ws.tasks']).length, sent: (await sentMail(page)).length };
  await page.locator('.ae-top button', { hasText: 'Test run' }).click();
  await testPanel.locator('.ae-test-verdict').waitFor({ timeout: 10000 });
  const picker = testPanel.getByLabel('Test with');
  await page.waitForFunction(() => document.querySelectorAll('.ae-test select option').length >= 3, null, { timeout: 10000 });
  const options = await picker.locator('option').allInnerTexts();
  ok(options[0] === 'Sample data' && options.includes('Jamie Lee <jamie@brightwave.co>: Quote for 40 seats?') && options.some((o) => /Dorothy Vaughan/.test(o)), `the recent emails are offered to test with (${options.join(' | ')})`);
  await picker.selectOption({ label: 'Jamie Lee <jamie@brightwave.co>: Quote for 40 seats?' });
  await testPanel.getByRole('button', { name: 'Run the test' }).click();
  await testPanel.getByText('With Jamie Lee: “Quote for 40 seats?”:').waitFor({ timeout: 10000 });
  const emailTest = await testPanel.innerText();
  ok(/Would wait in Approvals for someone to send it/.test(emailTest) && /To jamie@brightwave\.co/.test(emailTest) && /Nothing stops it being switched on\./.test(emailTest), 'tested with that email, it shows the reply going to its sender, and nothing stopping it');
  await page.waitForTimeout(800);
  ok((await runCount()) === before.runs && Object.keys((await slices())['ws.tasks']).length === before.tasks && (await sentMail(page)).length === before.sent && (await slices()).pending.length === 0, 'testing with a real email started no run, added no task, sent nothing and put nothing in Approvals');
  await testPanel.getByRole('button', { name: 'Close the test run' }).click();

  /* ── No mailbox: paused, with the reason; connected again, it carries on ── */
  ok((await api(page, 'POST', '/api/v1/connections/gmail/disconnect', {})).status === 200, 'the mailbox is disconnected');
  await page.locator('.ae-paused', { hasText: 'Paused. Connect a mailbox to run this.' }).waitFor({ timeout: 10000 });
  ok((await page.locator('.ae-top .ae-switch > span').innerText()) === 'Paused', 'the editor shows the automation as paused, and why');
  ok((await drawn()).on === true && (await drawn()).paused === 'Connect a mailbox to run this.', 'it is still on, and the server has it paused');
  await page.click('button[aria-label="AI library"]');
  await page.getByRole('tab', { name: /Automations/ }).click();
  const listCard = page.locator('.au-card', { hasText: 'Answer new leads' });
  await listCard.locator('.au-note', { hasText: 'Paused. Connect a mailbox to run this.' }).waitFor({ timeout: 8000 });
  ok((await listCard.locator('.ae-switch > span').innerText()) === 'Paused', 'the list of automations shows it paused too');

  await connectGmail(page, 'katherine@langley.test');
  ok(await until(async () => (await drawn()).paused === undefined && (await drawn()).on === true), 'with a mailbox connected again, it is no longer paused');
  await page.click('button[aria-label="AI library"]');
  await page.getByRole('tab', { name: /Automations/ }).click();
  ok(await until(async () => (await listCard.locator('.ae-switch > span').innerText()) === 'On' && (await listCard.locator('.au-note').count()) === 0), 'and the list shows it On, with no note');
  await deliver(page, { from: 'Mary Jackson <mary@langley.test>', subject: 'Another quote, please', body: 'For 12 seats.' });
  ok(await until(async () => (await runCount()) === before.runs + 1, 60), 'new mail starts a run again');

  /* ── A page open in the editor keeps the line an automation adds to it ── */
  const cmd = (action) => api(page, 'POST', '/api/v1/commands', { id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, action });
  await cmd({ type: 'ws', ops: [{ op: 'put', col: 'files', item: { id: 'lead-notes', name: 'Lead notes', kind: 'doc', folder: '', updated: new Date().toISOString(), owner: 'me' } }, { op: 'put', col: 'docs', item: { id: 'lead-notes', template: 'blank', blocks: [{ id: 'n1', type: 'p', text: 'Leads this month' }] } }] });
  const logLeads = { id: 'log-leads', name: 'Log leads', description: '', on: false, updated: new Date().toISOString(), nodes: [{ id: 't', kind: 'email', x: 0, y: 0, config: { subject: 'pricing' } }, { id: 'doc', kind: 'doc', x: 0, y: 150, config: { doc: 'Lead notes', line: '{{name}} asked: {{subject}}' } }], edges: [{ id: 'e1', from: 't', to: 'doc' }] };
  ok((await cmd({ type: 'ws', ops: [{ op: 'put', col: 'automations', item: logLeads }] })).body.ok && (await cmd({ type: 'ws', ops: [{ op: 'patch', col: 'automations', id: 'log-leads', patch: { on: true } }] })).body.ok, 'an automation that adds a line to “Lead notes” is switched on');
  const noteLines = async () => (await slices())['ws.docs']['lead-notes'].blocks.map((b) => b.text);
  const openNotes = async () => {
    await page.click('button[aria-label="Docs"]');
    await page.locator('.main').getByText('Lead notes').first().click();
    await page.waitForSelector('.nb-editor');
  };
  // As in live-pages: click the line, let the editor read where the click put the cursor, then go to its end.
  const typeAtEndOf = async (text) => {
    await page.locator('.nb-editor p', { hasText: text }).first().click();
    await page.waitForFunction((t) => document.activeElement?.classList.contains('nb-editor') && (window.getSelection()?.anchorNode?.textContent || '').includes(t), text);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 60)))));
    await page.keyboard.press('End');
  };

  // The page was opened before the line was added, and this tab never hears of the line: its save comes from a copy without it.
  const quietFrom = errors.length;
  await page.route('**/api/v1/stream*', (route) => route.abort());
  await page.reload();
  await page.locator('.main').waitFor();
  await openNotes();
  await deliver(page, { from: 'Ruth Teitelbaum <ruth@eniac.test>', subject: 'Pricing for 8 seats', body: 'Hello' });
  ok(await until(async () => (await noteLines()).includes('Ruth Teitelbaum asked: Pricing for 8 seats'), 60), 'the automation added its line to the page on the server');
  ok(!/Ruth Teitelbaum asked/.test(await page.locator('.nb-editor').innerText()), 'the open page doesn’t show it yet');
  await typeAtEndOf('Leads this month');
  await page.keyboard.type(', so far three');
  ok(await until(async () => (await noteLines()).includes('Leads this month, so far three')), 'what was typed is saved');
  ok((await noteLines()).includes('Ruth Teitelbaum asked: Pricing for 8 seats'), 'and the save, made from the copy without the line, kept the line');
  await page.unroute('**/api/v1/stream*');
  // The live updates this test stopped on purpose are the only errors that window may have.
  errors.splice(quietFrom, errors.length - quietFrom, ...errors.slice(quietFrom).filter((e) => !/ERR_FAILED/.test(e)));
  await page.reload();
  await page.locator('.main').waitFor();
  await openNotes();
  const reloaded = await page.locator('.nb-editor').innerText();
  ok(/Leads this month, so far three/.test(reloaded) && /Ruth Teitelbaum asked: Pricing for 8 seats/.test(reloaded), 'after a reload the page has both');

  // The line arrives on the open page while someone is typing: it goes in, and not a letter of the typing is lost.
  await typeAtEndOf('Leads this month, so far three');
  const more = ', and one more from the web form today, which Timmy will log here by itself as soon as the email comes in';
  let typed = false;
  const typing = page.keyboard.type(more, { delay: 100 }).then(() => (typed = true));
  await page.waitForTimeout(300);
  await deliver(page, { from: 'Kay McNulty <kay@eniac.test>', subject: 'Pricing for the lab', body: 'Hi' });
  await page.locator('.nb-editor', { hasText: 'Kay McNulty asked: Pricing for the lab' }).waitFor({ timeout: 15000 });
  ok(!typed, 'the line showed on the open page while typing was still going on');
  await typing;
  ok((await page.locator('.nb-editor').innerText()).includes(`Leads this month, so far three${more}`), 'and every letter typed, before and after it came, is still there');
  ok(await until(async () => (await noteLines()).includes(`Leads this month, so far three${more}`) && (await noteLines()).includes('Kay McNulty asked: Pricing for the lab'), 40), 'the server has the typing and both lines');
  ok((await noteLines()).filter((t) => /asked: Pricing/.test(t)).length === 2, 'each line is there once');

  ok(errors.filter((e) => !/400|404|409/.test(e)).length === 0, `no page errors (${errors.join(' | ')})`);
});
