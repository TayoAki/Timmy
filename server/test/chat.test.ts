/**
 * The website chat, version 1: a chat bubble on a customer's own website, answered by Timmy from rules the
 * owner set. Strangers type into it, so these tests treat every visitor as hostile and check, one property at
 * a time, what a visitor, another visitor, another workspace and an ordinary member can and cannot do.
 */
import pg from 'pg';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatConvo, ChatWidget } from '../../src/data/ws-types';
import { followUpName, matchFaq, newTalk, respond } from '../../src/lib/chat-bot';
import { wantsPerson } from '../../src/state/chat';
import { leadAlerts, onTheClock, waitingForFirstReply } from '../../src/state/leads';
import { newChallenge, zeroBits } from '../src/chat/challenge';
import { sendChatReply } from '../src/chat/deliver';
import type { VisitorMessage } from '../src/chat/hub';
import { removeExpiredChats } from '../src/chat/jobs';
import { LimitStore, resetLimits } from '../src/chat/limits';
import { allowedParents } from '../src/chat/site';
import { embedFile } from '../src/chat/static';
import { chatSecret, conversationOf, issueToken, textMark } from '../src/chat/token';
import { assertSafeConfig, config } from '../src/config';
import { executeEffect, type EffectRow } from '../src/gateway/gateway';
import { recent } from '../src/lib/log';
import { addMember, appPool, authPool, boot, jobs, newWorkspace, rows, sysPool, withWorkspace, type Client } from './helpers';

const ORIGIN = 'http://localhost:8787';
const FAQ = [
  { id: 'f1', q: 'How much does it cost?', a: 'Plans start at $29 a seat, billed monthly. No setup fee & no contract.' },
  { id: 'f2', q: 'Do you offer a free trial?', a: 'Yes: 14 days, no card needed.' },
];
const QUESTIONS = [
  { id: 'q1', text: 'What’s your company called?' },
  { id: 'q2', text: 'How many people are on your team?' },
];
const EMAIL_QUESTION = 'What’s the best email to reach you?';

let seq = 0;
const hex = (n = 32) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
/** A number that solves a bot-check challenge, found the way the chat window's worker finds one. */
const solve = (challenge: string, bits: number) => {
  for (let n = 0; ; n++) if (zeroBits(challenge, String(n)) >= bits) return String(n);
};
/** Each visitor in a test comes from their own address unless the test says otherwise. */
const freshAddress = () => `10.${(++seq >> 8) & 255}.${seq & 255}.${1 + Math.floor(Math.random() * 250)}`;

type Answer = { ok: boolean; notice?: string; reset?: boolean; recheck?: boolean; conversation?: string; token?: string; messages?: VisitorMessage[] };

/** A stranger on the customer's website: no account, no cookies, only what the chat window keeps. */
class Visitor {
  id = hex();
  address = freshAddress();
  conversation?: string;
  token?: string;
  seen: VisitorMessage[] = [];
  constructor(public siteKey: string) {}

  /**
   * The bot check's work for a first message, the way the chat window does it: a challenge from the public
   * settings, and a number that solves it. Empty when the settings don't answer (the chat is off or unknown).
   */
  async proof(): Promise<{ challenge?: string; answer?: string }> {
    const res = await (await boot()).request(`/api/public/chat/${this.siteKey}/config`, { headers: { 'x-real-ip': this.address } });
    if (res.status !== 200) return {};
    const { challenge } = (await res.json()) as { challenge: { id: string; bits: number } };
    return { challenge: challenge.id, answer: solve(challenge.id, challenge.bits) };
  }

  async post(body: unknown, headers: Record<string, string> = {}) {
    const res = await (await boot()).request(`/api/public/chat/${this.siteKey}/messages`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-real-ip': this.address, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { res, status: res.status, text, body: JSON.parse(text) as Answer };
  }

  /** Sends one message the way the chat window does, and remembers the conversation and what came back. */
  async say(text: string, extra: Record<string, unknown> = {}) {
    const out = await this.post({ visitor: this.id, id: hex(), text, ...(this.conversation ? { conversation: this.conversation, token: this.token } : await this.proof()), after: this.seen.at(-1)?.seq ?? 0, ...extra });
    if (out.body.ok) {
      this.conversation = out.body.conversation;
      this.token = out.body.token;
      this.seen.push(...out.body.messages!);
    }
    return out;
  }
  /** What Timmy or a person said back to the last message. */
  replies = (out: { body: Answer }) => (out.body.messages ?? []).filter((m) => m.from !== 'visitor').map((m) => m.text);

  async stream(opts: { conversation?: string; token?: string; after?: number } = {}) {
    const res = await (await boot()).request(`/api/public/chat/${this.siteKey}/stream?conversation=${opts.conversation ?? this.conversation ?? ''}&after=${opts.after ?? 0}`, {
      headers: { 'x-real-ip': this.address, ...((opts.token ?? this.token) ? { authorization: `Bearer ${opts.token ?? this.token}` } : {}) },
    });
    const events: { event: string; data: VisitorMessage }[] = [];
    if (res.status !== 200) return { res, events, messages: () => [] as VisitorMessage[], until: async () => false, close: async () => {} };
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let at: number;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (data) events.push({ event, data: JSON.parse(data) });
        }
      }
    })();
    const messages = () => events.filter((e) => e.event === 'message').map((e) => e.data);
    const until = async (found: (list: VisitorMessage[]) => boolean, ms = 4000) => {
      for (const end = Date.now() + ms; Date.now() < end; ) {
        if (found(messages())) return true;
        await new Promise((r) => setTimeout(r, 20));
      }
      return found(messages());
    };
    return { res, events, messages, until, close: () => reader.cancel().catch(() => {}) };
  }
}

const pub = async (path: string, headers: Record<string, string> = {}) => (await boot()).request(path, { headers: { 'x-real-ip': freshAddress(), ...headers } });
const settings = (c: Client, patch: Record<string, unknown>) => c.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'chat', id: 'site', patch }] });
const chat = (c: Client, op: Record<string, unknown>, id?: string) => c.cmd({ type: 'chat', op }, id);
const widget = async (c: Client) => (await c.state()).ws.chat.site as ChatWidget;
const convo = async (c: Client, id: string) => (await c.state()).ws.chats[id] as ChatConvo | undefined;
const count = async (sql: string, params: unknown[] = []) => (await rows<{ n: number }>(sql, params))[0]!.n;
const effects = (c: Client) => rows<EffectRow>(`select * from effect where workspace_id = $1 and kind = 'chat.reply' order by created_at`, [c.workspaceId]);

/** A workspace whose owner has set the chat up and switched it on. Returns the owner and the site key. */
async function chatOn(name = 'Acme', more: Record<string, unknown> = {}, domain = 'acme.example') {
  const owner = await newWorkspace(name);
  expect((await settings(owner, { domain, name: 'Acme Support', faq: FAQ, questions: QUESTIONS, ...more })).ok).toBe(true);
  const on = await settings(owner, { on: true });
  expect(on.ok, on.error).toBe(true);
  return { owner, siteKey: (await widget(owner)).siteKey! };
}

const limits = { ...config.chat };
const stage = config.stage;

beforeAll(async () => {
  await boot();
});
beforeEach(() => {
  resetLimits();
  jobs().queue = [];
});
afterEach(() => {
  Object.assign(config.chat, limits);
  config.stage = stage;
  vi.restoreAllMocks();
});

describe('the rules Timmy answers by (shared with the preview)', () => {
  const w: ChatWidget = { id: 'site', on: true, domain: 'acme.example', name: 'Acme Support', color: '#3f51d9', greeting: 'Hi!', questions: QUESTIONS, faq: FAQ, handoff: 'notify', booking: true };
  const site = { owner: followUpName(w), booking: false };

  it('a help desk answer is given word for word, then the email question', () => {
    const out = respond(w, newTalk(), 'what does it cost', site);
    expect(out.replies.map((r) => r.text)).toEqual([FAQ[0]!.a, EMAIL_QUESTION]);
    expect(matchFaq(FAQ, 'is there a free trial?')?.id).toBe('f2');
    expect(matchFaq(FAQ, 'tell me about the weather')).toBeNull();
  });

  it('an email is caught, then the owner’s questions are asked in order and the answers kept', () => {
    let st = respond(w, newTalk(), 'you can reach me at ada@lovelace.example', site);
    expect(st.st.email).toBe('ada@lovelace.example');
    expect(st.replies[0]!.text).toBe('Thanks, Ada! What’s your company called?');
    st = respond(w, st.st, 'Analytical Engines', site);
    expect(st.replies[0]!.text).toBe(QUESTIONS[1]!.text);
    st = respond(w, st.st, 'About 12', site);
    expect(st.st.answers).toEqual({ q1: 'Analytical Engines', q2: 'About 12' });
    expect(st.replies.map((r) => r.text)).toEqual(['Thanks! Acme Support will be in touch at ada@lovelace.example.']);
  });

  it('on a real website no call is ever offered: “offer a call” takes an email, and no times follow the questions', () => {
    const book = { ...w, handoff: 'book' as const };
    const asked = respond(book, newTalk(), 'can I talk to a person', site);
    expect(asked.st.handedOff).toBe(true);
    expect(asked.replies).toEqual([{ text: 'Leave your email and Acme Support will write back today.', asksEmail: true }]);
    const done = respond(book, { q: 2, answers: {}, email: 'a@b.example' }, 'thanks', site);
    expect(done.replies.some((r) => r.slots)).toBe(false);
    // The demo's preview keeps its behaviour: with booking on, it offers times.
    expect(respond(book, newTalk(), 'can I talk to a person', { owner: 'Taylor', booking: true }).replies).toEqual([{ text: 'Happy to set that up with Taylor. Pick a time:', slots: true }]);
    expect(respond(w, { q: 1, answers: {}, email: 'a@b.example' }, 'About 12', { owner: 'Taylor', booking: true }).replies).toEqual([{ text: 'Thanks! Want to talk it through with Taylor? Pick a time:', slots: true }]);
  });
});

describe('switching the chat on', () => {
  it('is off by default, and no public route answers for it', async () => {
    const owner = await newWorkspace('Quiet');
    expect((await widget(owner)).on).toBe(false);
    expect((await widget(owner)).siteKey).toBeUndefined();
    expect(await count('select count(*)::int as n from chat_widget where workspace_id = $1', [owner.workspaceId])).toBe(0);
    // Naming a website makes the key for the snippet. The chat is still off.
    expect((await settings(owner, { domain: 'quiet.example' })).ok).toBe(true);
    const key = (await widget(owner)).siteKey!;
    expect(key).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect((await pub(`/api/public/chat/${key}/config`)).status).toBe(404);
  });

  it('an off chat and a key that doesn’t exist get the same refusal on every public route, so a key can’t be probed', async () => {
    const owner = await newWorkspace('Probe');
    await settings(owner, { domain: 'probe.example', faq: FAQ });
    const off = (await widget(owner)).siteKey!;
    const unknown = `${hex(16)}${hex(16)}`;
    const shape = async (res: Response) => ({ status: res.status, body: await res.text(), type: res.headers.get('content-type'), policy: res.headers.get('content-security-policy') });
    for (const path of ['config', 'stream?conversation=cv_0000000000000000000&after=0']) {
      const a = await shape(await pub(`/api/public/chat/${off}/${path}`));
      const b = await shape(await pub(`/api/public/chat/${unknown}/${path}`));
      expect(a).toEqual(b);
      expect(a.status).toBe(404);
      expect(JSON.parse(a.body)).toEqual({ ok: false, notice: 'This chat isn’t available right now.' });
    }
    const said = [await new Visitor(off).say('hello'), await new Visitor(unknown).say('hello')];
    expect(said[0]!.text).toBe(said[1]!.text);
    expect(said.map((s) => s.status)).toEqual([404, 404]);
    const frames = [await shape(await pub(`/chat/frame?site=${off}`)), await shape(await pub(`/chat/frame?site=${unknown}`)), await shape(await pub('/chat/frame?site=not-a-key')), await shape(await pub('/chat/frame'))];
    for (const f of frames) expect(f).toEqual(frames[0]);
    expect(frames[0]!.status).toBe(404);
    expect(frames[0]!.policy).toContain("frame-ancestors 'none'");
    // Nothing was stored for either.
    expect(await count('select count(*)::int as n from chat_conversation where workspace_id = $1', [owner.workspaceId])).toBe(0);
  });

  it('a member or an assistant cannot switch it on; an owner or admin can, and not without a website', async () => {
    const owner = await newWorkspace('Gate');
    const member = await addMember(owner.workspaceId, 'member');
    const assistant = await addMember(owner.workspaceId, 'assistant');
    const admin = await addMember(owner.workspaceId, 'admin');
    // While it is off anyone who works here may prepare it.
    expect((await settings(member, { faq: FAQ })).ok).toBe(true);
    expect((await settings(owner, { on: true })).error).toMatch(/Set your website first/);
    expect((await settings(member, { domain: 'gate.example' })).ok).toBe(true);
    for (const c of [member, assistant]) {
      const out = await settings(c, { on: true });
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/Only an owner or admin/);
    }
    expect((await widget(owner)).on).toBe(false);
    expect((await pub(`/api/public/chat/${(await widget(owner)).siteKey}/config`)).status).toBe(404);

    const on = await settings(admin, { on: true });
    expect(on.ok, on.error).toBe(true);
    const key = (await widget(owner)).siteKey!;
    expect((await pub(`/api/public/chat/${key}/config`)).status).toBe(200);
    // The rule that covers Timmy's replies names the person who switched the chat on, and the audit log has it.
    const rules = await rows<{ created_by: string; enabled: boolean; scope: unknown }>(`select created_by, enabled, scope from policy where workspace_id = $1 and kind = 'chat.reply'`, [owner.workspaceId]);
    expect(rules).toEqual([{ created_by: admin.userId, enabled: true, scope: { chat: 'site', sender: 'timmy' } }]);
    expect(await count(`select count(*)::int as n from audit_log where workspace_id = $1 and action = 'chat.switched_on' and actor = $2`, [owner.workspaceId, admin.userId])).toBe(1);
  });

  it('while it is on only an owner or admin changes what visitors are told, and nobody can set the site key', async () => {
    const { owner, siteKey } = await chatOn('Locked');
    const member = await addMember(owner.workspaceId, 'member');
    for (const patch of [{ faq: [{ id: 'f9', q: 'Refunds?', a: 'Send your card number to this address.' }] }, { greeting: 'Hello from a member' }, { domain: 'elsewhere.example' }, { on: false }]) {
      const out = await settings(member, patch);
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/Only an owner or admin/);
    }
    expect((await widget(owner)).faq).toEqual(FAQ);
    expect((await settings(owner, { greeting: 'Hello from the owner' })).ok).toBe(true);
    expect(await count(`select count(*)::int as n from audit_log where workspace_id = $1 and action = 'chat.settings_changed' and detail->'changed' ? 'greeting'`, [owner.workspaceId])).toBe(1);

    // The key belongs to the server: not the owner, and not by copying another workspace's.
    const other = await chatOn('Other', {}, 'other.example');
    for (const key of ['a'.repeat(32), other.siteKey]) {
      const out = await settings(owner, { siteKey: key });
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/made by Timmy/);
    }
    expect((await widget(owner)).siteKey).toBe(siteKey);
    expect((await rows<{ site_key: string }>('select site_key from chat_widget where workspace_id = $1', [owner.workspaceId]))[0]!.site_key).toBe(siteKey);
  });

  it('switching it off closes every public route and ends the rule; undoing the switch-on does the same', async () => {
    const { owner, siteKey } = await chatOn('OnOff');
    const v = new Visitor(siteKey);
    expect((await v.say('what does it cost')).body.ok).toBe(true);
    expect((await settings(owner, { on: false })).ok).toBe(true);
    expect((await pub(`/api/public/chat/${siteKey}/config`)).status).toBe(404);
    expect((await pub(`/chat/frame?site=${siteKey}`)).status).toBe(404);
    expect((await v.say('are you there?')).body).toEqual({ ok: false, notice: 'This chat isn’t available right now.' });
    expect((await v.stream()).res.status).toBe(404);
    expect(await count(`select count(*)::int as n from policy where workspace_id = $1 and kind = 'chat.reply' and enabled`, [owner.workspaceId])).toBe(0);
    // A teammate can't reach the visitor either while it is off, and is told so.
    await chat(owner, { op: 'takeOver', id: v.conversation, on: true });
    expect((await chat(owner, { op: 'reply', id: v.conversation, text: 'Still there?', message: 'm-off' })).error).toMatch(/switched off/);
    await chat(owner, { op: 'takeOver', id: v.conversation, on: false });

    // On again: the same key (the snippet on the website keeps working), under a new rule.
    const again = await settings(owner, { on: true });
    expect((await widget(owner)).siteKey).toBe(siteKey);
    expect((await pub(`/api/public/chat/${siteKey}/config`)).status).toBe(200);
    // Undo takes the switch-on back for real: not only on the screen.
    expect((await owner.cmd({ type: 'undo', command: again.id })).ok).toBe(true);
    expect((await widget(owner)).on).toBe(false);
    expect((await pub(`/api/public/chat/${siteKey}/config`)).status).toBe(404);
    expect(await count(`select count(*)::int as n from policy where workspace_id = $1 and kind = 'chat.reply' and enabled`, [owner.workspaceId])).toBe(0);
  });

  it('sending switched off for the workspace closes the chat too', async () => {
    const { owner, siteKey } = await chatOn('Kill');
    expect((await owner.request('PATCH', '/api/v1/settings', { killSwitch: true })).status).toBe(200);
    expect((await pub(`/api/public/chat/${siteKey}/config`)).status).toBe(404);
    expect((await new Visitor(siteKey).say('hello')).status).toBe(404);
    expect(await count(`select count(*)::int as n from effect where workspace_id = $1`, [owner.workspaceId])).toBe(0);
  });

  it('settings a visitor would be shown are checked: the privacy link is https, retention is one of the choices', async () => {
    const owner = await newWorkspace('Checks');
    expect((await settings(owner, { privacyUrl: 'javascript:alert(1)' })).error).toMatch(/starts with https/);
    expect((await settings(owner, { privacyUrl: 'https://acme.example/privacy" onclick="x' })).ok).toBe(false);
    expect((await settings(owner, { retentionMonths: 600 })).error).toMatch(/1, 3, 6, 12 or 24 months/);
    expect((await settings(owner, { privacyUrl: 'https://acme.example/privacy', retentionMonths: 6, domain: 'acme.example' })).ok).toBe(true);
    expect((await rows<{ retention_months: number }>('select retention_months from chat_widget where workspace_id = $1', [owner.workspaceId]))[0]!.retention_months).toBe(6);
    // The privacy settings are an owner's or admin's to change, on or off.
    const member = await addMember(owner.workspaceId, 'member');
    expect((await settings(member, { retentionMonths: 24 })).error).toMatch(/privacy settings/);
  });
});

describe('getting it onto a website', () => {
  it('the frame may be shown by the configured website only, and does not inherit the app’s own framing rule', async () => {
    const { siteKey } = await chatOn('Framed');
    const res = await pub(`/chat/frame?site=${siteKey}&page=%2Fpricing`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    const policy = res.headers.get('content-security-policy')!;
    expect(policy.split('; ').find((d) => d.startsWith('frame-ancestors'))).toBe('frame-ancestors https://acme.example https://www.acme.example');
    expect(res.headers.get('x-frame-options')).toBeNull();
    // The frame runs only its own script: nothing inline, nothing from elsewhere.
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain('unsafe');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const html = await res.text();
    expect(html).not.toContain(siteKey);
    expect(html).not.toMatch(/<script>|\son\w+\s*=/i);
  });

  it('a developer’s own machine may show it only on a development server', async () => {
    expect(allowedParents('acme.example')).toEqual(['https://acme.example', 'https://www.acme.example']);
    expect(allowedParents('www.acme.example')).toEqual(['https://acme.example', 'https://www.acme.example']);
    config.stage = 'development';
    expect(allowedParents('acme.example')).toEqual(['https://acme.example', 'https://www.acme.example', 'http://localhost:*', 'http://127.0.0.1:*']);
    config.stage = 'production';
    expect(allowedParents('acme.example')).toEqual(['https://acme.example', 'https://www.acme.example']);
    // Anything that isn't a plain host name allows nobody (it would otherwise be written into a header).
    for (const bad of ['', 'acme.example; script-src *', 'acme.example https://evil.example', '*', 'acme']) expect(allowedParents(bad)).toEqual([]);
  });

  it('the rest of the app still refuses to be framed by anyone else', async () => {
    const { owner, siteKey } = await chatOn('NoFrame');
    const pages = [await pub('/'), await pub('/api/health'), await pub(`/api/public/chat/${siteKey}/config`), await owner.get('/api/v1/state')];
    for (const res of pages) {
      expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    }
  });

  it('the loader and the frame’s files are served as script and stylesheet, and put nothing on a page as markup', async () => {
    const loader = await pub('/chat.js');
    expect(loader.status).toBe(200);
    expect(loader.headers.get('content-type')).toMatch(/^text\/javascript/);
    // Other people's websites load it, so it must say other sites may.
    expect(loader.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(loader.headers.get('x-content-type-options')).toBe('nosniff');
    const code = await loader.text();
    expect(code).toContain('data-site');
    expect(code.length).toBeLessThan(6000);
    const js = await pub('/chat/frame.js');
    expect(js.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect((await pub('/chat/frame.css')).headers.get('content-type')).toMatch(/^text\/css/);
    for (const file of ['loader.js', 'frame.js', 'work.js'] as const) {
      expect(embedFile(file)).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|srcdoc/);
    }
    // The frame never listens to the page that holds it, and never sends it anything but how to be shown.
    expect(embedFile('frame.js')).not.toMatch(/addEventListener\('message'/);
    expect(embedFile('frame.js')).toContain("credentials: 'omit'");
  });

  it('the public settings hold the public fields and nothing else', async () => {
    const { owner, siteKey } = await chatOn('Public', { privacyUrl: 'https://acme.example/privacy', greeting: 'Hi there!', handoff: 'email', retentionMonths: 6 });
    const res = await pub(`/api/public/chat/${siteKey}/config`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // And a challenge for the bot check, new for every window, so the answer is never kept by a cache.
    expect(body).toEqual({ name: 'Acme Support', color: '#3f51d9', greeting: 'Hi there!', questions: QUESTIONS, faq: FAQ, privacyUrl: 'https://acme.example/privacy', challenge: { id: expect.stringMatching(/^c1\./), bits: config.chat.challengeBits } });
    expect(res.headers.get('cache-control')).toBe('no-store');
    // Nothing that identifies the workspace, its people, or how it is set up behind the scenes.
    const text = JSON.stringify(body);
    for (const secret of [owner.workspaceId, owner.userId, owner.email, siteKey, 'acme.example"', 'handoff', 'retention', 'Public Owner']) expect(text).not.toContain(secret);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('a visitor’s conversation', () => {
  it('a question gets the help desk answer word for word, through an effect the rule approved', async () => {
    const { owner, siteKey } = await chatOn('Answers');
    const v = new Visitor(siteKey);
    const out = await v.say('What does it cost?', { page: '/pricing' });
    expect(out.status).toBe(200);
    expect(v.replies(out)).toEqual([FAQ[0]!.a, EMAIL_QUESTION]);
    expect(out.body.messages!.map((m) => m.from)).toEqual(['visitor', 'timmy', 'timmy']);
    // Members see it on the Chats screen, unread, with the page it came from.
    const c = (await convo(owner, v.conversation!))!;
    expect(c).toMatchObject({ unread: true, live: false, page: '/pricing' });
    expect(c.messages.map((m) => [m.from, m.text])).toEqual([['visitor', 'What does it cost?'], ['timmy', FAQ[0]!.a], ['timmy', EMAIL_QUESTION]]);
    const made = await effects(owner);
    expect(made.map((e) => [e.status, e.source, e.approved_via, e.hold_until])).toEqual([['completed', 'rule', 'rule', null], ['completed', 'rule', 'rule', null]]);
  });

  it('leaving an email makes one lead with the answers, and a second chat with the same email adds to it', async () => {
    const { owner, siteKey } = await chatOn('Leads');
    const v = new Visitor(siteKey);
    expect(v.replies(await v.say('Hi, I am ADA@Lovelace.example.'))).toEqual(['Thanks, ADA! What’s your company called?']);
    expect(v.replies(await v.say('Analytical Engines'))).toEqual([QUESTIONS[1]!.text]);
    expect(v.replies(await v.say('About 12'))).toEqual(['Thanks! Acme Support will be in touch at ada@lovelace.example.']);

    let s = await owner.state();
    const leads = Object.values(s.out.leads);
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ email: 'ada@lovelace.example', source: 'chat', status: 'new', first: 'ADA', extra: { 'What’s your company called': 'Analytical Engines', 'How many people are on your team': 'About 12' } });
    // The answers are kept on the conversation too, in the screen's copy and the stored one.
    expect(s.ws.chats[v.conversation!]).toMatchObject({ email: 'ada@lovelace.example', name: 'ADA', answers: { q1: 'Analytical Engines', q2: 'About 12' } });
    const stored = (await rows<{ email: string; lead_id: string; talk: { answers: unknown } }>('select email, lead_id, talk from chat_conversation where id = $1', [v.conversation]))[0]!;
    expect(stored).toMatchObject({ email: 'ada@lovelace.example', lead_id: leads[0]!.id, talk: { answers: { q1: 'Analytical Engines', q2: 'About 12' } } });
    expect(s.activity.filter((a) => /New lead from your website chat: ada@lovelace\.example/.test(a.text))).toHaveLength(1);

    // The same person comes back in a new chat, from another browser: still one lead.
    const again = new Visitor(siteKey);
    await again.say('ada@lovelace.example');
    await again.say('Difference Engines Ltd');
    s = await owner.state();
    expect(Object.values(s.out.leads)).toHaveLength(1);
    // Anyone can type an address, so the second chat only fills gaps: what the first visitor said stays.
    expect(Object.values(s.out.leads)[0]!.extra).toMatchObject({ 'What’s your company called': 'Analytical Engines', 'How many people are on your team': 'About 12' });
    expect(again.conversation).not.toBe(v.conversation);
  });

  it('what a visitor types never replaces what a lead from elsewhere already holds', async () => {
    const { owner, siteKey } = await chatOn('Merge');
    const lead = { id: 'lead-1', first: 'Grace', last: 'Hopper', email: 'grace@navy.example', company: 'Navy', source: 'manual', added: new Date(), status: 'interested', extra: { 'What’s your company called': 'US Navy' } };
    expect((await owner.cmd({ type: 'out', op: { op: 'addLead', lead } })).ok).toBe(true);
    const v = new Visitor(siteKey);
    await v.say('grace@navy.example');
    await v.say('Totally Different Corp');
    await v.say('3');
    const leads = Object.values((await owner.state()).out.leads);
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ first: 'Grace', source: 'manual', status: 'interested', extra: { 'What’s your company called': 'US Navy', 'How many people are on your team': '3' } });
  });

  it('asking for a person marks the chat urgent and tells the team; Timmy stops once a member takes over, and answers again when handed back', async () => {
    const { owner, siteKey } = await chatOn('Handoff');
    const member = await addMember(owner.workspaceId, 'member', 'Mel Member');
    const v = new Visitor(siteKey);
    expect(v.replies(await v.say('Can I talk to a human?'))).toEqual(['I’ve let Acme Support know. They’ll reply here. What’s the best email in case you step away?']);
    let s = await owner.state();
    expect(s.ws.chats[v.conversation!]).toMatchObject({ urgent: true, live: false });
    expect(s.activity.filter((a) => /asked for a person/.test(a.text))).toHaveLength(1);

    const took = await chat(member, { op: 'takeOver', id: v.conversation, on: true });
    expect(took.ok, took.error).toBe(true);
    expect(await convo(owner, v.conversation!)).toMatchObject({ urgent: false, live: true });
    // Timmy says nothing now, even to a question it has an answer for.
    const waiting = await v.say('What does it cost?');
    expect(waiting.body.ok).toBe(true);
    expect(v.replies(waiting)).toEqual([]);
    expect((await effects(owner)).filter((e) => e.source === 'rule')).toHaveLength(1);

    expect((await chat(member, { op: 'takeOver', id: v.conversation, on: false })).ok).toBe(true);
    expect(v.replies(await v.say('What does it cost?'))).toEqual([FAQ[0]!.a, EMAIL_QUESTION]);
    expect(await count(`select count(*)::int as n from audit_log where workspace_id = $1 and action in ('chat.taken_over', 'chat.handed_back') and actor = $2`, [owner.workspaceId, member.userId])).toBe(2);
  });

  it('a member’s reply reaches the visitor’s stream, approved by their own send, with no hold', async () => {
    const { owner, siteKey } = await chatOn('Reply');
    const member = await addMember(owner.workspaceId, 'member', 'Mel Member');
    const v = new Visitor(siteKey);
    await v.say('I need a person please');
    const stream = await v.stream();
    expect(stream.res.status).toBe(200);
    expect(stream.res.headers.get('content-type')).toMatch(/text\/event-stream/);
    // The stream starts with what was said so far.
    expect(await stream.until((list) => list.length === 2)).toBe(true);

    // Replying needs the chat taken over first.
    expect((await chat(member, { op: 'reply', id: v.conversation, text: 'Hello!', message: 'm-early' })).error).toMatch(/Take over the chat/);
    await chat(member, { op: 'takeOver', id: v.conversation, on: true });
    const sent = await chat(member, { op: 'reply', id: v.conversation, text: '  Hi, Mel here. How can I help?  ', message: 'm-1', by: 'The CEO' });
    expect(sent.ok, sent.error).toBe(true);
    expect(sent.holding).toBeUndefined();
    expect(await stream.until((list) => list.some((m) => m.from === 'person'))).toBe(true);
    const got = stream.messages().find((m) => m.from === 'person')!;
    expect(got.text).toBe('Hi, Mel here. How can I help?');
    // The visitor is told a person wrote, never who.
    expect(JSON.stringify(got)).not.toMatch(/Mel Member|The CEO/);
    expect(Object.keys(got).sort()).toEqual(['at', 'from', 'id', 'seq', 'text']);
    await stream.close();

    // Members see who wrote it: the name is the server's to say, not the caller's.
    const c = (await convo(owner, v.conversation!))!;
    expect(c.messages.at(-1)).toMatchObject({ id: 'm-1', from: 'you', by: 'Mel Member', text: 'Hi, Mel here. How can I help?' });
    const e = (await effects(owner)).find((x) => x.source === 'user')!;
    expect(e).toMatchObject({ status: 'completed', approved_via: 'click', approved_by: member.userId, requested_by: member.userId, hold_until: null });
    // A visitor who comes back later gets the whole conversation from the start.
    const later = await v.stream();
    expect(await later.until((list) => list.length === 3)).toBe(true);
    expect(later.messages().map((m) => m.from)).toEqual(['visitor', 'timmy', 'person']);
    await later.close();
  });

  it('only someone who may send for the workspace takes a chat over or replies', async () => {
    const { owner, siteKey } = await chatOn('Roles');
    const v = new Visitor(siteKey);
    await v.say('hello');
    for (const role of ['assistant', 'revops', 'client']) {
      const c = await addMember(owner.workspaceId, role);
      expect((await chat(c, { op: 'takeOver', id: v.conversation, on: true })).ok, role).toBe(false);
      expect((await chat(c, { op: 'reply', id: v.conversation, text: 'hi', message: `m-${role}` })).ok, role).toBe(false);
    }
    expect((await convo(owner, v.conversation!))!.live).toBe(false);
    expect(await count(`select count(*)::int as n from chat_message where conversation_id = $1 and sender = 'member'`, [v.conversation])).toBe(0);
  });

  it('the privacy notice goes with the email question when a privacy policy is set', async () => {
    const { siteKey } = await chatOn('Privacy', { privacyUrl: 'https://acme.example/privacy' });
    const v = new Visitor(siteKey);
    const out = await v.say('What does it cost?');
    expect(out.body.messages!.map((m) => [m.text, m.notice])).toEqual([['What does it cost?', undefined], [FAQ[0]!.a, undefined], [EMAIL_QUESTION, 'privacy']]);
    const plain = new Visitor((await chatOn('NoPrivacy')).siteKey);
    expect((await plain.say('What does it cost?')).body.messages!.every((m) => m.notice === undefined)).toBe(true);
  });

  it('“offer a call” is never acted on: no times are offered and nothing is booked', async () => {
    const { owner, siteKey } = await chatOn('NoBooking', { handoff: 'book', booking: true });
    const v = new Visitor(siteKey);
    expect(v.replies(await v.say('Can someone call me?'))).toEqual(['Leave your email and Acme Support will write back today.']);
    await v.say('ada@lovelace.example');
    await v.say('Analytical Engines');
    expect(v.replies(await v.say('12'))).toEqual(['Thanks! Acme Support will be in touch at ada@lovelace.example.']);
    expect(v.seen.some((m) => /Pick a time|Booked/.test(m.text))).toBe(false);
    expect((await convo(owner, v.conversation!))!.booked).toBeUndefined();
    expect(Object.keys((await owner.state()).ws.events)).toEqual([]);
    expect(await count(`select count(*)::int as n from effect where workspace_id = $1 and kind <> 'chat.reply'`, [owner.workspaceId])).toBe(0);
  });
});

describe('every message that reaches a visitor is an effect record', () => {
  it('each of Timmy’s and each member’s messages has its record and its audit trail, and the record holds no words', async () => {
    const { owner, siteKey } = await chatOn('Trail');
    const v = new Visitor(siteKey);
    await v.say('What does it cost?');
    await v.say('talk to a person: ada@lovelace.example');
    await chat(owner, { op: 'takeOver', id: v.conversation, on: true });
    await chat(owner, { op: 'reply', id: v.conversation, text: 'Ada, this is the owner.', message: 'm-owner' });

    const shown = await rows<{ id: string; sender: string; effect_id: string | null; seq: number | null; body: string }>(`select id, sender, effect_id, seq, body from chat_message where conversation_id = $1 order by seq`, [v.conversation]);
    const outbound = shown.filter((m) => m.sender !== 'visitor');
    expect(outbound.map((m) => m.sender)).toEqual(['timmy', 'timmy', 'timmy', 'member']);
    expect(shown.every((m) => m.seq !== null)).toBe(true);
    const made = await effects(owner);
    expect(made).toHaveLength(outbound.length);
    for (const m of outbound) {
      const e = made.find((x) => x.id === m.effect_id)!;
      expect(e, m.body).toBeDefined();
      expect(e).toMatchObject({ status: 'completed', kind: 'chat.reply', target: `chat:${v.conversation}`, external_id: m.id });
      expect(e.payload).toMatchObject({ conversationId: v.conversation, messageId: m.id, sender: m.sender });
      // Approved by the rule (which names a person) or by the member's own send. Never by nobody.
      if (m.sender === 'timmy') expect([e.approved_via, e.approved_by, !!e.policy_id]).toEqual(['rule', `rule:${e.policy_id}`, true]);
      else expect([e.approved_via, e.approved_by]).toEqual(['click', owner.userId]);
      const trail = (await rows<{ action: string }>('select action from audit_log where workspace_id = $1 and effect_id = $2 order by id', [owner.workspaceId, e.id])).map((r) => r.action);
      expect(trail).toEqual(['effect.proposed', 'effect.approved', 'effect.executing', 'effect.completed']);
      // The record pins the message down without keeping what was said.
      expect(JSON.stringify([e.payload, e.preview, e.result])).not.toContain(m.body);
    }
    // And nothing reached the visitor that is not on that list.
    expect(v.seen.filter((m) => m.from !== 'visitor')).toHaveLength(3);
    expect(await count(`select count(*)::int as n from chat_message where workspace_id = $1 and sender <> 'visitor' and effect_id is null`, [owner.workspaceId])).toBe(0);
  });

  it('without the rule, Timmy says nothing to anyone: the message is turned away and nothing waits for approval', async () => {
    const { owner, siteKey } = await chatOn('NoRule');
    // The switch says on, but the rule a person set is gone (as if something had removed it behind the screen's back).
    await sysPool.query(`update policy set enabled = false where workspace_id = $1 and kind = 'chat.reply'`, [owner.workspaceId]);
    const v = new Visitor(siteKey);
    const out = await v.say('What does it cost?');
    expect([out.status, out.body]).toEqual([404, { ok: false, notice: 'This chat isn’t available right now.' }]);
    expect(await count('select count(*)::int as n from chat_message where workspace_id = $1', [owner.workspaceId])).toBe(0);
    expect(await count('select count(*)::int as n from effect where workspace_id = $1', [owner.workspaceId])).toBe(0);
    expect((await owner.state()).pending).toEqual([]);
    expect((await owner.state()).ws.chats).toEqual({});
  });

  it('a request sent twice stores one message and sends nothing twice', async () => {
    const { owner, siteKey } = await chatOn('Replay');
    const v = new Visitor(siteKey);
    // The very first message, sent again because its answer was lost: one conversation, one set of replies.
    const first = { visitor: v.id, id: hex(), text: 'What does it cost?', after: 0, ...(await v.proof()) };
    const a = await v.post(first);
    const b = await v.post(first);
    expect(b.body.conversation).toBe(a.body.conversation);
    expect(b.body.messages).toEqual(a.body.messages);
    expect(await count('select count(*)::int as n from chat_conversation where workspace_id = $1', [owner.workspaceId])).toBe(1);
    expect(await count('select count(*)::int as n from chat_message where workspace_id = $1', [owner.workspaceId])).toBe(3);
    expect(await effects(owner)).toHaveLength(2);

    // A later message, replayed with its token.
    v.conversation = a.body.conversation;
    v.token = a.body.token;
    const next = { visitor: v.id, id: hex(), text: 'ada@lovelace.example', conversation: v.conversation, token: v.token, after: 0 };
    await v.post(next);
    await v.post(next);
    await v.post(next);
    expect(await count('select count(*)::int as n from chat_message where workspace_id = $1', [owner.workspaceId])).toBe(5);
    expect(await effects(owner)).toHaveLength(3);
    expect(Object.values((await owner.state()).out.leads)).toHaveLength(1);
    expect((await convo(owner, v.conversation!))!.messages).toHaveLength(5);

    // Running a finished effect again does nothing, by the gateway or by the executor itself.
    const done = (await effects(owner))[0]!;
    const before = await rows('select id, seq, sent_at from chat_message where workspace_id = $1 order by seq', [owner.workspaceId]);
    expect(await executeEffect(owner.workspaceId, done.id)).toBeNull();
    expect((await sendChatReply(done)).status).toBe('completed');
    await jobs().drain();
    expect(await rows('select id, seq, sent_at from chat_message where workspace_id = $1 order by seq', [owner.workspaceId])).toEqual(before);

    // A member's reply: the same command again, and the same message under a new command.
    await chat(owner, { op: 'takeOver', id: v.conversation, on: true });
    const reply = { op: 'reply', id: v.conversation, text: 'Hello Ada', message: 'm-once' };
    const one = await chat(owner, reply, 'cmd-reply-once');
    const two = await chat(owner, reply, 'cmd-reply-once');
    expect(two.rev).toBe(one.rev);
    expect((await chat(owner, reply)).error).toMatch(/already sent/);
    expect(await count(`select count(*)::int as n from chat_message where conversation_id = $1 and sender = 'member'`, [v.conversation])).toBe(1);
    const stream = await v.stream();
    expect(await stream.until((list) => list.some((m) => m.from === 'person'))).toBe(true);
    expect(stream.messages().filter((m) => m.from === 'person')).toHaveLength(1);
    expect(new Set(stream.messages().map((m) => m.id)).size).toBe(stream.messages().length);
    await stream.close();
  });

  it('the database itself refuses to show a reply whose effect is not running', async () => {
    const { owner, siteKey } = await chatOn('DbGuard');
    const v = new Visitor(siteKey);
    await v.say('hello');
    const done = (await effects(owner))[0]!;
    const ids = [owner.workspaceId, v.conversation];
    // As the app's own database role, inside the right workspace: the most any code path could do.
    const direct = (sql: string, params: unknown[]) => withWorkspace({ workspaceId: owner.workspaceId }, (tx) => tx.query(sql, params));
    const refused = /a reply is shown only while its approved effect is running/;
    // A reply written straight in as visible, with no effect, or with one that has already finished.
    await expect(direct(`insert into chat_message (id, workspace_id, conversation_id, sender, body, seq, sent_at) values ('cm_planted_1', $1, $2, 'timmy', 'planted', nextval('chat_message_seq'), now())`, ids)).rejects.toThrow(refused);
    await expect(direct(`insert into chat_message (id, workspace_id, conversation_id, sender, body, effect_id, seq, sent_at) values ('cm_planted_2', $1, $2, 'member', 'planted', $3, nextval('chat_message_seq'), now())`, [...ids, done.id])).rejects.toThrow(refused);
    // A reply that is waiting can't be made visible by hand either.
    await direct(`insert into chat_message (id, workspace_id, conversation_id, sender, body, effect_id) values ('cm_waiting', $1, $2, 'timmy', 'waiting', $3)`, [...ids, done.id]);
    await expect(direct(`update chat_message set seq = nextval('chat_message_seq'), sent_at = now() where id = 'cm_waiting' and workspace_id = $1 and conversation_id = $2`, ids)).rejects.toThrow(refused);
    // What was shown stays where it is and says what it said.
    await expect(direct(`update chat_message set seq = seq + 1000 where workspace_id = $1 and conversation_id = $2 and sender = 'timmy' and seq is not null`, ids)).rejects.toThrow(/its place in the conversation cannot change/);
    await expect(direct(`update chat_message set body = 'rewritten' where workspace_id = $1 and conversation_id = $2 and sender = 'visitor'`, ids)).rejects.toThrow(/what was said cannot change/);
    const stream = await v.stream();
    expect(await stream.until((list) => list.length === 2)).toBe(true);
    expect(stream.messages().map((m) => m.text)).toEqual(['hello', expect.stringMatching(/^Good question/)]);
    await stream.close();
  });

  it('a reply is not shown late, after the chat was switched off, or once a teammate has taken over', async () => {
    const { owner, siteKey } = await chatOn('Late');
    const v = new Visitor(siteKey);
    await v.say('What does it cost?');
    const [shownAlready] = await effects(owner);
    // Three replies that were approved but never shown (as if the server stopped at that moment).
    const pending = async (sender: 'timmy' | 'member', label: string) => {
      const id = `cm_test_${label}`;
      await sysPool.query(`insert into chat_message (id, workspace_id, conversation_id, sender, body, effect_id) values ($1, $2, $3, $4, $5, $6)`, [id, owner.workspaceId, v.conversation, sender, `late ${label}`, shownAlready!.id]);
      return { ...shownAlready!, payload: { conversationId: v.conversation, messageId: id, mark: await textMark(`late ${label}`), sender } } as unknown as EffectRow;
    };
    const visible = () => count('select count(*)::int as n from chat_message where conversation_id = $1 and seq is not null', [v.conversation]);
    const before = await visible();

    // The words of a stored message can't be changed by anyone, even the database's owner.
    const tampered = await pending('timmy', 'tampered');
    await expect(sysPool.query(`update chat_message set body = 'something nobody approved' where id = $1`, ['cm_test_tampered'])).rejects.toThrow(/what was said cannot change/);
    // And were they ever not the words that were approved, the reply would not be shown.
    expect(await sendChatReply({ ...tampered, payload: { ...tampered.payload, mark: 'f'.repeat(64) } } as EffectRow)).toMatchObject({ status: 'failed', error: expect.stringMatching(/not the one that was approved/) });

    const stale = await pending('timmy', 'stale');
    await sysPool.query(`update chat_message set created_at = now() - interval '2 hours' where id = $1`, ['cm_test_stale']);
    expect(await sendChatReply(stale)).toMatchObject({ status: 'failed', error: expect.stringMatching(/Too much time/) });

    const overtaken = await pending('timmy', 'overtaken');
    await chat(owner, { op: 'takeOver', id: v.conversation, on: true });
    expect(await sendChatReply(overtaken)).toMatchObject({ status: 'failed', error: expect.stringMatching(/took over/) });

    const closed = await pending('member', 'closed');
    await settings(owner, { on: false });
    expect(await sendChatReply(closed)).toMatchObject({ status: 'failed', error: expect.stringMatching(/switched off/) });
    expect(await visible()).toBe(before);
  });
});

describe('one visitor can never reach another’s conversation', () => {
  it('a forged, swapped, expired or missing token reads and writes nothing', async () => {
    const { owner, siteKey } = await chatOn('Tokens');
    const a = new Visitor(siteKey);
    const b = new Visitor(siteKey);
    await a.say('I am Alice, alice@a.example');
    await b.say('I am Bob and my secret is 4242');
    const stored = () => count('select count(*)::int as n from chat_message where workspace_id = $1', [owner.workspaceId]);
    const before = await stored();
    const ended = { ok: false, notice: 'This conversation has ended. Send your message again to start a new one.', reset: true };
    const sig = a.token!.split('.');

    const attempts: [string, { conversation?: string; token?: string }][] = [
      ['A’s token with B’s conversation', { conversation: b.conversation, token: a.token }],
      ['B’s conversation with no token', { conversation: b.conversation }],
      ['A’s token re-pointed at B’s conversation', { conversation: b.conversation, token: [sig[0], b.conversation, sig[2], sig[3]].join('.') }],
      ['a token with a made-up signature', { conversation: b.conversation, token: `v1.${b.conversation}.${sig[2]}.${'A'.repeat(43)}` }],
      ['a token with its expiry pushed out', { conversation: a.conversation, token: [sig[0], sig[1], String(Number(sig[2]) + 1000), sig[3]].join('.') }],
      ['a token that ran out', { conversation: a.conversation, token: await issueToken(owner.workspaceId, a.conversation!, Date.now() - 40 * 86_400_000) }],
      ['a token signed for another workspace', { conversation: b.conversation, token: await issueToken('some-other-workspace', b.conversation!) }],
      ['a token that isn’t one', { conversation: b.conversation, token: 'null' }],
    ];
    for (const [what, as] of attempts) {
      const out = await a.post({ visitor: a.id, id: hex(), text: 'let me in', ...as });
      expect([what, out.status, out.body]).toEqual([what, 403, ended]);
      const stream = await a.stream(as.conversation ? { conversation: as.conversation, token: as.token ?? '' } : {});
      expect([what, stream.res.status]).toEqual([what, 403]);
      expect(await stream.res.json()).toEqual(ended);
    }
    // Claiming to be B (B's visitor id is not a secret B's browser ever sends to A, but suppose it leaked) starts a new chat; it opens nothing.
    const posing = await a.post({ visitor: b.id, id: hex(), text: 'I am Bob', ...(await a.proof()) });
    expect(posing.body.conversation).not.toBe(b.conversation);
    expect(JSON.stringify(posing.body)).not.toContain('4242');
    expect(await stored()).toBe(before + 2);
    // Each of them still reads only their own.
    const mine = await a.stream();
    expect(await mine.until((list) => list.length >= 2)).toBe(true);
    expect(JSON.stringify(mine.messages())).not.toContain('4242');
    await mine.close();
    expect(await conversationOf(a.token, owner.workspaceId)).toBe(a.conversation);
    expect(await conversationOf(a.token, 'some-other-workspace')).toBeNull();
  });
});

describe('one workspace can never reach another’s chats', () => {
  it('a site key reads and writes only its own workspace, and a member of another workspace cannot act on a conversation by id', async () => {
    const alpha = await chatOn('Alpha', { faq: [{ id: 'f1', q: 'What is the launch code?', a: 'Alpha’s answer is 1111.' }] }, 'alpha.example');
    const bravo = await chatOn('Bravo', { faq: [{ id: 'f1', q: 'What is the launch code?', a: 'Bravo’s answer is 2222.' }] }, 'bravo.example');
    const a = new Visitor(alpha.siteKey);
    const b = new Visitor(bravo.siteKey);
    expect(a.replies(await a.say('what is the launch code'))[0]).toBe('Alpha’s answer is 1111.');
    expect(b.replies(await b.say('what is the launch code'))[0]).toBe('Bravo’s answer is 2222.');
    const inBravo = () => count('select count(*)::int as n from chat_message where workspace_id = $1', [bravo.owner.workspaceId]);
    const before = await inBravo();

    // Alpha's visitor takes their conversation and token to Bravo's site key: refused, and nothing lands in Bravo.
    const crossed = new Visitor(bravo.siteKey);
    Object.assign(crossed, { id: a.id, conversation: a.conversation, token: a.token });
    expect((await crossed.say('let me into Bravo')).status).toBe(403);
    expect((await crossed.stream()).res.status).toBe(403);
    // Naming Bravo's conversation on Alpha's key finds nothing either, whatever the token.
    expect((await a.post({ visitor: a.id, id: hex(), text: 'x', conversation: b.conversation, token: b.token })).status).toBe(403);
    // A workspace named in the request is ignored: the workspace only ever comes from the site key.
    const named = await a.post({ visitor: a.id, id: hex(), text: 'where does this go', conversation: a.conversation, token: a.token, workspace: bravo.owner.workspaceId, workspaceId: bravo.owner.workspaceId, site: bravo.siteKey });
    expect(named.status).toBe(200);
    expect(await inBravo()).toBe(before);
    expect(JSON.stringify((await bravo.owner.state()).ws.chats)).not.toMatch(/Alpha|1111|where does this go/);

    // A member of Bravo, holding Alpha's conversation id, can do nothing to it and read nothing of it.
    for (const op of [{ op: 'takeOver', on: true }, { op: 'reply', text: 'hello from Bravo', message: 'm-x' }, { op: 'star', on: true }, { op: 'read' }, { op: 'delete' }]) {
      const out = await chat(bravo.owner, { ...op, id: a.conversation });
      expect([op.op, out.ok, out.error]).toEqual([op.op, false, 'That chat is no longer here.']);
    }
    expect((await bravo.owner.get(`/api/v1/chat/conversations/${a.conversation}/messages`)).status).toBe(404);
    expect(await convo(alpha.owner, a.conversation!)).toMatchObject({ live: false });
    expect(await count('select count(*)::int as n from chat_message where conversation_id = $1', [a.conversation])).toBe(5);
    expect((await alpha.owner.get(`/api/v1/chat/conversations/${a.conversation}/messages`)).status).toBe(200);
  });

  it('the database itself keeps the chat tables apart', async () => {
    const alpha = await chatOn('RlsA', {}, 'rls-a.example');
    const bravo = await chatOn('RlsB', {}, 'rls-b.example');
    const a = new Visitor(alpha.siteKey);
    await a.say('hello');
    await new Visitor(bravo.siteKey).say('hello');
    const tables = ['chat_widget', 'chat_conversation', 'chat_message', 'chat_counter'];
    const c = await appPool().connect();
    try {
      // With no workspace set, the app's database role sees no chat at all.
      for (const t of tables) expect((await c.query(`select count(*)::int as n from ${t}`)).rows[0].n, t).toBe(0);
    } finally {
      c.release();
    }
    await withWorkspace({ workspaceId: bravo.owner.workspaceId }, async (tx) => {
      for (const t of tables) {
        const r = (await tx.query(`select count(*)::int as n, count(*) filter (where workspace_id <> $1)::int as other from ${t}`, [bravo.owner.workspaceId])).rows[0];
        expect(r.n, `${t} is visible`).toBeGreaterThan(0);
        expect(r.other, `${t} leaks`).toBe(0);
      }
      expect((await tx.query('select 1 from chat_conversation where id = $1', [a.conversation])).rowCount).toBe(0);
      expect((await tx.query(`update chat_conversation set live = true where id = $1`, [a.conversation])).rowCount).toBe(0);
      expect((await tx.query(`delete from chat_message where conversation_id = $1`, [a.conversation])).rowCount).toBe(0);
    });
    await expect(withWorkspace({ workspaceId: bravo.owner.workspaceId }, (tx) => tx.query(`insert into chat_message (id, workspace_id, conversation_id, sender, body) values ('cm_evil', $1, $2, 'timmy', 'planted')`, [alpha.owner.workspaceId, a.conversation]))).rejects.toThrow(/row-level security/);
  });
});

describe('what a visitor types is only ever text', () => {
  it('HTML and script come back as the same inert characters, to the visitor and to members', async () => {
    const { owner, siteKey } = await chatOn('Inert', { faq: [{ id: 'f1', q: 'Markup?', a: 'We write <b>bold</b> & "quotes" as they are.' }] });
    const v = new Visitor(siteKey);
    const nasty = '<script>alert(document.cookie)</script><img src=x onerror="alert(1)"> {{7*7}} ${7*7} ‮txt.exe';
    const out = await v.say(nasty);
    expect(out.res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(out.res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(out.body.messages![0]).toMatchObject({ from: 'visitor', text: nasty });
    expect((await convo(owner, v.conversation!))!.messages[0]!.text).toBe(nasty);
    expect((await rows<{ body: string }>(`select body from chat_message where conversation_id = $1 and sender = 'visitor'`, [v.conversation]))[0]!.body).toBe(nasty);
    // An address with markup around it is taken as the address alone; the lead's name can't carry a tag.
    await v.say('<b>eve@evil.example</b><script>x</script>');
    const lead = Object.values((await owner.state()).out.leads)[0]!;
    expect(lead).toMatchObject({ email: 'eve@evil.example', first: 'Eve' });
    // Control characters are dropped; a page that isn't a plain path is not kept.
    const odd = new Visitor(siteKey);
    const res = await odd.say('a\u0000b\u0007c\r\nd', { page: 'javascript:alert(1)' });
    expect(res.body.messages![0]!.text).toBe('abc\nd');
    expect((await convo(owner, odd.conversation!))!.page).toBeUndefined();
    // The owner's own answer with markup in it is sent as written, as text.
    const asked = new Visitor(siteKey);
    expect(asked.replies(await asked.say('markup'))[0]).toBe('We write <b>bold</b> & "quotes" as they are.');
  });

  it('what is kept of a visitor’s words has a size: no lead from an absurd address, and a long answer is cut', async () => {
    const { owner, siteKey } = await chatOn('Sizes');
    const v = new Visitor(siteKey);
    await v.say(`${'a'.repeat(1900)}@example.test`);
    expect(Object.values((await owner.state()).out.leads)).toHaveLength(0);
    expect(await convo(owner, v.conversation!)).not.toHaveProperty('email');
    expect(await convo(owner, v.conversation!)).not.toHaveProperty('name');
    await v.say('real@person.example');
    await v.say('B'.repeat(1500));
    const s = await owner.state();
    expect(Object.values(s.out.leads)).toHaveLength(1);
    expect(Object.values(s.out.leads)[0]!.extra!['What’s your company called']).toHaveLength(501);
    expect(s.ws.chats[v.conversation!]!.answers!.q1).toHaveLength(501);
    // The transcript still has all of it.
    expect((await rows<{ n: number }>(`select char_length(body)::int as n from chat_message where conversation_id = $1 and sender = 'visitor' order by seq desc limit 1`, [v.conversation]))[0]!.n).toBe(1500);
  });

  it('a request that isn’t a chat message is refused with a plain sentence', async () => {
    const { owner, siteKey } = await chatOn('Shapes');
    const v = new Visitor(siteKey);
    const bad: unknown[] = ['not json', '[]', 'null', {}, { visitor: v.id, id: hex(), text: 42 }, { visitor: 'short', id: hex(), text: 'hi' }, { visitor: v.id, id: '../../etc/passwd', text: 'hi' }, { visitor: v.id, id: hex(), text: '   ' }, { visitor: { $ne: null }, id: hex(), text: 'hi' }, { visitor: v.id, id: hex(), text: 'hi', conversation: { id: 1 }, token: ['x'] }];
    for (const body of bad) {
      const out = await v.post(body);
      expect([JSON.stringify(body), out.status >= 400 && out.status < 500, typeof out.body.notice, out.body.ok]).toEqual([JSON.stringify(body), true, 'string', false]);
    }
    expect(await count('select count(*)::int as n from chat_conversation where workspace_id = $1', [owner.workspaceId])).toBe(0);
    // A page on some other website cannot post into the chat from a visitor's browser.
    const cross = await v.post({ visitor: v.id, id: hex(), text: 'hi' }, { origin: 'https://evil.example' });
    expect(cross.status).toBe(403);
  });
});

describe('limits a stranger cannot get past', () => {
  it('a message over 2,000 characters, or a request over the size limit, is refused and not stored', async () => {
    const { owner, siteKey } = await chatOn('Length');
    const v = new Visitor(siteKey);
    expect((await v.say('x'.repeat(2000))).body.ok).toBe(true);
    const long = await v.say('x'.repeat(2001));
    expect([long.status, long.body]).toEqual([413, { ok: false, notice: 'That message is too long. Keep it under 2,000 characters.' }]);
    const huge = await v.post({ visitor: v.id, id: hex(), text: 'y'.repeat(config.chat.maxBodyBytes + 10) });
    expect([huge.status, huge.body.ok, typeof huge.body.notice]).toEqual([413, false, 'string']);
    expect(await count(`select count(*)::int as n from chat_message where workspace_id = $1 and sender = 'visitor'`, [owner.workspaceId])).toBe(1);
    // A member's reply has the same limit.
    await chat(owner, { op: 'takeOver', id: v.conversation, on: true });
    expect((await chat(owner, { op: 'reply', id: v.conversation, text: 'z'.repeat(2001), message: 'm-long' })).error).toMatch(/too long/);
  });

  it('one visitor, and one address, can only send so many messages a minute', async () => {
    const { owner, siteKey } = await chatOn('Rates');
    config.chat.visitorMessagesPerMinute = 4;
    const v = new Visitor(siteKey);
    const answers = [];
    for (let i = 0; i < 6; i++) answers.push(await v.say(`message ${i}`));
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200, 429, 429]);
    expect(answers[5]!.body).toEqual({ ok: false, notice: 'You’re sending messages quickly. Wait a moment and try again.' });
    expect(answers[5]!.res.headers.get('content-type')).toMatch(/^application\/json/);

    // Many "visitors" from one address share that address's limit.
    resetLimits();
    config.chat.addressMessagesPerMinute = 3;
    const address = freshAddress();
    const crowd = [];
    for (let i = 0; i < 5; i++) {
      const one = new Visitor(siteKey);
      one.address = address;
      crowd.push((await one.say('hi')).status);
    }
    expect(crowd).toEqual([200, 200, 200, 429, 429]);
    // And one address can only start so many conversations an hour.
    resetLimits();
    Object.assign(config.chat, limits, { addressConversationsPerHour: 2 });
    const starts = [];
    for (let i = 0; i < 4; i++) {
      const one = new Visitor(siteKey);
      one.address = address;
      starts.push((await one.say('hi')).status);
    }
    expect(starts).toEqual([200, 200, 429, 429]);
    expect(await count(`select count(*)::int as n from chat_message where workspace_id = $1 and sender = 'visitor'`, [owner.workspaceId])).toBe(4 + 3 + 2);

    // And one address can only send so many messages to one business in a day, so it can't use up the chat's whole
    // allowance and close it to every other visitor. Another address is not affected.
    resetLimits();
    Object.assign(config.chat, limits, { addressMessagesPerDay: 3 });
    const daily = [];
    const steady = new Visitor(siteKey);
    steady.address = freshAddress();
    for (let i = 0; i < 5; i++) daily.push((await steady.say(`message ${i}`)).status);
    expect(daily).toEqual([200, 200, 200, 429, 429]);
    const someoneElse = new Visitor(siteKey);
    expect((await someoneElse.say('hello')).status).toBe(200);
    Object.assign(config.chat, limits);
  });

  it('a conversation holds only so many messages, and a widget takes only so many conversations and messages a day', async () => {
    const { owner, siteKey } = await chatOn('Caps');
    Object.assign(config.chat, { messagesPerConversation: 3, visitorMessagesPerMinute: 100 });
    const v = new Visitor(siteKey);
    const sent = [];
    for (let i = 0; i < 5; i++) sent.push(await v.say(`message ${i}`));
    expect(sent.map((s) => s.status)).toEqual([200, 200, 200, 429, 429]);
    expect(sent[4]!.body.notice).toMatch(/reached its limit/);
    expect(await count(`select count(*)::int as n from chat_message where conversation_id = $1 and sender = 'visitor'`, [v.conversation])).toBe(3);

    // The daily cap on new conversations: whoever asks and from wherever, the widget takes no more today.
    Object.assign(config.chat, limits, { conversationsPerDay: 3 });
    const started = [];
    for (let i = 0; i < 4; i++) started.push(await new Visitor(siteKey).say('hello'));
    expect(started.map((s) => s.status)).toEqual([200, 200, 429, 429]);
    expect(started[3]!.body).toEqual({ ok: false, notice: 'The chat is very busy today. Please try again tomorrow, or reach us another way.' });
    expect(await count('select count(*)::int as n from chat_conversation where workspace_id = $1', [owner.workspaceId])).toBe(3);
    // Conversations already open carry on.
    Object.assign(config.chat, limits, { conversationsPerDay: 3 });
    const open = new Visitor(siteKey);
    Object.assign(open, { id: v.id, conversation: v.conversation, token: v.token });
    expect((await open.say('still here')).status).toBe(200);

    // The daily cap on messages.
    const today = (await rows<{ messages: number }>('select messages from chat_counter where workspace_id = $1 and day = current_date', [owner.workspaceId]))[0]!.messages;
    Object.assign(config.chat, limits, { messagesPerDay: today + 1 });
    expect((await open.say('one more')).status).toBe(200);
    expect((await open.say('and one too many')).body.notice).toMatch(/very busy today/);
  });

  it('a visitor can only hold so many streams open', async () => {
    const { siteKey } = await chatOn('Streams');
    const v = new Visitor(siteKey);
    await v.say('hello');
    const open = [];
    for (let i = 0; i < config.chat.streamsPerConversation; i++) open.push(await v.stream());
    expect(open.map((s) => s.res.status)).toEqual(open.map(() => 200));
    const extra = await v.stream();
    expect(extra.res.status).toBe(429);
    expect((await extra.res.json()).notice).toMatch(/Wait a moment/);
    // Closing one frees its place.
    await open[0]!.close();
    await new Promise((r) => setTimeout(r, 50));
    const next = await v.stream();
    expect(next.res.status).toBe(200);
    for (const s of [...open.slice(1), next]) await s.close();
  });

  it('the Chats screen holds a bounded copy; the whole conversation stays in the stored one', async () => {
    const { owner, siteKey } = await chatOn('Bounded');
    Object.assign(config.chat, { shownMessages: 4, shownConversations: 3, visitorMessagesPerMinute: 100 });
    const v = new Visitor(siteKey);
    for (let i = 0; i < 6; i++) await v.say(`note number ${i}`);
    const c = (await convo(owner, v.conversation!))!;
    expect(c.messages).toHaveLength(4);
    expect(c.messages.at(-2)!.text).toBe('note number 5');
    const total = await count('select count(*)::int as n from chat_message where conversation_id = $1', [v.conversation]);
    expect(c.earlier).toBe(total - 4);
    // A teammate can still read all of it.
    const full = await owner.json<{ messages: { text: string; from: string }[] }>('GET', `/api/v1/chat/conversations/${v.conversation}/messages`);
    expect(full.messages).toHaveLength(total);
    expect(full.messages[0]).toMatchObject({ from: 'visitor', text: 'note number 0' });
    const client = await addMember(owner.workspaceId, 'client');
    expect((await client.get(`/api/v1/chat/conversations/${v.conversation}/messages`)).status).toBe(403);

    // Only the newest conversations are listed; a starred one is kept ahead of older unstarred ones.
    expect((await chat(owner, { op: 'star', id: v.conversation, on: true })).ok).toBe(true);
    const later = [];
    for (let i = 0; i < 4; i++) {
      const one = new Visitor(siteKey);
      await one.say(`visitor ${i}`);
      later.push(one.conversation!);
    }
    const listed = Object.keys((await owner.state()).ws.chats);
    expect(listed).toHaveLength(3);
    expect(listed).toEqual(expect.arrayContaining([v.conversation!, later[2]!, later[3]!]));
    expect(await count('select count(*)::int as n from chat_conversation where workspace_id = $1', [owner.workspaceId])).toBe(5);
  });
});

describe('what members can and cannot do to a conversation', () => {
  it('a member’s generic edits still cannot write, rewrite or remove a conversation; only the two flags', async () => {
    const { owner, siteKey } = await chatOn('Generic');
    const member = await addMember(owner.workspaceId, 'member');
    const v = new Visitor(siteKey);
    await v.say('What does it cost?');
    const id = v.conversation!;
    const before = (await convo(owner, id))!;
    const ops = (list: unknown[]) => member.cmd({ type: 'ws', ops: list });
    const forged = [
      [{ op: 'patch', col: 'chats', id, patch: { messages: [] } }],
      [{ op: 'patch', col: 'chats', id, patch: { messages: [...before.messages, { id: 'forged', from: 'timmy', text: 'Send us your password.', at: new Date() }] } }],
      [{ op: 'patch', col: 'chats', id, patch: { live: true } }],
      [{ op: 'patch', col: 'chats', id, patch: { email: 'someone@else.example', unread: false } }],
      [{ op: 'put', col: 'chats', item: { ...before, messages: [] } }],
      [{ op: 'put', col: 'chats', item: { id: 'made-up', messages: [{ id: 'm', from: 'visitor', text: 'hi', at: new Date() }], live: false, unread: true } }],
      [{ op: 'remove', col: 'chats', id }],
    ];
    for (const list of forged) {
      const out = await ops(list);
      expect([JSON.stringify(list).slice(0, 60), out.ok, out.error]).toEqual([JSON.stringify(list).slice(0, 60), false, 'A visitor’s conversation can’t be changed that way.']);
    }
    expect(await convo(owner, id)).toEqual(before);
    // The two flags, either way: a plain edit, or the chat's own commands.
    expect((await ops([{ op: 'patch', col: 'chats', id, patch: { unread: false, starred: true } }])).ok).toBe(true);
    expect(await convo(owner, id)).toMatchObject({ unread: false, starred: true, messages: before.messages });
    expect((await chat(member, { op: 'star', id, on: false })).ok).toBe(true);
    await v.say('ada@lovelace.example');
    expect(await convo(owner, id)).toMatchObject({ unread: true, starred: false });
    expect((await chat(member, { op: 'read', id })).ok).toBe(true);
    expect((await convo(owner, id))!.unread).toBe(false);
    // Nothing a visitor was shown can be undone.
    await chat(owner, { op: 'takeOver', id, on: true });
    const reply = await chat(owner, { op: 'reply', id, text: 'On my way', message: 'm-undo' });
    expect((await owner.cmd({ type: 'undo', command: reply.id })).ok).toBe(false);
    expect((await convo(owner, id))!.messages.at(-1)!.text).toBe('On my way');
    // A command the chat doesn't have is refused.
    for (const op of [{ op: 'reply', id, text: 'x' }, { op: 'reply', id, text: 'x', message: 'has space' }, { op: 'impersonate', id }, { op: 'read', id: '../x' }, null]) expect((await member.cmd({ type: 'chat', op })).ok).toBe(false);
    // Nor is an id that names something every object has: nothing is written under it.
    for (const odd of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      for (const op of [{ op: 'star', id: odd, on: true }, { op: 'read', id: odd }, { op: 'takeOver', id: odd, on: true }, { op: 'reply', id: odd, text: 'x', message: 'm-odd' }, { op: 'delete', id: odd }]) expect([odd, op.op, (await owner.cmd({ type: 'chat', op })).ok]).toEqual([odd, op.op, false]);
    }
    for (const odd of ['constructor', 'toString', '__proto__']) await ops([{ op: 'patch', col: 'chats', id: odd, patch: { unread: false, starred: true } }]);
    expect(Object.keys((await owner.state()).ws.chats)).toEqual([id]);
  });

  it('deleting a conversation removes the stored copy and every other place its words were kept', async () => {
    const { owner, siteKey } = await chatOn('Delete');
    const member = await addMember(owner.workspaceId, 'member');
    const v = new Visitor(siteKey);
    await v.say('My passport number is ZEBRA-QUARTZ-77');
    await v.say('zebra@quartz.example');
    await member.cmd({ type: 'ws', ops: [{ op: 'patch', col: 'chats', id: v.conversation, patch: { starred: true } }] });
    await chat(member, { op: 'takeOver', id: v.conversation, on: true });
    await chat(member, { op: 'reply', id: v.conversation, text: 'Thanks, noted: MAGENTA-OWL-31', message: 'm-del' });
    const keep = new Visitor(siteKey);
    await keep.say('hello from someone else');
    const stream = await v.stream();
    expect(await stream.until((list) => list.length > 0)).toBe(true);

    const gone = await chat(member, { op: 'delete', id: v.conversation });
    expect(gone.ok, gone.error).toBe(true);
    expect(await count('select count(*)::int as n from chat_conversation where id = $1', [v.conversation])).toBe(0);
    expect(await count('select count(*)::int as n from chat_message where conversation_id = $1', [v.conversation])).toBe(0);
    expect(await convo(owner, v.conversation!)).toBeUndefined();
    // Not in the screens' saved state, the record tabs catch up from, the commands kept for retry and undo, the effects, or the audit log.
    for (const table of ['state_doc', 'state_change', 'command', 'effect', 'approval', 'audit_log', 'chat_message', 'chat_conversation']) {
      for (const words of ['ZEBRA-QUARTZ-77', 'MAGENTA-OWL-31']) expect(await count(`select count(*)::int as n from ${table} t where workspace_id = $1 and t::text like $2`, [owner.workspaceId, `%${words}%`]), `${table} still holds ${words}`).toBe(0);
    }
    // The record that it happened stays: who deleted it, and the effects that sent the replies.
    expect(await count(`select count(*)::int as n from audit_log where workspace_id = $1 and action = 'chat.deleted' and actor = $2 and detail->>'conversation' = $3`, [owner.workspaceId, member.userId, v.conversation])).toBe(1);
    expect((await effects(owner)).filter((e) => e.target === `chat:${v.conversation}`).length).toBeGreaterThan(0);
    // The visitor's token opens nothing now, and their open stream is not sent anything more.
    expect((await v.say('am I still here?')).body).toMatchObject({ ok: false, reset: true });
    expect((await v.stream()).res.status).toBe(403);
    await stream.close();
    // Other conversations are untouched, and it can't be undone back into existence.
    expect((await convo(owner, keep.conversation!))!.messages[0]!.text).toBe('hello from someone else');
    expect((await owner.cmd({ type: 'undo', command: gone.id })).ok).toBe(false);
    expect(await convo(owner, v.conversation!)).toBeUndefined();
  });

  it('conversations past the retention period are deleted by the nightly job, and newer ones kept', async () => {
    const { owner, siteKey } = await chatOn('Retention');
    const old = new Visitor(siteKey);
    const recent6 = new Visitor(siteKey);
    const fresh = new Visitor(siteKey);
    await old.say('thirteen months ago: PURPLE-HERON');
    await recent6.say('seven months ago');
    await fresh.say('today');
    await sysPool.query(`update chat_conversation set last_message_at = now() - interval '13 months' where id = $1`, [old.conversation]);
    await sysPool.query(`update chat_conversation set last_message_at = now() - interval '7 months' where id = $1`, [recent6.conversation]);

    // Twelve months unless the workspace chose otherwise.
    await jobs().enqueue('chat.retention', {});
    await jobs().drain('chat.retention');
    expect(Object.keys((await owner.state()).ws.chats).sort()).toEqual([recent6.conversation!, fresh.conversation!].sort());
    expect(await count('select count(*)::int as n from chat_conversation where workspace_id = $1', [owner.workspaceId])).toBe(2);
    expect(await count(`select count(*)::int as n from chat_message where workspace_id = $1 and body like '%PURPLE-HERON%'`, [owner.workspaceId])).toBe(0);
    expect(await count(`select count(*)::int as n from state_change t where workspace_id = $1 and t::text like '%PURPLE-HERON%'`, [owner.workspaceId])).toBe(0);
    expect(await count(`select count(*)::int as n from audit_log where workspace_id = $1 and action = 'chat.retention'`, [owner.workspaceId])).toBe(1);

    // The owner shortens it to six months: the seven-month-old one goes at the next run.
    expect((await settings(owner, { retentionMonths: 6 })).ok).toBe(true);
    expect(await removeExpiredChats(owner.workspaceId)).toBe(1);
    expect(Object.keys((await owner.state()).ws.chats)).toEqual([fresh.conversation]);
  });
});

describe('nothing secret is written to the log', () => {
  it('no token, signing secret or visitor’s words appear in what the server logs', async () => {
    const lines: string[] = [];
    for (const fn of ['log', 'error', 'warn', 'info'] as const) vi.spyOn(console, fn).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
    const from = recent.length;
    const { owner, siteKey } = await chatOn('Logs');
    const v = new Visitor(siteKey);
    await v.say('My card is CRIMSON-FALCON-90 and I am falcon@crimson.example');
    await v.say('a\u0000b');
    await v.post({ visitor: v.id, id: hex(), text: 'forged', conversation: v.conversation, token: `${v.token}x` });
    await v.post('{"visitor": broken json CRIMSON-FALCON-90');
    await chat(owner, { op: 'takeOver', id: v.conversation, on: true });
    await chat(owner, { op: 'reply', id: v.conversation, text: 'Reply words AMBER-LYNX-12', message: 'm-log' });
    const stream = await v.stream();
    await stream.until((list) => list.length > 0);
    await stream.close();
    await chat(owner, { op: 'delete', id: v.conversation });
    await jobs().drain();

    const written = [...recent.slice(from), ...lines].join('\n');
    const signature = v.token!.split('.')[3]!;
    for (const secret of [v.token!, signature, await chatSecret(), 'CRIMSON-FALCON-90', 'falcon@crimson.example', 'AMBER-LYNX-12', v.id]) expect(written, `the log holds ${secret.slice(0, 12)}…`).not.toContain(secret);
    // The effect and audit records hold no token either.
    expect(await count(`select count(*)::int as n from effect t where workspace_id = $1 and t::text like $2`, [owner.workspaceId, `%${signature}%`])).toBe(0);
    expect(await count(`select count(*)::int as n from audit_log t where workspace_id = $1 and t::text like $2`, [owner.workspaceId, `%${signature}%`])).toBe(0);
    // The token never rides in an address: the stream takes it from a header only.
    const inAddress = await (await boot()).request(`/api/public/chat/${siteKey}/stream?conversation=${v.conversation}&token=${v.token}`, { headers: { 'x-real-ip': freshAddress() } });
    expect(inAddress.status).toBe(403);
  });
});

/* ───────────── The chat's own address ───────────── */

const CHAT_URL = 'https://chat.timmy.test';
const CHAT_HOST = 'chat.timmy.test';
const APP_HOST = 'localhost:8787';

/** A request for one host name, as a browser or a script sends it: no cookies unless the test gives some. */
const onHost = async (host: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
  (await boot()).request(path, { method: init.method ?? 'GET', headers: { host, 'x-real-ip': freshAddress(), ...init.headers }, ...(init.body !== undefined ? { body: init.body } : {}) });

describe('the chat’s own address (CHAT_PUBLIC_URL)', () => {
  it('every chat route answers on the chat’s address, and none of them on the app’s', async () => {
    const { owner, siteKey } = await chatOn('OwnHost');
    config.chat.publicUrl = CHAT_URL;
    // On the chat's address: the loader, the frame and its files, the settings, a first message, and the stream.
    for (const path of ['/chat.js', '/chat/frame.js', '/chat/frame.css', '/chat/work.js']) expect([path, (await onHost(CHAT_HOST, path)).status]).toEqual([path, 200]);
    const frame = await onHost(CHAT_HOST, `/chat/frame?site=${siteKey}`);
    expect(frame.status).toBe(200);
    expect(frame.headers.get('content-security-policy')).toContain('frame-ancestors https://acme.example https://www.acme.example');
    const settingsThere = await onHost(CHAT_HOST, `/api/public/chat/${siteKey}/config`);
    expect(settingsThere.status).toBe(200);
    expect(settingsThere.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    const { challenge } = (await settingsThere.json()) as { challenge: { id: string; bits: number } };
    const v = new Visitor(siteKey);
    const json = { origin: CHAT_URL, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
    const first = await onHost(CHAT_HOST, `/api/public/chat/${siteKey}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ visitor: v.id, id: hex(), text: 'What does it cost?', challenge: challenge.id, answer: solve(challenge.id, challenge.bits) }) });
    expect(first.status).toBe(200);
    const said = (await first.json()) as Required<Answer>;
    expect(said.messages.map((m) => m.text)).toEqual(['What does it cost?', FAQ[0]!.a, EMAIL_QUESTION]);
    const next = await onHost(CHAT_HOST, `/api/public/chat/${siteKey}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ visitor: v.id, id: hex(), text: 'ada@lovelace.example', conversation: said.conversation, token: said.token }) });
    expect(next.status).toBe(200);
    const stream = await onHost(CHAT_HOST, `/api/public/chat/${siteKey}/stream?conversation=${said.conversation}&after=0`, { headers: { authorization: `Bearer ${said.token}` } });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toMatch(/event-stream/);
    await stream.body!.cancel();
    // Writes to the chat's address come from the chat's own frame: a page on the app's address (or any other) is refused.
    for (const origin of [ORIGIN, 'https://evil.example']) {
      const forged = await onHost(CHAT_HOST, `/api/public/chat/${siteKey}/messages`, { method: 'POST', headers: { ...json, origin, 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ visitor: v.id, id: hex(), text: 'x', conversation: said.conversation, token: said.token }) });
      expect([origin, forged.status]).toEqual([origin, 403]);
    }

    // On the app's own address (with its Host header, or none at all) none of these paths exist.
    const paths = ['/chat.js', '/chat/frame.js', '/chat/frame.css', '/chat/work.js', `/chat/frame?site=${siteKey}`, `/api/public/chat/${siteKey}/config`, `/api/public/chat/${siteKey}/stream?conversation=${said.conversation}&after=0`];
    for (const host of [APP_HOST, '']) {
      for (const path of paths) {
        const res = host ? await onHost(host, path, { headers: { authorization: `Bearer ${said.token}` } }) : await pub(path, { authorization: `Bearer ${said.token}` });
        expect([host, path, res.status]).toEqual([host, path, 404]);
        expect(res.headers.get('content-security-policy') ?? '').not.toContain('frame-ancestors https://acme.example');
      }
      const post = await (await boot()).request(`/api/public/chat/${siteKey}/messages`, {
        method: 'POST',
        headers: { ...(host ? { host } : {}), origin: ORIGIN, 'content-type': 'application/json', 'x-real-ip': freshAddress() },
        body: JSON.stringify({ visitor: v.id, id: hex(), text: 'through the app', conversation: said.conversation, token: said.token }),
      });
      expect([host, post.status]).toEqual([host, 404]);
    }
    expect(await count(`select count(*)::int as n from chat_message where conversation_id = $1 and sender = 'visitor'`, [said.conversation])).toBe(2);
    // The app itself carries on at its own address, including a teammate reading the transcript.
    expect((await owner.get('/api/v1/state')).status).toBe(200);
    expect((await owner.get(`/api/v1/chat/conversations/${said.conversation}/messages`)).status).toBe(200);
  });

  it('on the chat’s address every app route answers 404, and no cookie is ever set or read there', async () => {
    const { owner, siteKey } = await chatOn('OwnHostApp');
    config.chat.publicUrl = CHAT_URL;
    const cookie = [...owner.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const stranger = `stranger.${hex(8)}@example.test`;
    const tries: [string, string, unknown?][] = [
      ['GET', '/'],
      ['GET', '/index.html'],
      ['GET', '/assets/index.js'],
      ['GET', '/chat'],
      ['GET', '/api/health'],
      ['GET', '/api/v1/me'],
      ['GET', '/api/v1/state'],
      ['GET', '/api/v1/stream'],
      ['GET', '/api/v1/settings'],
      ['GET', '/api/v1/audit'],
      ['GET', '/api/v1/chat/loader'],
      ['GET', '/api/v1/chat/conversations'],
      ['GET', '/api/auth/get-session'],
      ['POST', '/api/auth/sign-up/email', { name: 'Stranger', email: stranger, password: 'correct-horse-battery-9' }],
      ['POST', '/api/auth/sign-in/email', { email: owner.email, password: 'correct-horse-battery-9' }],
      ['POST', '/api/auth/sign-in/magic-link', { email: owner.email }],
      ['POST', '/api/auth/sign-out', {}],
      ['POST', '/api/v1/commands', { id: 'cmd-there', action: { type: 'ws', ops: [{ op: 'patch', col: 'chat', id: 'site', patch: { greeting: 'Planted' } }] } }],
      ['POST', '/api/hooks/composio', {}],
      ['POST', '/api/test/release-holds', {}],
      ['GET', '/api/public/chat'],
    ];
    for (const [method, path, body] of tries) {
      const res = await onHost(CHAT_HOST, path, { method, headers: { cookie, origin: CHAT_URL, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      expect([method, path, res.status, res.headers.get('set-cookie')]).toEqual([method, path, 404, null]);
    }
    // None of it happened: no account, and the greeting is as it was.
    expect((await authPool.query('select count(*)::int as n from "user" where email = $1', [stranger])).rows[0].n).toBe(0);
    expect((await widget(owner)).greeting).not.toBe('Planted');
    // The chat's own routes there set no cookie either, even for a browser that sends the app's.
    for (const path of ['/chat.js', `/chat/frame?site=${siteKey}`, `/api/public/chat/${siteKey}/config`]) expect([path, (await onHost(CHAT_HOST, path, { headers: { cookie } })).headers.get('set-cookie')]).toEqual([path, null]);
    // The same session still works on the app's own address.
    expect((await owner.get('/api/v1/me')).status).toBe(200);
  });

  it('the snippet loads from the chat’s address; the address is matched exactly; without the setting nothing changes', async () => {
    const { owner, siteKey } = await chatOn('Snippet');
    // Without the setting the chat is served as before, whatever the host, and the screen uses the app's own address.
    expect(await owner.json('GET', '/api/v1/chat/loader')).toEqual({ loader: null });
    for (const host of [CHAT_HOST, 'anything.test', APP_HOST]) {
      expect([host, (await onHost(host, '/chat.js')).status]).toEqual([host, 200]);
      expect([host, (await onHost(host, `/api/public/chat/${siteKey}/config`)).status]).toEqual([host, 200]);
    }
    expect((await onHost(CHAT_HOST, '/api/health')).status).toBe(200);

    config.chat.publicUrl = CHAT_URL;
    expect(await owner.json('GET', '/api/v1/chat/loader')).toEqual({ loader: 'https://chat.timmy.test/chat.js' });
    // The loader opens the frame on the address it was itself loaded from, so the snippet keeps the chat on that address.
    const loader = await (await onHost(CHAT_HOST, '/chat.js')).text();
    expect(loader).toContain('new URL(script.src, location.href).origin');
    expect(loader).toContain("origin + '/chat/frame?site='");
    // Written another way (capitals, the scheme's own port, a final dot) it is the same address; another port or name is not.
    for (const same of ['CHAT.Timmy.test', 'chat.timmy.test:443', 'chat.timmy.test.']) {
      expect([same, (await onHost(same, '/chat.js')).status, (await onHost(same, '/api/health')).status]).toEqual([same, 200, 404]);
    }
    for (const other of ['chat.timmy.test:8443', 'evil-chat.timmy.test', 'chat.timmy.test.evil.example']) {
      expect([other, (await onHost(other, '/chat.js')).status, (await onHost(other, '/api/health')).status]).toEqual([other, 404, 200]);
    }
    // Only people who may read the workspace are told.
    const client = await addMember(owner.workspaceId, 'client');
    expect((await client.get('/api/v1/chat/loader')).status).toBe(403);
  });

  it('the server won’t start with an address that isn’t a whole one on another host, or plain http in production', () => {
    for (const bad of ['chat.timmy.test', 'https://chat.timmy.test/chat', 'https://chat.timmy.test/?x=1', 'http://localhost:8787', 'javascript:alert(1)', 'https://user@chat.timmy.test']) {
      config.chat.publicUrl = bad;
      expect(() => assertSafeConfig(), bad).toThrow(/CHAT_PUBLIC_URL/);
    }
    config.chat.publicUrl = CHAT_URL;
    expect(() => assertSafeConfig()).not.toThrow();
    config.chat.publicUrl = '';
    expect(() => assertSafeConfig()).not.toThrow();
  });
});

/* ───────────── The bot check ───────────── */

describe('the bot check before a conversation starts', () => {
  const REFUSED = { ok: false, notice: 'The chat couldn’t start just now. Send your message again.', recheck: true };
  /** A number that does not solve a challenge. */
  const unsolved = (id: string, bits: number) => {
    let n = 0;
    while (zeroBits(id, String(n)) >= bits) n++;
    return String(n);
  };

  it('a first message without the work, with a wrong answer, or with a forged, expired or other chat’s challenge is refused and starts nothing', async () => {
    const { owner, siteKey } = await chatOn('Bots');
    const other = await chatOn('OtherBots', {}, 'other-bots.example');
    // One browser tries many times here; the limit per visitor is not what this test is about.
    config.chat.visitorMessagesPerMinute = 100;
    const v = new Visitor(siteKey);
    const { challenge, answer } = (await v.proof()) as { challenge: string; answer: string };
    expect(zeroBits(challenge, answer)).toBeGreaterThanOrEqual(config.chat.challengeBits);
    const [version, nonce, exp, bits, signature] = challenge.split('.') as [string, string, string, string, string];
    const theirs = await new Visitor(other.siteKey).proof();
    const old = await newChallenge(owner.workspaceId, Date.now() - 2 * 3_600_000);
    const longer = [version, nonce, String(Number(exp) + 86_400), bits, signature].join('.');
    const easier = [version, nonce, exp, '0', signature].join('.');
    const madeUp = [version, nonce, exp, bits, 'A'.repeat(43)].join('.');
    const attempts: [string, Record<string, unknown>][] = [
      ['no work at all', {}],
      ['a challenge with no answer', { challenge }],
      ['an answer with no challenge', { answer }],
      ['a wrong answer', { challenge, answer: unsolved(challenge, Number(bits)) }],
      ['another business’s challenge, solved', theirs],
      ['a challenge made easier', { challenge: easier, answer: '0' }],
      ['a challenge made to last longer', { challenge: longer, answer: solve(longer, Number(bits)) }],
      ['a made-up signature', { challenge: madeUp, answer: solve(madeUp, Number(bits)) }],
      ['a challenge that ran out', { challenge: old.id, answer: solve(old.id, old.bits) }],
      ['not a challenge', { challenge: 'null', answer: '1' }],
      ['an answer that isn’t a number', { challenge, answer: `${answer}.0` }],
      ['answers of the wrong kind', { challenge: [challenge], answer: Number(answer) }],
    ];
    for (const [what, extra] of attempts) {
      const out = await v.post({ visitor: v.id, id: hex(), text: 'hello', ...extra });
      expect([what, out.status, out.body]).toEqual([what, 403, REFUSED]);
    }
    expect(await count('select count(*)::int as n from chat_conversation where workspace_id = $1', [owner.workspaceId])).toBe(0);
    expect(await count('select count(*)::int as n from chat_message where workspace_id = $1', [owner.workspaceId])).toBe(0);
    expect(await count('select count(*)::int as n from chat_challenge where workspace_id = $1', [owner.workspaceId])).toBe(0);
    // None of those used the real challenge up: solved, it starts the conversation.
    const ok = await v.post({ visitor: v.id, id: hex(), text: 'hello', challenge, answer });
    expect(ok.status).toBe(200);
    expect(await count('select count(*)::int as n from chat_conversation where workspace_id = $1', [owner.workspaceId])).toBe(1);
  });

  it('a solved challenge starts exactly one conversation, however often and by whomever it is sent', async () => {
    const { owner, siteKey } = await chatOn('OneEach');
    const conversations = () => count('select count(*)::int as n from chat_conversation where workspace_id = $1', [owner.workspaceId]);
    const v = new Visitor(siteKey);
    const proof = await v.proof();
    const first = { visitor: v.id, id: hex(), text: 'What does it cost?', after: 0, ...proof };
    const a = await v.post(first);
    expect(a.status).toBe(200);
    // The same message again (its answer was lost on the way) is the same conversation, not a refusal and not a second one.
    const again = await v.post(first);
    expect([again.status, again.body.conversation]).toEqual([200, a.body.conversation]);
    // The same work sent with another message, by the same browser or by others, is refused.
    const reuse = await v.post({ ...first, id: hex(), text: 'and another thing' });
    expect([reuse.status, reuse.body]).toEqual([403, REFUSED]);
    const replays = await Promise.all(
      Array.from({ length: 6 }, () => {
        const x = new Visitor(siteKey);
        return x.post({ visitor: x.id, id: hex(), text: 'me too', ...proof });
      }),
    );
    expect(replays.map((r) => r.status)).toEqual(replays.map(() => 403));
    expect(await conversations()).toBe(1);
    // Many browsers racing with one fresh solved challenge: one of them starts a conversation, the rest are turned away.
    const shared = await new Visitor(siteKey).proof();
    const race = await Promise.all(
      Array.from({ length: 8 }, () => {
        const x = new Visitor(siteKey);
        return x.post({ visitor: x.id, id: hex(), text: 'racing', ...shared });
      }),
    );
    expect(race.filter((r) => r.status === 200)).toHaveLength(1);
    expect(race.filter((r) => r.status === 403 && r.body.recheck === true)).toHaveLength(7);
    expect(await conversations()).toBe(2);
    expect(await count('select count(*)::int as n from chat_challenge where workspace_id = $1', [owner.workspaceId])).toBe(2);
    // Messages inside a conversation need no new work.
    v.conversation = a.body.conversation;
    v.token = a.body.token;
    for (const text of ['ada@lovelace.example', 'Analytical Engines']) expect((await v.say(text)).status).toBe(200);
    expect(await count('select count(*)::int as n from chat_challenge where workspace_id = $1', [owner.workspaceId])).toBe(2);
    // The used challenges are the workspace's own, under row-level security like the rest of the chat.
    const other = await newWorkspace('OtherSpent');
    expect((await withWorkspace({ workspaceId: other.workspaceId }, (tx) => tx.query('select count(*)::int as n from chat_challenge'))).rows[0].n).toBe(0);
  });

  it('a message turned away leaves its challenge unused; the difficulty is a setting, and a raised one asks for new work', async () => {
    const { owner, siteKey } = await chatOn('Difficulty');
    // The day's conversations are used up: the message is turned away, and its work is still good tomorrow.
    await sysPool.query(`insert into chat_counter (workspace_id, day, conversations, messages) values ($1, current_date, $2, 0) on conflict (workspace_id, day) do update set conversations = excluded.conversations`, [owner.workspaceId, config.chat.conversationsPerDay]);
    const v = new Visitor(siteKey);
    const proof = await v.proof();
    const busy = await v.post({ visitor: v.id, id: hex(), text: 'hello', ...proof });
    expect([busy.status, busy.body.notice]).toEqual([429, 'The chat is very busy today. Please try again tomorrow, or reach us another way.']);
    expect(await count('select count(*)::int as n from chat_challenge where workspace_id = $1', [owner.workspaceId])).toBe(0);
    await sysPool.query(`update chat_counter set conversations = 0 where workspace_id = $1 and day = current_date`, [owner.workspaceId]);
    expect((await v.post({ visitor: v.id, id: hex(), text: 'hello', ...proof })).status).toBe(200);

    // The settings hand out the difficulty in force; an answer short of it is refused.
    config.chat.challengeBits = 12;
    const hard = new Visitor(siteKey);
    const res = await pub(`/api/public/chat/${siteKey}/config`);
    const { challenge } = (await res.json()) as { challenge: { id: string; bits: number } };
    expect(challenge.bits).toBe(12);
    let near = 0;
    while (!(zeroBits(challenge.id, String(near)) >= 8 && zeroBits(challenge.id, String(near)) < 12)) near++;
    expect((await hard.post({ visitor: hard.id, id: hex(), text: 'hello', challenge: challenge.id, answer: String(near) })).body).toEqual(REFUSED);
    expect((await hard.post({ visitor: hard.id, id: hex(), text: 'hello', challenge: challenge.id, answer: solve(challenge.id, 12) })).status).toBe(200);
    // Work done for an easier challenge, handed out before the difficulty went up, is no longer enough.
    config.chat.challengeBits = 4;
    const early = await new Visitor(siteKey).proof();
    config.chat.challengeBits = 12;
    const late = new Visitor(siteKey);
    expect((await late.post({ visitor: late.id, id: hex(), text: 'hello', ...early })).body).toEqual(REFUSED);
  });

  it('the frame does the work in a worker before the first message, and only then', () => {
    const frame = embedFile('frame.js');
    expect(frame).toContain("new Worker('/chat/work.js')");
    expect(frame).toMatch(/payload\.challenge = p\.challenge;\s+payload\.answer = p\.answer;/);
    // A message in a conversation that exists carries its token and no work.
    expect(frame).toMatch(/var starting = !\(conversation && token\);/);
    const page = embedFile('work.js');
    expect(page).not.toMatch(/fetch\(|XMLHttpRequest|importScripts\(/);
  });
});

/* ───────────── Limits every server shares ───────────── */

describe('limits every server shares', () => {
  /** A second server: its own connections to the same database, its own memory. */
  const server = () => new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

  it('two servers over one database count an address together, in windows, and keep no address', async () => {
    const pools = [server(), server()];
    try {
      const [one, two] = pools.map((p) => new LimitStore(p)) as [LimitStore, LimitStore];
      const address = freshAddress();
      const check = [{ key: `test:address:${address}`, limit: 3, windowMs: 60_000 }];
      const got: boolean[] = [];
      for (const store of [one, two, one, two, one]) got.push(await store.allow(check));
      expect(got).toEqual([true, true, true, false, false]);
      // Asked at the same moment from both, the limit holds between them.
      const crowd = [{ key: `test:crowd:${freshAddress()}`, limit: 7, windowMs: 60_000 }];
      const at = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? one : two).allow(crowd)));
      expect(at.filter(Boolean)).toHaveLength(7);
      // When the window ends (moved into the past here), the count starts again on either server.
      await sysPool.query(`update chat_limit set until = now() - interval '1 second' where until between now() and now() + interval '61 seconds'`);
      expect(await two.allow(check, Date.now() + 61_000)).toBe(true);
      expect(await one.allow(check, Date.now() + 61_000)).toBe(true);
      // What is stored is a fingerprint keyed with the server's secret, never the address.
      expect(await count('select count(*)::int as n from chat_limit where key like $1', [`%${address}%`])).toBe(0);
      expect(await count(`select count(*)::int as n from chat_limit where key !~ '^[A-Za-z0-9_-]{32}$'`)).toBe(0);
      // And the app's own database role can't read the counts at all.
      await expect(withWorkspace({ workspaceId: 'any' }, (tx) => tx.query('select count(*) from chat_limit'))).rejects.toThrow(/permission denied/);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });

  it('the public routes count against the shared limits: what another server counted holds here, and the other way round', async () => {
    const { owner, siteKey } = await chatOn('Shared');
    config.chat.addressMessagesPerMinute = 3;
    const v = new Visitor(siteKey);
    const pool = server();
    try {
      const elsewhere = new LimitStore(pool);
      const key = [{ key: `message:address:${v.address}`, limit: 3, windowMs: 60_000 }];
      // Another server already took two of this address's three messages this minute.
      expect([await elsewhere.allow(key), await elsewhere.allow(key)]).toEqual([true, true]);
      expect((await v.say('one')).status).toBe(200);
      expect((await v.say('two')).status).toBe(429);
      // A header anyone can send doesn't make it another address: only Railway's X-Real-IP counts.
      const spoofed = await v.post({ visitor: v.id, id: hex(), text: 'three', conversation: v.conversation, token: v.token }, { 'x-forwarded-for': freshAddress() });
      expect(spoofed.status).toBe(429);
      // The refusal here holds on the other server too.
      expect(await elsewhere.allow(key)).toBe(false);
      // The caps per day are still counted in the workspace's own table.
      expect((await rows<{ messages: number }>('select messages from chat_counter where workspace_id = $1 and day = current_date', [owner.workspaceId]))[0]!.messages).toBe(1);
    } finally {
      await pool.end();
    }
  });
});

/* ───────────── Speed to lead ───────────── */

describe('chat leads on the Speed to lead clock', () => {
  it('a visitor who leaves an email waits on the clock until a teammate answers in the chat; Timmy’s own answers don’t stop it', async () => {
    const { owner, siteKey } = await chatOn('Clock');
    const v = new Visitor(siteKey);
    await v.say('Hi, I am ada@lovelace.example');
    await v.say('Analytical Engines');
    let s = await owner.state();
    const lead = Object.values(s.out.leads)[0]!;
    expect(lead).toMatchObject({ source: 'chat', email: 'ada@lovelace.example', status: 'new' });
    expect(lead.receivedAt).toBeInstanceOf(Date);
    expect(lead.firstReplyAt).toBeUndefined();
    // Counted where form leads are counted: Speed to lead, the badges, and Today's leads waiting for a reply.
    expect(onTheClock(lead)).toBe(true);
    expect(waitingForFirstReply(s).map((l) => l.id)).toEqual([lead.id]);
    expect(leadAlerts(s)).toEqual([expect.objectContaining({ kind: 'waiting', lead: expect.objectContaining({ id: lead.id }) })]);
    // Taking the chat over is not an answer yet.
    await chat(owner, { op: 'takeOver', id: v.conversation, on: true });
    expect(waitingForFirstReply(await owner.state())).toHaveLength(1);
    // A teammate's reply in the chat is the first reply: the clock stops.
    expect((await chat(owner, { op: 'reply', id: v.conversation, text: 'Hi Ada, happy to help.', message: 'm-clock-1' })).ok).toBe(true);
    s = await owner.state();
    const answered = s.out.leads[lead.id]!;
    expect(answered.firstReplyAt).toBeInstanceOf(Date);
    expect(answered.firstReplyAt!.getTime()).toBeGreaterThanOrEqual(lead.receivedAt!.getTime());
    expect(answered.status).toBe('contacted');
    expect(waitingForFirstReply(s)).toEqual([]);
    expect(leadAlerts(s)).toEqual([]);
    // A later reply doesn't move the time of the first.
    await chat(owner, { op: 'reply', id: v.conversation, text: 'Anything else?', message: 'm-clock-2' });
    expect((await owner.state()).out.leads[lead.id]!.firstReplyAt).toEqual(answered.firstReplyAt);
  });
});

/* ───────────── A visitor asking for a person ───────────── */

describe('a visitor asking for a person', () => {
  it('raises the card on Today and the notice in the app for every member, until a teammate takes over or answers', async () => {
    const { owner, siteKey } = await chatOn('Needs');
    const member = await addMember(owner.workspaceId, 'member', 'Mel Member');
    const ids = async (c: Client) => wantsPerson(await c.state()).map((x) => x.id);
    const v = new Visitor(siteKey);
    await v.say('What does it cost?');
    expect(await ids(owner)).toEqual([]);
    await v.say('Can I talk to a human?');
    expect(await ids(owner)).toEqual([v.conversation]);
    expect(await ids(member)).toEqual([v.conversation]);
    expect(await ids(await newWorkspace('NeedsElsewhere'))).toEqual([]);
    // A teammate takes over: gone, for everyone.
    expect((await chat(member, { op: 'takeOver', id: v.conversation, on: true })).ok).toBe(true);
    expect(await ids(owner)).toEqual([]);
    expect(await ids(member)).toEqual([]);
    // Handed back, the visitor asks again, and a second visitor asks too: both are raised, newest first.
    await chat(member, { op: 'takeOver', id: v.conversation, on: false });
    await v.say('Please, a real person');
    const w = new Visitor(siteKey);
    await w.say('I need to speak to someone');
    expect(await ids(owner)).toEqual([w.conversation, v.conversation]);
    // Taking over and answering clears it, and the visitor writing again while a person is there raises nothing.
    await chat(owner, { op: 'takeOver', id: w.conversation, on: true });
    expect((await chat(owner, { op: 'reply', id: w.conversation, text: 'I’m here. How can I help?', message: 'm-needs' })).ok).toBe(true);
    await w.say('Great, can I talk to a person about pricing?');
    expect(await ids(owner)).toEqual([v.conversation]);
    expect((await rows<{ urgent: boolean }>('select urgent from chat_conversation where id = $1', [w.conversation]))[0]!.urgent).toBe(false);
    // The activity log keeps its line for each time someone asked.
    expect((await owner.state()).activity.filter((a) => /asked for a person/.test(a.text))).toHaveLength(3);
  });
});

/* ───────────── Older conversations ───────────── */

describe('conversations older than the Chats screen holds', () => {
  type Page = { conversations: { id: string; at: Date; messages: number; last?: { from: string; text: string }; urgent: boolean; live: boolean }[]; next: string | null };

  it('are listed a page at a time, newest first, from the stored copy, inside the workspace', async () => {
    const { owner, siteKey } = await chatOn('Older');
    Object.assign(config.chat, { shownConversations: 3 });
    const made: string[] = [];
    for (let i = 0; i < 8; i++) {
      const v = new Visitor(siteKey);
      await v.say(`visitor number ${i}`);
      made.push(v.conversation!);
    }
    const listed = Object.keys((await owner.state()).ws.chats);
    expect(listed).toHaveLength(3);
    const older = made.filter((id) => !listed.includes(id)).reverse();
    expect(older).toHaveLength(5);

    const all = await owner.json<Page>('GET', '/api/v1/chat/conversations');
    expect(all.conversations.map((c) => c.id)).toEqual(older);
    expect(all.next).toBeNull();
    const top = all.conversations[0]!;
    expect(top.at).toBeInstanceOf(Date);
    expect(top.messages).toBe(await count('select count(*)::int as n from chat_message where conversation_id = $1', [top.id]));
    expect(top).toMatchObject({ urgent: false, live: false, last: { from: 'timmy', text: expect.any(String) } });
    // Two at a time: the pages join up with nothing missed or repeated.
    const seen: string[] = [];
    const sizes: number[] = [];
    let next: string | null = null;
    do {
      const page: Page = await owner.json<Page>('GET', `/api/v1/chat/conversations?limit=2${next ? `&before=${next}` : ''}`);
      seen.push(...page.conversations.map((c) => c.id));
      sizes.push(page.conversations.length);
      next = page.next;
    } while (next);
    expect(seen).toEqual(older);
    expect(sizes).toEqual([2, 2, 1]);
    const cursor = (await owner.json<Page>('GET', '/api/v1/chat/conversations?limit=2')).next!;
    // An older one's whole transcript can be read.
    expect((await owner.json<{ messages: unknown[] }>('GET', `/api/v1/chat/conversations/${older[4]}/messages`)).messages.length).toBeGreaterThan(0);

    // Another workspace sees only its own, whatever page it asks for, and can't read one of these by id.
    const other = await chatOn('OtherOlder', {}, 'other-older.example');
    expect((await other.owner.json<Page>('GET', '/api/v1/chat/conversations')).conversations).toEqual([]);
    expect((await other.owner.json<Page>('GET', `/api/v1/chat/conversations?before=${cursor}`)).conversations).toEqual([]);
    expect((await other.owner.get(`/api/v1/chat/conversations/${older[0]}/messages`)).status).toBe(404);
    // A page that isn't one is refused; a role that may not read the workspace is refused.
    for (const bad of ['x', Buffer.from(`2026-01-01 00:00:00+00~x'; drop table chat_message; --`).toString('base64url'), Buffer.from('yesterday~cv_aaaaaaaaaaaa').toString('base64url')]) {
      expect([bad, (await owner.get(`/api/v1/chat/conversations?before=${bad}`)).status]).toEqual([bad, 400]);
    }
    expect((await (await addMember(owner.workspaceId, 'client')).get('/api/v1/chat/conversations')).status).toBe(403);
    expect((await (await addMember(owner.workspaceId, 'member')).get('/api/v1/chat/conversations')).status).toBe(200);

    // Deleting an older one removes it from the stored copy and from the list.
    expect((await chat(owner, { op: 'delete', id: older[0] })).ok).toBe(true);
    expect((await owner.json<Page>('GET', '/api/v1/chat/conversations')).conversations.map((c) => c.id)).toEqual(older.slice(1));
    expect(await count('select count(*)::int as n from chat_message where conversation_id = $1', [older[0]])).toBe(0);
  });
});

/* ───────────── The shared pool of streams ───────────── */

describe('the streams one business can hold open', () => {
  it('one business’s visitors can only hold so many streams on a server; another business is not affected', async () => {
    const a = await chatOn('PoolA');
    const b = await chatOn('PoolB', {}, 'pool-b.example');
    config.chat.streamsPerWorkspace = 2;
    const visitors: Visitor[] = [];
    for (let i = 0; i < 3; i++) {
      const v = new Visitor(a.siteKey);
      await v.say('hello');
      visitors.push(v);
    }
    const open = [await visitors[0]!.stream(), await visitors[1]!.stream()];
    expect(open.map((s) => s.res.status)).toEqual([200, 200]);
    const third = await visitors[2]!.stream();
    expect(third.res.status).toBe(429);
    expect((await third.res.json()).notice).toMatch(/Wait a moment/);
    // Another business's visitor still gets a place.
    const vb = new Visitor(b.siteKey);
    await vb.say('hello');
    const theirs = await vb.stream();
    expect(theirs.res.status).toBe(200);
    // A place given back is a place free.
    await open[0]!.close();
    await new Promise((r) => setTimeout(r, 50));
    const again = await visitors[2]!.stream();
    expect(again.res.status).toBe(200);
    for (const s of [open[1]!, theirs, again]) await s.close();
  });
});

/* ───────────── Whoever switched it on ───────────── */

describe('the chat switches off when whoever switched it on loses the right to', () => {
  const memberId = async (workspaceId: string, userId: string) => (await authPool.query('select id from member where "organizationId" = $1 and "userId" = $2', [workspaceId, userId])).rows[0].id as string;
  /** A workspace whose admin set the chat up and switched it on. */
  async function onByAdmin(name: string) {
    const owner = await newWorkspace(name);
    expect((await settings(owner, { domain: `${name.toLowerCase()}.example`, name: 'Acme Support', faq: FAQ })).ok).toBe(true);
    const admin = await addMember(owner.workspaceId, 'admin', `${name} Admin`);
    expect((await settings(admin, { on: true })).ok).toBe(true);
    const siteKey = (await widget(owner)).siteKey!;
    expect((await pub(`/api/public/chat/${siteKey}/config`)).status).toBe(200);
    return { owner, admin, siteKey };
  }
  async function expectOff(owner: Client, siteKey: string, who: string) {
    expect((await widget(owner)).on).toBe(false);
    expect((await rows<{ is_on: boolean }>('select is_on from chat_widget where workspace_id = $1', [owner.workspaceId]))[0]!.is_on).toBe(false);
    expect((await pub(`/api/public/chat/${siteKey}/config`)).status).toBe(404);
    expect((await pub(`/chat/frame?site=${siteKey}`)).status).toBe(404);
    expect(await count(`select count(*)::int as n from policy where workspace_id = $1 and kind = 'chat.reply' and enabled`, [owner.workspaceId])).toBe(0);
    const notes = (await owner.state()).activity.filter((a) => a.text.startsWith('For owners and admins: the website chat is switched off.'));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toContain(`${who} switched it on and is no longer an owner or admin here`);
    expect(await count(`select count(*)::int as n from audit_log where workspace_id = $1 and action = 'chat.switched_off' and actor = 'system'`, [owner.workspaceId])).toBe(1);
  }

  it('lowered from admin to member: off, with a note to owners and admins; another owner or admin switches it on again under their name', async () => {
    const { owner, admin, siteKey } = await onByAdmin('Lowered');
    const v = new Visitor(siteKey);
    expect((await v.say('hello')).status).toBe(200);
    // Someone else's role changing changes nothing, and nor does an owner becoming an admin (still allowed).
    const bystander = await addMember(owner.workspaceId, 'admin', 'Bea Bystander');
    expect((await owner.post('/api/auth/organization/update-member-role', { memberId: await memberId(owner.workspaceId, bystander.userId), role: 'member', organizationId: owner.workspaceId })).status).toBe(200);
    expect((await owner.post('/api/auth/organization/update-member-role', { memberId: await memberId(owner.workspaceId, admin.userId), role: 'owner', organizationId: owner.workspaceId })).status).toBe(200);
    expect((await owner.post('/api/auth/organization/update-member-role', { memberId: await memberId(owner.workspaceId, admin.userId), role: 'admin', organizationId: owner.workspaceId })).status).toBe(200);
    expect((await widget(owner)).on).toBe(true);
    expect((await pub(`/api/public/chat/${siteKey}/config`)).status).toBe(200);

    expect((await owner.post('/api/auth/organization/update-member-role', { memberId: await memberId(owner.workspaceId, admin.userId), role: 'member', organizationId: owner.workspaceId })).status).toBe(200);
    await expectOff(owner, siteKey, 'Lowered Admin');
    expect((await v.say('are you there?')).body).toEqual({ ok: false, notice: 'This chat isn’t available right now.' });
    // The person lowered can't switch it back on; an owner can, and the rule then names them.
    expect((await settings(admin, { on: true })).error).toMatch(/Only an owner or admin/);
    expect((await settings(owner, { on: true })).ok).toBe(true);
    expect((await pub(`/api/public/chat/${siteKey}/config`)).status).toBe(200);
    expect(await rows(`select created_by from policy where workspace_id = $1 and kind = 'chat.reply' and enabled`, [owner.workspaceId])).toEqual([{ created_by: owner.userId }]);
    expect((await v.say('back again?')).status).toBe(200);
    // Now that the owner runs it, the old switcher's next change is nothing to the chat.
    expect((await owner.post('/api/auth/organization/update-member-role', { memberId: await memberId(owner.workspaceId, admin.userId), role: 'client', organizationId: owner.workspaceId })).status).toBe(200);
    expect((await widget(owner)).on).toBe(true);
  });

  it('removed from the workspace, or leaving it: off', async () => {
    const removed = await onByAdmin('Removed');
    expect((await removed.owner.post('/api/auth/organization/remove-member', { memberIdOrEmail: removed.admin.email, organizationId: removed.owner.workspaceId })).status).toBe(200);
    await expectOff(removed.owner, removed.siteKey, 'Removed Admin');

    const leaving = await onByAdmin('Leaving');
    expect((await leaving.admin.post('/api/auth/organization/leave', { organizationId: leaving.owner.workspaceId })).status).toBe(200);
    await expectOff(leaving.owner, leaving.siteKey, 'Leaving Admin');
    // Another admin switches it on again.
    const second = await addMember(leaving.owner.workspaceId, 'admin', 'Second Admin');
    expect((await settings(second, { on: true })).ok).toBe(true);
    expect((await pub(`/api/public/chat/${leaving.siteKey}/config`)).status).toBe(200);
  });

  it('even if the switch-off never ran, the chat answers nobody while whoever switched it on lacks the role', async () => {
    const { owner, admin, siteKey } = await onByAdmin('Failsafe');
    const v = new Visitor(siteKey);
    expect((await v.say('hello')).status).toBe(200);
    // The role changed behind the auth library's back, so no hook ran.
    await authPool.query('update member set role = $3 where "organizationId" = $1 and "userId" = $2', [owner.workspaceId, admin.userId, 'member']);
    expect((await rows<{ is_on: boolean }>('select is_on from chat_widget where workspace_id = $1', [owner.workspaceId]))[0]!.is_on).toBe(true);
    expect((await pub(`/api/public/chat/${siteKey}/config`)).status).toBe(404);
    expect((await pub(`/chat/frame?site=${siteKey}`)).status).toBe(404);
    expect((await v.say('anyone?')).status).toBe(404);
    expect((await v.stream()).res.status).toBe(404);
    // Given the role back, it answers again: it was never switched off.
    await authPool.query('update member set role = $3 where "organizationId" = $1 and "userId" = $2', [owner.workspaceId, admin.userId, 'admin']);
    expect((await pub(`/api/public/chat/${siteKey}/config`)).status).toBe(200);
  });
});
