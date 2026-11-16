// Renders a film route frame by frame with Playwright.
//   FILM=intro STILLS=1.6,5.6,9.7 node render_film.cjs      -> OUT/still-<t>.png
//   FILM=intro OUT=out/intro FPS=30 node render_film.cjs    -> OUT/frames/f00000.png ...
// Needs the dev server (BASE, default http://localhost:5173/) and a route that waits for
// window.__film.seek(t) when opened with ?<FILM>=frames (see assets/engine.ts, useFilm).
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = process.env.BASE || 'http://localhost:5173/';
const FILM = process.env.FILM || 'intro';
const OUT = process.env.OUT || `out/${FILM}`;
const FPS = Number(process.env.FPS || 30);
const STILLS = process.env.STILLS ? process.env.STILLS.split(',').map(Number) : null;
(async () => {
  fs.mkdirSync(OUT + '/frames', { recursive: true });
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: process.env.SCHEME || 'light' });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${BASE}?${FILM}=frames`);
  await p.waitForFunction(() => window.__film && window.__film.ready, null, { timeout: 30000 });
  const length = await p.evaluate(() => window.__film.length);
  const times = STILLS ?? Array.from({ length: Math.round(length * FPS) + 1 }, (_, i) => i / FPS);
  const t0 = Date.now();
  for (let i = 0; i < times.length; i++) {
    await p.evaluate((t) => window.__film.seek(t), times[i]);
    // Let React paint anything the frame changed (e.g. a toast after a click).
    await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const name = STILLS ? `${OUT}/still-${String(times[i]).replace('.', '_')}.png` : `${OUT}/frames/f${String(i).padStart(5, '0')}.png`;
    await p.screenshot({ path: name });
    if (!STILLS && i % 60 === 0) console.log(`frame ${i}/${times.length} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  console.log('done', times.length, 'frames; errors:', errors.length ? errors.join(' | ') : 'none');
  await b.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
