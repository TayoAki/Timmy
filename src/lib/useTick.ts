import { useEffect, useState } from 'react';

/** Re-renders every `ms` while `on`, for live timers. */
export function useTick(on = true, ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = window.setInterval(() => set((n) => n + 1), ms);
    return () => window.clearInterval(t);
  }, [on, ms]);
}
