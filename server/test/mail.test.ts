/**
 * Timmy's own account mail, delivered through Resend, and the address confirmation that comes with it.
 * A small local server stands in for Resend's API so the real request can be checked.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initAuth, resetAuthForTests } from '../src/auth/auth';
import { config } from '../src/config';
import { recent } from '../src/lib/log';
import { deliverMail, mailReady, sendMail, undeliveredMail } from '../src/providers/email';
import { Client, boot, jobs, rows, sysPool } from './helpers';

interface Received {
  authorization: string;
  idempotencyKey: string;
  body: { from: string; to: string[]; subject: string; text: string };
}
let stub: Server;
let received: Received[] = [];
/** What the stand-in answers next: a status and a body. Defaults to success. */
let answers: { status: number; body: Record<string, unknown> }[] = [];
const KEY = ['re', 'test', 'k'.repeat(28)].join('_');
const original = { ...config.mail, requireEmailVerification: config.requireEmailVerification };
const outbox = (to: string) => rows<{ id: string; kind: string; body: string; sent_at: Date | null; provider_id: string | null; attempts: number; error: string | null }>('select id, kind, body, sent_at, provider_id, attempts, error from email_outbox where to_address = $1 order by id', [to]);
const address = (name: string) => `${name}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@people.test`;
const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => resolve(text));
  });

beforeAll(async () => {
  await boot();
  stub = createServer(async (req, res) => {
    const body = JSON.parse((await read(req)) || '{}') as Received['body'];
    received.push({ authorization: String(req.headers.authorization), idempotencyKey: String(req.headers['idempotency-key']), body });
    const next = answers.shift() ?? { status: 200, body: { id: `re_${received.length}` } };
    res.writeHead(next.status, { 'content-type': 'application/json' }).end(JSON.stringify(next.body));
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
});
afterAll(async () => {
  await new Promise((r) => stub.close(r));
});
beforeEach(() => {
  received = [];
  answers = [];
  jobs().queue = [];
  Object.assign(config.mail, { resendApiKey: KEY, from: 'Timmy <timmy@mail.example.test>', resendBaseUrl: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`, deliver: true });
});
afterEach(() => {
  Object.assign(config.mail, { resendApiKey: original.resendApiKey, from: original.from, resendBaseUrl: original.resendBaseUrl, deliver: original.deliver });
});

describe('delivering Timmy’s own mail through Resend', () => {
  it('records the message first, then sends it once with the configured sender and marks it delivered', async () => {
    const to = address('dana');
    await sendMail({ to, kind: 'magic-link', subject: 'Your Timmy sign-in link', body: 'Sign in to Timmy:\nhttps://timmy.example/link' });
    // The record exists before anything is sent.
    expect(await outbox(to)).toMatchObject([{ kind: 'magic-link', sent_at: null, attempts: 0 }]);
    expect(received).toHaveLength(0);
    await jobs().drain();
    expect(received).toHaveLength(1);
    const [row] = await outbox(to);
    expect(received[0]).toEqual({ authorization: `Bearer ${KEY}`, idempotencyKey: `timmy-outbox-${row!.id}`, body: { from: 'Timmy <timmy@mail.example.test>', to: [to], subject: 'Your Timmy sign-in link', text: 'Sign in to Timmy:\nhttps://timmy.example/link' } });
    expect(row).toMatchObject({ provider_id: 're_1', attempts: 1, error: null });
    expect(row!.sent_at).not.toBeNull();
    // Asking again for the same message sends nothing more.
    expect(await deliverMail(Number(row!.id))).toBe('already');
    expect(received).toHaveLength(1);
  });

  it('a refusal or an outage is recorded and tried again with the same key, so a late success is not a second email', async () => {
    const to = address('sam');
    answers.push({ status: 500, body: { name: 'internal_server_error', message: 'try later' } });
    await sendMail({ to, kind: 'invite', subject: 'Invitation', body: 'Join us' });
    await expect(jobs().drain()).rejects.toThrow(/mail not delivered/);
    let [row] = await outbox(to);
    expect(row).toMatchObject({ sent_at: null, attempts: 1 });
    expect(row!.error).toMatch(/^500: try later/);

    // The sweep finds it once it has sat for a moment, and the retry carries the same key.
    expect(await undeliveredMail()).not.toContain(Number(row!.id));
    await sysPool.query(`update email_outbox set created_at = now() - interval '2 minutes' where id = $1`, [row!.id]);
    expect(await undeliveredMail()).toContain(Number(row!.id));
    await jobs().enqueue('effect.sweep', {});
    await jobs().drain();
    [row] = await outbox(to);
    expect(row).toMatchObject({ attempts: 2, error: null });
    expect(row!.sent_at).not.toBeNull();
    // The sweep covers every waiting message on the server, so only this one's two attempts are looked at.
    expect(received.filter((r) => r.body.to[0] === to).map((r) => r.idempotencyKey)).toEqual([`timmy-outbox-${row!.id}`, `timmy-outbox-${row!.id}`]);
  });

  it('gives up on a message whose link would be useless by now', async () => {
    const to = address('late');
    await sendMail({ to, kind: 'magic-link', subject: 'Link', body: 'x' });
    jobs().queue = [];
    const [row] = await outbox(to);
    await sysPool.query(`update email_outbox set created_at = now() - interval '45 minutes' where id = $1`, [row!.id]);
    expect(await deliverMail(Number(row!.id))).toBe('expired');
    expect(received).toHaveLength(0);
    expect(await undeliveredMail()).not.toContain(Number(row!.id));
  });

  it('with the stand-in providers on, or without a sender address, nothing leaves: the message waits in the outbox', async () => {
    const to = address('quiet');
    config.mail.deliver = false;
    expect(mailReady()).toBe(false);
    await sendMail({ to, kind: 'reset', subject: 'Reset', body: 'x' });
    config.mail.deliver = true;
    config.mail.from = '';
    expect(mailReady()).toBe(false);
    await sendMail({ to, kind: 'reset', subject: 'Reset', body: 'y' });
    await jobs().drain();
    expect(received).toHaveLength(0);
    expect((await outbox(to)).map((r) => r.sent_at)).toEqual([null, null]);
  });

  it('the provider’s key never appears in a log line, even when delivery fails', async () => {
    answers.push({ status: 401, body: { name: 'invalid_api_key', message: `API key ${KEY} is invalid` } });
    await sendMail({ to: address('key'), kind: 'reset', subject: 'Reset', body: 'x' });
    await jobs().drain().catch(() => {});
    expect(recent.join('\n')).not.toContain(KEY);
    expect(recent.join('\n')).toContain('account mail was not delivered');
  });
});

describe('confirming an address at sign-up', () => {
  const rebuild = async (required: boolean) => {
    config.requireEmailVerification = required;
    resetAuthForTests();
    await initAuth();
  };
  beforeEach(async () => {
    // Messages stay in the outbox here; this block is about the sign-up flow, not delivery.
    config.mail.deliver = false;
    await rebuild(true);
  });
  afterEach(async () => {
    await rebuild(original.requireEmailVerification);
  });

  it('a new account is not signed in until the link sent to its address is opened', async () => {
    const email = address('ada');
    const c = new Client();
    const made = await c.request('POST', '/api/auth/sign-up/email', { name: 'Ada Lovelace', email, password: 'correct-horse-battery-9', callbackURL: '/' });
    expect(made.status).toBe(200);
    expect(((await made.json()) as { token: string | null }).token).toBeNull();
    expect((await c.get('/api/v1/me')).status).toBe(401);
    // Knowing the password is not enough.
    expect((await c.request('POST', '/api/auth/sign-in/email', { email, password: 'correct-horse-battery-9' })).status).toBe(403);
    expect((await c.get('/api/v1/me')).status).toBe(401);

    const mail = (await outbox(email)).filter((m) => m.kind === 'verify');
    expect(mail.length).toBeGreaterThanOrEqual(1);
    const link = new URL(/https?:\/\/\S+/.exec(mail.at(-1)!.body)![0]);
    expect(link.pathname).toBe('/api/auth/verify-email');
    const opened = await c.get(link.pathname + link.search);
    expect(opened.status).toBe(302);
    // Opening the link proves the address and signs the person in.
    const me = await c.get('/api/v1/me');
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe(email);
    expect(await rows('select "emailVerified" from auth."user" where email = $1', [email])).toEqual([{ emailVerified: true }]);
  });

  it('registering someone else’s address gets nothing: the link goes to them, not to whoever typed the address', async () => {
    const victim = address('victim');
    const attacker = new Client();
    await attacker.request('POST', '/api/auth/sign-up/email', { name: 'Not Them', email: victim, password: 'attacker-password-1', callbackURL: '/' });
    expect((await attacker.get('/api/v1/me')).status).toBe(401);
    expect((await attacker.post('/api/auth/organization/create', { name: 'Planted', slug: `planted-${Date.now().toString(36)}` })).status).toBe(401);
    expect(await rows('select 1 from auth.member m join auth."user" u on u.id = m."userId" where u.email = $1', [victim])).toHaveLength(0);
  });
});
