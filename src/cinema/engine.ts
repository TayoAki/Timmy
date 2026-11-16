/*
 * A small engine for cinematic 3D films of the real UI, in plain CSS 3D (no
 * 3D library). Used by the intro (src/intro/Intro.tsx) and the outro
 * (src/intro/Outro.tsx); the how-to is .claude/skills/cinematic-3d/SKILL.md.
 *
 * The model:
 * - A stage with `perspective`, a rig with `transform-style: preserve-3d`
 *   whose transform IS the camera, and surfaces placed in world space.
 *   The camera moves; the UI stays where it is.
 * - Depth of field: a layer blurs by its distance from the focus depth
 *   (depthBlur), plus a masked backdrop blur centred on the frame (the lens).
 * - Every move uses one curve: slow start, quick middle, long flat landing.
 * - A film is a pure function of time, so it can be played in real time or
 *   sought frame by frame (window.__film.seek(t)) for a 30 fps render.
 */
import { useEffect, useRef, useState } from 'react';

export function bezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      const d = dx(t);
      if (Math.abs(e) < 1e-5 || Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    return sy(Math.min(1, Math.max(0, t)));
  };
}

/** Slow start, quick middle, a long flat landing, and no overshoot. */
export const ease = bezier(0.65, 0, 0.25, 1);

export type Key = [time: number, value: number];
/** The value of a keyframed track at time t (held before the first key and after the last). */
export const kf = (t: number, keys: Key[]) => {
  if (t <= keys[0]![0]) return keys[0]![1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i]!;
    if (t <= t1) {
      const [t0, v0] = keys[i - 1]!;
      return v0 + (v1 - v0) * ease((t - t0) / (t1 - t0 || 1));
    }
  }
  return keys[keys.length - 1]![1];
};

/** A point in the world: x right, y down, z toward the camera. */
export interface P {
  x: number;
  y: number;
  z: number;
}

/** Centres a surface on a world point (surfaces sit at left/top 50% of the stage). */
export const place = (p: P, dz = 0) => `translate(-50%, -50%) translate3d(${p.x}px, ${p.y}px, ${p.z + dz}px)`;

/** The camera: look at a point, from `dolly` px closer, tilted by rx/ry/rz degrees. */
export const camera = (look: P, dolly: number, rx: number, ry: number, rz: number) =>
  `translateZ(${dolly}px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) translate3d(${-look.x}px, ${-look.y}px, ${-look.z}px)`;

/** Blur for a layer at depth z when `focus` is the sharp depth; `extra` defocuses everything. */
export const depthBlur = (z: number, focus: number, extra = 0) => Math.min(9, Math.abs(z - focus) * 0.022) + extra;
export const blur = (px: number) => (px < 0.15 ? 'none' : `blur(${px.toFixed(2)}px)`);

/** The lens: masked backdrop blurs, sharp within `r` px of the frame's centre. */
export const lensMask = (inner: number, outer: number) => `radial-gradient(circle at 50% 50%, transparent ${inner}px, #000 ${outer}px)`;
export function setLens(a: HTMLElement | null, b: HTMLElement | null, r: number) {
  for (const [el, i, o] of [[a, r, r * 1.5], [b, r * 1.35, r * 2.2]] as const) {
    if (!el) continue;
    el.style.maskImage = lensMask(i, o);
    el.style.webkitMaskImage = lensMask(i, o);
  }
}

/** A child's centre in its surface's own (untransformed) layout, for aiming the camera at it. */
export const centreIn = (el: HTMLElement, root: HTMLElement) => {
  let x = 0;
  let y = 0;
  let n: HTMLElement | null = el;
  while (n && n !== root) {
    x += n.offsetLeft;
    y += n.offsetTop;
    n = n.offsetParent as HTMLElement | null;
  }
  return { x: x + el.offsetWidth / 2, y: y + el.offsetHeight / 2 };
};

/** A point inside a surface placed at `at`, in world space. */
export const worldOf = (el: HTMLElement | null, root: HTMLElement, at: P, fallback = { x: 0.5, y: 0.5 }): P => {
  const c = el ? centreIn(el, root) : { x: root.offsetWidth * fallback.x, y: root.offsetHeight * fallback.y };
  return { x: at.x - root.offsetWidth / 2 + c.x, y: at.y - root.offsetHeight / 2 + c.y, z: at.z };
};

/** The frame the films are composed for; it scales to fit the window. */
export const FILM_W = 1440;
export const FILM_H = 900;

/**
 * Plays a film: waits for fonts and layout, calls `setup` (measure anchors),
 * then plays in real time, or, in frames mode, waits for window.__film.seek(t).
 */
/** `cover` fills a frame of another shape (16:9 for the product film), cropping the 16:10 film's edges instead of showing them. */
export function useFilm(length: number, frames: boolean, setup: () => void, render: (t: number) => void, cover = false) {
  const [ended, setEnded] = useState(false);
  const [scale, setScale] = useState(1);
  const renderRef = useRef(render);
  renderRef.current = render;
  const setupRef = useRef(setup);
  setupRef.current = setup;

  useEffect(() => {
    const fit = () => setScale((cover ? Math.max : Math.min)(window.innerWidth / FILM_W, window.innerHeight / FILM_H));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [cover]);

  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    const go = async () => {
      await document.fonts?.ready;
      await new Promise((r) => window.setTimeout(r, 400));
      if (cancelled) return;
      setupRef.current();
      renderRef.current(0);
      const api = { seek: (t: number) => renderRef.current(t), length, ready: true };
      (window as unknown as { __film: typeof api }).__film = api;
      if (frames) return;
      const start = performance.now();
      const loop = () => {
        const t = (performance.now() - start) / 1000;
        renderRef.current(Math.min(t, length));
        if (t < length) raf = window.requestAnimationFrame(loop);
        else setEnded(true);
      };
      raf = window.requestAnimationFrame(loop);
    };
    void go();
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
    };
  }, [length, frames]);

  return { ended, scale };
}
