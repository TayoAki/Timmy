/**
 * The demo runs on a fixed clock and counts ids from 1, so its sample data stays
 * meaningful. A real workspace needs real time and ids that never repeat.
 * Live mode is switched on once: by the browser when it starts in live mode, and by the server at boot.
 */
let live = false;

export const isLive = () => live;
export const enterLive = () => {
  live = true;
};

/** Extra characters on ids made in live mode, so two machines never mint the same one. */
export const liveSuffix = () => (live ? `-${Math.random().toString(36).slice(2, 7)}` : '');
