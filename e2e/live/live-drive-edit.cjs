// Live mode: a Google Drive file edited in Timmy's own editor, saved back over the original (src/live/DriveEditor.tsx,
// server/src/files/drive-edit.ts). The Google Doc opens in the document editor as the Word file Google exports; the
// editor's File › Save goes back to Drive through the Action gateway; a change someone made in Drive meanwhile is
// never saved over without the person choosing to.
//
// The editor draws on a canvas, so its Save is sent here the way the editor itself sends it: a `wordcraft:save`
// message from inside its frame, with the bytes of a Word file.
const { crc32 } = require('zlib');
const { ok, open, signUp, api, connectApp, connectGmail, run } = require('./lib.cjs');

/** A Word file whose paragraphs are `lines`: a zip archive, stored without packing. */
function docx(lines) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const parts = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines.map((l) => `<w:p><w:r><w:t xml:space="preserve">${esc(l)}</w:t></w:r></w:p>`).join('')}<w:sectPr/></w:body></w:document>`],
  ];
  const local = [];
  const dir = [];
  let offset = 0;
  for (const [name, text] of parts) {
    const raw = Buffer.from(text, 'utf8');
    const n = Buffer.from(name, 'utf8');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt32LE(crc32(raw), 14);
    head.writeUInt32LE(raw.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(n.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc32(raw), 16);
    entry.writeUInt32LE(raw.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(n.length, 28);
    entry.writeUInt32LE(offset, 42);
    local.push(head, n, raw);
    dir.push(entry, n);
    offset += 30 + n.length + raw.length;
  }
  const d = Buffer.concat(dir);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(d.length, 12);
  end.writeUInt32LE(offset, 16);
  return [...Buffer.concat([...local, d, end])];
}

run('live-drive-edit', async (browser) => {
  const { page, errors } = await open(browser);
  await signUp(page, { name: 'Margaret Hamilton' });
  await connectGmail(page, 'margaret@apollo.test');
  await connectApp(page, 'Google Drive', 'margaret@apollo.test');
  ok((await api(page, 'POST', '/api/test/fake', { op: 'file', file: { name: 'Landing checklist', mimeType: 'application/vnd.google-apps.document', text: 'Check the radar.\nWatch alarm 1202.' } })).body.ok, 'a Google Doc is in the stand-in Drive');

  // The Drive card says what Timmy may now change there.
  await page.click('button[aria-label="Connections"]');
  const card = page.locator('li.conn-card', { has: page.getByText('Google Drive', { exact: true }) }).first();
  ok(/Writes\s+Only a file you edit in Timmy and save/.test(await card.innerText()), 'the Drive card says Timmy writes only a file the person edits and saves');

  // The file opens read-only first, with Edit in Timmy beside Open in Google Drive.
  await page.click('button[aria-label="Drive"]');
  await page.getByRole('button', { name: 'Landing checklist' }).click();
  const viewer = page.getByRole('dialog', { name: 'Landing checklist' });
  await viewer.frameLocator('iframe.mail-frame').getByText('Check the radar.').waitFor();
  await viewer.getByRole('button', { name: 'Edit in Timmy' }).click();

  // Timmy's document editor opens full screen, on the Word file Google exported.
  const editor = page.getByRole('dialog', { name: 'Landing checklist in Timmy’s editor' });
  await editor.waitFor();
  ok(/Saving replaces this file’s content in Google Drive\. Google Drive keeps the earlier version in its version history\./.test(await editor.locator('.craft-note').innerText()), 'it says Save replaces the Drive file and Drive keeps the earlier version');
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = /Saves go to this file in Google Drive/.test(await editor.locator('.craft-state').innerText().catch(() => ''));
    if (!ready) await page.waitForTimeout(1000);
  }
  ok(ready, 'the document editor opens the file, and says its saves go to the file in Google Drive');

  const frame = page.frames().find((f) => f.url().includes('/craft/wordcraft/'));
  ok(!!frame, 'the editor runs in its own frame on Timmy’s origin');
  const saveFromEditor = (lines, id) => frame.evaluate(({ bytes, id }) => window.parent.postMessage({ type: 'wordcraft:save', name: 'Landing checklist.docx', bytes: new Uint8Array(bytes).buffer, id }, location.origin), { bytes: docx(lines), id });
  const driveFile = async () => (await api(page, 'POST', '/api/test/fake', { op: 'drive-file', name: 'Landing checklist' })).body;
  const until = async (fn, tries = 80) => {
    for (let i = 0; i < tries; i++) {
      if (await fn()) return true;
      await page.waitForTimeout(250);
    }
    return false;
  };

  // File › Save: the Doc in Drive now says what was saved.
  await saveFromEditor(['Check the radar.', 'Watch alarm 1202.', 'Go for landing.'], 's1');
  ok(await until(async () => (await driveFile()).uploads === 1), 'Save sends the edited file to Google Drive');
  ok((await driveFile()).text === 'Check the radar.\nWatch alarm 1202.\nGo for landing.', 'and the Doc in Drive now has the new words');
  await page.locator('.toast', { hasText: 'Saved to Google Drive' }).waitFor();
  ok(true, 'the person is told it was saved to Google Drive');
  const entries = (await api(page, 'GET', '/api/v1/audit?limit=20')).body.entries;
  const done = entries.find((e) => e.action === 'effect.completed' && e.effect_id);
  ok(!!done && (await api(page, 'GET', `/api/v1/effects/${done.effect_id}`)).body.kind === 'file.update', 'the save is recorded in the audit log as an approved, completed write');

  // A second save goes through too: the editor keeps Drive's new version.
  await saveFromEditor(['Check the radar.', 'Go for landing.'], 's2');
  ok(await until(async () => (await driveFile()).uploads === 2), 'a second save goes through as well');

  // Someone changes the Doc in Google Docs while it is open here: the next save stops and asks.
  await api(page, 'POST', '/api/test/fake', { op: 'drive-change', name: 'Landing checklist', text: 'Neil’s edit.' });
  await saveFromEditor(['My edit.'], 's3');
  const conflict = editor.locator('.drive-editor-conflict');
  await conflict.waitFor();
  ok(/Someone changed this file in Google Drive after you opened it/.test(await conflict.innerText()), 'a change made in Drive meanwhile stops the save, and the person is told');
  ok((await driveFile()).text === 'Neil’s edit.', 'their change is still what Drive has');
  await conflict.getByRole('button', { name: 'Save mine over theirs' }).click();
  ok(await until(async () => (await driveFile()).text === 'My edit.'), 'choosing to save over it does, once the person says so');
  ok((await conflict.count()) === 0, 'and the question goes away');

  // Close returns to the file list.
  await editor.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('heading', { name: 'Google Drive' }).waitFor();
  ok((await editor.count()) === 0, 'Close leaves the editor');

  const bad = errors.filter((e) => !/Failed to load resource|WebGPU|webgl|GPU/i.test(e));
  ok(bad.length === 0, `no page errors (${bad.join(' | ')})`);
});
