import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { inBox, useStore } from '../state/store';
import { Kbd } from './common';

type Theme = 'light' | 'dark';

const systemTheme = (): Theme =>
  window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

const savedTheme = (): Theme | null => {
  try {
    const v = localStorage.getItem('timmy-theme');
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
};

export function BottomBar() {
  const { state } = useStore();
  const [theme, setTheme] = useState<Theme>(() => savedTheme() ?? systemTheme());

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try {
      localStorage.setItem('timmy-theme', next);
    } catch {
      /* storage unavailable: theme still applies for this visit */
    }
  };

  const inbox = inBox(state.threads, 'inbox').length;
  const owe = inBox(state.threads, 'follow-up').length;
  const waiting = inBox(state.threads, 'waiting').length;

  return (
    <footer className="bar">
      <div className="bar-group">
        <span className="bar-item">
          <span className="bar-status" />
          Timmy is up to date
        </span>
        <span className="bar-item hide-sm">Last triage 7:02 AM · next tomorrow 7:00 AM</span>
      </div>
      <div className="bar-group">
        <span className="bar-item hide-sm mono">
          {inbox} unsorted · {owe} owe · {waiting} waiting
        </span>
        <span className="bar-item hide-sm">
          <Kbd>⌘K</Kbd> search
        </span>
        <button className="bar-btn" onClick={toggle} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
          {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
          <span className="hide-sm">{theme === 'dark' ? 'Light' : 'Dark'}</span>
        </button>
      </div>
    </footer>
  );
}
