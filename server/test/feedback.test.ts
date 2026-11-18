/**
 * Feedback sent from inside Timmy (src/http/feedback.ts): anyone signed in can send a few words; it is kept for the
 * people who run Timmy (the app's own role can't read it), logged, and emailed once an address is set.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { withWorkspace } from '../src/db/pool';
import { recent } from '../src/lib/log';
import { boot, newWorkspace, rows, sysPool, type Client } from './helpers';

let w: Client;
const send = (c: Client, body: unknown) => c.request('POST', '/api/v1/feedback', body);
const mine = () => rows<{ text: string; page: string | null; workspace_name: string | null; user_email: string }>(`select text, page, workspace_name, user_email from feedback where user_id = $1 order by id`, [w.userId]);

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  w = await newWorkspace('Feedback Co');
  config.mail.feedbackTo = '';
});

describe('sending feedback', () => {
  it('is kept with who sent it, their workspace and the screen’s name, and logged', async () => {
    const r = await send(w, { text: '  The archive button moved!  ', page: 'today/triage' });
    expect(r.status).toBe(200);
    expect(await mine()).toEqual([{ text: 'The archive button moved!', page: 'today/triage', workspace_name: 'Feedback Co', user_email: w.email }]);
    expect(recent.some((l) => l.includes('beta feedback') && l.includes('The archive button moved!'))).toBe(true);
    // No address set: nothing is emailed.
    expect(await rows(`select 1 from email_outbox where kind = 'feedback'`)).toHaveLength(0);
  });

  it('only the screen’s name goes with it, never anything else a page might send', async () => {
    await send(w, { text: 'Hello there', page: 'thread/<script>alert(1)</script>?id=secret' });
    expect((await mine())[0]!.page).toBeNull();
  });

  it('is emailed to the address set for it', async () => {
    config.mail.feedbackTo = 'team@timmy.test';
    await send(w, { text: 'Drafts are great.', page: 'today/drafts' });
    const [mail] = await rows<{ to_address: string; subject: string; body: string }>(`select to_address, subject, body from email_outbox where kind = 'feedback' order by id desc limit 1`);
    expect(mail).toMatchObject({ to_address: 'team@timmy.test', subject: 'Timmy feedback from Feedback Co Owner' });
    expect(mail!.body).toContain('Drafts are great.');
    expect(mail!.body).toContain('on today/drafts');
  });

  it('needs a sign-in and a few words, up to 5,000 characters, and a bounded number a day', async () => {
    expect((await (await boot()).request('/api/v1/feedback', { method: 'POST', headers: { origin: 'http://localhost:8787', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi there' }) })).status).toBe(401);
    expect((await send(w, { text: ' ' })).status).toBe(400);
    expect((await send(w, { text: 'x'.repeat(5001) })).status).toBe(400);
    await sysPool.query(`insert into feedback (user_id, text) select $1, 'filler' from generate_series(1, 30)`, [w.userId]);
    expect((await send(w, { text: 'One more thing' })).status).toBe(429);
  });

  it('the app’s own database role can’t read it', async () => {
    await send(w, { text: 'Private to the team' });
    await expect(withWorkspace({ workspaceId: w.workspaceId }, (tx) => tx.query('select * from feedback'))).rejects.toThrow(/permission denied/);
  });
});
