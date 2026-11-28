/**
 * Due today (src/state/outbound.ts dueSteps, skipStep; server/src/state/engine.ts; server/src/sync/ingest.ts): the
 * steps of sequences that are the person's to send. On a real workspace a campaign never sends by itself, so:
 *   - every lead's step is due as soon as they join a campaign, and later steps once their wait is up;
 *   - each is written for the lead from the sequence, with no merge field left showing;
 *   - opening a step's email in the mail app marks it, until the email is in Sent, which moves the lead on;
 *   - a step can be skipped; a lead who replied, or opted out, has nothing due;
 *   - an overdue step comes first and says so.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Campaign, Lead, Offer } from '../../src/data/outbound-types';
import { dueSteps } from '../../src/state/outbound';
import { boot, connectGmail, fake, jobs, model, newWorkspace, type Client } from './helpers';

const OFFER: Offer = { name: 'Chair Reminders', product: 'Text reminders for dental practices', audience: 'Dental practices', pain: 'patients miss appointments', hook: 'no-shows', outcome: 'fewer missed appointments', proof: 'Harbor Dental cut no-shows by 30%.', cta: 'Open to a quick call?', icp: { titles: ['Practice Manager'], industries: ['Dental'], minEmployees: 5, maxEmployees: 120 } };
const lead = (id: string, first: string, email: string): Lead => ({ id, first, last: 'Lee', email, company: `${first} Dental`, title: 'Practice Manager', phone: '+1 555 0100', source: 'manual', added: new Date(), status: 'new' });
const campaign = (id: string, status: Campaign['status'] = 'draft'): Campaign => ({
  id,
  name: 'Dental',
  status,
  created: new Date(),
  leads: [],
  steps: [
    { id: 'st1', channel: 'email', wait: 0, variants: [{ id: 'a', subject: '{{offerHook}} at {{companyName}}', body: '{{opener}}\n\nHi {{firstName}}, {{offerProof}} {{offerCta}}\n\n{{senderFirstName}}' }] },
    { id: 'st2', channel: 'email', wait: 3, variants: [{ id: 'a', subject: 'Re: {{companyName}}', body: 'Hi {{firstName}}, floating this back up.' }] },
    { id: 'st3', channel: 'call', wait: 2, variants: [{ id: 'a', subject: '', body: 'Hi {{firstName}}, it’s about {{offerHook}}.' }] },
  ],
  schedule: { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', tz: 'America/New_York' },
  options: { dailyLimit: 20, mailboxes: [], stopOnReply: true, trackOpens: false, unsubscribe: true, plainText: true },
});

describe('steps due today', () => {
  let w: Client;
  let box: { connectionId: string; account: string };
  const state = () => w.state();
  const sendFromMailbox = async (to: string, subject: string) => {
    const d = fake().deliver(box.account, { from: 'owner@due.test', to: [to], subject, body: 'Hi, a quick idea.', labels: ['SENT'] });
    await (await boot()).request('/api/hooks/composio', { method: 'POST', headers: d.webhook.headers, body: d.webhook.body });
    await jobs().drain();
  };

  beforeAll(async () => {
    await boot();
  });
  beforeEach(async () => {
    model().reset();
    jobs().queue = [];
    w = await newWorkspace('Due Co');
    box = await connectGmail(w, 'owner@due.test');
    await jobs().drain();
    await w.cmd({ type: 'out', op: { op: 'offer', offer: OFFER } });
    for (const l of [lead('l-ana', 'Ana', 'ana@ana-dental.test'), lead('l-ben', 'Ben', 'ben@ben-dental.test'), lead('l-cy', 'Cy', 'cy@cy-dental.test')]) expect((await w.cmd({ type: 'out', op: { op: 'addLead', lead: l } })).ok).toBe(true);
    expect((await w.cmd({ type: 'out', op: { op: 'campaign', campaign: campaign('camp-d'), quiet: true } })).ok).toBe(true);
    expect((await w.cmd({ type: 'out', op: { op: 'addToCampaign', id: 'camp-d', leads: ['l-ana', 'l-ben', 'l-cy'] } })).ok).toBe(true);
  });

  it('every lead’s first step is due when they join, written for them with no merge field showing', async () => {
    const due = dueSteps(await state());
    expect(due.map((d) => [d.lead.first, d.step, d.channel])).toEqual([
      ['Ana', 0, 'email'],
      ['Ben', 0, 'email'],
      ['Cy', 0, 'email'],
    ]);
    const ana = due[0]!;
    expect(ana.subject).toBe('no-shows at Ana Dental');
    expect(ana.body).toMatch(/^Hi Ana, Harbor Dental cut no-shows by 30%\. Open to a quick call\?/);
    expect(ana.body).not.toMatch(/\{\{/);
    expect(ana.overdue).toBe(false);
  });

  it('opening a step in the mail app marks it until the email is in Sent, which moves the lead on', async () => {
    const opened = await w.cmd({ type: 'out', op: { op: 'send', lead: 'l-ana', channel: 'email', subject: 'no-shows at Ana Dental', body: 'Hi Ana' } });
    expect(opened.ok).toBe(true);
    let ana = dueSteps(await state()).find((d) => d.lead.id === 'l-ana')!;
    expect(ana.opened).toBeInstanceOf(Date);
    // Nothing went out through the provider.
    expect(fake().sent(box.account)).toHaveLength(0);
    await sendFromMailbox('ana@ana-dental.test', 'no-shows at Ana Dental');
    const after = (await state()).out.leads['l-ana']!;
    expect(after).toMatchObject({ step: 1, status: 'contacted' });
    expect(after.openedStep).toBeUndefined();
    // Her next step waits three days, so she has nothing due today.
    ana = dueSteps(await state()).find((d) => d.lead.id === 'l-ana')!;
    expect(ana).toBeUndefined();
  });

  it('a step can be skipped, and a lead who replied has nothing due', async () => {
    expect((await w.cmd({ type: 'out', op: { op: 'skipStep', lead: 'l-ben' } })).ok).toBe(true);
    const ben = (await state()).out.leads['l-ben']!;
    expect(ben.step).toBe(1);
    expect(new Date(ben.nextAt!).getTime()).toBeGreaterThan(Date.now() + 2 * 86_400_000);
    const d = fake().deliver(box.account, { from: 'Cy Lee <cy@cy-dental.test>', subject: 'Re: hello', body: 'Not now, thanks.' });
    await (await boot()).request('/api/hooks/composio', { method: 'POST', headers: d.webhook.headers, body: d.webhook.body });
    await jobs().drain();
    expect((await state()).out.leads['l-cy']!.status).toBe('replied');
    expect(dueSteps(await state()).map((x) => x.lead.first)).toEqual(['Ana']);
  });

  it('a later step is due once its wait is up, the oldest first, saying when it is overdue', async () => {
    const s = await state();
    const yesterday = new Date(Date.now() - 86_400_000 - 3_600_000);
    const crafted = { ...s, out: { ...s.out, leads: { ...s.out.leads, 'l-ben': { ...s.out.leads['l-ben']!, step: 2, nextAt: yesterday }, 'l-cy': { ...s.out.leads['l-cy']!, step: 1, nextAt: new Date(Date.now() + 5 * 86_400_000) } } } };
    const due = dueSteps(crafted);
    expect(due.map((d) => [d.lead.first, d.step, d.channel, d.overdue])).toEqual([
      ['Ben', 2, 'call', true],
      ['Ana', 0, 'email', false],
    ]);
    // A campaign that runs by itself (the demo's launched ones) isn't the person's to work.
    const running = { ...s, out: { ...s.out, campaigns: { ...s.out.campaigns, 'camp-d': { ...s.out.campaigns['camp-d']!, status: 'active' as const } } } };
    expect(dueSteps(running)).toHaveLength(0);
  });
});
