/*
 * The cinematic outro (?outro): the end of Taylor's day, filmed in 3D, 15 seconds.
 *   1. "I'm waiting on": what everyone owes Taylor settles onto its card,
 *      row by row, while the camera drifts down it.
 *   2. The camera swings to today's calendar, where the 9:15 intro call
 *      Taylor booked that morning now sits.
 *   3. It pulls back to the whole app in the void; on the music's final hit
 *      the line "Never drop a ball." racks into focus, then the name and the
 *      call to action, and it fades to black.
 * Cut to the last 13 s of "Bass First" (from 57.10 s): the film opens on a hit
 * and the line lands on the final hit (68.75 s in the track, 11.65 s here).
 * Before filming, the morning's work is done on fresh demo data that is never
 * saved: Keep $62, the reply to Dana sent and tracked, the 9:15 call booked.
 */
import { Plug } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { TimmyMark } from '../components/common';
import { blur, camera, depthBlur, kf, place, setLens, useFilm, worldOf, type P } from '../cinema/engine';
import { leadAlerts } from '../state/leads';
import { useStore } from '../state/store';
import { CalendarNow, WaitingNow } from '../views/TodayView';
import '../styles/intro.css';

export const OUTRO_LENGTH = 15;
const FRAMES = new URLSearchParams(window.location.search).get('outro') === 'frames';

const PLANE: P = { x: 140, y: 60, z: -320 };
const WAIT: P = { x: -220, y: -40, z: 40 };
const CAL: P = { x: 330, y: 170, z: 170 };

interface Anchors {
  waitTop: P;
  waitEnd: P;
  calTop: P;
  call: P;
}

export function Outro({ children }: { children: ReactNode }) {
  const { state, dispatch } = useStore();
  const frame = useRef<HTMLDivElement>(null);
  const rig = useRef<HTMLDivElement>(null);
  const plane = useRef<HTMLDivElement>(null);
  const wait = useRef<HTMLDivElement>(null);
  const cal = useRef<HTMLDivElement>(null);
  const lensA = useRef<HTMLDivElement>(null);
  const lensB = useRef<HTMLDivElement>(null);
  const dim = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLParagraphElement>(null);
  const sign = useRef<HTMLDivElement>(null);
  const fade = useRef<HTMLDivElement>(null);
  const anchors = useRef<Anchors | null>(null);
  const waitRows = useRef<HTMLElement[]>([]);
  const calRows = useRef<HTMLElement[]>([]);
  const done = useRef(false);

  // The morning's work, done for real before the cameras roll.
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const yes = leadAlerts(state).find((a) => a.kind === 'confirmed');
    dispatch({ type: 'resolve', key: 'dec:acme-price', option: 'hold' });
    dispatch({ type: 'sendDraft', id: 'acme-quote', track: true });
    if (yes) dispatch({ type: 'out', op: { op: 'book', lead: yes.lead.id, start: yes.at, end: new Date(yes.at.getTime() + 30 * 60000) } });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function render(t: number) {
    const a = anchors.current;
    if (!a || !rig.current) return;

    const lx = kf(t, [[0, a.waitTop.x + 60], [4.6, a.waitEnd.x + 40], [6.2, a.calTop.x], [7.8, a.call.x - 40], [8.6, a.call.x - 40], [10.4, PLANE.x]]);
    const ly = kf(t, [[0, a.waitTop.y], [4.6, a.waitEnd.y], [6.2, a.calTop.y + 30], [7.8, a.call.y], [8.6, a.call.y], [10.4, PLANE.y]]);
    const lz = kf(t, [[0, WAIT.z], [4.6, WAIT.z], [6.2, CAL.z], [8.6, CAL.z], [10.4, PLANE.z]]);
    const dolly = kf(t, [[0, 520], [4.6, 470], [6.2, 500], [8.6, 470], [10.4, -540]]);
    const rx = kf(t, [[0, 26], [4.6, 22], [6.2, 16], [8.6, 14], [10.4, 18], [15, 15]]);
    const ry = kf(t, [[0, -24], [4.6, -19], [6.2, 18], [8.6, 21], [10.4, -12], [15, -9]]);
    const rz = kf(t, [[0, 6], [4.6, 5], [6.2, -4], [8.6, -5], [10.4, 3]]);
    rig.current.style.transform = camera({ x: lx, y: ly, z: lz }, dolly, rx, ry, rz);

    const focus = kf(t, [[0, WAIT.z], [4.6, WAIT.z], [6.2, CAL.z], [8.6, CAL.z], [9.8, PLANE.z]]);
    const defocus = kf(t, [[11.2, 0], [12.1, 5]]);

    if (plane.current) {
      plane.current.style.transform = place(PLANE);
      plane.current.style.filter = blur(depthBlur(PLANE.z, focus, defocus));
    }

    // Each card's rows arrive from depth, one after another, like a staircase.
    const cascade = (rows: HTMLElement[], base: number, start: number, gap: number, settledAfter: number) => {
      const settled = t > settledAfter;
      rows.forEach((row, i) => {
        const s0 = start + i * gap;
        const z = kf(t, [[s0, 170 + i * 60], [s0 + 1.6, 0]]);
        row.style.transform = `translateZ(${z.toFixed(1)}px)`;
        row.style.opacity = String(kf(t, [[s0, 0], [s0 + 0.55, 1]]));
        row.style.filter = settled ? 'none' : blur(depthBlur(base + z, focus));
        row.style.boxShadow = z > 1 ? `0 ${(z * 0.08).toFixed(1)}px ${(z * 0.16).toFixed(1)}px rgba(0, 0, 0, ${Math.min(0.26, z / 900).toFixed(3)})` : 'none';
      });
      return settled;
    };
    if (wait.current) {
      wait.current.style.transform = place(WAIT);
      const settled = cascade(waitRows.current, WAIT.z, 0.5, 0.42, 4.6);
      wait.current.style.filter = settled ? blur(depthBlur(WAIT.z, focus, defocus)) : 'none';
    }
    if (cal.current) {
      const dz = kf(t, [[4.5, 220], [6.1, 0]]);
      cal.current.style.transform = place(CAL, dz);
      cal.current.style.opacity = String(kf(t, [[4.5, 0], [5.3, 1]]));
      const settled = cascade(calRows.current, CAL.z, 5.0, 0.36, 8.4);
      cal.current.style.filter = settled ? blur(depthBlur(CAL.z + dz, focus, defocus)) : 'none';
    }

    setLens(lensA.current, lensB.current, kf(t, [[0, 300], [4.6, 330], [6.2, 300], [8.6, 300], [9.8, 1000]]));

    // The line lands on the final hit; the name and the call to action follow.
    if (dim.current) dim.current.style.opacity = String(kf(t, [[11.2, 0], [12.1, 0.55]]));
    if (line.current) {
      line.current.style.opacity = String(kf(t, [[11.45, 0], [11.85, 1]]));
      line.current.style.filter = blur(kf(t, [[11.45, 14], [12.1, 0]]));
      line.current.style.transform = `scale(${kf(t, [[11.45, 1.06], [14, 1]]).toFixed(4)})`;
    }
    if (sign.current) {
      sign.current.style.opacity = String(kf(t, [[12.2, 0], [12.9, 1]]));
      sign.current.style.transform = `translateY(${kf(t, [[12.2, 12], [12.9, 0]]).toFixed(2)}px)`;
    }
    if (fade.current) fade.current.style.opacity = String(kf(t, [[0, 1], [0.5, 0], [14.3, 0], [15, 1]]));
  }

  function setup() {
    if (!wait.current || !cal.current) return;
    waitRows.current = [...wait.current.querySelectorAll<HTMLElement>('.tc-list li')];
    calRows.current = [...cal.current.querySelectorAll<HTMLElement>('.tc-list li')];
    const callRow = calRows.current.find((li) => /Jamie|Intro call/.test(li.textContent ?? '')) ?? calRows.current[1] ?? null;
    anchors.current = {
      waitTop: worldOf(wait.current.querySelector('.tc-head'), wait.current, WAIT, { x: 0.5, y: 0.15 }),
      waitEnd: worldOf(waitRows.current[waitRows.current.length - 1] ?? null, wait.current, WAIT, { x: 0.5, y: 0.85 }),
      calTop: worldOf(cal.current.querySelector('.tc-head'), cal.current, CAL, { x: 0.5, y: 0.15 }),
      call: worldOf(callRow, cal.current, CAL),
    };
  }
  const { ended, scale } = useFilm(OUTRO_LENGTH, FRAMES, setup, render);

  return (
    <div className="intro outro" aria-label="Timmy, a cinematic outro">
      <div className="intro-frame" ref={frame} style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
        <div className="intro-stage" aria-hidden>
          <div className="intro-rig" ref={rig}>
            <div className="intro-layer intro-plane" ref={plane}>
              {children}
            </div>
            <div className="intro-layer outro-card" ref={wait}>
              <WaitingNow limit={5} />
            </div>
            <div className="intro-layer outro-card" ref={cal}>
              <CalendarNow />
            </div>
          </div>
        </div>
        <div className="intro-lens a" ref={lensA} />
        <div className="intro-lens b" ref={lensB} />
        <div className="intro-dim" ref={dim} />
        <div className="outro-title">
          <p className="outro-line" ref={line}>
            Never drop a ball.
          </p>
          <div className="outro-sign" ref={sign}>
            <span className="outro-word">
              <TimmyMark size={44} />
              Timmy
            </span>
            <span className="outro-cta">
              <Plug size={18} />
              Connect your Gmail
            </span>
          </div>
        </div>
        <div className="intro-fade" ref={fade} />
      </div>
      {ended && !FRAMES && (
        <div className="intro-end">
          <a className="btn btn-primary" href={window.location.pathname}>
            Explore the demo
          </a>
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Replay
          </button>
        </div>
      )}
    </div>
  );
}
