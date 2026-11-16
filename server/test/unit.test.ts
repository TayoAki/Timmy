import { describe, expect, it } from 'vitest';
import { applyPatches, diffState, fromWire, toWire, viaWire } from '../../src/live/patches';
import { blankState } from '../../src/live/blank';
import { approverFor, mayDecide, neverAllowed, reachesSomeoneElse, ruleCovers, type Actor } from '../src/gateway/policy';
import { rulesFor } from '../src/auth/roles';
import { redact } from '../src/lib/log';
import { normalize, paragraphs, parseSender } from '../src/sync/ingest';
import { signWebhook, verifyWebhookSignature } from '../src/providers/composio';
import { buildRequestBody } from '../src/providers/model';
import { canonical, hashOf } from '../src/lib/ids';

const blank = () => blankState({ first: 'Ada', company: 'Ada Co' });
const actor = (role: string): Actor => ({ userId: `u-${role}`, name: role, role, rules: rulesFor(role) });

describe('state patches', () => {
  it('a diff applied to the old state gives the new state', () => {
    const a = blank();
    const b = {
      ...a,
      threads: [{ id: 't1', subject: 'Hi', box: 'inbox' as const, participants: ['me'], messages: [{ id: 'm1', from: 'me', to: ['mail:x@y.io'], at: new Date('2026-11-16T10:00:00Z'), body: ['hello'] }], ask: 'x' }],
      rules: a.rules.filter((r) => r.id !== 'r2').map((r) => (r.id === 'r1' ? { ...r, enabled: false } : r)),
      ws: { ...a.ws, tasks: { t9: { id: 't9', title: 'Do it' } } } as unknown as typeof a.ws,
      schedule: { ...a.schedule, time: '07:30' },
      calm: true,
    };
    const patches = viaWire(diffState(a, b));
    const out = applyPatches(a, patches);
    expect(toWire(out.threads)).toBe(toWire(b.threads));
    expect(toWire(out.rules)).toBe(toWire(b.rules));
    expect(toWire(out.ws.tasks)).toBe(toWire(b.ws.tasks));
    expect(out.schedule.time).toBe('07:30');
    expect(out.calm).toBe(true);
    expect(out.threads[0]!.messages[0]!.at).toBeInstanceOf(Date);
  });

  it('keeps array order for inserts at the start, in the middle and at the end', () => {
    const a = { ...blank(), activity: [1, 2, 3].map((i) => ({ id: `a${i}`, at: new Date(), kind: 'send' as const, text: `${i}` })) };
    const mk = (id: string) => ({ id, at: new Date(), kind: 'send' as const, text: id });
    const b = { ...a, activity: [mk('n0'), a.activity[0]!, mk('n1'), a.activity[1]!, a.activity[2]!, mk('n2'), mk('n3')] };
    expect(applyPatches(a, diffState(a, b)).activity.map((x) => x.id)).toEqual(b.activity.map((x) => x.id));
    const c = { ...a, activity: [a.activity[2]!, a.activity[0]!, a.activity[1]!] };
    expect(applyPatches(a, diffState(a, c)).activity.map((x) => x.id)).toEqual(['a3', 'a1', 'a2']);
  });

  it('applying the same patches twice changes nothing more', () => {
    const a = blank();
    const b = { ...a, deals: { d1: { id: 'd1', company: 'X', name: 'X', stage: 'New', value: 1, contact: 'c', lastTouch: '', next: '', owner: 'me' } } };
    const p = diffState(a, b);
    expect(toWire(applyPatches(applyPatches(a, p), p))).toBe(toWire(applyPatches(a, p)));
  });

  it('untouched slices produce no patches, and ui-only fields never travel', () => {
    const a = blank();
    expect(diffState(a, { ...a, route: { view: 'approvals' }, toasts: [{ id: 1, text: 'x' }], searchOpen: true, focus: true })).toEqual([]);
  });

  it('dates survive the wire', () => {
    const d = new Date('2026-11-16T08:12:00.000Z');
    expect(fromWire<{ d: Date }>(toWire({ d })).d.getTime()).toBe(d.getTime());
  });
});

describe('policy', () => {
  it('never allows money, signing, account deletion or security changes', () => {
    for (const kind of ['money.transfer', 'payment.send', 'sign.contract', 'account.delete', 'security.change']) expect(neverAllowed(kind, {})).toMatch(/never/);
    for (const tool of ['STRIPE_CREATE_PAYOUT', 'DOCUSIGN_SIGN_ENVELOPE', 'PAYPAL_SEND_MONEY', 'OKTA_RESET_PASSWORD', 'ACME_DELETE_ACCOUNT', 'SHOPIFY_PLACE_ORDER']) expect(neverAllowed('email.send', { tool })).toMatch(/never/);
  });
  it('refuses kinds it has never heard of', () => {
    expect(neverAllowed('shell.run', {})).toMatch(/not something Timmy can do/);
    expect(neverAllowed('email.send', { to: ['a@b.co'] })).toBeNull();
  });
  it('treats anything that reaches another person as outbound', () => {
    expect(reachesSomeoneElse('email.send', {})).toBe(true);
    expect(reachesSomeoneElse('email.reply', {})).toBe(true);
    expect(reachesSomeoneElse('calendar.create', {})).toBe(true);
    expect(reachesSomeoneElse('mail.modify', {})).toBe(false);
    expect(reachesSomeoneElse('mail.modify', { tool: 'SLACK_SEND_MESSAGE' })).toBe(true);
    expect(reachesSomeoneElse('made.up', {})).toBe(true);
  });
  it('routes approvals by role', () => {
    expect(approverFor('email.send', actor('owner'), { approver: 'me' })).toEqual({ route: 'user', self: true });
    expect(approverFor('email.send', actor('member'), { approver: 'me' })).toEqual({ route: 'user', self: true });
    expect(approverFor('email.send', actor('assistant'), { approver: 'me' })).toEqual({ route: 'exec', self: false });
    expect(approverFor('crm.write', actor('member'), { approver: 'revops' })).toEqual({ route: 'revops', self: false });
    expect(approverFor('crm.write', actor('revops'), { approver: 'revops' })).toEqual({ route: 'user', self: true });
    expect(approverFor('email.send', actor('client'), { approver: 'me' }).self).toBe(false);
  });
  it('lets only the right person decide', () => {
    const e = { requested_by: 'u-member', on_behalf_of: null };
    expect(mayDecide('user', 'email.send', actor('member'), e)).toBe(true);
    expect(mayDecide('user', 'email.send', { ...actor('member'), userId: 'someone-else' }, e)).toBe(false);
    expect(mayDecide('user', 'email.send', actor('owner'), e)).toBe(true);
    expect(mayDecide('revops', 'crm.write', actor('member'), e)).toBe(false);
    expect(mayDecide('revops', 'crm.write', actor('revops'), e)).toBe(true);
    expect(mayDecide('exec', 'email.send', actor('assistant'), { requested_by: 'u-assistant', on_behalf_of: 'u-exec' })).toBe(false);
    expect(mayDecide('exec', 'email.send', { ...actor('member'), userId: 'u-exec' }, { requested_by: 'u-assistant', on_behalf_of: 'u-exec' })).toBe(true);
    expect(mayDecide('user', 'email.send', actor('revops'), e)).toBe(false);
    expect(mayDecide('user', 'email.send', actor('client'), e)).toBe(false);
  });
  it('a rule covers only what its scope names; an empty scope covers nothing', () => {
    const rule = { id: 'p1', kind: 'email.send', enabled: true, scope: { reason: 'speed_to_lead', form: 'f1' } };
    expect(ruleCovers(rule, 'email.send', { reason: 'speed_to_lead', form: 'f1' })).toBe(true);
    expect(ruleCovers(rule, 'email.send', { reason: 'speed_to_lead', form: 'f2' })).toBe(false);
    expect(ruleCovers(rule, 'email.reply', { reason: 'speed_to_lead', form: 'f1' })).toBe(false);
    expect(ruleCovers(rule, 'email.send', undefined)).toBe(false);
    expect(ruleCovers({ ...rule, enabled: false }, 'email.send', { reason: 'speed_to_lead', form: 'f1' })).toBe(false);
    expect(ruleCovers({ ...rule, scope: {} }, 'email.send', { anything: 1 })).toBe(false);
  });
});

describe('credentials stay out of logs and prompts', () => {
  it('masks configured keys and key-shaped strings', () => {
    const line = redact(`calling with ${process.env.OPENROUTER_API_KEY} and ${process.env.COMPOSIO_API_KEY}, Bearer abcdefghijklmnopqrstuvwxyz012345, postgres://owner:hunter2secret@db.internal:5432/x`);
    expect(line).not.toContain(process.env.OPENROUTER_API_KEY!);
    expect(line).not.toContain(process.env.COMPOSIO_API_KEY!);
    expect(line).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
    expect(line).not.toContain('hunter2secret');
    expect(line).toContain('postgres://owner:[redacted]@db.internal');
  });
  it('a model request carries no key, and asks for zero retention, fallbacks, caching and usage', () => {
    const body = buildRequestBody({ workspaceId: 'w', route: 'ask', model: 'anthropic/claude-opus-5.5', effort: 'low', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }] });
    const text = JSON.stringify(body);
    expect(text).not.toContain(process.env.OPENROUTER_API_KEY!);
    expect(text).not.toContain(process.env.COMPOSIO_API_KEY!);
    expect(body.provider.zdr).toBe(true);
    expect(body.models[0]).toBe('anthropic/claude-opus-5.5');
    expect(body.models.length).toBeGreaterThan(1);
    expect(body.usage.include).toBe(true);
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(JSON.stringify(body.messages[0])).toContain('cache_control');
    expect(JSON.stringify(body.messages[1])).toContain('cache_control');
  });
});

describe('mail parsing', () => {
  it('reads both shapes Composio sends', () => {
    const a = normalize({ messageId: 'm1', threadId: 't1', messageTimestamp: '2026-11-16T10:00:00Z', sender: 'Dana W <Dana@Acme.com>', to: 'me@x.io, Bob <bob@x.io>', subject: 'Quote', messageText: 'Hello', labelIds: ['INBOX'] })!;
    expect(a).toMatchObject({ id: 'm1', threadKey: 't1', to: ['me@x.io', 'bob@x.io'], subject: 'Quote', labels: ['INBOX'] });
    const b = normalize({ message_id: 'm2', thread_id: 't1', message_timestamp: '2026-11-16T10:00:00Z', sender: 'dana@acme.com', to: 'me@x.io', subject: '', message_text: 'Hi\u0000', label_ids: ['INBOX', 'UNREAD'] })!;
    expect(b).toMatchObject({ id: 'm2', threadKey: 't1', subject: '(no subject)', text: 'Hi' });
    expect(parseSender('Dana W <Dana@Acme.com>')).toEqual({ name: 'Dana W', email: 'dana@acme.com' });
    expect(normalize({})).toBeNull();
  });
  it('drops quoted history from a body', () => {
    expect(paragraphs('Sounds good.\n\nSee you Tuesday.\n\nOn Mon, Nov 16, 2026 at 9:00 AM Dana <d@a.com> wrote:\n> earlier text\n> more')).toEqual(['Sounds good.', 'See you Tuesday.']);
  });
});

describe('webhook signatures', () => {
  const secret = 's3cret';
  const sign = (body: string, ts = String(Math.floor(Date.now() / 1000)), id = 'wh_1') => new Headers({ 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signWebhook(id, ts, body, secret) });
  it('accepts a good signature', () => expect(verifyWebhookSignature(sign('{"a":1}'), '{"a":1}', secret)).toBe('wh_1'));
  it('rejects a changed body, a wrong secret, a stale timestamp and missing headers', () => {
    expect(() => verifyWebhookSignature(sign('{"a":1}'), '{"a":2}', secret)).toThrow(/does not match/);
    expect(() => verifyWebhookSignature(sign('{"a":1}'), '{"a":1}', 'other')).toThrow(/does not match/);
    expect(() => verifyWebhookSignature(sign('{"a":1}', String(Math.floor(Date.now() / 1000) - 3600)), '{"a":1}', secret)).toThrow(/window/);
    expect(() => verifyWebhookSignature(new Headers(), '{"a":1}', secret)).toThrow(/missing/);
    expect(() => verifyWebhookSignature(sign('{"a":1}'), '{"a":1}', '')).toThrow(/not configured/);
  });
});

describe('hashing', () => {
  it('is stable across key order', () => {
    expect(canonical({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonical({ a: [2, { c: 2, d: 1 }], b: 1 }));
    expect(hashOf({ a: 1 })).not.toBe(hashOf({ a: 2 }));
  });
});
