/**
 * What a button in a chat answer may do. The model writes those buttons, and
 * what the model writes can be steered by an email it read. So a button may
 * open something or start a draft, both of which leave the person looking at
 * the real thing before anything happens. It may not send, reply, approve,
 * delete or change settings: those only happen from the app's own controls or
 * from the approval card the server writes.
 */
type Loose = { type?: unknown; ops?: unknown; id?: unknown; approve?: unknown };

export function safeChatAction(a: unknown): boolean {
  if (!a || typeof a !== 'object') return false;
  const x = a as Loose;
  if (x.type === 'navigate' || x.type === 'openThread' || x.type === 'compose') return true;
  // Starting a draft is allowed only in its plainest form. With a note it would replace a draft the person has
  // already read, and the note (written by the model) would reach the drafting prompt as the person's own words.
  if (x.type === 'makeDraft') return typeof x.id === 'string' && Object.keys(x).every((k) => k === 'type' || k === 'id');
  if (x.type === 'ws') {
    return Array.isArray(x.ops) && x.ops.length > 0 && x.ops.every((o) => !!o && typeof o === 'object' && (o as { op?: unknown }).op === 'put' && ['tasks', 'notes'].includes(String((o as { col?: unknown }).col)));
  }
  return false;
}

/** The server's own approval card decides one effect by its id. The model never learns effect ids, and the server strips this from anything the model wrote. */
export const isEffectDecision = (a: unknown): boolean => !!a && typeof a === 'object' && (a as Loose).type === 'effect' && typeof (a as Loose).id === 'string' && typeof (a as Loose).approve === 'boolean';
