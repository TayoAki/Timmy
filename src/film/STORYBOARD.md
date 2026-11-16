# Storyboard: "Monday, 8:12" (v1)

The board (beat sheet, shot cards, sound plan, truth notes, feature coverage, styleframes and the
animatic) is on the private review page the owner approves before the master renders. This file
records how to rebuild it.

- **Runtime:** about 3:51. Cold open 13.6 s (`?outro&open`), walkthrough 201.6 s (`?film`), close 16.2 s (`?intro&close`).
- **Master:** 1920×1080 at 60 fps. Animatic 960×540 at 30 fps.
- **Timing:** every beat starts on the word that introduces it (`vo_words.json`). A new take re-times the film by swapping that file.
- **Styleframes:** `STILLS=<t,…> node scripts/film/render.cjs`
- **Frames:** `FPS=30 SCALE=0.5 OUT=… node scripts/film/render.cjs` (the animatic), or `FPS=60 SCALE=1 FORMAT=png` (the master).
- **Sound:** `python3 scripts/film/mix.py --voice … --bed … --bass … --out film.wav` (−14 LUFS, true peak ≤ −1 dBTP).
- **Captions:** `python3 scripts/film/srt.py src/film/vo_words.json film.srt --offset 13.6`

Truth notes: every screen is the product's own UI on the demo data, and every click shown is a real
click causing its result. Demo mode sends nothing, and the Gmail connection isn't live yet, so the film is a
pre-release recreation. No vendor names beyond Gmail.
