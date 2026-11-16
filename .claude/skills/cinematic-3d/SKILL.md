---
name: cinematic-3d
description: Turn a React app's real UI into a cinematic 3D product film (an intro, an outro, a launch teaser or a feature shot) with tilted surfaces floating in a dark void, a moving camera, depth of field, cascading entrances, cut to a music track, and rendered frame by frame to a 30 fps MP4. Use this whenever someone wants a cinematic or 3D intro or outro, an Apple-style or "YouTube intro"-style product mockup animation, a launch video built from their own app, 3D perspective mockups of their dashboard, or UI animation synced to music or a voiceover, even if they never say "3D" or name this skill.
---

# Cinematic 3D films of a real UI

You film the app's own React components, not screenshots: they stay crisp at any zoom, show real data and states, and can be clicked mid-shot. Everything is plain CSS 3D. A stage with `perspective`, a rig with `transform-style: preserve-3d` whose transform is the camera, and surfaces placed in world space. The film is a pure function of time, so it plays live in the browser and renders frame-exact to video.

The engine is `assets/engine.ts` (in the Timmy repo it lives at `src/cinema/engine.ts`). Copy it into the project if it isn't there. Complete worked examples: Timmy's `src/intro/Intro.tsx` (17 s intro) and `src/intro/Outro.tsx` (15 s outro).

## What makes it look cinematic

These rules come from real iterations. Each one fixed something that looked cheap.

1. **The camera moves; the UI stays put.** Moving the UI around a fixed camera looks like a cartoon. Animate the rig (`camera(look, dolly, rx, ry, rz)`): look at a point, dolly in or out, and tilt. Use one continuous move per shot.
2. **Depth of field is the effect.** Blur each layer by its distance from the focus depth (`depthBlur`), and add the lens: two masked backdrop blurs, sharp around the centre of the frame (`setLens`). Focus is locked to the camera, not to an element. Rack it by animating the focus depth, never by toggling blur on and off.
3. **One motion curve.** Slow start, quick middle, long flat landing, no overshoot (`ease`, a `bezier(0.65, 0, 0.25, 1)`). Make moves slower than feels natural; about half the speed of a UI transition is right. Bounces and linear moves read as cheap.
4. **Entrances cascade from depth.** Rows arrive from toward the camera and settle onto their surface one after another, each starting a little further out and a little later: a staircase that shrinks onto the plane. Lifted rows need their own background, or only the text flies in.
5. **Parallax needs a background.** Put the whole app behind as a plane (blurred, about 300 px back), and float a few real pieces in front of it, overlapping it. Nothing should hang over empty void unless the shot is the reveal.
6. **Compose each frame.** One subject per shot, three shots in about 15 s. Aim a little off the subject so it fills the frame: if a button is the target, look up and left of it so the card is in shot too. Tilts of 15–28° on X and Y and 3–10° on Z. Change the tilt's direction between shots.
7. **Make one micro-interaction real.** The cursor presses a real button, and the real result (a toast, a changed number) rises in front. Capture the component's props before the click (`useState` initialiser), so it doesn't vanish when its state changes.
8. **Cut to the music.** The music sets the clock: start camera moves on drops, land clicks and titles on hits, and cut in the gaps. Analyse the track first (below).
9. **End cleanly.** Rack focus to a title over the defocused, dimmed world, then fade to black, so the film cuts into whatever follows.
10. **No gimmicks.** No spins, flips over about 30°, zoom punches, or 60 fps hyper-smoothness. Render at 30 fps.

## Workflow

### 1. Plan shots against the music

Run the analysis on the track:

```bash
python3 scripts/analyze_music.py path/to/track.mp3
```

It prints the tempo, beat times, a key guess, a loudness map in 0.5 s steps, and the strongest hits. From these, write a cue sheet before any code. Find the drop (a jump of 6 dB or more), the hits, near-silent gaps (good for a breath before the title), and a gap at the length you want (the cut point). Use a quiet stretch at the start for the opening shot. Example from Timmy's intro: drop at 7.4 s → the camera swings to the decision card; hit at 10.45 s → the click; silence at 13.5–14.1 s, then a hit at 14.12 s → the title; gap at 16.9 s → cut.

To sync to a voiceover instead, get line timestamps locally with `python3 scripts/transcribe.py voice.mp3 out.json` (faster-whisper; the audio never leaves the machine). Use each line's start as its scene's start.

Write the shot list as: time range, subject (which real component), camera move, focus, and the music cue it lands on.

### 2. Build the film route

- **A route that renders the film:** e.g. `?intro`, with `?intro=frames` for seek mode. Mount it inside the app's providers, on an ephemeral store: seed data, nothing persisted. Filming must never touch the user's saved data.
- **Surfaces:** the whole app shell is the background plane (`.intro-plane`, 1440×900). Two or three real components float in front. Export small wrappers for pieces buried inside pages (e.g. `UrgentNow`, `WaitingNow`).
- **Set the scene up before filming:** if the shot should show the result of earlier work (booked meetings, sent mail), dispatch those actions on mount, then measure.
- **`setup()`:** after fonts load, query the rows to cascade and measure anchors with `worldOf(child, surfaceRoot, surfacePosition)`, so the camera can aim at a real button, title or row.
- **`render(t)`:** sets styles directly through refs (no React state per frame), from `kf(t, [[time, value], …])` tracks. Write it in this order: camera, focus and defocus, the plane, each surface and its rows, the cursor and click, the lens radius, then the title, dim and fade.
- **`useFilm(length, frames, setup, render)`:** plays live, or exposes `window.__film.seek(t)` in frames mode, and fits the 1440×900 frame to the window.

The skeleton:

```tsx
const PLANE: P = { x: 140, y: 60, z: -320 };   // the app, behind
const CARD: P = { x: 420, y: 300, z: 150 };     // a real component, floating in front
function render(t: number) {
  const look = { x: kf(t, [[0, CARD.x - 140], [6, CARD.x]]), y: kf(t, [[0, CARD.y - 60], [6, CARD.y]]), z: CARD.z };
  rig.current!.style.transform = camera(look, kf(t, [[0, 430], [6, 360]]), kf(t, [[0, 26], [6, 20]]), kf(t, [[0, -24], [6, -18]]), kf(t, [[0, 7], [6, 5]]));
  const focus = CARD.z;
  plane.current!.style.transform = place(PLANE);
  plane.current!.style.filter = blur(depthBlur(PLANE.z, focus));
  card.current!.style.transform = place(CARD, kf(t, [[0.5, 240], [2.1, 0]]));  // rises in from depth
  setLens(lensA.current, lensB.current, kf(t, [[0, 320], [6, 360]]));
  fade.current!.style.opacity = String(kf(t, [[0, 1], [0.8, 0]]));
}
```

The CSS needs a dark radial "void" background, `perspective: 1500px` on the stage, `preserve-3d` on the rig and on any surface whose children move in depth, and `color: var(--text)` on the layers. Copy `.intro*` from Timmy's `src/styles/intro.css`.

### 3. Check stills before rendering everything

```bash
FILM=intro STILLS=1.6,5.6,9.7,13.4,15.6 node scripts/render_film.cjs
```

Open every still and check:
- The subject fills the frame and nothing important is cut off at the edge.
- Nothing floats over empty void except in the reveal.
- The focused text is sharp, and the far things are softer.
- No text is invisible (inherited colour) or reduced to floating text with no background.
- The pull-back reveal is sharp for a beat before the title.

Fix, then re-check. It usually takes two or three passes.

### 4. Render and encode

```bash
FILM=intro OUT=out/intro node scripts/render_film.cjs
bash scripts/encode.sh out/intro/frames out/intro.mp4 track.mp3 0 16.9
```

`encode.sh` encodes 30 fps H.264, trims the music from its start time to the film's length, fades it out over the last 0.45 s, and normalises it to −14 LUFS with peaks no higher than −1 dBTP. A 17 s film takes a few minutes to render (about 0.5 s a frame). Run it in the background and review something else meanwhile.

### 5. Test it

Seek to known times and assert on the result:
- It opens from black.
- The rig's transform contains `rotateX` and `translateZ`.
- A row's `translateZ` is large mid-cascade and 0 once landed.
- The background has a `blur(`.
- The micro-interaction really happened (its toast text appears).
- The title's opacity is near 1 at the end.
- The last frame is black.
- The user's saved data is unchanged.

Timmy's `e2e/e2e-intro.cjs` is a template.

## Pitfalls

- **`preserve-3d` is flattened** by `overflow` other than visible, `filter`, `opacity` below 1, and `mix-blend-mode` on any element between the rig and the moving layer. Put blur and opacity on leaves (rows). Put them on a surface only once its rows have landed, when flattening no longer shows.
- **Inherited colour:** a light `color` on the film root turns unstyled UI text white on white. Set `color: var(--text)` on the layers.
- **`position: fixed` children** (toasts, menus) live inside the transformed plane. Hide them (`.intro-plane .toasts`) or use them on purpose.
- **Layouts sized with `100vh`/`100dvh`** need an explicit height inside the plane.
- **Blur cost:** stacking many CSS blurs drops live playback toward 10 fps. Keep the lens to two layers and set filters only when they change. Frame rendering is exact whatever the live frame rate.
- **Frames mode:** nothing may run on timers. Derive everything from `t`. Fire side effects (the click) once, when `t` first passes their time.
- **Measure after fonts load** (`document.fonts.ready`). Measure with offsets, not `getBoundingClientRect`, because rects are already transformed. Use rects only to place screen-space things like the cursor.

## Files

- `assets/engine.ts`: `bezier`, `ease`, `kf`, `place`, `camera`, `depthBlur`, `blur`, `setLens`, `centreIn`, `worldOf`, `useFilm`.
- `scripts/analyze_music.py`: tempo, beats, key, loudness map and hits (librosa).
- `scripts/transcribe.py`: local voiceover timestamps (faster-whisper).
- `scripts/render_film.cjs`: Playwright; stills or every frame of `?<film>=frames`.
- `scripts/encode.sh`: frames and music to MP4.
