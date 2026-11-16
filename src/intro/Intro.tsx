/*
 * The cinematic intro (?intro): the real Timmy UI filmed in 3D, about 17 seconds.
 *   1. The "Needs you today" list settles onto the tilted brief, row by row,
 *      like a staircase, while the camera travels down it.
 *   2. The camera swings to the $58 decision floating above the app; the
 *      cursor presses Keep $62 and the real confirmation rises in front.
 *   3. The camera pulls back to the whole app in the void, focus racks to the
 *      title, and it fades to black (where the story can pick up).
 *
 * How it works, with no 3D library:
 * - Every surface is a real component (the whole app, the urgent list, the
 *   approval card) placed in one CSS 3D scene. The camera is the rig's
 *   transform: the camera moves, the UI stays put.
 * - Depth of field: each layer blurs by its distance from the focus depth, and
 *   two masked backdrop blurs add a radial, progressive falloff around the
 *   centre of the frame, where the camera looks.
 * - One motion curve for everything: slow start, quick middle, long flat
 *   landing, no bounce.
 * - The film is a pure function of time. ?intro plays it; ?intro=frames waits
 *   for window.__intro.seek(t), so a 30 fps render can step frame by frame.
 * The demo data here is fresh and never saved.
 */
import { Play, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApprovalCard } from '../areas/approvals/ApprovalCard';
import { TimmyMark } from '../components/common';
import { openApprovals, type Approval } from '../state/approvals';
import { useStore } from '../state/store';
import { UrgentNow } from '../views/TodayView';
import '../styles/intro.css';

export const INTRO_LENGTH = 17;
const FRAMES = new URLSearchParams(window.location.search).get('intro') === 'frames';
const W = 1440;
const H = 900;

/* ───────────── Motion ───────────── */

function bezier(x1: number, y1: number, x2: number, y2: number) {
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
const ease = bezier(0.65, 0, 0.25, 1);

type Key = [time: number, value: number];
/** The value of a keyframed track at time t. */
const kf = (t: number, keys: Key[]) => {
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

/* ───────────── The world ───────────── */

interface P {
  x: number;
  y: number;
  z: number;
}
/** Where each surface sits in the world (the app plane lies behind the floating pieces). */
const PLANE: P = { x: 140, y: 60, z: -320 };
const URGENT: P = { x: -40, y: 0, z: 0 };
const CARD: P = { x: 420, y: 300, z: 150 };

const place = (p: P, dz = 0) => `translate(-50%, -50%) translate3d(${p.x}px, ${p.y}px, ${p.z + dz}px)`;
const depthBlur = (z: number, focus: number, extra = 0) => Math.min(9, Math.abs(z - focus) * 0.022) + extra;
const blur = (px: number) => (px < 0.15 ? 'none' : `blur(${px.toFixed(2)}px)`);

/** A child's centre in its surface's own (untransformed) layout. */
const centreIn = (el: HTMLElement, root: HTMLElement) => {
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

interface Anchors {
  title: P;
  facts: P;
  keep: P;
  toast: P;
}

export function Intro({ children }: { children: ReactNode }) {
  const { state } = useStore();
  // The decision is filmed as it was before Keep $62 is pressed.
  const [card] = useState<Approval | undefined>(() => openApprovals(state).find((a) => a.key === 'dec:acme-price'));
  const [toast, setToast] = useState('');
  const [ended, setEnded] = useState(false);
  const [scale, setScale] = useState(1);

  const frame = useRef<HTMLDivElement>(null);
  const rig = useRef<HTMLDivElement>(null);
  const plane = useRef<HTMLDivElement>(null);
  const urgent = useRef<HTMLDivElement>(null);
  const cardEl = useRef<HTMLDivElement>(null);
  const toastEl = useRef<HTMLDivElement>(null);
  const lensA = useRef<HTMLDivElement>(null);
  const lensB = useRef<HTMLDivElement>(null);
  const dim = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLDivElement>(null);
  const sub = useRef<HTMLParagraphElement>(null);
  const fade = useRef<HTMLDivElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const anchors = useRef<Anchors | null>(null);
  const rows = useRef<HTMLElement[]>([]);
  const head = useRef<HTMLElement | null>(null);
  const keepBtn = useRef<HTMLButtonElement | null>(null);
  const pressed = useRef(false);

  // Fit the 1440×900 film to the window.
  useEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / W, window.innerHeight / H));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  // The confirmation the real app showed when Keep $62 was pressed.
  useEffect(() => {
    if (!pressed.current || toast) return;
    const last = state.toasts[state.toasts.length - 1];
    if (last) setToast(last.text);
  }, [state.toasts, toast]);

  function render(t: number) {
    const a = anchors.current;
    if (!a || !rig.current || !frame.current) return;

    // Camera: what it looks at, how close it is, and the tilt.
    // Shot 2 frames each target a little up and left of centre, so the card fills the frame.
    // Cut to the music ("Bass First", 99 BPM): the swing starts on the drop at 7.4 s,
    // Keep $62 is clicked on the hit at 10.45 s, the title lands on the hit at 14.12 s
    // after a beat of silence, and the film cuts in the gap at 16.9 s.
    const lx = kf(t, [[0, URGENT.x + 140], [7.4, URGENT.x + 100], [8.8, a.title.x], [9.7, a.facts.x], [10.3, a.keep.x - 140], [10.9, a.keep.x - 140], [11.6, a.toast.x], [12.2, a.toast.x], [13.8, PLANE.x]]);
    const ly = kf(t, [[0, -60], [7.4, 170], [8.8, a.title.y + 40], [9.7, a.facts.y], [10.3, a.keep.y - 60], [10.9, a.keep.y - 60], [11.6, a.toast.y - 40], [12.2, a.toast.y - 40], [13.8, PLANE.y]]);
    const lz = kf(t, [[0, 0], [7.4, 0], [8.8, CARD.z], [12.2, CARD.z], [13.8, PLANE.z]]);
    const dolly = kf(t, [[0, 430], [7.4, 360], [8.8, 400], [12.2, 400], [13.8, -540]]);
    const rx = kf(t, [[0, 28], [7.4, 22], [8.8, 16], [12.2, 14], [13.8, 17], [16.9, 15]]);
    const ry = kf(t, [[0, -26], [7.4, -20], [8.8, 16], [12.2, 20], [13.8, 13], [16.9, 10]]);
    const rz = kf(t, [[0, 7], [7.4, 6], [8.8, -4], [12.2, -5], [13.8, -3]]);
    rig.current.style.transform = `translateZ(${dolly}px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) translate3d(${-lx}px, ${-ly}px, ${-lz}px)`;

    // Focus: the depth that's sharp, plus a defocus when the title takes over.
    const focus = kf(t, [[0, 0], [7.4, 0], [8.8, CARD.z], [12.2, CARD.z], [13.3, PLANE.z]]);
    const defocus = kf(t, [[13.6, 0], [14.6, 5]]);

    if (plane.current) {
      plane.current.style.transform = place(PLANE);
      plane.current.style.filter = blur(depthBlur(PLANE.z, focus, defocus));
    }

    // The urgent list: each row arrives from a little further out than the one before.
    if (urgent.current) {
      urgent.current.style.transform = place(URGENT);
      const settled = t > 7.4;
      urgent.current.style.filter = settled ? blur(depthBlur(URGENT.z, focus, defocus)) : 'none';
      urgent.current.style.opacity = String(kf(t, [[12.4, 1], [13.8, 0.9]]));
      if (head.current) head.current.style.opacity = String(kf(t, [[0.3, 0], [1.4, 1]]));
      rows.current.forEach((row, i) => {
        const start = 0.9 + i * 0.42;
        const z = kf(t, [[start, 200 + i * 60], [start + 1.7, 0]]);
        row.style.transform = `translateZ(${z.toFixed(1)}px)`;
        row.style.opacity = String(kf(t, [[start, 0], [start + 0.6, 1]]));
        row.style.filter = settled ? 'none' : blur(depthBlur(URGENT.z + z, focus));
        row.style.boxShadow = z > 1 ? `0 ${(z * 0.08).toFixed(1)}px ${(z * 0.16).toFixed(1)}px rgba(0, 0, 0, ${Math.min(0.28, z / 900).toFixed(3)})` : 'none';
      });
    }

    // The decision rises toward the camera as the camera swings to it.
    if (cardEl.current) {
      const dz = kf(t, [[7.3, 240], [8.9, 0]]);
      cardEl.current.style.transform = place(CARD, dz);
      cardEl.current.style.opacity = String(kf(t, [[7.3, 0], [8.1, 1], [12.6, 1], [13.8, 0.9]]));
      cardEl.current.style.filter = blur(depthBlur(CARD.z + dz, focus, defocus));
    }

    // The micro-interaction: the cursor presses Keep $62 for real.
    if (keepBtn.current) {
      keepBtn.current.classList.toggle('intro-press', t >= 10.3 && t < 10.62);
      if (t >= 10.45 && !pressed.current) {
        pressed.current = true;
        keepBtn.current.click();
      }
    }
    if (cursor.current && keepBtn.current) {
      const fr = frame.current.getBoundingClientRect();
      const br = keepBtn.current.getBoundingClientRect();
      const s = fr.width / W;
      const bx = (br.left + br.width / 2 - fr.left) / s;
      const by = (br.top + br.height / 2 - fr.top) / s;
      const p = kf(t, [[9.5, 0], [10.35, 1]]);
      cursor.current.style.transform = `translate(${bx + 240 * (1 - p)}px, ${by + 170 * (1 - p)}px)`;
      cursor.current.style.opacity = String(kf(t, [[9.5, 0], [9.8, 1], [11.0, 1], [11.4, 0]]));
      cursor.current.classList.toggle('click', t >= 10.3 && t < 10.8);
    }

    if (toastEl.current) {
      const dz = kf(t, [[10.55, 200], [11.5, 0]]);
      toastEl.current.style.transform = place(a.toast, dz);
      toastEl.current.style.opacity = String(kf(t, [[10.55, 0], [11.1, 1], [12.1, 1], [13.1, 0]]));
      toastEl.current.style.filter = blur(depthBlur(a.toast.z + dz, focus, defocus));
    }

    // The lens: sharp in the middle of the frame, softer toward the edges.
    const r = kf(t, [[0, 320], [7.4, 360], [8.8, 320], [12.2, 320], [13.3, 1000]]);
    const mask = (inner: number, outer: number) => `radial-gradient(circle at 50% 50%, transparent ${inner}px, #000 ${outer}px)`;
    for (const [el, i, o] of [[lensA.current, r, r * 1.5], [lensB.current, r * 1.35, r * 2.2]] as const) {
      if (!el) continue;
      el.style.maskImage = mask(i, o);
      el.style.webkitMaskImage = mask(i, o);
    }

    // The title racks into focus as the world falls back.
    if (dim.current) dim.current.style.opacity = String(kf(t, [[13.6, 0], [14.6, 0.5]]));
    if (title.current) {
      title.current.style.opacity = String(kf(t, [[13.95, 0], [14.35, 1]]));
      title.current.style.filter = blur(kf(t, [[13.95, 14], [14.6, 0]]));
      title.current.style.transform = `translateY(-60%) scale(${kf(t, [[13.95, 1.06], [16.2, 1]]).toFixed(4)})`;
    }
    if (sub.current) {
      sub.current.style.opacity = String(kf(t, [[14.6, 0], [15.4, 1]]));
      sub.current.style.transform = `translateY(${kf(t, [[14.6, 10], [15.4, 0]]).toFixed(2)}px)`;
    }
    if (fade.current) fade.current.style.opacity = String(kf(t, [[0, 1], [0.9, 0], [16.3, 0], [16.9, 1]]));
  }

  // Measure where things are inside the surfaces, then play (or wait for seek).
  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    const setup = async () => {
      await document.fonts?.ready;
      await new Promise((r) => window.setTimeout(r, 400));
      if (cancelled || !cardEl.current || !urgent.current) return;
      rows.current = [...urgent.current.querySelectorAll<HTMLElement>('.urg-row')];
      head.current = urgent.current.querySelector<HTMLElement>('.section-head');
      const root = cardEl.current;
      const at = (el: HTMLElement | null, fallback: { x: number; y: number }) => {
        const c = el ? centreIn(el, root) : fallback;
        return { x: CARD.x - root.offsetWidth / 2 + c.x, y: CARD.y - root.offsetHeight / 2 + c.y, z: CARD.z };
      };
      keepBtn.current = [...root.querySelectorAll<HTMLButtonElement>('.ap-actions button')].find((b) => /^Keep \$62$/.test(b.textContent?.trim() ?? '')) ?? null;
      const keep = at(keepBtn.current, { x: root.offsetWidth - 150, y: root.offsetHeight - 30 });
      anchors.current = {
        title: at(root.querySelector('.ap-title'), { x: root.offsetWidth / 2, y: 40 }),
        facts: at(root.querySelector('.ap-facts'), { x: root.offsetWidth / 2, y: root.offsetHeight / 2 }),
        keep,
        toast: { x: keep.x - 160, y: keep.y + 96, z: CARD.z + 70 },
      };
      render(0);
      const api = { seek: (t: number) => render(t), length: INTRO_LENGTH, ready: true };
      (window as unknown as { __intro: typeof api }).__intro = api;
      if (FRAMES) return;
      const start = performance.now();
      const loop = () => {
        const t = (performance.now() - start) / 1000;
        render(Math.min(t, INTRO_LENGTH));
        if (t < INTRO_LENGTH) raf = window.requestAnimationFrame(loop);
        else setEnded(true);
      };
      raf = window.requestAnimationFrame(loop);
    };
    void setup();
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="intro" aria-label="Timmy, a cinematic intro">
      <div className="intro-frame" ref={frame} style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
        <div className="intro-stage" aria-hidden>
          <div className="intro-rig" ref={rig}>
            <div className="intro-layer intro-plane" ref={plane}>
              {children}
            </div>
            <div className="intro-layer intro-urgent" ref={urgent}>
              <UrgentNow limit={5} />
            </div>
            {card && (
              <div className="intro-layer intro-card" ref={cardEl}>
                <ApprovalCard a={card} />
              </div>
            )}
            <div className="intro-layer intro-toast-layer" ref={toastEl}>
              {toast && <div className="toast intro-toast">{toast}</div>}
            </div>
          </div>
        </div>
        <div className="intro-lens a" ref={lensA} />
        <div className="intro-lens b" ref={lensB} />
        <div className="intro-cursor" ref={cursor} aria-hidden>
          <svg width="26" height="26" viewBox="0 0 24 24">
            <path d="M4 2.5 19.5 12l-7 1.6L9 20.5z" fill="#fff" stroke="#1c1b19" strokeWidth="1.6" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="intro-dim" ref={dim} />
        <div className="intro-title" ref={title}>
          <h1 className="intro-word">
            <TimmyMark size={104} />
            Timmy
          </h1>
          <p className="intro-sub" ref={sub}>
            Monday, 8:12
          </p>
        </div>
        <div className="intro-fade" ref={fade} />
      </div>
      {ended && !FRAMES && (
        <div className="intro-end">
          <a className="btn btn-primary" href={`${window.location.pathname}?story`}>
            <Play size={15} />
            Watch the story
          </a>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            <RotateCcw size={15} />
            Replay
          </button>
        </div>
      )}
    </div>
  );
}
