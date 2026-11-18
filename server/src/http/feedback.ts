/**
 * Feedback sent from inside Timmy (the Feedback button, src/live/Feedback.tsx). It goes to the people who run Timmy:
 * kept in the `feedback` table (the system role's; the app's own role can't read it), written to the log, and
 * emailed to TIMMY_FEEDBACK_TO once Timmy's own mail is on. Anyone signed in may send it, with or without a
 * workspace; a person can send a bounded number a day.
 */
import type { Hono } from 'hono';
import { workspacesOf } from '../auth/members';
import { config } from '../config';
import { sysPool } from '../db/pool';
import { log } from '../lib/log';
import { sendMail } from '../providers/email';
import { requireSession, type Env } from './session';

export const FEEDBACK_PER_DAY = 30;

export function feedbackRoutes(app: Hono<Env>) {
  app.post('/api/v1/feedback', requireSession, async (c) => {
    const s = c.get('session');
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; page?: unknown };
    const text = typeof body.text === 'string' ? body.text.replace(/\u0000/g, '').trim() : '';
    if (text.length < 2) return c.json({ error: 'Write a few words first.' }, 400);
    if (text.length > 5000) return c.json({ error: 'Feedback can be up to 5,000 characters.' }, 400);
    // The screen's name only ("today/triage"); anything else a page might send is dropped.
    const page = typeof body.page === 'string' && /^[\w/.:-]{1,120}$/.test(body.page) ? body.page : null;
    const sent = Number((await sysPool.query(`select count(*) as n from feedback where user_id = $1 and created_at > now() - interval '1 day'`, [s.user.id])).rows[0].n);
    if (sent >= FEEDBACK_PER_DAY) return c.json({ error: 'That’s a lot of feedback for one day. Thank you! Send more tomorrow.' }, 429);
    const workspace = s.activeWorkspaceId ? (await workspacesOf(s.user.id)).find((w) => w.id === s.activeWorkspaceId) : undefined;
    const agent = (c.req.header('user-agent') ?? '').slice(0, 300);
    const { rows } = await sysPool.query(
      'insert into feedback (user_id, user_email, workspace_id, workspace_name, text, page, user_agent) values ($1, $2, $3, $4, $5, $6, $7) returning id',
      [s.user.id, s.user.email, workspace?.id ?? null, workspace?.name ?? null, text, page, agent],
    );
    const id = String(rows[0].id);
    log.info('beta feedback', { id, from: s.user.email, workspace: workspace?.name ?? null, page, text: text.slice(0, 2000) });
    if (config.mail.feedbackTo) {
      await sendMail({
        to: config.mail.feedbackTo,
        kind: 'feedback',
        subject: `Timmy feedback from ${s.user.name || s.user.email}`,
        body: `${text}\n\n— ${s.user.name} <${s.user.email}>${workspace ? `, workspace “${workspace.name}”` : ''}${page ? `, on ${page}` : ''}\n${agent}\nFeedback #${id}`,
      }).catch((e) => log.warn('could not queue the feedback email', { error: (e as Error).message }));
    }
    return c.json({ ok: true, id });
  });
}
