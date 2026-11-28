/**
 * Whether lead suggestions are on for a real workspace (the server has Treg set up), and how many are left today.
 * In the sample demo, lead finding runs in the browser on sample data, so this answers "off" there and the demo's
 * own finder is used.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../live/api';
import { isLive } from '../../live/clock';

export type LeadsStatus = { on: boolean; sample: boolean; today: number; left: number; perDay: number };

export function useLeadsStatus(): { status: LeadsStatus | null; refresh: () => void } {
  const [status, setStatus] = useState<LeadsStatus | null>(null);
  const refresh = useCallback(() => {
    if (!isLive()) return;
    api
      .leadsStatus()
      .then(setStatus)
      .catch(() => setStatus({ on: false, sample: false, today: 0, left: 0, perDay: 0 }));
  }, []);
  useEffect(refresh, [refresh]);
  return { status, refresh };
}
