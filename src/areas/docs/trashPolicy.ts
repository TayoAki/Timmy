/*
 * How long the trash keeps a page on a real workspace. The server decides (it is a setting there) and
 * empties the trash itself; the app asks once and remembers, so the trash dialog can say the number.
 */
import { useEffect, useState } from 'react';
import { api } from '../../live/api';
import { isLive } from '../../live/clock';

let known: number | null = null;
let asking: Promise<number | null> | null = null;

/** The number of days. Null in the demo, where pages stay until you delete them, and until the server has answered. */
export function useTrashDays(): number | null {
  const [days, setDays] = useState(known);
  useEffect(() => {
    if (!isLive() || known !== null) return;
    asking ??= api.pageTrash().then(
      (r) => (known = r.keptDays),
      () => (asking = null),
    );
    let mounted = true;
    void asking.then((d) => mounted && d !== null && setDays(d));
    return () => {
      mounted = false;
    };
  }, []);
  return days;
}
