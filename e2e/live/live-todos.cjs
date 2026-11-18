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

  await page.click('button[aria-label="Tasks"]');
  await page.getByRole('tab', { name: 'List' }).click();
  // Finished tasks are hidden until asked for.
  await page.getByRole('button', { name: 'Show done' }).click();
  const row = page.locator('.table-row', { hasText: 'Send the signed SOW' });
  await row.waitFor();
  ok((await row.getByRole('button', { name: 'Open the source email: Signed SOW' }).count()) === 1, 'Tasks lists it with the email it came from');

  ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
});
