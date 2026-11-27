// To-dos from email (server/src/agent/read.ts, ThreadView's To-dos): what an email asks becomes a task, shown in the
// thread to check off and in Tasks with the email it came from; Make a to-do asks for one on any email (agent/todo.ts).
const { ok, open, signUp, api, connectGmail, run } = require('./lib.cjs');

run('live-todos', async (browser) => {
  const { page, errors } = await open(browser);
  await signUp(page, { name: 'Grace Hopper' });
  await connectGmail(page, 'grace@mycompany.test');
  await api(page, 'POST', '/api/test/fake', { op: 'deliver', message: { from: 'Dana Whitfield <dana@acme.test>', subject: 'Signed SOW', body: 'Hi Grace,\n\nPlease send the signed SOW by 2026-11-20. Thanks!\n\nDana' } });
  let task;
  for (let i = 0; i < 80 && !task; i++) {
    task = Object.values((await api(page, 'GET', '/api/v1/state')).body.slices['ws.tasks'] ?? {}).find((t) => t.title === 'Send the signed SOW');
    if (!task) await page.waitForTimeout(150);
  }
  ok(task && task.by === 'timmy' && task.due.startsWith('2026-11-20'), 'what the email asks becomes a to-do with its due date');

  await page.getByRole('tab', { name: /Triage/ }).click();
  await page.locator('.triage-subject', { hasText: 'Signed SOW' }).first().click();
  const todos = page.getByRole('region', { name: 'To-dos from this email' });
  await todos.waitFor();
  ok(/Send the signed SOW/.test(await todos.innerText()) && /1 open/.test(await todos.innerText()), 'the thread shows its to-do');
  await todos.getByRole('checkbox').check();
  await todos.getByText('all done').waitFor();
  ok(true, 'checking it off in the thread marks it done');
  let done;
  for (let i = 0; i < 40 && !done; i++) {
    done = Object.values((await api(page, 'GET', '/api/v1/state')).body.slices['ws.tasks']).find((t) => t.title === 'Send the signed SOW')?.status === 'done';
    if (!done) await page.waitForTimeout(150);
  }
  ok(done, 'and it is saved');
  // With its last to-do done, the email is filed too (it asked nothing more of the person): archived.
  let filed = false;
  for (let i = 0; i < 40 && !filed; i++) {
    filed = (await api(page, 'GET', '/api/v1/state')).body.slices.threads.find((t) => t.subject === 'Signed SOW')?.box === 'archived';
    if (!filed) await page.waitForTimeout(150);
  }
  ok(filed, 'ticking off the email’s last to-do archives the email');

  // Make a to-do: Timmy reads an email that came in without an ask of its own and adds what it asks.
  await api(page, 'POST', '/api/test/fake', { op: 'deliver', message: { from: 'Sam Rivera <sam@acme.test>', subject: 'Wireframes', body: 'Here they are.\n\nPlease share the brand guide with the team.' } });
  for (let i = 0; i < 80 && !(await api(page, 'GET', '/api/v1/state')).body.slices.threads.some((t) => t.subject === 'Wireframes'); i++) await page.waitForTimeout(150);
  await page.click('button[aria-label="Today & mail"]');
  await page.getByRole('tab', { name: /Triage/ }).click();
  await page.locator('.triage-subject', { hasText: 'Wireframes' }).first().click();
  const more = page.getByRole('region', { name: 'To-dos from this email' });
  await more.getByRole('button', { name: 'Make a to-do' }).click();
  await page.locator('.toast', { hasText: 'To-do added: Share the brand guide with the team' }).waitFor();
  await more.getByText('Share the brand guide with the team').waitFor();
  ok(true, 'Make a to-do on an email adds what it asks, and the email shows it');

  const statusOf = async (title) => Object.values((await api(page, 'GET', '/api/v1/state')).body.slices['ws.tasks']).find((t) => t.title === title)?.status;
  const until = async (title, status) => {
    for (let i = 0; i < 40; i++) {
      if ((await statusOf(title)) === status) return true;
      await page.waitForTimeout(150);
    }
    return false;
  };

  // On the Tasks board, one click on a card's box marks it done.
  await page.click('button[aria-label="Tasks"]');
  await page.getByRole('tab', { name: 'Board' }).click();
  const box = page.getByRole('checkbox', { name: 'Mark “Share the brand guide with the team” as done' });
  await box.click();
  await page.locator('.toast', { hasText: 'Done: Share the brand guide with the team' }).waitFor();
  ok(await until('Share the brand guide with the team', 'done'), 'ticking the box on a Tasks card marks it done, and it is saved');

  await page.getByRole('tab', { name: 'List' }).click();
  // Finished tasks are hidden until asked for.
  await page.getByRole('button', { name: 'Show done' }).click();
  const row = page.locator('.table-row', { hasText: 'Send the signed SOW' });
  await row.waitFor();
  ok((await row.getByRole('button', { name: 'Open the source email: Signed SOW' }).count()) === 1, 'Tasks lists it with the email it came from');
  // In the list, the box shows it is done, and unticking it puts it back on the list.
  const sow = row.getByRole('checkbox', { name: 'Mark “Send the signed SOW” as not done' });
  ok((await sow.getAttribute('aria-checked')) === 'true', 'the list shows the to-do ticked in the email as done');
  await sow.click();
  ok(await until('Send the signed SOW', 'todo'), 'unticking it in the list puts it back to do, and it is saved');

  // Done on the email: it is archived and its open to-do is ticked off, in one go, with one Undo.
  const boxOf = async (subject) => (await api(page, 'GET', '/api/v1/state')).body.slices.threads.find((t) => t.subject === subject)?.box;
  await api(page, 'POST', '/api/test/fake', { op: 'deliver', message: { from: 'Dana Whitfield <dana@acme.test>', subject: 'Contract', body: 'Hi Grace,\n\nPlease sign the contract by 2026-11-28.\n\nDana' } });
  for (let i = 0; i < 80 && !(await statusOf('Sign the contract')); i++) await page.waitForTimeout(150);
  const before = await boxOf('Contract');
  await page.click('button[aria-label="Today & mail"]');
  await page.getByRole('tab', { name: /Triage/ }).click();
  await page.locator('.triage-subject', { hasText: 'Contract' }).first().click();
  const doneBtn = page.getByRole('button', { name: 'Done: archive this email and tick off its to-do' });
  await doneBtn.waitFor();
  await doneBtn.click();
  await page.locator('.toast', { hasText: 'Done: archived, its to-do ticked off' }).waitFor();
  ok((await page.locator('.thread-title', { hasText: 'Contract' }).count()) === 0, 'Done takes you back from the email');
  let archived = false;
  for (let i = 0; i < 40 && !archived; i++) {
    archived = (await boxOf('Contract')) === 'archived' && (await statusOf('Sign the contract')) === 'done';
    if (!archived) await page.waitForTimeout(150);
  }
  ok(archived, 'Done archives the email and ticks off its to-do, and both are saved');
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  let back = false;
  for (let i = 0; i < 40 && !back; i++) {
    back = (await boxOf('Contract')) === before && (await statusOf('Sign the contract')) === 'todo';
    if (!back) await page.waitForTimeout(150);
  }
  ok(back, `one Undo puts the email back in ${before} and the to-do back on the list`);

  // Do it with Timmy: the open to-do on the email hands itself to Ask, which starts a chat with the request sent.
  await page.locator('.triage-subject', { hasText: 'Contract' }).first().click().catch(() => undefined);
  if (!(await page.locator('.thread-title', { hasText: 'Contract' }).count())) {
    await page.click('button[aria-label="Today & mail"]');
    await page.getByRole('tab', { name: /Triage/ }).click();
    await page.locator('.triage-subject', { hasText: 'Contract' }).first().click();
  }
  await page.getByRole('button', { name: 'Do it with Timmy: Sign the contract' }).click();
  const chat = page.getByRole('dialog', { name: 'Ask Timmy' });
  await chat.locator('.ai-msg.me', { hasText: 'Do my task “Sign the contract”' }).waitFor();
  await chat.locator('.ai-msg.timmy').last().waitFor();
  ok(true, 'Do it with Timmy on an email’s to-do opens Ask with the task asked for, and Timmy answers');
  await page.keyboard.press('Escape');

  ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
});
