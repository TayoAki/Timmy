/**
 * What the Action gateway tells the rest of the server, and the one thing it asks of it.
 *
 * The gateway must not import the job queue or the command engine: both import the gateway. So each of them
 * registers its part here once, at boot, and the gateway calls through. Until something is registered a hook
 * does nothing, which is what a test that never starts the queue wants.
 */
import type { State } from '../../../src/state/store';
import type { Loaded } from '../state/docs';
import type { EffectRow } from './gateway';

export interface EffectHooks {
  /** An effect was approved, so it can be scheduled for the end of its hold. Set by the job queue. */
  approved(effect: EffectRow): void;
  /** An effect reached a final state, so a run waiting on it can continue. Set by the job queue. */
  settled(effect: EffectRow): void;
  /** Applies a reducer action to a state. Set by the command engine, which owns the reducer. */
  replay(loaded: Loaded, state: State, action: unknown): State | undefined;
}

const registered: EffectHooks = {
  approved: () => {},
  settled: () => {},
  replay: () => undefined,
};

/** Puts `fn` in place of whatever was registered for `name` before. */
function register<K extends keyof EffectHooks>(name: K, fn: EffectHooks[K]) {
  registered[name] = fn;
}

export const onEffectApproved = (fn: EffectHooks['approved']) => register('approved', fn);
export const onEffectSettled = (fn: EffectHooks['settled']) => register('settled', fn);
export const onReplay = (fn: EffectHooks['replay']) => register('replay', fn);

/** The gateway's side: each call goes to whatever is registered at the moment it is made. */
export const effectApproved = (effect: EffectRow) => registered.approved(effect);
export const effectSettled = (effect: EffectRow) => registered.settled(effect);
export const replayAction = (loaded: Loaded, state: State, action: unknown) => registered.replay(loaded, state, action);
