import { CalendarClock, CalendarPlus } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Field, Modal, Segmented } from '../../components/kit';
import { NOW } from '../../data/mock';
import type { WEvent } from '../../data/ws-types';
import { dayDiff, fmtDay } from '../../lib/format';
import { useStore, ws } from '../../state/store';
import { isoDay, parseIsoDay, patch, put, uid, type WsOp } from '../../state/ws';
import { fmtClock, fmtDuration, fmtRange, freeSlots, MIN, overlaps } from './shared';

const LENGTHS = [
  { id: '30', label: '30 min' },
  { id: '60', label: '1 hour' },
  { id: '90', label: '90 min' },
  { id: '120', label: '2 hours' },
];

const dayWord = (d: Date) => {
  const diff = dayDiff(d);
  return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : fmtDay(d);
};

/** "today", "tomorrow" or "Wed, Nov 18". */
const dayPhrase = (d: Date) => {
  const w = dayWord(d);
  return w === 'Today' || w === 'Tomorrow' ? w.toLowerCase() : w;
};

const when = (d: Date) => `${dayPhrase(d)} at ${fmtClock(d)}`;

/**
 * Reserve a calendar block for a piece of work. Owned by the Calendar area;
 * used from tasks, threads and projects. Links the event to the task/thread.
 *
 * Optional extras for callers in this area: `extraOps` are applied in the same
 * change (so one Undo reverts everything), `onBooked` runs after confirming and
 * `children` adds fields under the slot picker.
 */
export function BlockTimeDialog(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  task?: string;
  thread?: string;
  minutes?: number;
  extraOps?: WsOp[];
  onBooked?: (ev: WEvent) => void;
  toastSuffix?: string;
  children?: ReactNode;
}) {
  if (!props.open) return null;
  return <BlockTimeForm {...props} />;
}

function BlockTimeForm({
  onClose,
  title,
  task,
  thread,
  minutes = 60,
  extraOps,
  onBooked,
  toastSuffix,
  children,
}: Parameters<typeof BlockTimeDialog>[0]) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState(title.replace(/^Focus:\s*/i, ''));
  const initialLen = LENGTHS.some((l) => l.id === String(minutes)) ? String(minutes) : '60';
  const [len, setLen] = useState(initialLen);
  const slots = useMemo(() => freeSlots(state.ws, Number(len)), [state.ws, len]);
  const [choice, setChoice] = useState<number | 'custom'>(0);
  const [customDay, setCustomDay] = useState(isoDay(NOW));
  const [customTime, setCustomTime] = useState('14:00');

  const picked = (() => {
    if (choice !== 'custom') return slots[choice] ?? null;
    if (!customDay || !customTime) return null;
    const [h, m] = customTime.split(':').map(Number);
    const start = parseIsoDay(customDay, h, m);
    return { start, end: new Date(start.getTime() + Number(len) * MIN) };
  })();

  const clash = picked && choice === 'custom' ? overlaps(state.ws, picked.start, picked.end) : [];
  const existing = task ? state.ws.tasks[task] : undefined;
  const already = existing?.event ? state.ws.events[existing.event] : undefined;

  const confirm = () => {
    if (!picked || !name.trim()) return;
    const ev: WEvent = {
      id: uid('ev'),
      title: `Focus: ${name.trim()}`,
      start: picked.start,
      end: picked.end,
      kind: 'focus',
      with: [],
      task,
      thread,
      note: 'Blocked from Timmy so the work has a time.',
    };
    const ops: WsOp[] = [...(extraOps ?? []), put('events', ev)];
    if (task) ops.push(patch('tasks', task, { event: ev.id }));
    dispatch(
      ws(ops, {
        toast: `Blocked ${dayPhrase(ev.start)}, ${fmtRange(ev.start, ev.end)}${toastSuffix ?? ''}`,
        undo: true,
      }),
    );
    onBooked?.(ev);
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Block time"
      description="Put the work on your calendar so it has a time, not just a due date."
      width={500}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!picked || !name.trim()} onClick={confirm}>
            <CalendarPlus size={15} />
            {picked ? `Block ${when(picked.start)}` : 'Block time'}
          </button>
        </>
      }
    >
      <form
        className="cal-block-form"
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
      >
        <Field label="What you’ll work on" hint={`Shows as “Focus: ${name.trim() || '…'}” on your calendar.`}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <div className="field">
          <span className="field-label">How long</span>
          <Segmented label="How long" options={LENGTHS} value={len} onChange={setLen} />
        </div>

        <fieldset className="cal-slots">
          <legend className="field-label">Free between 9 AM and 6 PM</legend>
          {slots.map((s, i) => (
            <label key={s.start.toISOString()} className="cal-slot" data-on={choice === i || undefined}>
              <input type="radio" name="slot" checked={choice === i} onChange={() => setChoice(i)} />
              <CalendarClock size={15} aria-hidden />
              <span className="cal-slot-day">{dayWord(s.start)}</span>
              <span className="cal-slot-time mono">{fmtRange(s.start, s.end)}</span>
            </label>
          ))}
          {slots.length === 0 && <p className="muted">No free {fmtDuration(Number(len))} slot in the next few days. Pick a time below.</p>}
          <label className="cal-slot" data-on={choice === 'custom' || undefined}>
            <input type="radio" name="slot" checked={choice === 'custom'} onChange={() => setChoice('custom')} />
            <CalendarPlus size={15} aria-hidden />
            <span className="cal-slot-day">Pick a time</span>
          </label>
          {choice === 'custom' && (
            <div className="field-row cal-slot-custom">
              <Field label="Date">
                <input className="input" type="date" value={customDay} onChange={(e) => setCustomDay(e.target.value)} />
              </Field>
              <Field label="Start">
                <input className="input" type="time" step={900} value={customTime} onChange={(e) => setCustomTime(e.target.value)} />
              </Field>
            </div>
          )}
          {clash && clash.length > 0 && (
            <p className="cal-warn" role="status">
              Overlaps with {clash.map((e) => e.title).join(', ')}.
            </p>
          )}
        </fieldset>

        {already && (
          <p className="field-hint">
            This task already has a block: {fmtDay(already.start)}, {fmtRange(already.start, already.end)}. A new block is added, the old one stays.
          </p>
        )}
        {children}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
