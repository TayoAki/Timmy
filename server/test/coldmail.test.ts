/**
 * Cold email is never sent through the mail provider's API. Timmy writes it; the person sends it
 * from Gmail's own compose window; Timmy learns it was sent, and sees replies, through sync.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { composeLink } from '../../src/live/compose-link';
import { boot, connectGmail, fake, jobs, model, newWorkspace, rows, type Client } from './helpers';

let w: Client;
let box: { connectionId: string; account: string };
const lead = { id: 'lead-lee', first: 'Lee', last: 'Lead', email: 'lee@leadco.test', company: 'LeadCo', title: 'VP Operations', status: 'new', source: 'csv', fit: 70, added: new Date() };

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
});

describe('sending a cold email', () => {
  it('goes nowhere through the provider: no effect, nothing sent, and the lead is not marked contacted', async () => {
    const callsBefore = fake().calls.length;
    const out = await w.cmd({ type: 'out', op: { op: 'send', lead: lead.id, channel: 'email', subject: 'Quick idea for LeadCo', body: 'Hi Lee, a quick idea.' } });
    expect(out.ok).toBe(true);
    expect(out.toast?.text).toMatch(/Gmail/);
    expect(await rows('select 1 from effect where workspace_id = $1', [w.workspaceId])).toEqual([]);
    expect(fake().sent(box.account)).toEqual([]);
    // Not one call to the provider was made for it.
    expect(fake().calls.slice(callsBefore)).toEqual([]);
    const s = await w.state();
    expect(s.out.messages).toEqual([]);
    expect(s.out.leads[lead.id]!.status).toBe('new');
    expect(s.activity[0]!.text).toMatch(/Opened an email to Lee Lead in Gmail/);
  });

  it('texts and calls stay refused, and so does a campaign that would send by itself', async () => {
    expect((await w.cmd({ type: 'out', op: { op: 'send', lead: lead.id, channel: 'sms', body: 'Text' } })).ok).toBe(false);
    const launch = await w.cmd({ type: 'out', op: { op: 'launch', id: 'camp-1' } });
    expect(launch.ok).toBe(false);
    expect(launch.error).toMatch(/can’t send by itself/);
  });

  it('a link opens the mail app’s own compose window with the email filled in', () => {
    const g = composeLink('gmail', { to: 'lee@leadco.test', subject: 'Quick idea & a question', body: 'Hi Lee,\n\nA quick idea.', from: 'owner@cold.test' });
    const u = new URL(g.url);
    expect(u.origin + u.pathname).toBe('https://mail.google.com/mail/');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ view: 'cm', to: 'lee@leadco.test', su: 'Quick idea & a question', body: 'Hi Lee,\n\nA quick idea.', authuser: 'owner@cold.test' });
    expect(g.bodyFits).toBe(true);
    expect(composeLink('outlook', { to: 'a@b.test', subject: 's', body: 'b' }).url).toMatch(/^https:\/\/outlook\.office\.com\/mail\/deeplink\/compose\?to=a%40b\.test/);
    const long = composeLink('gmail', { to: 'a@b.test', subject: 's', body: 'x'.repeat(9000) });
    expect(long.bodyFits).toBe(false);
    expect(long.url.length).toBeLessThan(400);
  });
});

describe('what sync learns afterwards', () => {
  const announce = async (slug: string, data: Record<string, unknown>) => {
    const { signWebhook } = await import('../src/providers/composio');
    const body = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, metadata: { trigger_slug: slug, connected_account_id: box.account, user_id: 'x' }, data });
    const id = `wh_${Math.random().toString(36).slice(2)}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await (await boot()).request('/api/hooks/composio', { method: 'POST', headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signWebhook(id, ts, body, fake().secret) }, body });
    expect(res.status).toBe(200);
    await jobs().drain();
  };
  const sendFromGmail = () => fake().accounts.get(box.account)!.messages.push({ id: 'sent-1', threadId: 'th-cold-1', from: 'Owner <owner@cold.test>', to: ['lee@leadco.test'], subject: 'Quick idea for LeadCo', body: 'Hi Lee, a quick idea.', at: new Date(), labels: ['SENT'] });

  it('connecting Gmail also listens for sent mail', async () => {
    expect((await rows<{ slug: string }>('select slug from trigger_instance where connection_id = $1 order by slug', [box.connectionId])).map((r) => r.slug)).toEqual(['GMAIL_EMAIL_SENT_TRIGGER', 'GMAIL_NEW_GMAIL_MESSAGE']);
  });

  it('once the email is in Sent, the lead is contacted and the message is in the lead’s history, once', async () => {
    sendFromGmail();
    await announce('GMAIL_EMAIL_SENT_TRIGGER', { thread_id: 'th-cold-1', message_id: 'sent-1' });
    await announce('GMAIL_EMAIL_SENT_TRIGGER', { thread_id: 'th-cold-1', message_id: 'sent-1' });
    const s = await w.state();
    expect(s.out.messages).toHaveLength(1);
    expect(s.out.messages[0]).toMatchObject({ lead: lead.id, channel: 'email', dir: 'out', status: 'sent', subject: 'Quick idea for LeadCo', body: 'Hi Lee, a quick idea.' });
    expect(s.out.leads[lead.id]!.status).toBe('contacted');
  });

  it('mail the person sent to someone who is not a lead changes nothing in Outbound', async () => {
    fake().accounts.get(box.account)!.messages.push({ id: 'sent-2', threadId: 'th-other', from: 'owner@cold.test', to: ['friend@elsewhere.test'], subject: 'Lunch', body: 'Noon?', at: new Date(), labels: ['SENT'] });
    await announce('GMAIL_EMAIL_SENT_TRIGGER', { thread_id: 'th-other', message_id: 'sent-2' });
    const s = await w.state();
    expect(s.out.messages).toEqual([]);
    expect(s.out.leads[lead.id]!.status).toBe('new');
  });

  it('a reply from the lead lands in the Unibox and marks the lead as replied', async () => {
    sendFromGmail();
    await announce('GMAIL_EMAIL_SENT_TRIGGER', { thread_id: 'th-cold-1', message_id: 'sent-1' });
    await w.post('/api/test/fake', { op: 'deliver', message: { from: 'Lee Lead <lee@leadco.test>', subject: 'Re: Quick idea for LeadCo', body: 'Interested. Can we talk Thursday?', threadId: 'th-cold-1' } });
    await jobs().drain();
    const s = await w.state();
    expect(s.out.messages.map((m) => m.dir).sort()).toEqual(['in', 'out']);
    expect(s.out.messages.find((m) => m.dir === 'in')).toMatchObject({ lead: lead.id, channel: 'email', body: 'Interested. Can we talk Thursday?' });
    expect(s.out.leads[lead.id]).toMatchObject({ status: 'replied', unread: true });
    // It is ordinary mail too: the thread is in the inbox with both messages.
    const thread = s.threads.find((t) => t.ext?.threadKey === 'th-cold-1')!;
    expect(thread.messages.map((m) => m.from)).toEqual(['me', 'mail:lee@leadco.test']);
  });

  it('a display name cannot make outside mail look like a lead’s reply', async () => {
    await w.post('/api/test/fake', { op: 'deliver', message: { from: '"lee@leadco.test" <mallory@evil.test>', subject: 'Hello', body: 'I am Lee, honest.' } });
    await jobs().drain();
    const s = await w.state();
    expect(s.out.messages).toEqual([]);
    expect(s.out.leads[lead.id]!.status).toBe('new');
  });
});
