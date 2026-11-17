// Live mode: OneDrive, connected through Composio as its own app. Timmy only reads it: a list of files, and the words
// of Word, Excel and PowerPoint files, so Ask can find one by a word inside it and read it. Disconnecting takes it all away.
const { ok, open, signUp, api, connectApp, run } = require('./lib.cjs');

run('live-onedrive', async (browser) => {
  const { page, errors } = await open(browser);
  await signUp(page, { name: 'Grace Hopper' });

  // The card says what Timmy reads and that it writes nothing; the connect dialog says Microsoft is asked only to read.
  await page.click('button[aria-label="Connections"]');
  const card = page.locator('li.conn-card', { has: page.getByText('OneDrive', { exact: true }) }).first();
  await card.waitFor();
  const before = await card.innerText();
  ok(/Reads\s+The names, types and owners of your files, and the words in your recent Word, Excel and PowerPoint files/.test(before), 'the OneDrive card says what Timmy reads');
  ok(/Writes\s+Nothing/.test(before) && !/Coming soon/.test(before), 'and that it writes nothing, and it can be connected');
  await card.getByRole('button', { name: 'Connect', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect OneDrive' });
  await dialog.waitFor();
  const told = await dialog.innerText();
  ok(/Timmy may write\s+Nothing\./.test(told) && /only to let Timmy read your own files/.test(told) && /changes nothing in OneDrive/.test(told), 'the connect dialog says Timmy only reads, and changes nothing');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await connectApp(page, 'OneDrive', 'grace@navy.test');
  await page.click('button[aria-label="Connections"]');
  await card.getByRole('button', { name: 'Disconnect' }).waitFor();
  ok(/Connected · grace@navy\.test/.test(await card.innerText()), 'OneDrive shows as connected, with the address OneDrive gave');
  const outlook = page.locator('li.conn-card', { has: page.getByText('Outlook and Microsoft 365', { exact: true }) }).first();
  ok((await outlook.getByRole('button', { name: 'Connect', exact: true }).count()) === 1, 'Outlook is still its own app, not connected by connecting OneDrive');

  // A Word document and a workbook are made in OneDrive and announced; each is listed and its words kept.
  ok((await api(page, 'POST', '/api/test/fake', { op: 'file', app: 'onedrive', file: { name: 'Compiler notes.docx', text: 'The first bug was a moth.\nTape it into the logbook.' } })).body.ok, 'a Word document made in OneDrive is announced, listed and read');
  ok((await api(page, 'POST', '/api/test/fake', { op: 'file', app: 'onedrive', file: { name: 'Budget.xlsx', rows: [['Project', 'Cost'], ['COBOL manual', 1200]] } })).body.ok, 'and an Excel workbook');

  const ask = async (text, expect) => {
    if (!(await page.locator('.ai-input').isVisible().catch(() => false))) await page.keyboard.press('Control+i');
    await page.locator('.ai-input').waitFor();
    await page.locator('.ai-input').fill(text);
    await page.keyboard.press('Enter');
    await page.locator('.ai-msg.timmy', { hasText: expect }).last().waitFor({ timeout: 30000 });
    return page.locator('.ai-msg.timmy').last().innerText();
  };
  ok(/I found a file: “Compiler notes\.docx” \(Word document\)/.test(await ask('find the file about moth', 'Compiler notes.docx')), 'Ask finds the Word document by a word inside it');
  ok(/I found a file: “Budget\.xlsx” \(Excel workbook\)/.test(await ask('find the file about cobol', 'Budget.xlsx')), 'and the workbook by a word in one of its cells');
  ok(/It says: The first bug was a moth\./.test(await ask('what does the file compiler notes say', 'It says:')), 'Ask reads what the Word document says');
  ok((await page.locator('.ai-error').count()) === 0, 'no error in the chat');
  await page.keyboard.press('Escape');

  // A file deleted in OneDrive leaves the list; disconnecting takes the rest, and Ask finds nothing more.
  ok((await api(page, 'POST', '/api/test/fake', { op: 'file-trash', app: 'onedrive', name: 'Budget.xlsx' })).body.ok, 'a file deleted in OneDrive leaves the list');
  await page.click('button[aria-label="Connections"]');
  await card.getByRole('button', { name: 'Disconnect' }).click();
  await card.getByRole('button', { name: 'Connect', exact: true }).waitFor({ timeout: 10000 });
  ok(/I couldn’t find a file with that name\./.test(await ask('find the file about moth', 'I couldn’t find')), 'after disconnecting, Ask no longer finds its files');

  ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
});
