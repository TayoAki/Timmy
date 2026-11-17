// Live mode: files sent with email, and the website chat's picture.
// A file attached in the compose window or in a reply is uploaded first. The email then waits out the undo
// window like any other, the approval shows the file by name, and what goes out is that exact file, once.
// What can't be attached (a program, a script under another name) is refused with a plain reason.
const { createHash } = require('crypto');
const { ok, open, signUp, api, connectGmail, deliver, sentMail, run } = require('./lib.cjs');
const HOLD = Number(process.env.TIMMY_SEND_HOLD_SECONDS || 4) * 1000;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
/** The EICAR test string every virus scanner flags on purpose, put together here so this file isn't flagged itself. */
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join('');

/** A JPEG with an Exif block put in after its start, the way a phone writes one: the camera's make and a GPS position. */
function withLocation(jpeg) {
  const u16 = (n) => [(n >> 8) & 255, n & 255];
  const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const make = Buffer.from('Phone Camera GPS\0', 'latin1');
  const gpsAt = 8 + 2 + 2 * 12 + 4;
  const makeAt = gpsAt + 2 + 12 + 4;
  const ifd0 = [...u16(2), ...u16(0x010f), ...u16(2), ...u32(make.length), ...u32(makeAt), ...u16(0x8825), ...u16(4), ...u32(1), ...u32(gpsAt), ...u32(0)];
  // One GPS entry: the latitude is north.
  const gps = [...u16(1), ...u16(1), ...u16(2), ...u32(2), 0x4e, 0, 0, 0, ...u32(0)];
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from([0x4d, 0x4d, 0, 0x2a, ...u32(8), ...ifd0, ...gps]), make]);
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1, ...u16(body.length + 2)]), body, jpeg.subarray(2)]);
}

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

  /* ── The website chat's picture stays inline ── */
  // Visitors on the customer's website are shown it, and an uploaded file is only ever handed to members of the
  // workspace. So this picture is kept in the settings themselves, as before, and is not uploaded.
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
  const uploads = [];
  const listen = (r) => r.url().includes('/api/v1/uploads') && uploads.push(r.url());
  page.on('request', listen);
  await page.locator('.wc-look input[type="file"]').setInputFiles({ name: 'face.png', mimeType: 'image/png', buffer: face });
  ok(await until(async () => /^data:image\/(png|jpeg);base64,/.test((await state())['ws.chat'].site.icon || '')), 'the chat’s picture is kept inline in its settings, ready for visitors');
  await page.waitForFunction(() => { const i = document.querySelector('.wc-look img.wc-face'); return !!i && i.complete && i.naturalWidth > 0 && i.getAttribute('src').startsWith('data:image/'); }, null, { timeout: 10000 });
  page.off('request', listen);
  ok(uploads.length === 0, 'and it shows in the settings without going through the uploads');
  // Named by reference to an upload it is refused, so no upload ever reaches the public chat.
  const named = await api(page, 'POST', '/api/v1/commands', { id: `icon-${Date.now()}`, action: { type: 'ws', ops: [{ op: 'patch', col: 'chat', id: 'site', patch: { icon: `asset:${fileId}` } }] } });
  ok(named.body.ok === false && /chat’s picture/.test(named.body.error), 'an uploaded file can’t be made the chat’s picture');

  /* ── A photo is kept without where it was taken ── */
  // A JPEG the browser draws, with an Exif block such as a phone writes: the camera, and a GPS position.
  const drawn = Buffer.from(await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 48;
    const g = c.getContext('2d');
    g.fillStyle = '#b45309';
    g.fillRect(0, 0, 64, 48);
    g.fillStyle = '#1d4ed8';
    g.fillRect(16, 12, 32, 24);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  }), 'base64');
  const photo = withLocation(drawn);
  ok(photo.includes('Phone Camera') && photo.includes('GPS'), 'the photo carries its camera and where it was taken');
  await page.click('button[aria-label="Today & mail"]');
  await page.getByRole('button', { name: 'New email' }).first().click();
  const again = page.getByRole('dialog', { name: 'New message' });
  await again.getByPlaceholder('Name or email').fill('dana@client.test');
  await page.keyboard.press('Enter');
  await again.locator('.draft-subject').fill('Site photo');
  await again.getByRole('textbox', { name: 'Message' }).fill('The photo from the site.');
  const arrived = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/api\/v1\/uploads\//.test(r.url()));
  await again.locator('input[type="file"]').setInputFiles({ name: 'site.jpg', mimeType: 'image/jpeg', buffer: photo });
  const told = await (await arrived).json();
  await again.locator('.compose-files .chip', { hasText: 'site.jpg' }).waitFor();
  ok(told.scanned === false && /not checked for viruses/.test(told.note), 'with no virus scanner set up, the upload’s answer says the file was not checked');
  ok(told.size < photo.length, 'the server kept a smaller file than was sent');
  const kept = Buffer.from(await page.evaluate(async (id) => {
    const bytes = new Uint8Array(await (await fetch(`/api/v1/assets/${id}`)).arrayBuffer());
    let text = '';
    for (const b of bytes) text += String.fromCharCode(b);
    return btoa(text);
  }, told.assetId), 'base64');
  ok(kept.length === told.size && !kept.includes('GPS') && !kept.includes('Phone Camera'), 'what is kept has no camera and no position in it');
  const size = await page.evaluate(async (id) => {
    const img = new Image();
    img.src = `/api/v1/assets/${id}`;
    await img.decode();
    return [img.naturalWidth, img.naturalHeight];
  }, told.assetId);
  ok(size[0] === 64 && size[1] === 48, 'and it is still the same picture: the browser draws it at its own size');
  await again.getByRole('button', { name: /^Send/ }).first().click();
  await page.locator('.toast', { hasText: /Sending in \d+ seconds/ }).waitFor();
  let photoSent;
  for (let i = 0; i < 40 && !photoSent; i++) {
    await page.waitForTimeout(500);
    photoSent = (await sentMail(page)).find((m) => m.subject === 'Site photo');
  }
  ok(photoSent && photoSent.attachments[0].sha256 === sha256(kept) && photoSent.attachments[0].size === kept.length, 'the photo that goes out is the one without its location');

  /* ── With a virus scanner set up, an infected file is refused ── */
  const scanner = await api(page, 'POST', '/api/test/files/scanner', { on: true });
  ok(scanner.status === 200 && scanner.body.scanning === true, 'the stand-in virus scanner is put in front of uploads');
  try {
    await page.click('button[aria-label="Today & mail"]');
    await page.getByRole('button', { name: 'New email' }).first().click();
    const scanned = page.getByRole('dialog', { name: 'New message' });
    const files = scanned.locator('input[type="file"]');
    await files.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from(`${EICAR}\n`) });
    await page.locator('.toast', { hasText: 'The virus scanner found Eicar-Test-Signature in this file, so Timmy didn’t keep it.' }).waitFor();
    ok((await scanned.locator('.compose-files .chip').count()) === 0, 'a file carrying the test virus is refused, with the reason, and nothing is attached');
    const clean = page.waitForResponse((r) => r.request().method() === 'PUT' && /\/api\/v1\/uploads\//.test(r.url()));
    await files.setInputFiles({ name: 'Terms.txt', mimeType: 'text/plain', buffer: terms });
    ok((await (await clean).json()).scanned === true, 'a clean file is scanned and kept');
    await scanned.locator('.compose-files .chip', { hasText: 'Terms.txt' }).waitFor();
  } finally {
    await api(page, 'POST', '/api/test/files/scanner', { on: false });
  }

  // 422 is the stand-in scanner refusing the test virus, expected above.
  ok(errors.filter((e) => !/400|413|415|422/.test(e)).length === 0, `no page errors (${errors.join(' | ')})`);
});
