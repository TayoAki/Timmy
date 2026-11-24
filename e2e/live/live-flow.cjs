// From an email to done, on a real workspace:
//   - a to-do whose email names no date gets one Timmy suggests, and says so (server/src/agent/todo-dates.ts);
//   - a reply sent from Timmy ticks off the to-do it does (src/state/store.tsx, doneByReply);
//   - ticking off an email's last to-do files the email (followTasks), with one Undo;
//   - when an email may be about a project, Triage asks “Is this about …?” (server/src/agent/read.ts, maybe_project);
//   - a project's emails can be searched, archived ones included.
const { ok, open, signUp, api, connectGmail, deliver, run } = require('./lib.cjs');

run('live-flow', async (browser) => {
  const { page, errors } = await open(browser);
  await signUp(page, { name: 'Grace Hopper' });
  await connectGmail(page, 'grace@mycompany.test');
  const cmd = (action) => api(page, 'POST', '/api/v1/commands', { id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, action });
  const slices = async () => (await api(page, 'GET', '/api/v1/state')).body.slices;
  const until = async (fn) => {
    for (let i = 0; i < 80; i++) {
      const v = await fn(await slices());
      if (v) return v;
      await page.waitForTimeout(150);
    }
    return null;
  };
  const threadBy = (subject) => (s) => s.threads.find((t) => t.subject === subject);
  const taskBy = (title) => (s) => Object.values(s['ws.tasks'] ?? {}).find((t) => t.title === title);
  const openEmail = async (subject) => {
    await page.click('button[aria-label="Today & mail"]');
    await page.getByRole('tab', { name: /Triage/ }).click();
    await page.locator('.triage-subject', { hasText: subject }).first().click();
    await page.locator('.thread-title', { hasText: subject }).waitFor();
  };

  ok((await cmd({ type: 'ws', ops: [{ op: 'put', col: 'projects', item: { id: 'apollo', num: '10', name: 'Apollo launch', color: 'var(--c-blue)', status: 'active', folder: 'f02-10', sources: [] } }] })).body.ok, 'a project to file into');

  // 1. An ask with no date: the to-do gets a suggested date, and the email says so.
  await deliver(page, { from: 'Dana Whitfield <dana@acme.test>', subject: 'Quote for the Apollo launch', body: 'Hi Grace,\n\nWhen you can, reply to Dana with the quote.\n\nDana' });
  const quote = await until(taskBy('Reply to Dana with the quote'));
  ok(quote && quote.dueSuggested === true && quote.due && quote.project === 'apollo', 'the to-do has a suggested date and is in the email’s project');
  await openEmail('Quote for the Apollo launch');
  const todos = page.getByRole('region', { name: 'To-dos from this email' });
  ok(/due .+ · suggested/.test(await todos.innerText()), 'the email’s to-do shows its date as suggested');

  // 2. Replying does the to-do: it is ticked off, and with nothing else open the email is archived.
  await page.getByRole('textbox', { name: 'Reply' }).fill('It is $58 per seat.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('.toast', { hasText: 'ticked off “Reply to Dana with the quote”' }).waitFor();
  ok(await until((s) => taskBy('Reply to Dana with the quote')(s)?.status === 'done' && threadBy('Quote for the Apollo launch')(s)?.box === 'archived'), 'the reply ticks off its to-do and the email is archived');

  // 3. Ticking off an email's last to-do files the email; one Undo puts both back.
  await deliver(page, { from: 'Dana Whitfield <dana@acme.test>', subject: 'Board deck', body: 'When you can, send the board deck.' });
  await until(taskBy('Send the board deck'));
  const before = (await until(threadBy('Board deck'))).box;
  await openEmail('Board deck');
  await page.getByRole('region', { name: 'To-dos from this email' }).getByRole('checkbox').check();
  await page.locator('.toast', { hasText: 'Nothing is left on “Board deck”, so the email is archived' }).waitFor();
  ok(await until((s) => threadBy('Board deck')(s)?.box === 'archived' && taskBy('Send the board deck')(s)?.status === 'done'), 'ticking the last to-do archives the email');
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  ok(await until((s) => threadBy('Board deck')(s)?.box === before && taskBy('Send the board deck')(s)?.status === 'todo'), 'one Undo puts the email and the to-do back');

  // 4. Maybe a project: Triage asks, Yes files it, No stops the question.
  await deliver(page, { from: 'Gene Kranz <gene@mission.test>', subject: 'Countdown', body: 'The Apollo team meeting moved to Thursday.' });
  await deliver(page, { from: 'Gene Kranz <gene@mission.test>', subject: 'Patches', body: 'Can we order Apollo patches for everyone?' });
  await until((s) => threadBy('Countdown')(s)?.maybeProject && threadBy('Patches')(s)?.maybeProject);
  await page.click('button[aria-label="Today & mail"]');
  await page.getByRole('tab', { name: /Triage/ }).click();
  const ask = (subject) => page.locator('.triage-item', { hasText: subject }).getByRole('group', { name: 'Is this about Apollo launch?' });
  await ask('Countdown').waitFor();
  ok((await ask('Patches').count()) === 1, 'Triage asks “Is this about Apollo launch?” on both');
  await ask('Countdown').getByRole('button', { name: 'Yes' }).click();
  await ask('Patches').getByRole('button', { name: 'No' }).click();
  ok(await until((s) => threadBy('Countdown')(s)?.project === 'apollo' && !threadBy('Patches')(s)?.project && !threadBy('Patches')(s)?.maybeProject), 'Yes puts it in the project; No leaves it out and stops asking');

  // 5. The project's emails can be searched, archived ones too.
  await page.click('button[aria-label="Projects"]');
  await page.locator('.pj-row-main', { hasText: 'Apollo launch' }).click();
  await page.getByRole('tab', { name: /Mail/ }).click();
  const search = page.getByRole('searchbox', { name: 'Search this project’s emails' });
  await search.fill('per seat');
  await page.getByText('1 of 2 emails match').waitFor();
  const shown = await page.locator('.main').innerText();
  ok(shown.includes('Quote for the Apollo launch') && !shown.includes('Countdown') && /Archived/.test(shown), 'search finds the archived email by what was said in it, and leaves the other out');
  await search.fill('nothing like this');
  await page.getByText('No email in this project matches “nothing like this”.').waitFor();
  ok(true, 'a search with no match says so');

  ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
});
