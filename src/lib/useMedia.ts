import { useEffect, useState } from 'react';

/** True while the media query matches, e.g. useMedia('(max-width: 599px)'). */
export function useMedia(query: string): boolean {
  const get = () => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches;
  const [on, setOn] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const onChange = () => setOn(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return on;
}

/** Phone width: the layout switches to a bottom tab bar. */
export const PHONE = '(max-width: 599px)';
