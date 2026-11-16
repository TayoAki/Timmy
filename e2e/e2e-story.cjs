// The story player: "Monday, 8:12" plays the SB7 story in the real app on fresh demo data,
// does what each scene says, and puts back the demo data you had when you close it.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:5173/';
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };
const KEY = 'timmy-state-v3';
(async () => {
  const b = await chromium.launch();
  const errors = [];
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', (e) => errors.push(e.message));
  const state = async () => { await p.waitForTimeout(600); return p.evaluate((KEY) => JSON.parse(localStorage.getItem(KEY) || 'null'), KEY); };
  const scene = async () => parseInt(await p.locator('.story-count').first().innerText({ timeout: 500 }).catch(() => '0'), 10) || 0;
  // Skip ahead to the scene before `n`, then let `n` arrive on its own so it isn't skipped too.
  const goTo = async (n, ms = 40000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && (await scene()) < n - 1) {
      await p.keyboard.press('ArrowRight');
      await p.waitForTimeout(300);
    }
    while (Date.now() < end) {
      if ((await scene()) >= n) return;
      await p.waitForTimeout(200);
    }
    throw new Error(`FAIL: stuck before scene ${n} (at ${await scene()})`);
  };

  // Your own demo: calm view on, so we can tell it comes back.
  await p.goto(BASE);
  await p.evaluate(() => localStorage.clear());
  await p.reload();
  await p.waitForTimeout(800);
  await p.click('button.calm-toggle');
  await p.waitForTimeout(700);
  assert((await state()).calm === true, 'set up: calm view is on in your own demo');

  await p.click('button:has-text("Watch the story")');
  const intro = p.locator('.story-card');
  assert(/Monday, 8:12/.test(await intro.innerText()) && /When you close it, the demo goes back to how you left it/.test(await intro.innerText()), 'the story opens on its title card and says your changes come back');
  await p.click('.story-card button:has-text("Play the story")');
  await p.waitForSelector('.story-caption');
  await p.waitForTimeout(900);
  assert(/8:12 AM/.test(await p.locator('.story-caption').innerText()), 'scene 1 starts at 8:12 AM');
  assert(await p.locator('.story-spot').count() === 1, 'each scene points at one thing on screen');
  assert((await state()).calm === false, 'the story plays on fresh demo data');

  await goTo(11);
  let s = await state();
  assert(s.decisions.find((d) => d.id === 'acme-price')?.chosen?.option === 'hold', 'Approvals: the story keeps $62 for Acme');
  await goTo(14);
  s = await state();
  const t = s.threads.find((x) => x.id === 'acme-quote');
  assert(t.box === 'waiting' && /\$62/.test(t.messages[t.messages.length - 1].body.join(' ')), 'Dana’s reply goes out quoting $62 and moves to Waiting');
  await goTo(16);
  s = await state();
  assert(Object.values(s.ws.events).some((e) => /^Intro call:/.test(e.title)), 'the lead’s 9:15 call is booked on the calendar');
  await goTo(18);
  s = await state();
  const drafts = s.out.messages.filter((m) => m.status === 'draft').length;
  assert(drafts > 0, `asking Timmy for a campaign saves drafts (${drafts})`);
  await goTo(20);
  s = await state();
  assert(s.threads.filter((x) => x.box === 'inbox').length < 7, 'triage sorts the confident ones out of the inbox');
  await goTo(22);
  s = await state();
  assert(s.out.messages.filter((m) => m.status === 'draft').length === 0, 'at lunch the drafts are sent');
  assert(/The plan is short/.test(await p.locator('.story-card').innerText()), 'the plan card lists the three steps');
  await goTo(24);
  await p.keyboard.press('ArrowRight');
  await p.waitForSelector('.story-card:has-text("Explore from here")', { timeout: 10000 });
  assert(/never drops a ball/.test(await p.locator('.story-card').innerText()), 'the story ends on the change in Taylor, with the call to action');

  await p.click('.story-card button:has-text("Put back the demo data I had")');
  await p.waitForTimeout(400);
  assert(await p.locator('.story').count() === 0, 'closing hides the story');
  assert(/Your demo is back the way you left it/.test(await p.locator('.toast').innerText().catch(() => '')), 'putting it back says so');
  s = await state();
  assert(s.calm === true && !s.decisions.find((d) => d.id === 'acme-price')?.chosen, 'your own demo data is back (calm view on, $62 not decided)');

  // ?story=play starts without a click; Esc stops it and puts your demo back.
  await p.goto(BASE + '?story=play');
  await p.waitForSelector('.story-caption', { timeout: 8000 });
  assert(/8:12 AM/.test(await p.locator('.story-caption').innerText()), '?story=play starts the story straight away (for recordings)');
  await goTo(11);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(600);
  s = await state();
  assert(await p.locator('.story').count() === 0 && s.calm === true && !s.decisions.find((d) => d.id === 'acme-price')?.chosen, 'Esc stops the story and undoes what it did');

  assert(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
