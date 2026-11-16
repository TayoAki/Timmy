// The cinematic intro (?intro): the real app filmed in 3D, seekable frame by frame, on demo
// data that is never saved; and the story's voiceover-sync mode starts on cue.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://localhost:5173/';
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };
const KEY = 'timmy-state-v3';
(async () => {
  const b = await chromium.launch();
  const errors = [];
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  p.on('pageerror', (e) => errors.push(e.message));

  // Your own demo data, to prove the intro leaves it alone.
  await p.goto(BASE);
  await p.evaluate(() => localStorage.clear());
  await p.reload();
  await p.waitForTimeout(700);
  await p.click('button.calm-toggle');
  await p.waitForTimeout(700);
  const before = await p.evaluate((KEY) => localStorage.getItem(KEY), KEY);

  await p.goto(BASE + '?intro=frames');
  await p.waitForFunction(() => window.__film && window.__film.ready, null, { timeout: 20000 });
  assert(await p.evaluate(() => window.__film.length) === 17, 'the intro is 17 seconds long');
  assert(await p.locator('.intro-plane .app').count() === 1 && await p.locator('.intro-urgent .urg-row').count() >= 4 && await p.locator('.intro-card .ap-card').count() === 1, 'it films the real app, the urgent list and the $58 decision');
  assert(await p.locator('.intro-plane .tri-grid').count() === 1, 'it plays on fresh demo data (the full brief, not your calm view)');

  const at = async (t) => { await p.evaluate((t) => window.__film.seek(t), t); await p.waitForTimeout(120); };
  await at(0.2);
  assert(Number(await p.locator('.intro-fade').evaluate((el) => getComputedStyle(el).opacity)) > 0.6, 'it opens from black');
  await at(3);
  const rig = await p.locator('.intro-rig').evaluate((el) => el.style.transform);
  assert(/rotateX\(/.test(rig) && /translateZ\(/.test(rig), 'a camera rig moves through a 3D scene');
  const z1 = await p.locator('.intro-urgent .urg-row').nth(4).evaluate((el) => el.style.transform);
  await at(6.5);
  const z2 = await p.locator('.intro-urgent .urg-row').nth(4).evaluate((el) => el.style.transform);
  assert(z1 !== z2 && /translateZ\(0/.test(z2), `rows settle onto the list from depth (${z1} → ${z2})`);
  assert(/blur\(/.test(await p.locator('.intro-plane').evaluate((el) => el.style.filter)), 'the app behind is out of focus');
  await at(10.3);
  await at(10.6);
  await p.waitForTimeout(300);
  await at(11.4);
  assert(/Kept \$62/.test(await p.locator('.intro-toast').innerText().catch(() => '')), 'the cursor presses Keep $62 for real, and the real confirmation appears');
  await at(15.2);
  assert(Number(await p.locator('.intro-title').evaluate((el) => getComputedStyle(el).opacity)) > 0.9 && /Timmy/.test(await p.locator('.intro-word').innerText()), 'the title racks into focus');
  await at(17);
  assert(Number(await p.locator('.intro-fade').evaluate((el) => getComputedStyle(el).opacity)) > 0.95, 'it ends on black, ready to cut to the story');

  // The outro: the end of Taylor's day, then the line and the call to action.
  await p.goto(BASE + '?outro=frames');
  await p.waitForFunction(() => window.__film && window.__film.ready, null, { timeout: 20000 });
  assert(await p.evaluate(() => window.__film.length) === 15, 'the outro is 15 seconds long');
  assert(/CFO approval/.test(await p.locator('.outro-card').first().innerText()), 'the outro films what Taylor is waiting on, including Dana’s CFO approval');
  assert(/Intro call: Jamie Ortega/.test(await p.locator('.outro-card').nth(1).innerText()), 'and the 9:15 call booked that morning on today’s calendar');
  await at(2);
  const w1 = await p.locator('.outro-card').first().locator('.tc-list li').nth(2).evaluate((el) => el.style.transform);
  await at(5);
  const w2 = await p.locator('.outro-card').first().locator('.tc-list li').nth(2).evaluate((el) => el.style.transform);
  assert(w1 !== w2 && /translateZ\(0/.test(w2), `its rows settle from depth too (${w1} → ${w2})`);
  await at(13.6);
  assert(Number(await p.locator('.outro-line').evaluate((el) => getComputedStyle(el).opacity)) > 0.9 && /Never drop a ball/.test(await p.locator('.outro-line').innerText()) && /Connect your Gmail/.test(await p.locator('.outro-cta').innerText()), 'it ends on “Never drop a ball.” and Connect your Gmail');
  await at(15);
  assert(Number(await p.locator('.intro-fade').evaluate((el) => getComputedStyle(el).opacity)) > 0.95, 'and fades to black');

  await p.goto(BASE);
  await p.waitForTimeout(800);
  assert(await p.evaluate((KEY) => localStorage.getItem(KEY), KEY) === before, 'your saved demo data is untouched by both films');

  // ?intro plays on its own and offers the story at the end.
  await p.goto(BASE + '?intro');
  await p.waitForSelector('.intro-end a:has-text("Watch the story")', { timeout: 30000 });
  assert(true, '?intro plays through and offers Watch the story');

  // The story's voiceover-sync mode: no controls, and the voice's start time is published.
  await p.goto(BASE + '?story=play&sync=vo');
  await p.waitForFunction(() => window.__storyVoiceAt, null, { timeout: 15000 });
  await p.waitForSelector('.story-caption', { timeout: 8000 });
  await p.waitForTimeout(500);
  assert(/Taylor opens the laptop/.test(await p.locator('.story-caption').innerText()) && await p.locator('.story-controls').count() === 0, 'sync mode starts scene 1 with the voice, without controls');
  await p.keyboard.press('Escape');

  assert(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
