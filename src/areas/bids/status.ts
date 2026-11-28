/**
 * Whether bids are on: always in the sample demo; on a real workspace, when the server has Kontract set up.
 * Asked once per page load and shared, so the rail, the phone's More sheet and the Bids screens agree.
 */
import { useEffect, useState } from 'react';
import { api } from '../../live/api';
import { isLive } from '../../live/clock';

let known: { on: boolean; sample: boolean } | null = null;
let asking: Promise<{ on: boolean; sample: boolean }> | null = null;

export function useBidsStatus(): { on: boolean; sample: boolean; known: boolean } {
  const [s, setS] = useState(() => (!isLive() ? { on: true, sample: true } : known));
  useEffect(() => {
    if (!isLive() || known) return;
    let alive = true;
    asking ??= api.bidsStatus().catch(() => ({ on: false, sample: false }));
    asking.then((r) => {
      known = r;
      if (alive) setS(r);
    });
    return () => {
      alive = false;
    };
  }, []);
  return { on: !!s?.on, sample: !!s?.sample, known: !!s };
}
