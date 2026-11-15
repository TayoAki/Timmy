/*
 * Full screen for an editor: the browser's own full screen where it exists
 * (Esc leaves it), otherwise the element fills the window. ⌘\ or Ctrl+\
 * toggles it, including while an embedded editor in a frame has the keyboard.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** The shortcut, as shown in hints. */
export const FULLSCREEN_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘\\' : 'Ctrl+\\';

export const isFullscreenKey = (e: KeyboardEvent) => (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === '\\' || e.code === 'Backslash');

export function useFullscreen<T extends HTMLElement>(enabled = true) {
  const ref = useRef<T>(null);
  const [full, setFull] = useState(false);

  useEffect(() => {
    const onChange = () => setFull(!!ref.current && document.fullscreenElement === ref.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const enter = useCallback(async () => {
    const el = ref.current;
    if (el?.requestFullscreen) {
      try {
        await el.requestFullscreen();
        return;
      } catch {
        /* not allowed here: fill the window instead */
      }
    }
    setFull(true);
  }, []);

  const exit = useCallback(async () => {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    setFull(false);
  }, []);

  const toggle = useCallback(() => (full ? exit() : enter()), [full, enter, exit]);
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;

  // The shortcut on this page, and Escape for the fill-the-window fallback.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (isFullscreenKey(e)) {
        e.preventDefault();
        void toggleRef.current();
      } else if (e.key === 'Escape' && full && !document.fullscreenElement) {
        setFull(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, full]);

  /** Also listen inside a same-origin frame, which keeps its own keyboard events. */
  const listenIn = useCallback((win: Window | null | undefined) => {
    if (!win) return () => undefined;
    const onKey = (e: KeyboardEvent) => {
      if (isFullscreenKey(e)) {
        e.preventDefault();
        e.stopPropagation();
        void toggleRef.current();
      }
    };
    try {
      win.addEventListener('keydown', onKey, true);
      return () => win.removeEventListener('keydown', onKey, true);
    } catch {
      return () => undefined;
    }
  }, []);

  return { ref, full, toggle, exit, listenIn };
}
