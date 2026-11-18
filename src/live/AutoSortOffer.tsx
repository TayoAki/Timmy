/**
 * In Triage on a real workspace: while sorting automatically is off and junk is waiting, an owner or admin is
 * offered to switch it on (the same switch as in Settings). Switching it on files what is waiting inside Timmy only;
 * the mailbox is left as it was, and new junk is filed there too from then on (server/src/sync/sorting.ts).
 */
import { useEffect, useState } from 'react';
import { Wand2 } from 'lucide-react';
import type { Thread } from '../data/types';
import { useStore } from '../state/store';
import { api } from './api';
import { useProfile } from './LiveApp';
import { sortedNotice } from './Settings';

/** The suggestions the rule would act on: plain code's sure calls on junk and newsletters. */
const isJunk = (t: Thread) => t.box === 'inbox' && t.suggestion?.confidence === 'high' && !t.suggestion.provisional && (t.suggestion.box === 'archived' || t.suggestion.box === 'read-through');

export function AutoSortOffer({ threads }: { threads: Thread[] }) {
  const live = useProfile();
  const { dispatch } = useStore();
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const canChange = !!live?.profile.can.policy;
  useEffect(() => {
    if (!canChange) return;
    let gone = false;
    void api
      .settings()
      .then((s) => !gone && setOn(s.autoSort.on))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [canChange]);
  const junk = threads.filter(isJunk).length;
  if (!canChange || on !== false || junk === 0) return null;

  const switchOn = async () => {
    setBusy(true);
    try {
      const r = await api.saveSettings({ autoSort: true });
      setOn(true);
      dispatch({ type: 'toast', text: sortedNotice(r.sorted) });
    } catch (e) {
      dispatch({ type: 'toast', text: (e as Error).message, tone: 'warn' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card autosort-offer" aria-label="Sort junk automatically">
      <span className="autosort-icon" aria-hidden>
        <Wand2 size={17} />
      </span>
      <div className="autosort-text">
        <strong>Let Timmy sort the junk for you</strong>
        <span>
          {junk.toLocaleString('en-US')} of these are promotions, receipts, notices or newsletters Timmy is sure about. Sort them now, inside Timmy only, and file new ones automatically as they arrive. Mail a person wrote still waits for you.
        </span>
      </div>
      <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void switchOn()}>
        {busy ? 'Sorting…' : 'Sort junk automatically'}
      </button>
    </section>
  );
}
