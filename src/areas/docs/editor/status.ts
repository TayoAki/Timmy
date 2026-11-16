/* Whether a doc's latest edits are saved, for the "Saving… / Saved" badge. */
import { useSyncExternalStore } from 'react';

export type SaveState = 'saved' | 'saving';

const states = new Map<string, SaveState>();
const subs = new Set<() => void>();

export const setSaveState = (id: string, s: SaveState) => {
  if (states.get(id) === s) return;
  states.set(id, s);
  subs.forEach((f) => f());
};

export const useSaveState = (id: string) =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => states.get(id) ?? 'saved',
  );
