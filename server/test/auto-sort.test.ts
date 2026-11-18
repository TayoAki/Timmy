/**
 * Sorting mail automatically (src/sync/sorting.ts). It is a rule an owner or admin switches on. While it is on,
 * junk plain code is sure of is filed as it arrives; mail a person wrote always waits in Triage. Inside Timmy the
 * rule also files what was already waiting; in the mailbox it files only mail that arrived after it was switched on,
 * and each of those writes is an effect the rule approves.
 */
import { CASES } from '../scripts/sorting-eval/cases';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EffectRow } from '../src/gateway/gateway';
import { suggest, sortsItself } from '../src/sync/sorting';
import { addMember, boot, connectGmail, fake, jobs, model, newWorkspace, rows, type Client } from './helpers';

let w: Client;
let box: { connectionId: string; account: string };

const filings = () => rows<EffectRow>(`select * from effect where workspace_id = $1 and kind = 'mail.modify' order by created_at, id`, [w.workspaceId]);
const writes = () => fake().calls.filter((c) => c.connectedAccountId === box.account && c.slug === 'GMAIL_MODIFY_THREAD_LABELS');
/** A message reaches the stand-in mailbox and Composio announces it, as a real one would. */
const deliver = async (m: { from: string; subject: string; body?: string; labels?: string[]; at?: Date }) => {
  const d = fake().deliver(box.account, { body: 'Hello there.', ...m });
  await (await boot()).request('/api/hooks/composio', { method: 'POST', headers: d.webhook.headers, body: d.webhook.body });
  await jobs().drain();
  return (await w.state()).threads.find((t) => t.subject === m.subject)!;
};
const promo = (subject: string, at?: Date) => deliver({ from: 'Shop <deals@shop.test>', subject, labels: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'], at });
const person = (subject: string) => deliver({ from: 'Dana Whitfield <dana@acme.test>', subject, body: 'Could you look at the contract before Friday?' });
const patchSettings = async (body: Record<string, unknown>, c: Client = w) => {
  const r = await c.request('PATCH', '/api/v1/settings', body);
  return { status: r.status, body: (await r.json().catch(() => ({}))) as { sorted?: Record<string, number> } };
};
const switchSorting = (on: boolean, c: Client = w) => patchSettings({ autoSort: on }, c);
const settings = () => w.json<{ autoSort: { on: boolean } }>('GET', '/api/v1/settings');

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  model().reset();
  jobs().queue = [];
  w = await newWorkspace('Sorting');
  box = await connectGmail(w, 'owner@sorting.test');
  await jobs().drain();
});

describe('the first sort', () => {
  it('puts Gmail’s Promotions and Social tabs in the archive, and is sure of it', () => {
    for (const tab of ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL']) {
      expect(suggest({ sender: 'anna@brand.test', subject: 'Our autumn sale', text: 'Hi', labels: ['INBOX', tab] })).toMatchObject({ box: 'archived', confidence: 'high' });
    }
  });

  it('is sure of a system sender, and only guesses at addresses a small business’s person might use', () => {
    expect(suggest({ sender: 'no-reply@service.test', subject: 'Your code', text: 'Code: 1234', labels: [] })).toMatchObject({ box: 'archived', confidence: 'high' });
    expect(suggest({ sender: 'notifications@github.test', subject: 'New issue', text: 'x', labels: [] })).toMatchObject({ box: 'archived', confidence: 'high' });
    expect(suggest({ sender: 'hello@smallstudio.test', subject: 'Following up on our call', text: 'x', labels: [] })).toMatchObject({ confidence: 'medium' });
    expect(suggest({ sender: 'info@vendor.test', subject: 'Quote', text: 'x', labels: [] })).toMatchObject({ confidence: 'medium' });
  });

  it('leaves mail a person wrote for the model and the person', () => {
    expect(suggest({ sender: 'dana@acme.test', subject: 'Contract', text: 'Can you look?', labels: ['INBOX'] })).toMatchObject({ provisional: true, confidence: 'low' });
  });

  it('is never sure and wrong on the sorting evaluation’s emails (scripts/sorting-eval): what it is unsure of goes to the model', () => {
    for (const c of CASES) {
      const s = suggest({ sender: c.sender, subject: c.subject, text: c.text, labels: c.labels });
      if (!s.provisional) expect({ id: c.id, box: s.box }).toEqual({ id: c.id, box: c.expect });
    }
    // Everything that needs the person is left for the model, never decided by plain code.
    for (const c of CASES.filter((x) => x.expect === 'follow-up')) expect({ id: c.id, provisional: suggest(c).provisional }).toEqual({ id: c.id, provisional: true });
  });

  it('leaves for the model what may ask something of the person, even from a tool or a mailing list', () => {
    const left = (m: { sender: string; subject: string; text: string; labels?: string[] }) => suggest({ labels: [], ...m }).provisional;
    // A new invitation asks for an answer; a reply to one doesn't.
    expect(left({ sender: 'lee@northpeak.test', subject: 'Invitation: Beta review @ Thu', text: 'Going? Yes - Maybe - No' })).toBe(true);
    expect(suggest({ sender: 'lee@northpeak.test', subject: 'Accepted: Beta review @ Thu', text: '', labels: [] })).toMatchObject({ box: 'archived', confidence: 'high' });
    // A tool asking the person to sign, review or answer a mention.
    expect(left({ sender: 'dse@docusign.net', subject: 'Please DocuSign: MSA', text: 'Dana sent you a document to review and sign.' })).toBe(true);
    expect(left({ sender: 'notifications@github.test', subject: '[repo] PR #4', text: '@sam requested your review on PR #4. Unsubscribe' })).toBe(true);
    // A question about an invoice from the people who sent it is not a receipt.
    expect(left({ sender: 'billing.team@printhaus.test', subject: 'PO number for invoice 4471', text: 'Could you reply with the PO?' })).toBe(true);
    // A person writing through a sending tool (an unsubscribe line at the foot): a client or a pitch, only reading tells.
    expect(left({ sender: 'kim.ortega@lumen.test', subject: 'Re: Proposal', text: 'Can you confirm the start date?\n\nUnsubscribe' })).toBe(true);
  });

  it('is sure of digests and notices from tools, of selling, and of newsletters, wherever Gmail puts them', () => {
    expect(suggest({ sender: 'notification@slack.test', subject: 'You have 5 unread messages', text: 'Catch up. Unsubscribe', labels: [] })).toMatchObject({ box: 'archived', confidence: 'high' });
    expect(suggest({ sender: 'drive-shares-dm-noreply@google.test', subject: 'Shared with you', text: 'Open', labels: [] })).toMatchObject({ box: 'archived', confidence: 'high' });
    expect(suggest({ sender: 'news@shop.test', subject: 'Weekly deals', text: 'Big savings. Unsubscribe', labels: [] })).toMatchObject({ box: 'archived', confidence: 'high' });
    // A newsletter that Gmail filed under Promotions is still a newsletter.
    expect(suggest({ sender: 'crew@morningbrew.test', subject: 'Ad spend rebounds', text: 'Good morning. View in browser. Unsubscribe', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] })).toMatchObject({ box: 'read-through', confidence: 'high' });
    expect(suggest({ sender: 'lenny@substack.com', subject: 'Your first 100 calls', text: 'Read in app. Unsubscribe', labels: [] })).toMatchObject({ box: 'read-through', confidence: 'high' });
    // A bulk mailing it can't place is a guess, never filed by the rule.
    expect(suggest({ sender: 'events@vendor.test', subject: 'November', text: 'Things happened. Unsubscribe', labels: [] })).toMatchObject({ confidence: 'medium' });
  });

  it('the rule only takes plain code’s sure calls on junk and newsletters, never the model’s and never a person’s mail', () => {
    const base = { id: 't', subject: 's', ask: '', box: 'inbox' as const, participants: [], messages: [] };
    expect(sortsItself({ ...base, suggestion: { box: 'archived', confidence: 'high', reason: 'A receipt or order notice. Nothing to answer.' } })).toBe(true);
    expect(sortsItself({ ...base, suggestion: { box: 'read-through', confidence: 'high', reason: 'A newsletter or bulk mailing. Read it when you have time.' } })).toBe(true);
    expect(sortsItself({ ...base, suggestion: { box: 'archived', confidence: 'medium', reason: 'An automated notice from a system, not a person.' } })).toBe(false);
    // The model said it needs nothing, and is sure: still the person's call.
    expect(sortsItself({ ...base, suggestion: { box: 'archived', confidence: 'high', reason: 'A thank-you that needs no reply.' } })).toBe(false);
    expect(sortsItself({ ...base, box: 'follow-up', suggestion: { box: 'archived', confidence: 'high', reason: 'A receipt or order notice. Nothing to answer.' } })).toBe(false);
  });
});

describe('with the rule off', () => {
  it('files nothing by itself: junk waits in Triage with its suggestion, and nothing is written to the mailbox', async () => {
    const t = await promo('Big sale today');
    expect(t).toMatchObject({ box: 'inbox', suggestion: { box: 'archived', confidence: 'high' } });
    expect(await filings()).toHaveLength(0);
    expect(writes()).toHaveLength(0);
    expect((await settings()).autoSort).toEqual({ on: false });
  });
});

describe('switching the rule on', () => {
  it('only an owner or admin may, and it is recorded as a rule naming them', async () => {
    const member = await addMember(w.workspaceId, 'member', 'Mo Member');
    expect((await switchSorting(true, member)).status).toBe(403);
    expect((await switchSorting(true)).status).toBe(200);
    const [rule] = await rows<{ kind: string; scope: unknown; created_by: string; enabled: boolean }>(`select kind, scope, created_by, enabled from policy where workspace_id = $1`, [w.workspaceId]);
    expect(rule).toEqual({ kind: 'mail.modify', scope: { sort: 'automatic' }, created_by: w.userId, enabled: true });
    expect((await settings()).autoSort.on).toBe(true);
    const log = await rows<{ action: string }>(`select action from audit_log where workspace_id = $1 and action like 'autosort.%'`, [w.workspaceId]);
    expect(log.map((l) => l.action)).toEqual(['autosort.switched_on']);
    expect((await patchSettings({ autoSort: 'yes' })).status).toBe(400);
  });

  it('files the junk already waiting inside Timmy only, and leaves mail a person wrote', async () => {
    await promo('Old sale');
    await deliver({ from: 'Billing <receipts@saas.test>', subject: 'Your receipt #1042' });
    await deliver({ from: 'Weekly <editor@letters.test>', subject: 'This week in design', body: 'Stories you missed. Unsubscribe here.' });
    await person('The contract');
    const r = await switchSorting(true);
    expect(r.body.sorted).toEqual({ archived: 2, 'read-through': 1 });
    const s = await w.state();
    const where = Object.fromEntries(s.threads.map((t) => [t.subject, t.box]));
    expect(where).toMatchObject({ 'Old sale': 'archived', 'Your receipt #1042': 'archived', 'This week in design': 'read-through', 'The contract': 'inbox' });
    // Said once, on the activity log, and on each thread's own history.
    expect(s.activity[0]!.text).toMatch(/Timmy sorted 3 emails on its own: 2 archived and 1 to Read Through/);
    expect(s.threads.find((t) => t.subject === 'Old sale')!.history?.at(-1)?.text).toMatch(/on its own/);
    // What was already there stays as it was in Gmail.
    await jobs().drain();
    expect(await filings()).toHaveLength(0);
    expect(writes()).toHaveLength(0);
  });

  it('applies what plain code knows now to threads sorted before (a promotion once sent to Read Through is archived)', async () => {
    const t = await promo('Flash sale');
    // As the first sort used to leave a promotion: a bulk mailing, to read later.
    const { mutate } = await import('../src/state/mutate');
    await mutate(w.workspaceId, 'test', async (_tx, loaded) => ({
      state: { ...loaded.state, threads: loaded.state.threads.map((x) => (x.id === t.id ? { ...x, suggestion: { box: 'read-through' as const, confidence: 'high' as const, reason: 'A newsletter or bulk mailing. Read it when you have time.' } } : x)) },
      result: null,
    }));
    await switchSorting(true);
    expect((await w.state()).threads.find((x) => x.id === t.id)!.box).toBe('archived');
  });

  it('a large inbox is sorted in several writes, each a modest change, with one line on the activity log', async () => {
    for (let i = 0; i < 5; i++) await promo(`Sale number ${i}`);
    await person('A person in the middle');
    const { setAutoSort, sortWhatIsWaiting } = await import('../src/sync/sorting');
    const { withWorkspace } = await import('../src/db/pool');
    await withWorkspace({ workspaceId: w.workspaceId }, (tx) => setAutoSort(tx, w.workspaceId, w.userId, true));
    const before = (await rows<{ n: number }>(`select count(*)::int as n from state_change where workspace_id = $1`, [w.workspaceId]))[0]!.n;
    expect(await sortWhatIsWaiting(w.workspaceId, 2)).toEqual({ archived: 5 });
    const writes = (await rows<{ n: number }>(`select count(*)::int as n from state_change where workspace_id = $1`, [w.workspaceId]))[0]!.n - before;
    // Three writes of two threads each, then the activity line.
    expect(writes).toBe(4);
    const s = await w.state();
    expect(s.threads.filter((t) => /^Sale number/.test(t.subject)).every((t) => t.box === 'archived')).toBe(true);
    expect(s.threads.find((t) => t.subject === 'A person in the middle')!.box).toBe('inbox');
    expect(s.activity.filter((a) => /sorted \d+ emails? on its own/.test(a.text))).toHaveLength(1);
  });

  it('switching it on twice changes nothing the second time', async () => {
    await switchSorting(true);
    await switchSorting(true);
    expect(await rows(`select 1 from policy where workspace_id = $1`, [w.workspaceId])).toHaveLength(1);
  });
});

describe('with the rule on, new mail', () => {
  beforeEach(async () => {
    await switchSorting(true);
  });

  it('files junk as it arrives, in Timmy and in Gmail, through an effect the rule approves', async () => {
    const t = await promo('Weekend offer');
    expect(t.box).toBe('archived');
    const [e] = await filings();
    expect(e).toMatchObject({ kind: 'mail.modify', source: 'rule', approved_via: 'rule', requested_by: 'system' });
    expect(e!.payload).toMatchObject({ box: 'archived', threadKey: t.ext!.threadKey });
    expect(e!.policy_id).toBeTruthy();
    await jobs().drain();
    expect((await filings())[0]!.status).toBe('completed');
    expect(writes()).toHaveLength(1);
    const labels = (await w.json<{ threads: Record<string, string[]> }>('POST', '/api/test/fake', { op: 'labels' })).threads['Weekend offer'];
    expect(labels).not.toContain('INBOX');
  });

  it('never files mail a person wrote', async () => {
    const t = await person('Can we meet Tuesday?');
    expect(t.box).toBe('inbox');
    await jobs().drain();
    expect(await filings()).toHaveLength(0);
  });

  it('files mail that arrived before the rule was switched on inside Timmy only (a backfill catching up)', async () => {
    const t = await promo('Last month’s sale', new Date(Date.now() - 10 * 86400_000));
    expect(t.box).toBe('archived');
    await jobs().drain();
    expect(await filings()).toHaveLength(0);
    expect(writes()).toHaveLength(0);
  });

  it('files a thread once, however often the same mail is seen', async () => {
    const t = await promo('Repeat offer');
    await jobs().enqueue('mail.reconcile.all', {});
    await jobs().drain();
    expect((await w.state()).threads.find((x) => x.id === t.id)!.box).toBe('archived');
    expect(await filings()).toHaveLength(1);
  });

  it('with sending switched off, still sorts inside Timmy but writes nothing to the mailbox', async () => {
    await patchSettings({ killSwitch: true });
    const t = await promo('Quiet offer');
    expect(t.box).toBe('archived');
    await jobs().drain();
    expect(await filings()).toHaveLength(0);
    expect(writes()).toHaveLength(0);
  });

  it('switched off again, junk waits in Triage once more', async () => {
    await switchSorting(false);
    const t = await promo('After the switch');
    expect(t.box).toBe('inbox');
    expect(await filings()).toHaveLength(0);
    expect(await rows(`select 1 from policy where workspace_id = $1 and enabled`, [w.workspaceId])).toHaveLength(0);
  });
});

describe('a rule is the only way in', () => {
  it('a filing proposed by an unattended run without the rule’s mark still waits for a person', async () => {
    await switchSorting(true);
    const t = await person('Needs a person');
    const { propose } = await import('../src/gateway/gateway');
    const { filingProposal } = await import('../src/sync/labels');
    const { mutate } = await import('../src/state/mutate');
    const outcome = await mutate(w.workspaceId, 'test', async (tx, loaded) => {
      const p = await propose(tx, loaded, loaded.state, null, { ...filingProposal(t, 'archived')!, why: 'test', idempotencyKey: 'probe:no-mark', source: 'routine' });
      return { state: p.state, result: p.outcome };
    });
    expect(outcome).toBe('waiting');
  });
});

describe('running what was approved', () => {
  it('the job that runs an approved filing is queued only once its transaction has committed, and never after a rollback', async () => {
    await switchSorting(true);
    const t = await person('Queued after commit');
    const { propose } = await import('../src/gateway/gateway');
    const { filingProposal } = await import('../src/sync/labels');
    const { mutate } = await import('../src/state/mutate');
    const { AUTO_SORT_SCOPE } = await import('../src/sync/sorting');
    const queued = () => jobs().queue.filter((j) => j.name === 'effect.execute').length;
    jobs().queue = [];
    let inside = -1;
    await mutate(w.workspaceId, 'test', async (tx, loaded) => {
      const p = await propose(tx, loaded, loaded.state, null, { ...filingProposal(t, 'archived')!, why: 'test', idempotencyKey: 'probe:commit', source: 'rule', meta: { ...AUTO_SORT_SCOPE } });
      expect(p.outcome).toBe('approved');
      inside = queued();
      return { state: p.state, result: null };
    });
    expect(inside).toBe(0);
    expect(queued()).toBe(1);

    jobs().queue = [];
    await expect(
      mutate(w.workspaceId, 'test', async (tx, loaded) => {
        await propose(tx, loaded, loaded.state, null, { ...filingProposal(t, 'read-through')!, why: 'test', idempotencyKey: 'probe:rollback', source: 'rule', meta: { ...AUTO_SORT_SCOPE } });
        throw new Error('changed my mind');
      }),
    ).rejects.toThrow('changed my mind');
    expect(queued()).toBe(0);
    expect(await rows(`select 1 from effect where idempotency_key = 'probe:rollback'`)).toHaveLength(0);
  });
});

describe('sorting again after the rules improved (Nov 18)', () => {
  const OLD_RULE = 'Timmy filed this under Read Through on its own, as the rule to sort mail automatically says. A newsletter or bulk mailing. Read it when you have time.';
  /** Puts a thread where the old first sort left it. */
  const asBefore = async (id: string, patch: Record<string, unknown>) => {
    const { mutate } = await import('../src/state/mutate');
    await mutate(w.workspaceId, 'test', async (_tx, loaded) => ({ state: { ...loaded.state, threads: loaded.state.threads.map((x) => (x.id === id ? { ...x, ...patch } : x)) }, result: null }));
  };
  const resort = async () => {
    await jobs().enqueue('mail.resort', { workspaceId: w.workspaceId });
    await jobs().drain();
  };

  it('brings back what may need the person, archives digests, keeps real newsletters, and leaves what a person placed', async () => {
    const digest = await deliver({ from: 'Slack <notification@slack.test>', subject: 'You have 5 unread messages', body: 'Catch up on #sales. Unsubscribe' });
    const client = await deliver({ from: 'Kim Ortega <kim.ortega@lumen.test>', subject: 'Proposal timing', body: 'Can you confirm the start date?\n\nUnsubscribe' });
    const letter = await deliver({ from: 'Lenny <lenny@substack.com>', subject: 'Your first 100 calls', body: 'Read in app. Unsubscribe' });
    const mine = await deliver({ from: 'Pat <pat@club.test>', subject: 'Club news', body: 'Can you come Saturday? Unsubscribe' });
    const invoice = await deliver({ from: 'PrintHaus <billing.team@printhaus.test>', subject: 'PO number for invoice 4471', body: 'Could you reply with the PO?' });
    const filed = { box: 'read-through', suggestion: undefined, history: [{ at: new Date(), text: OLD_RULE }] };
    for (const t of [digest, client, letter]) await asBefore(t.id, filed);
    // One the person put in Read Through themselves.
    await asBefore(mine.id, { box: 'read-through', suggestion: undefined, history: [{ at: new Date(), text: 'You moved it under Read Through' }] });
    // One the old first sort called a receipt, still waiting in Triage.
    await asBefore(invoice.id, { suggestion: { box: 'archived', confidence: 'high', reason: 'A receipt or order notice. Nothing to answer.' } });
    model().reset();
    const calls = writes().length;

    await resort();
    const s = await w.state();
    const at = (id: string) => s.threads.find((t) => t.id === id)!;
    expect(at(client.id).box).toBe('inbox');
    expect(at(client.id).history?.some((h) => /put this back in Triage: its sorting rules improved/.test(h.text))).toBe(true);
    expect(at(digest.id).box).toBe('archived');
    expect(at(letter.id).box).toBe('read-through');
    expect(at(mine.id).box).toBe('read-through');
    expect(at(invoice.id).box).toBe('inbox');
    // The two that may need the person were read by the model.
    const read = model().requests.filter((r) => r.route === 'read').map((r) => r.messages.at(-1)!.content);
    expect(read).toHaveLength(2);
    expect(read.some((c) => c.includes('Proposal timing')) && read.some((c) => c.includes('PO number for invoice 4471'))).toBe(true);
    expect(at(invoice.id).suggestion?.provisional).toBeFalsy();
    expect(s.activity[0]!.text).toMatch(/Timmy sorted your mail again with better rules: 1 back to Triage because they may need you, 1 digests and notices archived, 1 suggestions in Triage redone\. Nothing changed in your mailbox\./);
    // Inside Timmy only.
    expect(writes().length).toBe(calls);
  });

  it('runs once per workspace', async () => {
    const client = await deliver({ from: 'Kim Ortega <kim.ortega@lumen.test>', subject: 'Proposal timing', body: 'Can you confirm the start date?\n\nUnsubscribe' });
    await asBefore(client.id, { box: 'read-through', suggestion: undefined, history: [{ at: new Date(), text: OLD_RULE }] });
    await resort();
    expect((await w.state()).threads.find((t) => t.id === client.id)!.box).toBe('inbox');
    // Put back where it was: a second run changes nothing.
    await asBefore(client.id, { box: 'read-through', history: [{ at: new Date(), text: OLD_RULE }] });
    await resort();
    expect((await w.state()).threads.find((t) => t.id === client.id)!.box).toBe('read-through');
    expect(await rows(`select 1 from audit_log where workspace_id = $1 and action = 'sorting.resorted'`, [w.workspaceId])).toHaveLength(1);
  });
});
