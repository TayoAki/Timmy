/**
 * Replying to a lead who wrote back, and two things a screen may no longer decide for itself.
 *
 * A first cold email still opens the person's own mail app (coldmail.test.ts). Once a lead has written back, a
 * reply typed in the Unibox is an ordinary reply in the lead's thread: an email.reply effect, the approval rules,
 * the undo window, and sent once.
 *
 * Safety properties this file holds:
 *   - no outside write without an approved effect record: the reply waits in its effect, and someone who may not
 *     send from the mailbox waits for its owner;
 *   - no action runs twice: the same command, a retried job or a second release sends nothing more;
 *   - a client's "already approved" is never trusted, and a lead form can't be marked connected on a real workspace.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mutate } from '../src/state/mutate';
import { executeEffect } from '../src/gateway/gateway';
import { addMember, boot, connectGmail, fake, jobs, model, newWorkspace, releaseHolds, rows, type Client } from './helpers';

let w: Client;
let box: { connectionId: string; account: string };
const lead = { id: 'lead-lee', first: 'Lee', last: 'Lead', email: 'lee@leadco.test', company: 'LeadCo', title: 'VP Operations', status: 'new', source: 'csv', fit: 70, added: new Date() };
let mark = 0;
/** Calls that send mail through the provider since the test began. */
const sends = () => fake().calls.slice(mark).filter((c) => /^GMAIL_(SEND_EMAIL|REPLY_TO_THREAD)$/.test(c.slug));
const effects = () => rows<{ id: string; kind: string; status: string; hold_until: Date | null; payload: Record<string, unknown>; requested_by: string; command_id: string | null }>(`select id, kind, status, hold_until, payload, requested_by, command_id from effect where workspace_id = $1 and kind like 'email.%' order by created_at`, [w.workspaceId]);
const reply = (body: string, c: Client = w, id?: string) => c.cmd({ type: 'out', op: { op: 'send', lead: lead.id, channel: 'email', subject: 'Re: Quick idea for LeadCo', body } }, id);

/** Has the provider announce an event to the webhook, signed as it signs them. */
async function announce(slug: string, data: Record<string, unknown>) {
  const { signWebhook } = await import('../src/providers/composio');
  const body = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, metadata: { trigger_slug: slug, connected_account_id: box.account, user_id: 'x' }, data });
  const id = `wh_${Math.random().toString(36).slice(2)}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await (await boot()).request('/api/hooks/composio', { method: 'POST', headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signWebhook(id, ts, body, fake().secret) }, body });
  expect(res.status).toBe(200);
  await jobs().drain();
}

/** The cold email the person sent by hand from Gmail, and the lead's answer to it, both seen by sync. */
async function leadWroteBack(labels?: string[]) {
  fake().accounts.get(box.account)!.messages.push({ id: 'sent-1', threadId: 'th-cold-1', from: 'Owner <owner@cold.test>', to: [lead.email], subject: 'Quick idea for LeadCo', body: 'Hi Lee, a quick idea.', at: new Date(Date.now() - 3600_000), labels: ['SENT'] });
  await announce('GMAIL_EMAIL_SENT_TRIGGER', { thread_id: 'th-cold-1', message_id: 'sent-1' });
  await w.post('/api/test/fake', { op: 'deliver', message: { from: 'Lee Lead <lee@leadco.test>', subject: 'Re: Quick idea for LeadCo', body: 'Interested. Can we talk Thursday?', threadId: 'th-cold-1', ...(labels ? { labels } : {}) } });
  await jobs().drain();
  mark = fake().calls.length;
}

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  model().reset();
  jobs().queue = [];
  w = await newWorkspace('Cold');
  box = await connectGmail(w, 'owner@cold.test');
  await jobs().drain();
  await w.cmd({ type: 'out', op: { op: 'addLead', lead } });
  mark = fake().calls.length;
});

describe('replying in the Unibox to a lead who wrote back', () => {
  it('is an email.reply in the lead’s own thread, held for the undo window, then sent once', async () => {
    await leadWroteBack();
    const before = await w.state();
    expect(before.out.messages.some((m) => m.lead === lead.id && m.dir === 'in')).toBe(true);
    const thread = before.threads.find((t) => t.ext?.threadKey === 'th-cold-1')!;

    const out = await reply('Thursday at 10 works. Talk then.');
    expect(out.ok).toBe(true);
    expect(out.holding?.seconds).toBe(30);
    expect(out.toast?.text).toBe('Sending in 30 seconds. Undo to stop it.');
    const [e] = await effects();
    expect(e).toMatchObject({ kind: 'email.reply', status: 'approved', requested_by: w.userId, command_id: out.id, payload: expect.objectContaining({ threadKey: 'th-cold-1', to: ['lee@leadco.test'], body: 'Thursday at 10 works. Talk then.' }) });
    expect(e!.hold_until).not.toBeNull();
    // On the screens: the thread holds the reply, and no mail app was involved.
    const s = await w.state();
    const after = s.threads.find((t) => t.id === thread.id)!;
    expect(after.messages.at(-1)).toMatchObject({ from: 'me', to: ['mail:lee@leadco.test'], body: ['Thursday at 10 works. Talk then.'] });
    expect(after.draft).toBeUndefined();
    expect(s.activity.some((a) => /Opened an email to Lee Lead/.test(a.text))).toBe(false);

    // Nothing leaves during the hold, however often the job runs.
    await jobs().drain();
    await executeEffect(w.workspaceId, e!.id);
    expect(sends()).toEqual([]);
    // The same command again gets the same answer and makes no second effect.
    const again = await reply('Thursday at 10 works. Talk then.', w, out.id);
    expect(again).toMatchObject({ ok: true, rev: out.rev });
    expect(await effects()).toHaveLength(1);

    expect(await releaseHolds(w)).toBe(1);
    await Promise.all([executeEffect(w.workspaceId, e!.id), executeEffect(w.workspaceId, e!.id)]);
    await releaseHolds(w);
    await jobs().drain();
    expect(sends()).toHaveLength(1);
    expect(sends()[0]).toMatchObject({ slug: 'GMAIL_REPLY_TO_THREAD', args: expect.objectContaining({ thread_id: 'th-cold-1', recipient_email: 'lee@leadco.test', message_body: 'Thursday at 10 works. Talk then.' }) });
    expect((await effects())[0]).toMatchObject({ status: 'completed' });

    // When sync sees it in Sent, the Unibox shows it in the lead's history, once.
    await w.post('/api/test/fake', { op: 'deliver', message: { from: 'Lee Lead <lee@leadco.test>', subject: 'Re: Quick idea for LeadCo', body: 'Great, see you then.', threadId: 'th-cold-1' } });
    await jobs().drain();
    const unibox = (await w.state()).out.messages.filter((m) => m.lead === lead.id);
    expect(unibox.filter((m) => m.dir === 'out' && m.body === 'Thursday at 10 works. Talk then.')).toHaveLength(1);
  });

  it('can be undone inside the window: nothing is sent and the thread is as it was', async () => {
    await leadWroteBack();
    const thread = (await w.state()).threads.find((t) => t.ext?.threadKey === 'th-cold-1')!;
    const out = await reply('On second thoughts, Friday?');
    expect(out.ok).toBe(true);
    const undone = await w.cmd({ type: 'undo', command: out.id });
    expect(undone.ok).toBe(true);
    expect(undone.toast?.text).toBe('Undone. Nothing was sent.');
    expect((await effects())[0]).toMatchObject({ status: 'cancelled' });
    await releaseHolds(w);
    await jobs().drain();
    expect(sends()).toEqual([]);
    expect((await w.state()).threads.find((t) => t.id === thread.id)!.messages.map((m) => m.from)).toEqual(['me', 'mail:lee@leadco.test']);
  });

  it('follows the approval rules: a member’s reply from the owner’s mailbox waits for the owner, and goes once approved', async () => {
    await leadWroteBack();
    const mia = await addMember(w.workspaceId, 'member', 'Mia Member');
    const out = await reply('Thursday works for us.', mia);
    expect(out.ok).toBe(true);
    expect(out.toast?.text).toMatch(/Waiting for the person whose mailbox this is/);
    const [e] = await effects();
    expect(e).toMatchObject({ kind: 'email.reply', status: 'intended', requested_by: mia.userId });
    await releaseHolds(w);
    await jobs().drain();
    expect(sends()).toEqual([]);
    // The member cannot approve it; the owner can.
    expect((await mia.cmd({ type: 'effect', id: e!.id, approve: true })).ok).toBe(false);
    expect((await w.cmd({ type: 'effect', id: e!.id, approve: true })).ok).toBe(true);
    expect(sends()).toEqual([]);
    await releaseHolds(w);
    await jobs().drain();
    expect(sends()).toHaveLength(1);
    // Once it has gone out, the thread shows it as sent.
    const t = (await w.state()).threads.find((x) => x.ext?.threadKey === 'th-cold-1')!;
    expect(t.messages.at(-1)).toMatchObject({ from: 'me', body: ['Thursday works for us.'] });
  });

  it('a lead who never wrote back still gets the first cold email through the mail app, with no effect', async () => {
    const out = await reply('Hi Lee, a quick idea.');
    expect(out.ok).toBe(true);
    expect(out.toast?.text).toMatch(/Opened in Gmail/);
    expect(await effects()).toEqual([]);
    expect(sends()).toEqual([]);
  });

  it('a reply with nothing in it is refused and sends nothing', async () => {
    await leadWroteBack();
    const empty = await reply('   ');
    expect(empty.ok).toBe(false);
    expect(empty.error).toBe('Write your reply to Lee first.');
    expect(await effects()).toEqual([]);
  });

  it('a reply to an email Timmy doesn’t hold as a thread is refused, not sent some other way', async () => {
    await leadWroteBack(['UNREAD']);
    // The reply arrived outside the inbox: it is in the lead's history but is not a thread Timmy shows.
    const s = await w.state();
    expect(s.out.messages.some((m) => m.lead === lead.id && m.dir === 'in')).toBe(true);
    expect(s.threads.some((t) => t.ext?.threadKey === 'th-cold-1')).toBe(false);
    const out = await reply('Thursday works.');
    expect(out.ok).toBe(false);
    expect(out.error).toBe('Lee wrote back, but that email isn’t in Timmy’s inbox, so Timmy can’t reply in that thread. Reply from your mail app instead.');
    expect(await effects()).toEqual([]);
    expect(sends()).toEqual([]);
  });
});

describe('what a screen may not decide for itself', () => {
  /** As if CRM sync were on with RevOps signing off, which can't be switched on for real yet: set straight in the stored state. */
  async function crmWithRevOps() {
    await mutate(w.workspaceId, 'test', async (_tx, loaded) => ({
      state: {
        ...loaded.state,
        conn: { ...loaded.state.conn, apps: { ...loaded.state.conn.apps, hubspot: { connected: true } as never }, crm: { ...loaded.state.conn.crm, approver: 'revops', revops: 'Rae RevOps' } },
        deals: { d1: { id: 'd1', company: 'Globex', name: 'Renewal', stage: 'Proposal sent', value: 1000, contact: 'mail:sam@globex.test', lastTouch: '', next: '', owner: 'me' } },
      },
      result: null,
    }));
  }

  it('a client-sent approved: true is ignored: the hold it would skip still applies, and it is not kept', async () => {
    await crmWithRevOps();
    for (const action of [
      { type: 'applyDeal', id: 'd1', approved: true },
      { type: 'editDeal', id: 'd1', stage: 'Closed won', value: 5000, approved: true },
    ]) {
      const out = await w.cmd(action);
      expect(out.ok, JSON.stringify(action)).toBe(true);
      const s = await w.state();
      // Not applied: it waits for RevOps like any CRM write.
      expect(s.deals.d1).toMatchObject({ stage: 'Proposal sent', value: 1000 });
      expect(s.conn.held.map((h) => h.key)).toEqual(['crm:d1']);
      const [stored] = await rows<{ action: Record<string, unknown> }>(`select action from command where workspace_id = $1 and id = $2`, [w.workspaceId, out.id]);
      expect(stored!.action).not.toHaveProperty('approved');
    }
  });

  it('a send marked approved by the client is approved by the server’s rules alone', async () => {
    await w.post('/api/test/fake', { op: 'deliver', message: { from: 'Dana <dana@client.test>', subject: 'Question', body: 'Could you confirm?' } });
    await jobs().drain();
    const thread = (await w.state()).threads.find((t) => t.subject === 'Question')!;
    expect((await w.cmd({ type: 'makeDraft', id: thread.id })).ok).toBe(true);
    await jobs().drain();
    const mia = await addMember(w.workspaceId, 'member', 'Mia Member');
    const out = await mia.cmd({ type: 'sendDraft', id: thread.id, track: false, approved: true });
    expect(out.ok).toBe(true);
    // A member sending from the owner's mailbox still waits for the owner.
    expect((await effects())[0]).toMatchObject({ status: 'intended', requested_by: mia.userId });
    const [stored] = await rows<{ action: Record<string, unknown> }>(`select action from command where workspace_id = $1 and id = $2`, [w.workspaceId, out.id]);
    expect(stored!.action).not.toHaveProperty('approved');
    await releaseHolds(w);
    expect(sends()).toEqual([]);
  });

  it('a lead form can’t be marked connected on a real workspace, nor changed', async () => {
    await mutate(w.workspaceId, 'test', async (_tx, loaded) => ({
      state: { ...loaded.state, out: { ...loaded.state.out, forms: { 'form-1': { id: 'form-1', name: 'Website form', kind: 'website', connected: false, sla: 5, template: 'tpl-speed', autoReply: false, textToo: false, slack: false } as never } } },
      result: null,
    }));
    for (const patch of [{ connected: true }, { autoReply: true }]) {
      const out = await w.cmd({ type: 'out', op: { op: 'form', id: 'form-1', patch } });
      expect(out.ok).toBe(false);
      expect(out.error).toBe('Lead forms can’t be connected on a real workspace yet.');
    }
    expect((await w.state()).out.forms['form-1']).toMatchObject({ connected: false, autoReply: false });
  });
});
