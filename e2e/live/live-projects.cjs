// Projects › Detect projects (src/live/DetectProjects.tsx, server/src/projects): scan the mail, see what was found as a
// list and a map, keep, rename, merge or drop each, and get projects with their threads, files and new mail.
const { ok, open, signUp, api, connectApp, connectGmail, run } = require('./lib.cjs');

const SHOTS = process.env.SHOTS;

run('live-projects', async (browser) => {
  const { page, errors } = await open(browser, SHOTS ? { viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 } : {});
  await signUp(page, { name: 'Grace Hopper' });
  await connectGmail(page, 'grace@mycompany.test');
  await connectApp(page, 'Google Drive', 'grace@mycompany.test');
  const added = await api(page, 'POST', '/api/test/fake', { op: 'file', file: { name: 'Acme redesign brief', owner: 'dana@acme.test' } });
  ok(added.body.ok, 'a file from Acme is in the Drive');

  const mails = [
    ['Dana Whitfield <dana@acme.test>', 'Website redesign kickoff'],
    ['Sam Rivera <sam@acme.test>', 'Homepage wireframes'],
    ['Dana Whitfield <dana@acme.test>', 'Redesign budget question'],
    ['Lee Park <lee@northwind.test>', 'Northwind renewal terms'],
    ['Lee Park <lee@northwind.test>', 'Renewal: signed order form'],
    ['Pat Kim <pat@mycompany.test>', 'Offsite venue options'],
    ['Ravi Shah <ravi@mycompany.test>', 'Offsite agenda draft'],
    ['Pat Kim <pat@mycompany.test>', 'Offsite travel bookings'],
  ];
  for (const [from, subject] of mails) await api(page, 'POST', '/api/test/fake', { op: 'deliver', message: { from, subject, body: 'Could you take a look at this?' } });
  await api(page, 'POST', '/api/test/fake', { op: 'deliver', message: { from: 'Shop <deals@shop.test>', subject: 'Spring sale', body: 'Sale!', labels: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'] } });
  for (let i = 0; i < 100; i++) {
    if ((await api(page, 'GET', '/api/v1/state')).body.slices.threads.length >= 9) break;
    await page.waitForTimeout(150);
  }

  await page.click('button[aria-label="Projects"]');
  await page.getByRole('heading', { name: 'Projects', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Detect projects' }).click();
  const dialog = page.getByRole('dialog', { name: 'Detect projects' });
  await dialog.waitFor();
  ok(/Nothing changes in your mailbox or your Drive/.test(await dialog.innerText()), 'it says up front that nothing changes in the mailbox or Drive');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/projects-intro.png` });
  await dialog.getByRole('button', { name: 'Scan my mail' }).click();

  const found = page.getByRole('dialog', { name: /Timmy found 3 projects/ });
  await found.waitFor({ timeout: 60000 });
  const list = found.getByRole('list', { name: 'Projects found' });
  const names = await list.getByLabel('Project name').evaluateAll((els) => els.map((e) => e.value));
  ok(names.sort().join('|') === 'Acme work|Northwind work|Team work', `it found Acme, Northwind and the offsite among colleagues, and left the sale out (${names.join(', ')})`);
  ok((await found.locator('.react-flow__node.dp-node-project').count()) === 3, 'the map shows the three projects');
  ok((await found.locator('.react-flow__node.dp-node-org', { hasText: 'Acme' }).count()) === 1, 'with the companies');
  ok((await found.locator('.react-flow__node.dp-node-file', { hasText: 'Acme redesign brief' }).count()) === 1, 'and the file that belongs to Acme');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/projects-found.png` });

  // Rename Acme, merge Northwind into it, drop the offsite.
  const item = (name) => list.locator('.dp-item', { has: page.locator(`input[aria-label="Project name"][value="${name}"]`) });
  await item('Acme work').getByLabel('Project name').fill('Acme website');
  await item('Northwind work').locator('select').selectOption({ label: 'Acme website' });
  await item('Team work').getByRole('checkbox').uncheck();
  ok((await found.getByRole('button', { name: 'Create 1 project' }).count()) === 1, 'the button says what will be made');
  await found.getByRole('button', { name: 'Create 1 project' }).click();
  await page.getByText(/Created Acme website and put 5 threads in it/).waitFor();
  ok(true, 'creating says what was made and how many threads went in');

  await page.getByText('Acme website').first().click();
  await page.getByRole('tab', { name: /Mail/ }).click();
  const mailTab = await page.locator('.main').innerText();
  ok(['Website redesign kickoff', 'Homepage wireframes', 'Redesign budget question', 'Northwind renewal terms', 'Renewal: signed order form'].every((s) => mailTab.includes(s)), 'the project’s Mail has its threads, Northwind’s merged in');
  ok(!mailTab.includes('Offsite'), 'and not the dropped offsite');
  await page.getByRole('tab', { name: /Files/ }).click();
  await page.getByText('From your connected apps').waitFor();
  ok((await page.locator('.pj-line', { hasText: 'Acme redesign brief' }).count()) === 1, 'its Files tab lists the Drive file linked to it');
  await page.locator('.pj-line', { hasText: 'Acme redesign brief' }).click();
  await page.getByRole('dialog', { name: 'Acme redesign brief' }).waitFor();
  ok(true, 'and opens it inside Timmy');
  await page.keyboard.press('Escape');

  // New mail from Acme goes into the project by itself.
  await api(page, 'POST', '/api/test/fake', { op: 'deliver', message: { from: 'Morgan Lee <morgan@acme.test>', subject: 'New page copy', body: 'Draft attached.' } });
  let project;
  for (let i = 0; i < 60 && !project; i++) {
    const s = (await api(page, 'GET', '/api/v1/state')).body.slices;
    project = s.threads.find((t) => t.subject === 'New page copy')?.project;
    if (!project) await page.waitForTimeout(150);
  }
  const projects = (await api(page, 'GET', '/api/v1/state')).body.slices['ws.projects'];
  ok(projects[project]?.name === 'Acme website', 'new mail from Acme goes into the project by itself');

  ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
});
