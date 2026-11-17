/**
 * Putting an earlier version of a page back.
 *
 * The version's contents become the page's current contents, held to the same checks as any save. What
 * they replace is kept first, as a version of its own, so a restore can itself be taken back. The change is
 * saved like every other change to the workspace's state, which is how open tabs come to show it.
 */
import { patch, type WsOp } from '../../../src/state/ws';
import { assetRefsOf, usablePictures } from '../files/assets';
import { audit } from '../gateway/gateway';
import { reduce, type Ctx } from '../state/engine';
import { mutate } from '../state/mutate';
import { checkWsOps } from '../state/ws-check';
import { OWN_ORIGIN, contentsOf, keepVersion, readVersion, sameContents } from './versions';

export type Restored =
  /** `changed` is false when the page already held exactly that version, so nothing was replaced. `kept` is the number of the version that now holds what was replaced. */
  | { ok: true; changed: boolean; kept?: number }
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

    // An icon or cover the version did not have is taken off again.
    const ops: WsOp[] = [patch('docs', pageId, { blocks: version.blocks, icon: version.icon, cover: version.cover }), patch('files', pageId, { updated: new Date() })];
    // A version may hold pictures uploaded to this workspace, saved by reference. They count only while they are still
    // this workspace's uploaded pictures, looked up the same way as for any save.
    const pictures = await usablePictures(tx, ctx.workspaceId, [...assetRefsOf(ops)]);
    const bad = checkWsOps(state, ops, pictures);
    if (bad) return refuse(422, `That version can’t be put back. ${bad}`);
    if (sameContents(doc, version)) return { result: { ok: true as const, changed: false } };

    const kept = await keepVersion(tx, ctx.workspaceId, pageId, contentsOf(doc), ctx.user.id, 'before-restore');
    const next = reduce(loaded, state, { type: 'ws', ops, log: `Restored an earlier version of the page “${file.name}”` });
    await audit(tx, ctx.workspaceId, { actor: ctx.user.id, action: 'page.version.restored', detail: { page: pageId, version: number, kept } });
    return { state: next, result: { ok: true as const, changed: true, kept } };
  });
}
