import type { CSSProperties, ReactNode } from 'react';
import { CircleAlert, Clock, FilePenLine, Hourglass, Timer, Zap } from 'lucide-react';
import { PEOPLE, PROJECTS } from '../data/mock';
import type { Thread } from '../data/types';
import { dueInfo, initials } from '../lib/format';

const TINTS = ['#d9534f', '#d98a1a', '#2f9a65', '#3591cc', '#8a4ec2', '#cc3f95', '#13998a', '#4a5bd6', '#9b7258', '#5f7d2f'];

const tintFor = (id: string) => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TINTS[h % TINTS.length]!;
};

export const tint = (color: string) => ({ '--tint': color }) as CSSProperties;

export function Avatar({ id, size = 32 }: { id: string; size?: number }) {
  const p = PEOPLE[id];
  const name = p?.name ?? id;
  const style = {
    width: size,
    height: size,
    fontSize: Math.round(size * 0.38),
    '--tint': id === 'me' ? 'var(--accent)' : tintFor(id),
  } as CSSProperties;
  return (
    <span className={`avatar${p?.bot ? ' bot' : ''}`} style={style} title={name} aria-hidden>
      {initials(name)}
    </span>
  );
}

/** Timmy's mark: a friendly face inside a rounded tile. */
export function TimmyMark({ size = 32, muted = false }: { size?: number; muted?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="timmy-mark">
      <rect width="32" height="32" rx="9" fill={muted ? 'var(--accent-soft)' : 'var(--accent)'} />
      <circle cx="12" cy="14" r="2.2" fill={muted ? 'var(--accent-text)' : 'var(--on-accent)'} />
      <circle cx="20" cy="14" r="2.2" fill={muted ? 'var(--accent-text)' : 'var(--on-accent)'} />
      <path
        d="M11 20c2.8 2.4 7.2 2.4 10 0"
        stroke={muted ? 'var(--accent-text)' : 'var(--on-accent)'}
        strokeWidth="2.2"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function DueChip({ due, prefix }: { due: Date; prefix?: string }) {
  const { label, tone } = dueInfo(due);
  const cls = tone === 'overdue' ? 'overdue' : tone === 'today' ? 'today' : '';
  return (
    <span className={`chip ${cls}`}>
      {tone === 'overdue' ? <CircleAlert size={12} /> : <Clock size={12} />}
      {prefix ? `${prefix} ` : ''}
      {label}
    </span>
  );
}

export function ProjectChip({ id }: { id: string }) {
  const p = PROJECTS.find((x) => x.id === id);
  if (!p) return null;
  return (
    <span className="chip plain" style={tint(p.color)}>
      <span className="dot" />
      {p.name}
    </span>
  );
}

export function EffortChip({ effort }: { effort: 'quick' | 'focus' }) {
  return effort === 'quick' ? (
    <span className="chip quick">
      <Zap size={12} />
      Quick · 2 min
    </span>
  ) : (
    <span className="chip">
      <Timer size={12} />
      Needs focus
    </span>
  );
}

export function ThreadChips({ t, showProject = true }: { t: Thread; showProject?: boolean }) {
  const due = t.box === 'waiting' ? t.waiting?.due : t.due;
  return (
    <div className="chips">
      {due && t.box !== 'archived' && <DueChip due={due} prefix={t.box === 'waiting' ? 'Promised' : undefined} />}
      {t.box === 'waiting' && !t.waiting?.due && (
        <span className="chip">
          <Hourglass size={12} />
          No date promised
        </span>
      )}
      {t.effort && t.box === 'follow-up' && <EffortChip effort={t.effort} />}
      {t.draft && (
        <span className="chip accent">
          <FilePenLine size={12} />
          {t.draft.kind === 'nudge' ? 'Nudge drafted' : 'Draft ready'}
        </span>
      )}
      {showProject && t.project && <ProjectChip id={t.project} />}
    </div>
  );
}

/** Small coloured folder glyph, like a numbered drive folder. */
export function Folder({ color, size = 18 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="folder-glyph" style={tint(color)}>
      <path
        d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.6c.6 0 1.2.24 1.6.66L12 6h6.5A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11Z"
        fill="currentColor"
      />
    </svg>
  );
}
