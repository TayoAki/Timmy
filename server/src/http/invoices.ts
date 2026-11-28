/**
 * Invoices and quotes as files:
 *   GET  /api/v1/invoices/:id/pdf          the PDF, to download or print
 *   POST /api/v1/invoices/from-email       { thread, kind } Timmy drafts an invoice or quote from what an email says
 *   POST /api/v1/invoices/:id/attachment   the PDF kept as one of the workspace's attachments, for the email that
 *                                          sends it. The email itself goes through the compose window and the
 *                                          gateway like any other: the person sees it, sends it, and can undo it.
 * The invoice and quote records themselves are workspace state, changed through commands (src/state/store.tsx).
 */
import type { Hono } from 'hono';
import { announceUpload, receiveUpload } from '../files/assets';
import { invoiceFromThread } from '../invoices/from-email';
import { invoicePdf, pdfName } from '../invoices/pdf';
import { readState } from '../state/mutate';
import { defaultBilling } from '../../../src/state/invoices';
import { ctxOf, requireRead, requireWorkspace, type Env } from './session';

async function render(workspaceId: string, id: string) {
  const loaded = await readState(workspaceId);
  const inv = Object.hasOwn(loaded.state.ws.invoices ?? {}, id) ? loaded.state.ws.invoices[id] : undefined;
  if (!inv) return null;
  const s = loaded.state.ws.billing?.settings ?? defaultBilling(loaded.workspace.name, loaded.workspace.owner_email ?? undefined);
  return { inv, name: pdfName(inv, s), bytes: await invoicePdf(inv, s) };
}

export function invoiceRoutes(app: Hono<Env>): void {
  app.get('/api/v1/invoices/:id/pdf', requireWorkspace, requireRead, async (c) => {
    const ctx = ctxOf(c);
    const made = await render(ctx.workspaceId, c.req.param('id'));
    if (!made) return c.json({ error: 'That invoice isn’t in this workspace.' }, 404);
    return new Response(Buffer.from(made.bytes), {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `${c.req.query('download') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(made.name)}`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  });

  app.post('/api/v1/invoices/from-email', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    if (!ctx.rules.work) return c.json({ error: 'Your role can’t make invoices in this workspace.' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { thread?: unknown; kind?: unknown };
    if (typeof body.thread !== 'string' || body.thread.length > 200) return c.json({ error: 'Which email?' }, 400);
    const kind = body.kind === 'quote' ? 'quote' : body.kind === 'invoice' ? 'invoice' : null;
    if (!kind) return c.json({ error: 'An invoice or a quote?' }, 400);
    const r = await invoiceFromThread(ctx.workspaceId, body.thread, kind);
    if (!r.ok) return c.json({ error: r.error }, r.status as 400);
    return c.json({ invoice: { id: r.invoice.id, number: r.invoice.number, lines: r.invoice.items.filter((l) => l.unitPrice).length } });
  });

  app.post('/api/v1/invoices/:id/attachment', requireWorkspace, async (c) => {
    const ctx = ctxOf(c);
    if (!ctx.rules.work) return c.json({ error: 'Your role can’t send invoices in this workspace.' }, 403);
    const made = await render(ctx.workspaceId, c.req.param('id'));
    if (!made) return c.json({ error: 'That invoice isn’t in this workspace.' }, 404);
    // Kept the way a file from the person's computer is: announced, then received and checked by size and kind.
    const who = { workspaceId: ctx.workspaceId, userId: ctx.user.id, mayWork: ctx.rules.work };
    const announced = await announceUpload(who, { purpose: 'attachment', type: 'application/pdf', size: made.bytes.length, name: made.name });
    if (!announced.ok) return c.json({ error: announced.reason }, announced.status as 400);
    const got = await receiveUpload(who, announced.asset.id, made.bytes, 'application/pdf');
    if (!got.ok) return c.json({ error: got.reason }, got.status as 400);
    return c.json({ file: { id: got.asset.id, name: made.name, type: 'application/pdf', size: made.bytes.length } });
  });
}
