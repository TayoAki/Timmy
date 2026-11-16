// Live mode: delegate holds. An assistant (EA) sends on the exec's behalf; it waits for the exec.
// RevOps holds on CRM writes are covered by the API tests until the CRM connection is built.
const { BASE, ok, open, signUp, api, connectGmail, compose, sentMail, run, stamp } = require('./lib.cjs');

run('live-holds', async (browser) => {
  const exec = await open(browser);
  const who = await signUp(exec.page, { name: 'Taylor Exec', company: 'Holdings' });
  await connectGmail(exec.page, 'taylor@holdings.test');

  // The exec invites their assistant, who signs up and accepts.
  const eaEmail = `jess.${stamp()}@example.test`;
  const invite = await api(exec.page, 'POST', '/api/auth/organization/invite-member', { email: eaEmail, role: 'assistant' });
  ok(invite.status === 200 && invite.body.id, 'the owner can invite someone as an assistant');
  const mail = (await api(exec.page, 'GET', `/api/test/outbox?to=${encodeURIComponent(eaEmail)}`)).body.mail;
  ok(mail && mail.kind === 'invite' && /assistant/.test(mail.body), 'the invitation email names the role');

  const ea = await open(browser);
  await ea.page.goto(BASE);
  await ea.page.getByRole('button', { name: 'Create an account' }).click();
  await ea.page.getByLabel('Your name').fill('Jess Assistant');
  await ea.page.getByLabel('Work email').fill(eaEmail);
  await ea.page.getByLabel('Password').fill('correct-horse-battery-9');
  await ea.page.getByRole('button', { name: 'Create account' }).click();
  await ea.page.getByRole('heading', { name: 'Name your workspace' }).waitFor();

  // Opening the invitation link joins nothing by itself: it says who is inviting them to what, and asks.
  await ea.page.goto(`${BASE}?invite=${invite.body.id}`);
  await ea.page.getByRole('heading', { name: `Join ${who.company}?` }).waitFor();
  const asked = await ea.page.locator('.live-card').innerText();
  ok(new RegExp(who.email).test(asked) && /as an assistant/.test(asked), 'the invitation link shows who invited them, to which workspace, and in what role');
  ok((await api(ea.page, 'GET', '/api/v1/me')).body.workspaces.length === 0, 'opening the link did not join the workspace');
  await ea.page.getByRole('button', { name: 'Not now' }).click();
  await ea.page.getByRole('heading', { name: 'Name your workspace' }).waitFor();
  ok((await api(ea.page, 'GET', '/api/v1/me')).body.workspaces.length === 0, 'saying “Not now” joins nothing');
  // Someone else's invitation tells them nothing and joins nothing.
  const outsider = await open(browser);
  await signUp(outsider.page, { name: 'Olive Outsider' });
  await outsider.page.goto(`${BASE}?invite=${invite.body.id}`);
  await outsider.page.getByRole('heading', { name: 'This invitation can’t be used' }).waitFor();
  ok(!new RegExp(who.company).test(await outsider.page.locator('.live-card').innerText()), 'an invitation for another address reveals nothing and joins nothing');
  await outsider.context.close();

  await ea.page.goto(`${BASE}?invite=${invite.body.id}`);
  await ea.page.getByRole('button', { name: `Join ${who.company}` }).click();
  await ea.page.locator('.main').waitFor();
  const me = (await api(ea.page, 'GET', '/api/v1/me')).body;
  ok(me.active.role === 'assistant' && me.active.name === who.company, 'the assistant lands in the exec’s workspace with the assistant role');
  ok(me.active.can.approveSends === false && me.active.can.connect === false, 'an assistant cannot approve sends or connect apps');

  // The assistant writes an email. It does not go out; it waits for the exec.
  await compose(ea.page, { to: 'board@investor.test', subject: 'Board update', body: 'Here is the board update.' });
  await ea.page.locator('.toast', { hasText: /Waiting for the exec/ }).waitFor();
  ok(true, 'the assistant is told it is waiting for the exec');
  await ea.page.waitForTimeout(6500);
  ok((await sentMail(exec.page)).length === 0, 'nothing is sent while it waits');

  // The assistant cannot approve their own request.
  const pending = (await api(ea.page, 'GET', '/api/v1/state')).body.slices.pending;
  ok(pending.length === 1 && pending[0].waitingOn === 'exec', 'the request is in the queue, waiting on the exec');
  const tried = await api(ea.page, 'POST', '/api/v1/commands', { id: `ea-approve-${stamp()}`, action: { type: 'effect', id: pending[0].id, approve: true } });
  ok(tried.body.ok === false && /isn’t yours to approve/.test(tried.body.error), 'the assistant’s attempt to approve it is refused');
  await ea.page.waitForTimeout(5500);
  ok((await sentMail(exec.page)).length === 0, 'and still nothing is sent');

  // The exec sees it in Approvals, with the exact email, and approves.
  await exec.page.click('button[aria-label="Approvals"]');
  const card = exec.page.locator('.ap-card', { hasText: 'Board update' });
  await card.waitFor({ timeout: 10000 });
  ok(/board@investor\.test/.test(await card.innerText()) || /Board update/.test(await card.innerText()), 'the exec sees the request in Approvals');
  await card.getByRole('button', { name: 'Send', exact: true }).click();
  let sent = [];
  for (let i = 0; i < 40 && sent.length === 0; i++) {
    await exec.page.waitForTimeout(500);
    sent = await sentMail(exec.page);
  }
  ok(sent.length === 1 && sent[0].to[0] === 'board@investor.test' && sent[0].body === 'Here is the board update.', 'after the exec approves, the email goes out as written');

  // The audit log says who asked and who approved.
  const audit = (await api(exec.page, 'GET', '/api/v1/audit')).body.entries;
  const proposed = audit.find((e) => e.action === 'effect.proposed' && e.detail.route === 'exec');
  const approved = audit.find((e) => e.action === 'effect.approved' && e.effect_id === proposed.effect_id);
  const execId = (await api(exec.page, 'GET', '/api/v1/me')).body.user.id;
  ok(proposed.actor === me.user.id && approved.actor === execId && approved.detail.requestedBy === me.user.id, 'the audit log records that the assistant asked and the exec approved');

  ok(exec.errors.length === 0 && ea.errors.length === 0, `no page errors (${[...exec.errors, ...ea.errors].join(' | ')})`);
});
