# Storyboard: "Your inbox decides your day" (v2, Demo2Win)

The board (beat sheet, shot cards, sound plan, truth notes, feature coverage, styleframes and the
animatic) is on the private review page the owner approves before the master renders. This file
records how to rebuild it. The script is `docs/film-script-v2.md`.

- **Runtime:** about 2:01. Walkthrough 113.9 s (`?film`), then the 3D close 7.35 s (`?intro&close&from=11.05`).
- **Structure:** a problem card with no app (0:00), the app swings in at "This is Timmy" (0:14.8), six
  parts each told on a card, shown with real clicks and recapped, then a dark recap card and the 3D close,
  whose title lands on the music's final hit with "Timmy, never drop a ball."
- **Master:** 1920×1080 at 60 fps. Animatic 960×540 at 30 fps.
- **Timing:** every beat starts on the word that introduces it (`vo_words.json`). A new take re-times the film by swapping that file.
- **Render from a static build, not the dev server.** Hot reload would restart the page mid-capture if a
  file changes: `npx vite build --outDir <dir> && npx vite preview --outDir <dir> --port 5175`, then pass
  `BASE=http://localhost:5175/` to the recorders.
- **Styleframes:** `STILLS=<t,…> node scripts/film/render.cjs`
- **Frames:** `FPS=30 SCALE=0.5 OUT=… node scripts/film/render.cjs` (the animatic), or `FPS=60 SCALE=1 FORMAT=png` (the master).
  The close is rendered from `?intro=frames&close&from=11.05` with `window.__film.seek(t)`.
- **Sound:** `python3 scripts/film/mix.py --voice … --bed … --bass … --out film.wav --walk 113.9 --close 7.35` (−14 LUFS, true peak ≤ −1 dBTP).
- **Captions:** `python3 scripts/film/srt.py src/film/vo_words.json film.srt` (the voice starts at 0).

Truth notes: every screen is the product's own UI on the demo data, and every click shown is a real
click causing its result. Demo mode sends nothing, and the Gmail and Drive connections aren't live yet,
so the film is a pre-release recreation. No vendor names beyond Gmail, Google Drive and the form sources the
product lists; the leads' data partner shows as "your data provider" on the film route. The narration
names HubSpot as a form source, but Speed to lead's forms are the website form, Typeform, Facebook Lead
Ads and a webhook (HubSpot connects as a CRM): the owner decides how to resolve it.
