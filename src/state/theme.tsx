import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Mode = 'system' | 'light' | 'dark';
export type Palette = 'midnight' | 'graphite' | 'espresso';

export const MODES: { id: Mode; name: string }[] = [
  { id: 'light', name: 'Light' },
  { id: 'dark', name: 'Dark' },
  { id: 'system', name: 'System' },
];

export const PALETTES: { id: Palette; name: string; hint: string }[] = [
  { id: 'midnight', name: 'Midnight', hint: 'Navy with a periwinkle accent' },
  { id: 'graphite', name: 'Graphite', hint: 'Neutral gray with a lime accent' },
  { id: 'espresso', name: 'Espresso', hint: 'Warm brown with an apricot accent' },
];

// index.html reads the same keys before first paint; keep them in sync.
const MODE_KEY = 'timmy-mode';
const PALETTE_KEY = 'timmy-palette';
const LEGACY_KEY = 'timmy-theme';

function read<T extends string>(key: string, allowed: readonly T[]): T | null {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v as T) ? (v as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the choice still applies for this visit */
  }
}

const systemPrefersDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;

interface ThemeValue {
  mode: Mode;
  palette: Palette;
  /** What is on screen right now once "System" is resolved. */
  resolved: 'light' | 'dark';
  systemDark: boolean;
  setMode: (m: Mode) => void;
  setPalette: (p: Palette) => void;
}

const Ctx = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Mode>(
    () => read(MODE_KEY, ['system', 'light', 'dark'] as const) ?? read(LEGACY_KEY, ['light', 'dark'] as const) ?? 'system',
  );
  const [palette, setPaletteState] = useState<Palette>(() => read(PALETTE_KEY, PALETTES.map((p) => p.id)) ?? 'midnight');
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolved = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.dataset.palette = palette;
  }, [resolved, palette]);

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    write(MODE_KEY, m);
  }, []);

  const setPalette = useCallback(
    (p: Palette) => {
      setPaletteState(p);
      write(PALETTE_KEY, p);
      // Picking a dark palette while the screen is light means "show me it".
      if (resolved === 'light') setMode('dark');
    },
    [resolved, setMode],
  );

  const value = useMemo(
    () => ({ mode, palette, resolved, systemDark, setMode, setPalette }),
    [mode, palette, resolved, systemDark, setMode, setPalette],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme outside ThemeProvider');
  return v;
}

/** A small chip that paints itself in a palette's own colors. */
export function Swatch({ palette, size = 'sm' }: { palette: Palette | 'light'; size?: 'sm' | 'md' }) {
  return (
    <span
      className={`swatch swatch-${size}`}
      data-theme={palette === 'light' ? 'light' : 'dark'}
      data-palette={palette === 'light' ? undefined : palette}
      aria-hidden
    />
  );
}
