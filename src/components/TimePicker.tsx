/*
 * Time and day pickers for the morning run. The time picker is a listbox of
 * 15-minute steps: arrow keys move, Page Up/Down jump an hour, Enter picks,
 * Escape closes.
 */
import { Check, ChevronDown, Clock3 } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { DAY_NAMES, WEEK, fmtClock } from '../state/schedule';

const pad = (n: number) => String(n).padStart(2, '0');

export const timeOptions = (step = 15) => {
  const out: string[] = [];
  for (let m = 0; m < 24 * 60; m += step) out.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
  return out;
};

export function TimePicker({
  value,
  onChange,
  label,
  step = 15,
  align = 'left',
}: {
  value: string;
  onChange: (time: string) => void;
  label: string;
  step?: number;
  align?: 'left' | 'right';
}) {
  const options = useMemo(() => timeOptions(step), [step]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const perHour = 60 / step;

  useEffect(() => {
    if (!open) return;
    const i = options.indexOf(value);
    setActive(i >= 0 ? i : 0);
    list.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, options, value]);

  useEffect(() => {
    if (open) list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  // Centre the selected time when the list opens.
  useEffect(() => {
    if (!open) return;
    const el = list.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (el && list.current) list.current.scrollTop = el.offsetTop - list.current.clientHeight / 2 + el.clientHeight / 2;
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const choose = (i: number) => {
    onChange(options[i]!);
    close();
  };
  const move = (to: number) => setActive(Math.max(0, Math.min(options.length - 1, to)));

  const onKey = (e: KeyboardEvent) => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => move(active + 1),
      ArrowUp: () => move(active - 1),
      PageDown: () => move(active + perHour),
      PageUp: () => move(active - perHour),
      Home: () => move(0),
      End: () => move(options.length - 1),
      Enter: () => choose(active),
      ' ': () => choose(active),
      Escape: close,
    };
    const run = keys[e.key];
    if (run) {
      e.preventDefault();
      e.stopPropagation();
      run();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className="tp" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="tp-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${fmtClock(value)}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Clock3 size={15} />
        <span className="tp-value">{fmtClock(value)}</span>
        <ChevronDown size={14} className="tp-chev" />
      </button>
      {open && (
        <ul
          ref={list}
          className={`tp-pop${align === 'right' ? ' right' : ''}`}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={`${id}-${active}`}
          onKeyDown={onKey}
        >
          {options.map((o, i) => (
            <li
              key={o}
              id={`${id}-${i}`}
              data-i={i}
              role="option"
              aria-selected={o === value}
              className={`tp-opt${i === active ? ' active' : ''}${o.endsWith(':00') ? ' hour' : ''}`}
              onMouseMove={() => i !== active && setActive(i)}
              onClick={() => choose(i)}
            >
              <span>{fmtClock(o)}</span>
              {o === value && <Check size={14} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Seven toggles, Monday first. */
export function DayPicker({ value, onChange, label = 'Days' }: { value: number[]; onChange: (days: number[]) => void; label?: string }) {
  return (
    <div className="day-picker" role="group" aria-label={label}>
      {WEEK.map((d) => {
        const on = value.includes(d);
        return (
          <button
            key={d}
            type="button"
            className="day-btn"
            aria-pressed={on}
            aria-label={DAY_NAMES[d]}
            title={DAY_NAMES[d]}
            onClick={() => onChange(on ? value.filter((x) => x !== d) : [...value, d].sort())}
          >
            {DAY_NAMES[d]!.slice(0, 2)}
          </button>
        );
      })}
    </div>
  );
}
