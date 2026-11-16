// Live mode: an event added in Timmy's calendar is written to Google Calendar. With a guest it sends an
// invitation, so it waits out the undo window first, and Undo inside the window means nobody is invited.
const { ok, open, signUp, api, run } = require('./lib.cjs');
const HOLD = Number(process.env.TIMMY_SEND_HOLD_SECONDS || 4) * 1000;

run('live-calendar', async (browser) => {
  const { page, errors } = await open(browser);
  await signUp(page, { name: 'Mary Jackson' });

  // Connect Google Calendar the way a person would.
  await api(page, 'POST', '/api/test/fake', { op: 'address', address: 'mary@nasa.test' });
  await page.click('button[aria-label="Connections"]');
  const card = page.locator('li.conn-card', { has: page.getByText('Google Calendar', { exact: true }) }).first();
  await card.getByRole('button', { name: 'Connect' }).click();
  await page.getByRole('button', { name: 'Continue to Google Calendar' }).click();
  await page.waitForURL(/connect=ok/, { timeout: 15000 });
  await page.locator('.main').waitFor();
  const google = async () => (await api(page, 'POST', '/api/test/fake', { op: 'calendar' })).body.events;
  ok((await google()).length === 0, 'the connected calendar starts with nothing Timmy made');

  const addEvent = async (title, guest) => {
    await page.click('button[aria-label="Calendar"]');
    await page.getByRole('button', { name: 'New event' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New event' });
    await dialog.getByPlaceholder(/what it’s about|what you’ll work on/i).fill(title);
    if (guest) {
      await dialog.getByLabel('Invite people').fill(guest);
      await page.keyboard.press('Enter');
    }
    await dialog.getByRole('button', { name: 'Add event' }).click();
  };
  const until = async (fn) => {
    for (let i = 0; i < 40; i++) {
      if (await fn()) return true;
      await page.waitForTimeout(250);
    }
    return false;
  };

  // An event with a guest: nothing reaches Google until the undo window has passed.
  await addEvent('Wind tunnel review', 'dorothy@nasa.test');
  await page.locator('.toast', { hasText: /Event added/ }).waitFor();
  ok((await page.locator('.toast').getByRole('button', { name: 'Undo' }).count()) === 1, 'adding an event with a guest starts an undo window');
  ok((await google()).length === 0, 'during the window nothing is on Google Calendar and nobody is invited');
  // The notice appears at once; the server's record of the waiting invitation follows when it has answered.
  let pending = [];
  for (let i = 0; i < 20 && pending.length === 0; i++) {
    pending = (await api(page, 'GET', '/api/v1/state')).body.slices.pending;
    if (pending.length === 0) await page.waitForTimeout(150);
  }
  ok(pending.length === 1 && pending[0].kind === 'calendar' && /dorothy@nasa\.test/.test(pending[0].title), `the invitation is listed as waiting to go out (${pending[0] && pending[0].title})`);
  ok((await google()).length === 0, 'and it is still not on Google Calendar while it waits');
  ok(await until(async () => (await google()).length === 1), 'after the window the event is created in Google Calendar');
  const [made] = await google();
  ok(made.summary === 'Wind tunnel review' && made.attendees.join() === 'dorothy@nasa.test' && made.invited === true, 'with the guest invited, as written');
  await page.waitForTimeout(HOLD + 1500);
  ok((await google()).length === 1, 'it is created once');
  const shown = Object.values((await api(page, 'GET', '/api/v1/state')).body.slices['ws.events']).filter((e) => e.title === 'Wind tunnel review');
  ok(shown.length === 1 && /^gcal-/.test(shown[0].id), 'and it shows once on Timmy’s calendar, as the Google event');

  // Undo inside the window: the event goes, and nobody is invited.
  await addEvent('Changed my mind', 'katherine@nasa.test');
  await page.locator('.toast', { hasText: /Event added/ }).waitFor();
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await page.locator('.toast', { hasText: /Undone/ }).waitFor();
  await page.waitForTimeout(HOLD + 2000);
  ok((await google()).length === 1, 'after Undo the second event never reaches Google Calendar');
  ok(!Object.values((await api(page, 'GET', '/api/v1/state')).body.slices['ws.events']).some((e) => e.title === 'Changed my mind'), 'and it is gone from Timmy’s calendar');

  const audit = (await api(page, 'GET', '/api/v1/audit')).body.entries.map((e) => e.action);
  ok(audit.includes('effect.completed') && audit.includes('effect.cancelled'), 'the audit log has the invitation that went out and the one that was undone');
  ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
});
