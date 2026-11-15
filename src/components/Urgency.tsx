/*
 * How urgency shows up: a tag on rows and cards, and on a thread a line with
 * the reasons and a menu to set it yourself.
 */
import { ArrowDownToLine, Flame, RotateCcw, Sparkles } from 'lucide-react';
import type { Thread } from '../data/types';
import { useStore } from '../state/store';
import { URGENCY, useUrgency, type UrgencyInfo } from '../state/urgency';
import { Menu } from './kit';

export function UrgencyTag({ info, always }: { info: UrgencyInfo; always?: boolean }) {
  if (info.level === 'later' && !always) return null;
  return (
    <span className={`urg urg-${info.level}`} title={info.reasons.join(' · ')}>
      <span className="urg-dot" aria-hidden />
      {URGENCY[info.level].label}
    </span>
  );
}

/** Reasons as one readable line: "Due today at 5:00 PM · Says “today”". */
export function UrgencyReasons({ info, max = 3 }: { info: UrgencyInfo; max?: number }) {
  if (!info.reasons.length) return null;
  return <span className="urg-reasons">{info.reasons.slice(0, max).join(' · ')}</span>;
}

/** On a thread: the level, why, and a way to correct Timmy. */
export function UrgencyLine({ t }: { t: Thread }) {
  const { dispatch } = useStore();
  const { of } = useUrgency();
  if (t.box === 'archived' || t.box === 'read-through') return null;
  const info = of(t);
  return (
    <div className="urg-line">
      <UrgencyTag info={info} always />
      <span className="urg-why">
        {info.manual ? null : <Sparkles size={13} aria-hidden />}
        <UrgencyReasons info={info} max={4} />
      </span>
      <Menu
        label="Change urgency"
        trigger={<span className="urg-change">Change</span>}
        items={[
          { label: 'Mark urgent', icon: Flame, onSelect: () => dispatch({ type: 'setUrgency', id: t.id, level: 'urgent' }), disabled: t.urgency === 'urgent' },
          { label: 'Mark as can wait', icon: ArrowDownToLine, onSelect: () => dispatch({ type: 'setUrgency', id: t.id, level: 'later' }), disabled: t.urgency === 'later' },
          { label: 'Let Timmy rank it', icon: RotateCcw, onSelect: () => dispatch({ type: 'setUrgency', id: t.id, level: null }), disabled: !t.urgency },
        ]}
      />
    </div>
  );
}
