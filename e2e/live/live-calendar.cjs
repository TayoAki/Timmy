// Live mode: an event added in Timmy's calendar is written to Google Calendar. With a guest it sends an
// invitation, so it waits out the undo window first, and Undo inside the window means nobody is invited.
// An event that is already on the calendar can be moved and deleted from Timmy under the same rules, and one
// that someone else organizes can't.
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

  /* ───── Changing and deleting an event that is already on the calendar ───── */

  const told = async (id, about) => (await api(page, 'POST', '/api/test/fake', { op: 'calendar' })).body.notices.filter((n) => n.event === id && n.about === about);
  const onGoogle = async (id) => (await google()).find((e) => e.id === id);
  const onTimmy = async (title) => Object.values((await api(page, 'GET', '/api/v1/state')).body.slices['ws.events']).filter((e) => e.title === title);
  const today = (hour, minute = 0) => {
    const d = new Date();
    d.setHours(hour, minute, 0, 0);
    return d.toISOString();
  };
  // Today on the calendar. An event's own window stays open after it is edited, so it is closed first.
  const showToday = async () => {
    await page.keyboard.press('Escape');
    await page.click('button[aria-label="Calendar"]');
    await page.getByRole('tab', { name: 'Day' }).click();
  };
  const openEvent = async (title) => {
    await showToday();
    await page.locator('.cal-ev', { hasText: title }).first().click();
    return page.getByRole('dialog', { name: title });
  };
  const moveTo = async (title, time) => {
    const detail = await openEvent(title);
    await detail.getByRole('button', { name: 'Edit' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit event' });
    await edit.getByLabel('Start', { exact: true }).fill(time);
    await edit.getByRole('button', { name: 'Save changes' }).click();
    // Saving goes back to the event's own window, which covers the notice and its Undo. It is closed, as a person would.
    await page.getByRole('dialog', { name: title }).getByRole('button', { name: 'Done' }).click();
  };

  // Two events made in Google Calendar itself: one of Mary's own with a guest, and one that someone else organizes.
  const seeded = await api(page, 'POST', '/api/test/fake', { op: 'calendar-event', event: { id: 'seedbudget', summary: 'Budget sync', start: today(14), end: today(14, 30), attendees: ['mary@nasa.test', 'dorothy@nasa.test'] } });
  await api(page, 'POST', '/api/test/fake', { op: 'calendar-event', event: { id: 'seedvendor', summary: 'Vendor all-hands', start: today(16), end: today(17), attendees: ['mary@nasa.test'], organizer: 'vendor@elsewhere.test' } });
  ok(seeded.body.ok && (await until(async () => (await onTimmy('Budget sync')).length === 1 && (await onTimmy('Vendor all-hands')).length === 1)), 'events made in Google Calendar itself appear on Timmy’s calendar');
  const [budget] = await onTimmy('Budget sync');

  // Moving an event that has a guest: approved like an email, with the undo window first.
  await moveTo('Budget sync', '15:00');
  await page.locator('.toast', { hasText: /Changing “Budget sync” on the calendar in \d+ seconds; dorothy@nasa\.test will be told\. Undo to stop it\./ }).waitFor();
  ok((await page.locator('.toast').getByRole('button', { name: 'Undo' }).count()) === 1, 'moving an event with a guest says who will be told and starts an undo window');
  ok((await onGoogle('seedbudget')).start === today(14) && (await told('seedbudget', 'changed')).length === 0, 'during the window Google Calendar still has the old time and the guest has been told nothing');
  const waiting = (await api(page, 'GET', '/api/v1/state')).body.slices.pending.find((p) => /Budget sync/.test(p.title));
  ok(waiting && waiting.kind === 'calendar' && /^Move “Budget sync” to .+, and tell dorothy@nasa\.test$/.test(waiting.title), `the change is listed as waiting to go out, saying who is told (${waiting && waiting.title})`);
  // The times are written on the workspace's own clock, so only their shape is checked here: an old one and a different new one.
  const times = waiting && /^Now: (.+)\n\nMoves to: (.+)\n\n/.exec(waiting.preview.body);
  const span = /\d:\d\d [AP]M to \d+:\d\d [AP]M/;
  ok(times && times[1] !== times[2] && span.test(times[1]) && span.test(times[2]) && /Google Calendar tells dorothy@nasa\.test about the change/.test(waiting.preview.body), `and what the approver is shown has the old and the new time (${waiting && waiting.preview.body.replace(/\n+/g, ' | ')})`);
  ok(await until(async () => (await onGoogle('seedbudget')).start === today(15)), 'after the window the event has its new time in Google Calendar');
  ok((await onGoogle('seedbudget')).end === today(15, 30) && (await onGoogle('seedbudget')).attendees.join() === 'mary@nasa.test,dorothy@nasa.test', 'its length and its guests are as they were');
  await page.waitForTimeout(HOLD + 1500);
  const heard = await told('seedbudget', 'changed');
  ok(heard.length === 1 && heard[0].to.join() === 'dorothy@nasa.test', 'the guest was told once');
  const moved = await onTimmy('Budget sync');
  ok(moved.length === 1 && moved[0].id === budget.id && new Date(moved[0].start).toISOString() === today(15), 'and Timmy’s calendar shows one event, the same one, at its new time');
  await showToday();
  ok((await page.locator('.cal-ev', { hasText: 'Budget sync' }).count()) === 1 && /3:00/.test(await page.locator('.cal-ev', { hasText: 'Budget sync' }).getAttribute('aria-label')), 'on the screen too');

  // Undo inside the window: nothing is written and nobody is told.
  await moveTo('Budget sync', '17:00');
  await page.locator('.toast', { hasText: /Changing “Budget sync”/ }).waitFor();
  await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
  await page.locator('.toast', { hasText: /Undone/ }).waitFor();
  await page.waitForTimeout(HOLD + 2000);
  ok((await onGoogle('seedbudget')).start === today(15) && (await told('seedbudget', 'changed')).length === 1, 'after Undo the second move never reaches Google Calendar, and the guest hears nothing more');
  ok(new Date((await onTimmy('Budget sync'))[0].start).toISOString() === today(15), 'and Timmy’s calendar is back at the time Google has');

  // An event someone else organizes can't be deleted from Timmy.
  const theirs = await openEvent('Vendor all-hands');
  await theirs.getByRole('button', { name: 'Delete' }).click();
  await page.locator('.toast', { hasText: /“Vendor all-hands” is organized by vendor@elsewhere\.test, so it can’t be deleted from Timmy/ }).waitFor();
  ok((await onGoogle('seedvendor')) !== undefined && (await onTimmy('Vendor all-hands')).length === 1, 'an event someone else organizes is refused with the reason, and stays where it is');
  await page.locator('.cal-ev', { hasText: 'Vendor all-hands' }).first().waitFor();

  // Deleting an event that has a guest: the same window, then Google cancels it and tells the guest.
  const mine = await openEvent('Budget sync');
  await mine.getByRole('button', { name: 'Delete' }).click();
  await page.locator('.toast', { hasText: /Cancelling “Budget sync” in \d+ seconds; dorothy@nasa\.test will be told\. Undo to stop it\./ }).waitFor();
  ok((await onGoogle('seedbudget')) !== undefined && (await told('seedbudget', 'cancelled')).length === 0, 'during the window the event is still in Google Calendar and nobody has been told');
  ok(await until(async () => (await onGoogle('seedbudget')) === undefined), 'after the window the event is gone from Google Calendar');
  const cancelled = await told('seedbudget', 'cancelled');
  ok(cancelled.length === 1 && cancelled[0].to.join() === 'dorothy@nasa.test', 'and the guest was told it is cancelled, once');
  ok(await until(async () => (await onTimmy('Budget sync')).length === 0), 'it is gone from Timmy’s calendar');
  await page.waitForTimeout(HOLD + 1500);
  ok((await onTimmy('Budget sync')).length === 0 && (await google()).length === 2, 'and it stays gone: the other events are untouched');

  const kinds = (await api(page, 'GET', '/api/v1/audit')).body.entries.filter((e) => e.action === 'effect.proposed').map((e) => e.detail.kind);
  ok(kinds.filter((k) => k === 'calendar.update').length === 2 && kinds.filter((k) => k === 'calendar.delete').length === 1, 'the audit log has the two moves and the deletion, and nothing for the event that was refused');
  ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
});
