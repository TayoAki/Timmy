/**
 * Putting an earlier version of a page back.
 *
 * The version's contents become the page's current contents, held to the same checks as any save. What
 * they replace is kept first, as a version of its own, so a restore can itself be taken back. The change is
 * saved like every other change to the workspace's state, which is how open tabs come to show it.
 *
 * A version may link to sub-pages that have been deleted for good since it was kept. Those links are left out
 * (they could only show "Deleted page"), and the answer says how many were.
 */
import type { Block } from '../../../src/data/ws-types';
import type { State } from '../../../src/state/store';
import { patch, type WsOp } from '../../../src/state/ws';
import { assetRefsOf, usablePictures } from '../files/assets';
import { audit } from '../gateway/gateway';
import { reduce, type Ctx } from '../state/engine';
import { mutate } from '../state/mutate';
import { checkWsOps } from '../state/ws-check';
import { OWN_ORIGIN, contentsOf, keepVersion, readVersion, sameContents } from './versions';

export type Restored =
  /**
   * `changed` is false when the page already held exactly that version, so nothing was replaced. `kept` is the number
   * of the version that now holds what was replaced. `leftOut` counts the links to pages deleted since, `links`
   * lists them (the link's block and the page it pointed at), and `note` says so in words.
   */
  | { ok: true; changed: boolean; kept?: number; leftOut?: number; links?: { block: string; page: string }[]; note?: string }
  | { ok: false; status: 403 | 404 | 409 | 422; reason: string };

export async function restoreVersion(ctx: Ctx, pageId: string, number: number): Promise<Restored> {
  if (!ctx.rules.work) return { ok: false, status: 403, reason: 'Your role can’t change pages in this workspace.' };
  return mutate<Restored>(ctx.workspaceId, `${OWN_ORIGIN}restore`, async (tx, loaded) => {
    const state = loaded.state;
    const refuse = (status: 404 | 409 | 422, reason: string) => ({ result: { ok: false as const, status, reason } });
    // A page in the trash is read-only, like everywhere else: it comes out of the trash first.
    if (state.ws.trash[pageId]) return refuse(409, 'This page is in the trash. Restore the page first, then pick a version.');
    const file = state.ws.files[pageId];
    const doc = state.ws.docs[pageId];
    if (!file || file.kind !== 'doc' || !doc) return refuse(404, 'That page is no longer here.');
    const version = await readVersion(tx, ctx.workspaceId, pageId, number);
    if (!version) return refuse(404, 'That version is no longer kept.');

    // Links to pages that no longer exist anywhere (not listed, not in the trash) are left out.
    // A stored version that isn't a list of blocks is left as it is here; the checks below refuse it.
    const blocks = Array.isArray(version.blocks) ? version.blocks.filter((b) => !linksToGonePage(state, b)) : version.blocks;
    const said = leftOutNote(Array.isArray(version.blocks) ? version.blocks.filter((b) => linksToGonePage(state, b)) : []);
    // An icon or cover the version did not have is taken off again.
    const ops: WsOp[] = [patch('docs', pageId, { blocks, icon: version.icon, cover: version.cover }), patch('files', pageId, { updated: new Date() })];
    // A version may hold pictures uploaded to this workspace, saved by reference. They count only while they are still
    // this workspace's uploaded pictures, looked up the same way as for any save.
    const pictures = await usablePictures(tx, ctx.workspaceId, [...assetRefsOf(ops)]);
    const bad = checkWsOps(state, ops, pictures);
    if (bad) return refuse(422, `That version can’t be put back. ${bad}`);
    if (sameContents(doc, { ...version, blocks })) return { result: { ok: true as const, changed: false, ...said } };

    const kept = await keepVersion(tx, ctx.workspaceId, pageId, contentsOf(doc), ctx.user.id, 'before-restore');
    const next = reduce(loaded, state, { type: 'ws', ops, log: `Restored an earlier version of the page “${file.name}”` });
    await audit(tx, ctx.workspaceId, { actor: ctx.user.id, action: 'page.version.restored', detail: { page: pageId, version: number, kept, ...(said.leftOut ? { leftOut: said.leftOut } : {}) } });
    return { state: next, result: { ok: true as const, changed: true, kept, ...said } };
  });
}

/** A sub-page link whose page is neither among the pages nor in the trash: it was deleted for good. */
const linksToGonePage = (state: State, b: Block | null) => !!b && typeof b === 'object' && b.type === 'page' && typeof b.file === 'string' && !Object.hasOwn(state.ws.files, b.file) && !Object.hasOwn(state.ws.trash, b.file);

function leftOutNote(gone: Block[]): { leftOut?: number; links?: { block: string; page: string }[]; note?: string } {
  const n = gone.length;
  if (!n) return {};
  const links = gone.map((b) => ({ block: String(b.id), page: (b as { file: string }).file }));
  return { leftOut: n, links, note: n === 1 ? 'A link to a page that has been deleted since was left out.' : `${n} links to pages that have been deleted since were left out.` };
}
