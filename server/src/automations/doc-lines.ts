/**
 * “Add to a doc” adds a line to a page on the server, and someone may have that page open. Their editor saves the
 * whole page, made from the copy it has. If that copy didn't have the line yet (the save left before the line
 * reached the screen), the save would take the line away again.
 *
 * So a save of a page's blocks keeps every line Timmy added that it leaves out, unless the copy the save was made
 * from had that line: then the person took it out, and it goes. The page editor says which of Timmy's lines its copy
 * had (`base` on the save); any other save (adding a link to a sub-page, deleting one) says nothing, and keeps them all.
 * The person's own blocks are saved exactly as they sent them; only Timmy's missing lines are put back among them.
 */
import type { State } from '../../../src/state/store';
import type { Block } from '../../../src/data/ws-types';
import { isTimmyLine } from '../../../src/lib/blocks';
import { MAX_BLOCKS } from '../state/ws-check';

const plain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The workspace operations of one command, with Timmy's lines put back into any page save that would drop them unseen. */
export function keepTimmyLines<T>(state: State, ops: T): T {
  if (!Array.isArray(ops)) return ops;
  return ops.map((o: unknown) => {
    if (!plain(o) || o.col !== 'docs' || o.op !== 'patch' || typeof o.id !== 'string' || !plain(o.patch) || !Array.isArray(o.patch.blocks)) return o;
    const stored = Object.hasOwn(state.ws.docs, o.id) ? state.ws.docs[o.id]?.blocks : undefined;
    if (!Array.isArray(stored)) return o;
    const incoming = o.patch.blocks as Block[];
    const seen = new Set(Array.isArray(o.base) ? o.base.filter((x): x is string => typeof x === 'string') : []);
    const saved = new Set(incoming.map((b) => (plain(b) ? b.id : undefined)));
    const missing = stored.filter((b) => isTimmyLine(b.id) && !saved.has(b.id) && !seen.has(b.id));
    if (!missing.length || incoming.length + missing.length > MAX_BLOCKS) return o;
    const blocks = [...incoming];
    const back = new Set(missing);
    for (const line of missing) {
      // A line that ended the page (as “Add to a doc” adds them) still ends it. Any other goes back after the block it
      // followed on the server, when the save still has that block, and at the end when it doesn't.
      const was = stored.indexOf(line);
      const ended = stored.slice(was + 1).every((b) => back.has(b));
      let at = was === 0 && !ended ? 0 : blocks.length;
      for (let j = was - 1; j >= 0 && !ended; j--) {
        const k = blocks.findIndex((b) => plain(b) && b.id === stored[j]!.id);
        if (k >= 0) {
          at = k + 1;
          break;
        }
      }
      blocks.splice(at, 0, line);
    }
    return { ...o, patch: { ...o.patch, blocks } };
  }) as T;
}
