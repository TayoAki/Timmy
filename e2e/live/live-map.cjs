// People › Map (src/live/PeopleMap.tsx, server/src/ontology/map.ts): the people, companies, projects and files a
// workspace knows of, as a network; details on click, focus, filters and search.
const { ok, open, signUp, api, connectApp, connectGmail, run } = require('./lib.cjs');

const SHOTS = process.env.SHOTS;

run('live-map', async (browser) => {
  const { page, errors } = await open(browser, SHOTS ? { viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 } : {});
  await signUp(page, { name: 'Grace Hopper' });
  await connectGmail(page, 'grace@mycompany.test');
  await connectApp(page, 'Google Drive', 'grace@mycompany.test');
  await api(page, 'POST', '/api/test/fake', { op: 'file', file: { name: 'Acme redesign brief', owner: 'dana@acme.test' } });
  const mails = [
    ['Dana Whitfield <dana@acme.test>', 'Website redesign kickoff'],
    ['Sam Rivera <sam@acme.test>', 'Homepage wireframes'],
    ['Dana Whitfield <dana@acme.test>', 'Redesign budget question'],
    ['Lee Park <lee@northwind.test>', 'Northwind renewal terms'],
    ['Lee Park <lee@northwind.test>', 'Renewal: signed order form'],
    ['Jo Freelancer <jo.design@gmail.com>', 'Logo sketches'],
  ];
  for (const [from, subject] of mails) await api(page, 'POST', '/api/test/fake', { op: 'deliver', message: { from, subject, body: 'Could you take a look at this?' } });
  // The map of people is built from the mail in the background.
  let built = false;
  for (let i = 0; i < 100 && !built; i++) {
    built = (await api(page, 'GET', '/api/v1/map')).body.nodes.filter((n) => n.type === 'person').length >= 4;
    if (!built) await page.waitForTimeout(200);
  }
  ok(built, 'Timmy knows the people from the mail');

  // Keep the Acme project a scan finds.
  await api(page, 'POST', '/api/v1/projects/detect', {});
  let scan;
  for (let i = 0; i < 100 && scan?.status !== 'ready'; i++) {
    scan = (await api(page, 'GET', '/api/v1/projects/detect')).body.scan;
    if (scan?.status !== 'ready') await page.waitForTimeout(200);
  }
  const acme = scan.proposals.find((p) => p.keys[0] === 'org:acme.test');
  await api(page, 'POST', `/api/v1/projects/detect/${scan.id}/apply`, { choices: [{ id: acme.id, keep: true, name: 'Acme website' }] });

  await page.reload();
  await page.locator('.main').waitFor();
  await page.click('button[aria-label="People"]');
  await page.getByRole('tab', { name: 'Map' }).click();
  const canvas = page.locator('.pm-canvas');
  await canvas.locator('.react-flow__node.pm-project', { hasText: 'Acme website' }).waitFor();
  ok(true, 'the map shows the kept project');
  ok((await canvas.locator('.react-flow__node.pm-company', { hasText: 'Acme' }).count()) >= 1 && (await canvas.locator('.react-flow__node.pm-company', { hasText: 'Northwind' }).count()) === 1, 'and the companies');
  ok((await canvas.locator('.react-flow__node.pm-person', { hasText: 'Dana Whitfield' }).count()) === 1 && (await canvas.locator('.react-flow__node.pm-person', { hasText: 'Jo Freelancer' }).count()) === 1, 'and the people, by name');
  ok((await canvas.locator('.react-flow__node.pm-file', { hasText: 'Acme redesign brief' }).count()) === 1, 'and the project’s file');
  ok((await canvas.locator('.react-flow__edge').count()) >= 5, 'with lines between what belongs together');
  if (SHOTS) {
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOTS}/people-map.png` });
  }

  // Click a company: what it is and what connects to it.
  // Picked by name, not by where the layout put it on screen.
  await canvas.locator('.react-flow__node.pm-company', { hasText: 'Northwind' }).dispatchEvent('click');
  const panel = page.locator('.pm-details');
  await panel.waitFor();
  ok(/Northwind/.test(await panel.locator('h2').innerText()) && /Lee Park/.test(await panel.innerText()), 'clicking a company shows its people');
  ok(/Northwind renewal terms|Renewal: signed order form/.test(await panel.innerText()), 'and its latest threads');
  // Focus: only what connects.
  await panel.getByRole('button', { name: 'Show only what connects' }).click();
  await page.waitForTimeout(400);
  ok((await canvas.locator('.react-flow__node.pm-project').count()) === 0 && (await canvas.locator('.react-flow__node.pm-person', { hasText: 'Lee Park' }).count()) === 1, 'focusing shows only what connects to it');
  await page.getByRole('button', { name: 'Show everything' }).click();
  await canvas.locator('.react-flow__node.pm-project').first().waitFor();

  // Search, then open a person's thread from the panel.
  await page.getByLabel('Find on the map').fill('dana');
  await page.getByLabel('Find on the map').press('Enter');
  await panel.locator('h2', { hasText: 'Dana Whitfield' }).waitFor();
  ok((await canvas.locator('.react-flow__node.pm-match').count()) >= 1, 'search finds a person and opens them');
  await panel.getByRole('button', { name: 'Redesign budget question' }).click();
  await page.locator('.msg-head').first().waitFor();
  ok(/Redesign budget question/.test(await page.locator('.main').innerText()), 'a thread opens from the map');

  // Filters.
  await page.goBack().catch(() => {});
  await page.click('button[aria-label="People"]');
  await page.getByRole('tab', { name: 'Map' }).click();
  await canvas.locator('.react-flow__node.pm-person').first().waitFor();
  await page.locator('.pm-kind-person').click();
  await page.waitForTimeout(300);
  ok((await canvas.locator('.react-flow__node.pm-person').count()) === 0 && (await canvas.locator('.react-flow__node.pm-company').count()) >= 1, 'people can be hidden, leaving the rest');

  ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
});
