/** Accepting or turning down a rule Timmy proposed (Library › Learned rules, and the offer in Triage). */
import type { Dispatch } from 'react';
import type { LearnedRule } from '../data/ws-types';
import { ws, type Action } from './store';
import { remove } from './ws';

/** Saves a proposed rule: a sorting rule exactly as proposed, a written one in its words. */
export function acceptLearned(dispatch: Dispatch<Action>, r: LearnedRule) {
  dispatch(r.mail ? { type: 'addRule', group: 'triage', text: '', mail: r.mail } : { type: 'addRule', group: r.group, text: r.text });
  dispatch(ws([remove('learned', r.id)]));
}

/** Turns a proposed rule down. A sorting rule is remembered as declined, so the same offer doesn't come back. */
export function declineLearned(dispatch: Dispatch<Action>, r: LearnedRule) {
  if (r.dismissKey) dispatch({ type: 'dismiss', key: r.dismissKey });
  dispatch(ws([remove('learned', r.id)], { toast: 'Declined. Timmy won’t suggest this one again.', undo: true }));
}
