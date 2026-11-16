// Live mode: files sent with email, and the website chat's picture.
// A file attached in the compose window or in a reply is uploaded first. The email then waits out the undo
// window like any other, the approval shows the file by name, and what goes out is that exact file, once.
// What can't be attached (a program, a script under another name) is refused with a plain reason.
const { createHash } = require('crypto');
const { ok, open, signUp, api, connectGmail, deliver, sentMail, run } = require('./lib.cjs');
const HOLD = Number(process.env.TIMMY_SEND_HOLD_SECONDS || 4) * 1000;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

run('live-files', async (browser) => {
  const { page, errors } = await open(browser);
  await signUp(page, { name: 'Radia Perlman' });
  await connectGmail(page, 'radia@bridges.test');
  const state = async () => (await api(page, 'GET', '/api/v1/state')).body.slices;
  const until = async (fn, tries = 40) => {
    for (let i = 0; i < tries; i++) {
      if (await fn()) return true;
      await page.waitForTimeout(250);
    }
    return false;
  };
  const quote = Buffer.from('%PDF-1.4\n% Quote for 120 seats at $58 per seat.\n%%EOF\n');
  const terms = Buffer.from('Net 30. Cancel any time.\n');

  /* ── A new email with a file ── */
  await page.click('button[aria-label="Today & mail"]');
  await page.getByRole('button', { name: 'New email' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New message' });
  await dialog.getByPlaceholder('Name or email').fill('dana@client.test');
  await page.keyboard.press('Enter');
  await dialog.locator('.draft-subject').fill('Quote attached');
  await dialog.getByRole('textbox', { name: 'Message' }).fill('Hi Dana, the quote is attached.');
  const picker = dialog.locator('input[type="file"]');

  // What can't be sent is refused when it is picked, and nothing is attached.
  await picker.setInputFiles({ name: 'setup.exe', mimeType: 'application/x-msdownload', buffer: Buffer.from('MZ\u0090\u0000\u0003\u0000') });
  await page.locator('.toast', { hasText: /can’t be attached/ }).waitFor();
  ok((await dialog.locator('.compose-files .chip').count()) === 0, 'a program can’t be attached, and the reason is given');
  // A program renamed to look like a text file is caught by what is in it, not by its name.
  await picker.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0]) });
  await page.locator('.toast', { hasText: /programs or scripts/ }).waitFor();
  ok((await dialog.locator('.compose-files .chip').count()) === 0, 'nor can a program under an innocent name');

  await picker.setInputFiles({ name: 'Quote.pdf', mimeType: 'application/pdf', buffer: quote });
  await dialog.locator('.compose-files .chip', { hasText: 'Quote.pdf' }).waitFor();
  ok(true, 'a PDF picked in the compose window is uploaded and shows as attached');
  ok((await sentMail(page)).length === 0, 'attaching a file sends nothing');

  await dialog.getByRole('button', { name: /^Send/ }).first().click();
  await page.locator('.toast', { hasText: /Sending in \d+ seconds/ }).waitFor();
  ok((await sentMail(page)).length === 0, 'pressing Send starts the undo window; nothing has left');
  await page.click('button[aria-label="Approvals"]');
  const card = page.locator('.ap-card', { hasText: 'Quote attached' });
  await card.waitFor();
  ok(/Quote\.pdf/.test(await card.innerText()), 'the held email shows the file it carries, by name');

  let sent = [];
  for (let i = 0; i < 40 && sent.length === 0; i++) {
    await page.waitForTimeout(500);
    sent = await sentMail(page);
  }
  ok(sent.length === 1 && sent[0].subject === 'Quote attached' && sent[0].body === 'Hi Dana, the quote is attached.', 'when the window ends the email goes out as written');
  const went = sent[0].attachments || [];
  ok(went.length === 1 && went[0].name === 'Quote.pdf' && went[0].mimetype === 'application/pdf', 'with the attachment, under its own name and type');
  ok(went[0].size === quote.length && went[0].sha256 === sha256(quote), 'and it is byte for byte the file that was attached');
  await page.waitForTimeout(HOLD + 2000);
  ok((await sentMail(page)).length === 1, 'it is sent once, not again');
  const thread = (await state()).threads.find((t) => t.subject === 'Quote attached');
  ok(thread && thread.messages[0].files && thread.messages[0].files[0].name === 'Quote.pdf', 'the sent email is kept with its file');

  // The approval record names the exact file: which upload, and the hash of its bytes.
  const audit = (await api(page, 'GET', '/api/v1/audit')).body.entries;
  ok(audit.some((e) => e.action === 'effect.completed') && audit.filter((e) => e.action === 'effect.executing').length === 1, 'the audit log shows one send');

  /* ── A reply with a file ── */
  await deliver(page, { from: 'Dana Whitfield <dana@client.test>', subject: 'Terms?', body: 'Hi Radia,\n\nCould you send your terms?\n\nDana' });
  await page.click('button[aria-label="Today & mail"]');
  await page.getByRole('tab', { name: /Triage/ }).click();
  await page.locator('.main').getByText('Terms?').first().click();
  await page.locator('.main').getByText('Could you send your terms?').first().waitFor();
  if ((await page.locator('section[aria-label="Reply"]').count()) === 0) await page.getByRole('button', { name: /^Reply/ }).first().click();
  const reply = page.locator('section[aria-label="Reply"]');
  await reply.waitFor();
  await reply.getByRole('textbox', { name: 'Reply' }).fill('Hi Dana,\n\nOur terms are attached.');
  await reply.locator('input[type="file"]').setInputFiles([{ name: 'Terms.txt', mimeType: 'text/plain', buffer: terms }, { name: 'Quote.pdf', mimeType: 'application/pdf', buffer: quote }]);
  await reply.locator('.reply-files .chip', { hasText: 'Terms.txt' }).waitFor();
  await reply.locator('.reply-files .chip', { hasText: 'Quote.pdf' }).waitFor();
  // One of them is taken off again before sending.
  await reply.getByRole('button', { name: 'Remove Quote.pdf' }).click();
  ok((await reply.locator('.reply-files .chip').count()) === 1, 'a reply can carry files too, and one can be taken off again');
  await reply.getByRole('button', { name: /^Send/ }).click();
  await page.locator('.toast', { hasText: /Sending in \d+ seconds/ }).waitFor();
  for (let i = 0; i < 40 && sent.length < 2; i++) {
    await page.waitForTimeout(500);
    sent = await sentMail(page);
  }
  const inbound = (await state()).threads.find((t) => t.subject === 'Terms?');
  ok(sent.length === 2 && sent[1].threadId === inbound.ext.threadKey, 'the reply went out in the same mail thread');
  ok((sent[1].attachments || []).length === 1 && sent[1].attachments[0].name === 'Terms.txt' && sent[1].attachments[0].sha256 === sha256(terms), 'carrying the one file that was left on it');
  await page.waitForTimeout(HOLD + 1500);
  ok((await sentMail(page)).length === 2, 'and it is sent once');

  /* ── A file added to a reply Timmy drafted ── */
  await deliver(page, { from: 'Dana Whitfield <dana@client.test>', subject: 'Contract?', body: 'Hi Radia,\n\nCould you send the contract?\n\nDana' });
  const contract = async () => (await state()).threads.find((t) => t.subject === 'Contract?');
  await until(async () => !!(await contract()));
  ok((await api(page, 'POST', '/api/v1/commands', { id: `draft-${Date.now()}`, action: { type: 'makeDraft', id: (await contract()).id } })).body.ok, 'Timmy is asked to draft a reply');
  await page.click('button[aria-label="Today & mail"]');
  await page.getByRole('tab', { name: /Triage/ }).click();
  await page.locator('.main').getByText('Contract?').first().click();
  const drafted = page.locator('section[aria-label="Draft reply"]');
  await drafted.waitFor({ timeout: 15000 });
  await drafted.locator('input[type="file"]').setInputFiles({ name: 'Contract.pdf', mimeType: 'application/pdf', buffer: quote });
  await drafted.locator('.reply-files .chip', { hasText: 'Contract.pdf' }).waitFor();
  ok(await until(async () => ((await contract()).draft?.files || []).length === 1), 'a file added to Timmy’s draft is kept with the draft, on the server');
  await page.click('button[aria-label="Approvals"]');
  const waitingDraft = page.locator('.ap-card', { hasText: 'Re: Contract?' });
  await waitingDraft.waitFor();
  ok(/Contract\.pdf/.test(await waitingDraft.innerText()), 'the draft waiting in Approvals shows the file');
  await waitingDraft.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('.toast', { hasText: /Sending in \d+ seconds/ }).waitFor();
  for (let i = 0; i < 40 && sent.length < 3; i++) {
    await page.waitForTimeout(500);
    sent = await sentMail(page);
  }
  ok(sent.length === 3 && sent[2].threadId === (await contract()).ext.threadKey && /^Thanks for your message/.test(sent[2].body), 'approving it sends Timmy’s draft as a reply');
  ok((sent[2].attachments || []).length === 1 && sent[2].attachments[0].name === 'Contract.pdf' && sent[2].attachments[0].sha256 === sha256(quote), 'with the file that was added to it');

  /* ── Undo takes the file back with the email ── */
  const up = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const told = await (await fetch('/api/v1/uploads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ purpose: 'attachment', type: 'application/pdf', size: bytes.length, name: 'Undone.pdf' }) })).json();
    const put = await fetch(told.upload.url, { method: 'PUT', headers: told.upload.headers, body: bytes });
    return { id: told.assetId, status: put.status, size: bytes.length };
  }, quote.toString('base64'));
  ok(up.status === 200, 'a file can be uploaded from the page itself');
  const held = await api(page, 'POST', '/api/v1/commands', { id: `undo-${Date.now()}`, action: { type: 'sendNew', draft: { to: ['mail:dana@client.test'], subject: 'Changed my mind', body: 'Attached.', files: [{ id: up.id, name: 'Undone.pdf', type: 'application/pdf', size: up.size }] } } });
  ok(held.body.ok && held.body.holding, 'an email with a file waits out the undo window');
  const pending = (await state()).pending.find((p) => /Changed my mind/.test(p.title));
  ok(pending && pending.preview.attachments[0].name === 'Undone.pdf', 'what is waiting names the file');
  const undone = await api(page, 'POST', `/api/v1/actions/${pending.id}/decline`, {});
  ok(undone.body.ok, 'Undo is accepted');
  await page.waitForTimeout(HOLD + 2000);
  ok((await sentMail(page)).length === 3, 'after Undo neither the email nor its file goes out');

  /* ── Nobody else can read or send the file ── */
  const fileId = thread.messages[0].files[0].id;
  ok((await api(page, 'GET', `/api/v1/assets/${fileId}`)).status === 200, 'the workspace can read back the file it sent');
  const outsider = await open(browser);
  await signUp(outsider.page, { name: 'Other Person' });
  ok((await api(outsider.page, 'GET', `/api/v1/assets/${fileId}`)).status === 404, 'another workspace gets 404 for it');
  await connectGmail(outsider.page, 'other@elsewhere.test');
  const stolen = await api(outsider.page, 'POST', '/api/v1/commands', { id: `steal-${Date.now()}`, action: { type: 'sendNew', draft: { to: ['mail:me@elsewhere.test'], subject: 'Not mine', body: 'x', files: [{ id: fileId, name: 'Quote.pdf', type: 'application/pdf', size: quote.length }] } } });
  ok(stolen.body.ok === false && /isn’t in Timmy any more/.test(stolen.body.error), 'and can’t attach it to an email of its own');
  ok((await sentMail(outsider.page)).length === 0, 'so nothing is sent from there');
  await outsider.context.close();

  /* ── The website chat's picture ── */
  const face = Buffer.from(await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 300;
    c.height = 300;
    const g = c.getContext('2d');
    g.fillStyle = '#0f766e';
    g.fillRect(0, 0, 300, 300);
    return c.toDataURL('image/png').split(',')[1];
  }), 'base64');
  await page.click('button[aria-label="Outbound"]');
  await page.getByRole('tab', { name: /Website chat/ }).click();
  await page.getByRole('radio', { name: 'Set up' }).click();
  await page.locator('.wc-look input[type="file"]').setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: face });
  ok(await until(async () => /^asset:ast_/.test((await state())['ws.chat'].site.icon || '')), 'the chat’s picture is uploaded and its settings keep a reference to it');
  await page.waitForFunction(() => { const i = document.querySelector('.wc-look img.wc-face'); return !!i && i.complete && i.naturalWidth > 0 && i.getAttribute('src').startsWith('/api/v1/assets/'); }, null, { timeout: 10000 });
  ok(true, 'and it shows in the settings, from the server');

  ok(errors.filter((e) => !/400|413|415/.test(e)).length === 0, `no page errors (${errors.join(' | ')})`);
});
