// Renders the product film (?film) frame by frame, with real input.
//
// The page clock is stepped one frame at a time (Playwright's clock), so timers, toasts
// and Ask Timmy's answer run on film time. Each frame, the director (src/film/Film.tsx)
// says where the mouse is and what to click, press and type; this script does it for
// real, so hover states, clicks and typing are the product's own.
//
//   STILLS=8.3,30.2 node scripts/film/render.cjs           stills at those times (stepped at STEP fps)
//   FILM=inbox ...                                           a feature film (src/film/features) instead
//   FPS=30 SCALE=0.5 OUT=out/animatic node ...render.cjs   every frame, as JPEGs for ffmpeg
//   FPS=60 SCALE=1 OUT=out/master FORMAT=png node ...      the master's frames
//   FPS=60 SCALE=1 PIPE=out/master-walk.mov node ...       the master, streamed into ffmpeg (no frames on disk):
//                                                          PNG frames, encoded as near-lossless H.264 (CRF 10)
// Render from a static build (vite build + vite preview, then BASE=…): the dev server's hot reload
// would restart the page mid-capture if a file changed.
const { chromium } = require('playwright');
const fs = require('fs');
const { spawn } = require('child_process');
const BASE = process.env.BASE || 'http://localhost:5173/';
const OUT = process.env.OUT || 'out/film';
const STILLS = process.env.STILLS ? process.env.STILLS.split(',').map(Number) : null;
const FPS = Number(process.env.FPS || (STILLS ? process.env.STEP || 15 : 30));
const SCALE = Number(process.env.SCALE || 1);
const FORMAT = process.env.FORMAT || 'jpeg';
const UNTIL = process.env.UNTIL ? Number(process.env.UNTIL) : Infinity;
const PIPE = process.env.PIPE || null;
// FILM=<id> renders that feature's 30-second film (src/film/features); without it, the product film.
const FILM = process.env.FILM || '';

(async () => {
  if (!PIPE) fs.mkdirSync(OUT + (STILLS ? '' : '/frames'), { recursive: true });
  const enc = PIPE
    ? spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '10', '-pix_fmt', 'yuv420p', '-r', String(FPS), PIPE], { stdio: ['pipe', 'inherit', 'inherit'] })
    : null;
  const encDone = enc ? new Promise((r) => enc.on('close', r)) : null;
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: SCALE, colorScheme: 'light' });
  const p = await ctx.newPage();
  const warnings = [];
  p.on('console', (m) => m.type() === 'warning' && /\[film\]/.test(m.text()) && warnings.push(m.text()));
  p.on('pageerror', (e) => warnings.push('pageerror: ' + e.message));
  await p.clock.install({ time: new Date('2026-11-16T08:12:00') });
  await p.goto(BASE + (FILM ? `?film=${FILM}` : '?film'));
  await p.waitForFunction(() => window.__film && window.__film.ready, null, { timeout: 30000 });
  await p.clock.pauseAt(new Date('2026-11-16T08:12:30'));
  await p.waitForTimeout(600);
  const length = Math.min(UNTIL, await p.evaluate(() => window.__film.length));
  const frames = Math.ceil(length * FPS);
  const want = STILLS ? new Set(STILLS.map((s) => Math.round(s * FPS))) : null;
  const t0 = Date.now();
  for (let i = 0; i <= frames; i++) {
    const t = i / FPS;
    if (i > 0) await p.clock.runFor(1000 / FPS);
    const f = await p.evaluate((t) => window.__film.frame(t), t);
    if (f.mouse) await p.mouse.move(f.mouse.x, f.mouse.y);
    if (f.dragDown) await p.mouse.down();
    if (f.dragUp) await p.mouse.up();
    for (const pr of f.presses) {
      await p.mouse.move(pr.x, pr.y);
      await p.mouse.down();
      await p.mouse.up();
    }
    for (const k of f.keys) await p.keyboard.press(k);
    if (f.text) await p.keyboard.type(f.text);
    // An embedded full editor downloads in real time: hold the film clock until it has opened, so a
    // fast render never films its loading screen.
    if (await p.$('.craft-overlay')) {
      const held = Date.now();
      await p.waitForFunction(() => !document.querySelector('.craft-overlay'), null, { timeout: 15000, polling: 100 }).catch(() => warnings.push(`[film] the full editor was still opening at ${t.toFixed(2)}`));
      if (Date.now() - held > 50) console.log(`held ${Date.now() - held} ms at ${t.toFixed(2)} for the full editor`);
    }
    if (want && !want.has(i)) continue;
    // Let React commit what this frame's input changed, then draw the overlays for it.
    if (f.presses.length || f.keys.length || f.text) await p.evaluate((t) => window.__film.frame(t), t);
    if (enc) {
      const png = await p.screenshot();
      if (!enc.stdin.write(png)) await new Promise((r) => enc.stdin.once('drain', r));
    } else {
      const name = STILLS ? `${OUT}/still-${t.toFixed(2).replace('.', '_')}.png` : `${OUT}/frames/f${String(i).padStart(5, '0')}.${FORMAT === 'png' ? 'png' : 'jpg'}`;
      await p.screenshot(STILLS || FORMAT === 'png' ? { path: name } : { path: name, type: 'jpeg', quality: 92 });
    }
    if (!STILLS && i % 300 === 0) console.log(`frame ${i}/${frames} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  if (enc) {
    enc.stdin.end();
    await encDone;
  }
  console.log(`done: ${STILLS ? STILLS.length + ' stills' : frames + 1 + ' frames'} in ${Math.round((Date.now() - t0) / 1000)}s`);
  if (warnings.length) console.log('warnings:\n  ' + [...new Set(warnings)].join('\n  '));
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
