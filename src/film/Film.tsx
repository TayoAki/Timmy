/*
 * The product film's director (?film): the real app inside one virtual camera,
 * with a cursor, a dim layer and kinetic type drawn on top.
 *
 * Every frame is a function of time. window.__film.frame(t) applies the camera,
 * dim, cards and cursor for time t, and returns what the recorder must do for
 * real at this frame: where the mouse is (so hover states are real), which
 * clicks land, which keys are pressed and what is typed. The recorder
 * (scripts/film/render.cjs) steps the page clock one frame at a time, so
 * timers, toasts and Ask Timmy's answer run on film time.
 *
 * Demo data only, never saved (the store is ephemeral on this route).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { bezier } from '../cinema/engine';
import { useStore } from '../state/store';
import { walkthrough, type Card, type Target } from './script';
import '../styles/film.css';

const camEase = bezier(0.65, 0, 0.35, 1);
const moveEase = bezier(0.45, 0, 0.25, 1);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

interface View {
  cx: number;
  cy: number;
  s: number;
}
interface Pt {
  x: number;
  y: number;
}

export function Film({ children }: { children: ReactNode }) {
  const { dispatch } = useStore();
  const spec = useRef(walkthrough()).current;
  const camEl = useRef<HTMLDivElement>(null);
  const dimEl = useRef<HTMLDivElement>(null);
  const cardEl = useRef<HTMLDivElement>(null);
  const cursorEl = useRef<HTMLDivElement>(null);
  const [card, setCard] = useState<{ i: number; n: number } | null>(null);

  // Mutable film state: it only moves forward, one frame at a time.
  const st = useRef({
    last: -1,
    view: null as View | null,
    camSeg: -1,
    camFrom: null as View | null,
    camTo: null as View | null,
    camStart: 0,
    cursor: null as Pt | null,
    moveSeg: -1,
    moveFrom: null as Pt | null,
    scrolls: new Map<number, { el: HTMLElement; from: number; to: number }>(),
    typed: new Map<number, number>(),
    cardKey: '',
  }).current;

  // Start on the opening screen.
  useEffect(() => {
    dispatch({ type: 'navigate', route: spec.start });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const W = () => window.innerWidth;
    const H = () => window.innerHeight;
    const fit = (v: View): View => {
      const s = Math.max(1, v.s);
      const hw = W() / (2 * s);
      const hh = H() / (2 * s);
      return { s, cx: clamp(v.cx, hw, W() - hw), cy: clamp(v.cy, hh, H() - hh) };
    };
    const tx = (v: View) => ({ x: W() / 2 - v.s * v.cx, y: H() / 2 - v.s * v.cy });
    const toApp = (p: Pt, v: View): Pt => {
      const o = tx(v);
      return { x: (p.x - o.x) / v.s, y: (p.y - o.y) / v.s };
    };
    const toScreen = (p: Pt, v: View): Pt => {
      const o = tx(v);
      return { x: o.x + v.s * p.x, y: o.y + v.s * p.y };
    };
    const rectApp = (el: HTMLElement, v: View) => {
      const r = el.getBoundingClientRect();
      const a = toApp({ x: r.left, y: r.top }, v);
      return { x: a.x, y: a.y, w: r.width / v.s, h: r.height / v.s };
    };
    const find = (t: Target | null | undefined) => {
      try {
        return t ? t() : null;
      } catch {
        return null;
      }
    };

    function frame(t: number) {
      const prev = st.last;
      st.last = t;
      const view0: View = st.view ?? { cx: W() / 2, cy: H() / 2, s: 1 };

      // Cuts under a card: straight to the next screen.
      for (const c of spec.cuts) if (c.t > prev && c.t <= t) dispatch({ type: 'navigate', route: c.route });

      // Scrolls, from where the container is to where the target sits `offset` px from its top.
      spec.scrolls.forEach((sc, i) => {
        if (t < sc.t) return;
        let run = st.scrolls.get(i);
        if (!run) {
          const target = find(sc.target);
          if (!target) return;
          let el: HTMLElement | null = target.parentElement;
          while (el && !(el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
          if (!el) return;
          const delta = (target.getBoundingClientRect().top - el.getBoundingClientRect().top) / view0.s - (sc.offset ?? 0);
          run = { el, from: el.scrollTop, to: clamp(el.scrollTop + delta, 0, el.scrollHeight - el.clientHeight) };
          st.scrolls.set(i, run);
        }
        if (t <= sc.t + sc.d + 0.05) run.el.scrollTop = run.from + (run.to - run.from) * camEase(clamp((t - sc.t) / sc.d, 0, 1));
      });

      // Camera: ease from wherever it was to frame the segment's subject; then hold.
      let seg = -1;
      spec.cams.forEach((c, i) => {
        if (c.t <= t) seg = i;
      });
      let view = view0;
      if (seg >= 0) {
        const c = spec.cams[seg]!;
        if (seg !== st.camSeg) {
          st.camSeg = seg;
          st.camFrom = view0;
          st.camTo = null;
          st.camStart = Math.max(c.t, t - 1 / 60);
        }
        if (!st.camTo) {
          if (c.target === 'full') st.camTo = { cx: W() / 2, cy: H() / 2, s: 1 };
          else {
            const el = find(c.target);
            if (el) {
              const r = rectApp(el, view0);
              const z = c.zoom ?? clamp(Math.min((W() * 0.7) / r.w, (H() * 0.6) / r.h), 1, 2);
              st.camTo = fit({ cx: r.x + r.w / 2 + (c.dx ?? 0), cy: r.y + r.h / 2 + (c.dy ?? 0), s: z });
              st.camStart = Math.max(st.camStart, t - 1 / 60);
            }
          }
        }
        if (st.camTo && st.camFrom) {
          const p = camEase(clamp((t - st.camStart) / Math.max(0.01, c.d ?? 0.8), 0, 1));
          const a = st.camFrom;
          const b = st.camTo;
          const s = Math.exp(Math.log(a.s) + (Math.log(b.s) - Math.log(a.s)) * p);
          view = fit({ cx: a.cx + (b.cx - a.cx) * p, cy: a.cy + (b.cy - a.cy) * p, s });
        }
      }
      st.view = view;
      const o = tx(view);
      if (camEl.current) camEl.current.style.transform = `translate(${o.x.toFixed(2)}px, ${o.y.toFixed(2)}px) scale(${view.s.toFixed(4)})`;

      // Cursor: a bowed arc to each target, drawn in screen space at a constant size.
      let mv = -1;
      spec.moves.forEach((m, i) => {
        if (m.t <= t) mv = i;
      });
      if (!st.cursor) st.cursor = toApp({ x: W() + 40, y: H() - 60 }, view);
      if (mv >= 0) {
        const m = spec.moves[mv]!;
        if (mv !== st.moveSeg) {
          st.moveSeg = mv;
          st.moveFrom = { ...st.cursor };
        }
        let to: Pt | null = null;
        if ('edge' in (m.to as object)) {
          const e = (m.to as { edge: [number, number] }).edge;
          to = toApp({ x: (e[0] / 1920) * W(), y: (e[1] / 1080) * H() }, view);
        } else {
          const el = find(m.to as Target);
          if (el) {
            const r = rectApp(el, view);
            to = { x: r.x + r.w / 2 + (m.ox ?? 0), y: r.y + r.h / 2 + (m.oy ?? 0) };
          }
        }
        if (to && st.moveFrom) {
          const p = moveEase(clamp((t - m.t) / (m.d ?? 0.7), 0, 1));
          const a = st.moveFrom;
          const dx = to.x - a.x;
          const dy = to.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          const bow = (m.bow ?? 40) / view.s;
          const c = { x: (a.x + to.x) / 2 - (dy / len) * bow, y: (a.y + to.y) / 2 + (dx / len) * bow };
          const q = 1 - p;
          st.cursor = { x: q * q * a.x + 2 * q * p * c.x + p * p * to.x, y: q * q * a.y + 2 * q * p * c.y + p * p * to.y };
        }
      }

      // Presses due this frame: the tip goes inside the real control, and the recorder clicks it.
      const presses: Pt[] = [];
      let down = false;
      for (const p of spec.presses) {
        if (t >= p.t && t < p.t + 0.12) down = true;
        if (p.t > prev && p.t <= t) {
          const el = find(p.target);
          if (!el) {
            console.warn('[film] press target missing at', p.t);
            continue;
          }
          const r = rectApp(el, view);
          st.cursor = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
          const at = toScreen(st.cursor, view);
          if (at.x < 0 || at.y < 0 || at.x >= W() || at.y >= H()) console.warn('[film] press target off-screen at', p.t);
          presses.push(at);
        }
      }

      const sc = toScreen(st.cursor, view);
      if (cursorEl.current) {
        cursorEl.current.style.transform = `translate(${sc.x.toFixed(1)}px, ${sc.y.toFixed(1)}px)`;
        cursorEl.current.classList.toggle('down', down);
        const under = sc.x >= 0 && sc.y >= 0 && sc.x < W() && sc.y < H() ? document.elementFromPoint(sc.x, sc.y) : null;
        const hand = !!under && getComputedStyle(under).cursor === 'pointer';
        cursorEl.current.classList.toggle('hand', hand);
        cursorEl.current.classList.toggle('ibeam', !!under && !hand && /^(INPUT|TEXTAREA)$/.test(under.tagName));
      }

      // Typing at a human pace, and keys.
      let text = '';
      spec.typing.forEach((ty, i) => {
        if (t < ty.t) return;
        const n = Math.min(ty.text.length, Math.floor((t - ty.t) * (ty.cps ?? 15)) + 1);
        const had = st.typed.get(i) ?? 0;
        if (n > had) {
          text += ty.text.slice(had, n);
          st.typed.set(i, n);
        }
      });
      const keys = spec.keys.filter((k) => k.t > prev && k.t <= t).map((k) => k.key);

      // Dim everything but the subject once the camera has settled.
      let dimmed = false;
      for (const d of spec.dims) {
        if (t < d.t0 || t > d.t1) continue;
        const el = find(d.target);
        if (!el || !dimEl.current) continue;
        const r = el.getBoundingClientRect();
        const pad = d.pad ?? 10;
        const a = Math.min(clamp((t - d.t0) / 0.3, 0, 1), clamp((d.t1 - t) / 0.25, 0, 1));
        Object.assign(dimEl.current.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`, opacity: String(a) });
        dimmed = true;
        break;
      }
      if (!dimmed && dimEl.current) dimEl.current.style.opacity = '0';

      // Kinetic type: the words get the frame to themselves.
      const ci = spec.cards.findIndex((c) => t >= c.t0 && t < c.t1);
      const shown = ci >= 0 ? spec.cards[ci]!.lines.filter((l) => t >= l.t).length : 0;
      const key = ci >= 0 ? `${ci}:${shown}` : '';
      if (key !== st.cardKey) {
        st.cardKey = key;
        setCard(ci >= 0 ? { i: ci, n: shown } : null);
      }
      if (ci >= 0 && cardEl.current) {
        const c = spec.cards[ci]!;
        cardEl.current.style.opacity = String(Math.min(clamp((t - c.t0) / 0.22, 0, 1), clamp((c.t1 - t) / 0.18, 0, 1)));
        cardEl.current.querySelectorAll<HTMLElement>('[data-at]').forEach((el) => {
          const p = camEase(clamp((t - Number(el.dataset.at)) / 0.28, 0, 1));
          el.style.opacity = String(p);
          el.style.transform = `translateY(${((1 - p) * 18).toFixed(2)}px)`;
        });
      }
      const covered = ci >= 0 && Number(cardEl.current?.style.opacity ?? 0) > 0.98;
      if (cursorEl.current) cursorEl.current.style.opacity = covered ? '0' : '1';

      const onScreen = sc.x > -20 && sc.y > -20 && sc.x < W() + 20 && sc.y < H() + 20;
      return { mouse: onScreen ? { x: clamp(sc.x, 0, W() - 1), y: clamp(sc.y, 0, H() - 1) } : null, presses, text, keys };
    }

    const api = { ready: false, length: spec.length, frame };
    (window as unknown as { __film: typeof api }).__film = api;
    void (async () => {
      await document.fonts?.ready;
      api.ready = true;
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const active: Card | null = card ? spec.cards[card.i]! : null;
  return (
    <div className="film">
      <div className="film-cam" ref={camEl}>
        {children}
      </div>
      <div className="film-dim" ref={dimEl} aria-hidden />
      {active && (
        <div className={`film-card ${active.theme}`} ref={cardEl} aria-live="polite">
          <div className="film-card-body">
            {active.lines.slice(0, card!.n).map((l, i) => (
              <p key={i} className={`film-line ${l.size ?? 'm'}${l.num ? ' numbered' : ''}`} data-at={l.t}>
                {l.num && <span className="film-num">{l.num}</span>}
                <span>{l.text}</span>
              </p>
            ))}
          </div>
        </div>
      )}
      <div className="film-cursor" ref={cursorEl} aria-hidden>
        <svg className="arrow" width="28" height="28" viewBox="0 0 24 24">
          <path d="M4 2.5 19.5 12l-7 1.6L9 20.5z" fill="#fff" stroke="#1c1b19" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
        <svg className="pointer" width="28" height="28" viewBox="0 0 24 24">
          <path d="M9 3.5a1.6 1.6 0 0 1 3.2 0V10l.4-.1a1.6 1.6 0 0 1 2 1.2l.1.4.4-.2a1.6 1.6 0 0 1 2.1 1l.1.4.3-.1a1.6 1.6 0 0 1 2 1.5v3.4c0 2.8-2.3 5-5.1 5h-1.5c-1.6 0-3.1-.8-4-2.1l-3.6-5.2a1.5 1.5 0 0 1 2.3-1.9L9 14.4z" fill="#fff" stroke="#1c1b19" strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
  );
}
