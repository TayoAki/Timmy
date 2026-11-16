/*
 * The story player: plays "Monday, 8:12" (src/story/script.ts) inside the
 * real app. It starts from fresh demo data, points at one thing per beat,
 * moves a cursor to the buttons it presses, and narrates in a caption.
 * Closing it puts back the demo data you had; "Explore from here" keeps
 * what the story did. Open it with playStory(), or ?story in the URL
 * (?story=play starts right away, for recordings).
 */
import { ArrowRight, Pause, Play, Plug, RotateCcw, SkipForward, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { assistant } from '../agent/conversations';
import { useStore } from '../state/store';
import { BEATS, readTime, type Find, type Helpers } from './script';
import '../styles/story.css';

const STATE_KEY = 'timmy-state-v3';
const STASH_KEY = 'timmy-story-stash';
const EVENT = 'timmy:story';

/** Opens the story's first card. */
export const playStory = () => window.dispatchEvent(new CustomEvent(EVENT));

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Cursor {
  x: number;
  y: number;
  show: boolean;
  click: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

const resolve = (f: Find): HTMLElement | null => {
  if (typeof f === 'function') return f();
  const el = document.querySelector(f);
  if (!(el instanceof HTMLElement)) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? el : null;
};

const readStash = (): { state: string | null } | undefined => {
  try {
    const raw = localStorage.getItem(STASH_KEY);
    return raw ? (JSON.parse(raw) as { state: string | null }) : undefined;
  } catch {
    return undefined;
  }
};
const dropStash = () => {
  try {
    localStorage.removeItem(STASH_KEY);
  } catch {
    /* storage unavailable */
  }
};

export function StoryPlayer() {
  const { state, dispatch } = useStore();
  const stateRef = useRef(state);
  stateRef.current = state;

  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [box, setBox] = useState<Box | null>(null);
  const [cursor, setCursor] = useState<Cursor>({ x: window.innerWidth / 2, y: window.innerHeight - 80, show: false, click: false });
  const [progress, setProgress] = useState(0);
  const [hadOwn, setHadOwn] = useState(false);

  const token = useRef(0);
  const pausedRef = useRef(false);
  const skipRef = useRef(false);
  const target = useRef<HTMLElement | null>(null);
  const convosBefore = useRef<Set<string>>(new Set());

  const beat = BEATS[index]!;

  // Open from the button on Today, or from ?story in the URL.
  useEffect(() => {
    const onOpen = () => show(false);
    window.addEventListener(EVENT, onOpen);
    const q = new URLSearchParams(window.location.search).get('story');
    if (q !== null) show(q === 'play');
    return () => window.removeEventListener(EVENT, onOpen);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The spotlight follows its element as the page lays out and scrolls.
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    let last = '';
    const tick = () => {
      const el = target.current;
      // While the next screen loads, the spotlight stays where it was and then glides to the new target.
      if (el && !el.isConnected) {
        raf = window.requestAnimationFrame(tick);
        return;
      }
      const r = el ? el.getBoundingClientRect() : null;
      const next = r && r.width > 0 ? { x: r.left, y: Math.max(r.top, 4), w: r.width, h: Math.min(r.bottom, window.innerHeight - 4) - Math.max(r.top, 4) } : null;
      const key = next ? `${Math.round(next.x)},${Math.round(next.y)},${Math.round(next.w)},${Math.round(next.h)}` : '';
      if (key !== last) {
        last = key;
        setBox(next && next.h > 0 ? next : null);
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [open]);

  // Space pauses, → skips ahead, Esc closes. Nothing reaches the app's shortcuts.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        close(true);
      } else if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        togglePause();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        skip();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  function show(autoplay: boolean) {
    token.current++;
    target.current = null;
    setBox(null);
    setIndex(0);
    setPaused(false);
    pausedRef.current = false;
    let own = false;
    try {
      own = readStash()?.state != null || localStorage.getItem(STATE_KEY) !== null;
    } catch {
      /* storage unavailable */
    }
    setHadOwn(own);
    setOpen(true);
    if (autoplay) void begin();
  }

  /** Puts your demo aside, starts from fresh data, and plays from the first scene. */
  async function begin() {
    if (!readStash()) {
      try {
        localStorage.setItem(STASH_KEY, JSON.stringify({ state: localStorage.getItem(STATE_KEY) }));
      } catch {
        /* storage unavailable: the story still plays */
      }
    }
    convosBefore.current = new Set(assistant.get().convos.map((c) => c.id));
    assistant.close();
    assistant.newChat();
    dispatch({ type: 'reset', quiet: true });
    await sleep(350);
    void run(1);
  }

  async function run(from: number) {
    const my = ++token.current;
    const alive = () => my === token.current;
    const h: Helpers = {
      state: () => stateRef.current,
      dispatch,
      go: (route) => dispatch({ type: 'navigate', route }),
      wait: sleep,
      until: async (test, ms = 8000) => {
        const end = Date.now() + ms;
        while (!test() && Date.now() < end) await sleep(120);
      },
    };
    const find = async (list: Find[] | undefined, ms: number) => {
      if (!list?.length) return null;
      const end = Date.now() + ms;
      for (;;) {
        for (const f of list) {
          const el = resolve(f);
          if (el) return el;
        }
        if (Date.now() > end || !alive()) return null;
        await sleep(100);
      }
    };

    for (let i = from; i < BEATS.length; i++) {
      if (!alive()) return;
      const b = BEATS[i]!;
      setIndex(i);
      setProgress(0);
      if (b.card || !b.spot) target.current = null;
      if (b.card === 'end') {
        setCursor((c) => ({ ...c, show: false }));
        return;
      }
      if (b.setup) {
        await b.setup(h);
        await sleep(450);
      }
      if (!alive()) return;
      const el = await find(b.spot, 2500);
      if (!alive()) return;
      target.current = el;
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.top < 70 || r.bottom > window.innerHeight - 90) {
          el.scrollIntoView({ block: r.height > window.innerHeight * 0.6 ? 'start' : 'center', behavior: 'smooth' });
          await sleep(450);
        }
        target.current = el;
      }

      // Read, unless paused or skipped.
      const total = b.card === 'plan' ? 8000 : readTime(b.text);
      let spent = 0;
      while (spent < total) {
        if (!alive()) return;
        if (skipRef.current) break;
        await sleep(100);
        if (!pausedRef.current) spent += 100;
        setProgress(Math.min(1, spent / total));
      }
      skipRef.current = false;
      setProgress(1);
      if (!alive()) return;

      if (b.press) {
        const btn = await find(b.press, 2000);
        if (btn && alive()) {
          const r = btn.getBoundingClientRect();
          setCursor((c) => ({ ...c, show: true, click: false, x: r.left + r.width / 2, y: r.top + r.height / 2 }));
          await sleep(800);
          setCursor((c) => ({ ...c, click: true }));
          await sleep(180);
          if (!alive()) return;
          btn.click();
          await sleep(320);
          setCursor((c) => ({ ...c, click: false }));
        }
      }
      if (b.act) await b.act(h);
      if (!alive()) return;
      await sleep(b.press ? 600 : 150);
      setCursor((c) => ({ ...c, show: false }));
    }
  }

  function togglePause() {
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
  }

  function skip() {
    if (BEATS[index]?.card === 'intro') return void begin();
    skipRef.current = true;
    if (pausedRef.current) togglePause();
  }

  /** Stops the story. `restore` puts back the demo data you had before it played. */
  function close(restore: boolean) {
    token.current++;
    target.current = null;
    skipRef.current = false;
    setBox(null);
    setCursor((c) => ({ ...c, show: false }));
    setOpen(false);
    const stash = readStash();
    dropStash();
    if (!restore || !stash) return;
    assistant.close();
    for (const c of assistant.get().convos) if (!convosBefore.current.has(c.id)) assistant.remove(c.id);
    if (stash.state) {
      try {
        localStorage.setItem(STATE_KEY, stash.state);
      } catch {
        /* storage unavailable */
      }
      dispatch({ type: 'reload', toast: 'Your demo is back the way you left it' });
    } else {
      dispatch({ type: 'reset', quiet: true });
    }
  }

  function connect() {
    close(false);
    dispatch({ type: 'navigate', route: { view: 'connections' } });
  }

  if (!open) return null;

  const total = BEATS.length - 2; // scenes between the intro and the end
  const controls = (
    <div className="story-controls">
      <span className="story-count mono" aria-label={`Scene ${index} of ${total}`}>
        {index}/{total}
      </span>
      <button type="button" className="icon-btn sm" onClick={togglePause} aria-label={paused ? 'Play' : 'Pause'} title={paused ? 'Play (Space)' : 'Pause (Space)'}>
        {paused ? <Play size={15} /> : <Pause size={15} />}
      </button>
      <button type="button" className="icon-btn sm" onClick={skip} aria-label="Next" title="Next (→)">
        <SkipForward size={15} />
      </button>
      <button type="button" className="icon-btn sm" onClick={() => close(true)} aria-label="Close the story" title="Close (Esc)">
        <X size={15} />
      </button>
    </div>
  );

  // The caption goes wherever the spotlight isn't.
  const placeTop = !!box && box.y + box.h / 2 > window.innerHeight * 0.52 && box.h < window.innerHeight * 0.6;

  return (
    <div className={`story${box ? ' spot' : ''}${beat.card ? ' carded' : ''}`} role="dialog" aria-modal="true" aria-label="The Timmy story">
      {box && !beat.card && <div className="story-spot" style={{ left: box.x - 6, top: box.y - 6, width: box.w + 12, height: box.h + 12 }} />}
      <div className={`story-cursor${cursor.show ? ' on' : ''}${cursor.click ? ' click' : ''}`} style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }} aria-hidden>
        <svg width="22" height="22" viewBox="0 0 24 24">
          <path d="M4 2.5 19.5 12l-7 1.6L9 20.5z" fill="#fff" stroke="#1c1b19" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
      </div>

      {beat.card === 'intro' && (
        <section className="story-card">
          <p className="story-kicker">The Timmy story</p>
          <h1 className="story-title">Monday, 8:12</h1>
          <p className="story-lede">{beat.text}</p>
          {hadOwn && <p className="story-note">It plays on fresh demo data. When you close it, the demo goes back to how you left it.</p>}
          <div className="story-actions">
            <button type="button" className="btn btn-primary" onClick={() => void begin()} autoFocus>
              <Play size={15} />
              Play the story
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => close(false)}>
              Not now
            </button>
          </div>
        </section>
      )}

      {beat.card === 'plan' && (
        <section className="story-card">
          <p className="story-kicker">The plan</p>
          <h2 className="story-title sm">{beat.text}</h2>
          <ol className="story-plan">
            <li>
              <strong>Connect your Gmail.</strong>
              <span>Add your calendar and Drive when you’re ready.</span>
            </li>
            <li>
              <strong>Timmy sorts, drafts and lines up your morning.</strong>
              <span>Every suggestion says why.</span>
            </li>
            <li>
              <strong>You approve what goes out.</strong>
              <span>Nothing leaves without your OK, and every move can be undone.</span>
            </li>
          </ol>
          <div className="story-bar" aria-hidden>
            <span style={{ transform: `scaleX(${progress})` }} />
          </div>
          {controls}
        </section>
      )}

      {beat.card === 'end' && (
        <section className="story-card">
          <p className="story-kicker">5:31 PM</p>
          <p className="story-end">{beat.text}</p>
          <div className="story-actions">
            <button type="button" className="btn btn-primary" onClick={connect}>
              <Plug size={15} />
              Connect your Gmail
            </button>
            <button type="button" className="btn" onClick={() => close(false)}>
              Explore from here
              <ArrowRight size={15} />
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void begin()}>
              <RotateCcw size={15} />
              Watch again
            </button>
          </div>
          {hadOwn && (
            <button type="button" className="link-btn story-restore" onClick={() => close(true)}>
              Put back the demo data I had
            </button>
          )}
        </section>
      )}

      {!beat.card && (
        <section className={`story-caption${placeTop ? ' top' : ''}${box ? '' : ' alone'}`} aria-live="polite">
          <div className="story-bar" aria-hidden>
            <span style={{ transform: `scaleX(${progress})` }} />
          </div>
          {beat.clock && <p className="story-clock mono">{beat.clock}</p>}
          <p className="story-text">{beat.text}</p>
          {controls}
        </section>
      )}
    </div>
  );
}
