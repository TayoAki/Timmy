// Live mode: the app as someone outside sees it. No source code, no test helpers beyond signing up: just requests
// an attacker could send. It runs against any server (BASE), so it is also the check to point at staging.
// Each block is one thing an outsider would try; each check is what must be true whatever they try.
// OUTSIDE_NO_ACCOUNT=1 stops before anything that needs an account: the form for a server where sign-up is closed.
const { request } = require('playwright');
const { BASE, ok, open, signUp, api, run, stamp } = require('./lib.cjs');

const DEPLOYED = BASE.startsWith('https://');
const ORIGIN = new URL(BASE).origin;
const url = (path) => new URL(path, BASE).toString();

run('live-outside', async (browser) => {
  // A caller with no session, and no cookies carried from one request to the next.
  const anon = await request.newContext({ ignoreHTTPSErrors: false });
  const call = async (ctx, method, path, { body, headers, raw } = {}) => {
    const r = await ctx.fetch(url(path), { method, failOnStatusCode: false, maxRedirects: 0, headers: { ...(method === 'GET' ? {} : { origin: ORIGIN }), ...(headers || {}) }, ...(raw !== undefined ? { data: raw } : body !== undefined ? { data: body } : {}) });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status(), headers: r.headers(), text, json };
  };

  // ── 1. Nothing behind the API answers without a session ──
  const reads = ['/api/v1/me', '/api/v1/state', '/api/v1/settings', '/api/v1/audit', '/api/v1/usage', '/api/v1/effects/anything', '/api/v1/stream', '/api/v1/connections/callback?c=anything'];
  for (const path of reads) ok((await call(anon, 'GET', path)).status === 401, `signed out, GET ${path.split('?')[0]} is refused`);
  const writes = [
    ['POST', '/api/v1/commands', { id: 'x', action: { type: 'ws', ops: [] } }],
    ['PATCH', '/api/v1/settings', { cap: 1 }],
    ['POST', '/api/v1/connections/gmail/connect', {}],
    ['POST', '/api/v1/connections/gmail/disconnect', {}],
    ['POST', '/api/v1/actions/anything/approve', {}],
    ['POST', '/api/v1/pages/anything/summarize', {}],
  ];
  for (const [method, path, body] of writes) ok((await call(anon, method, path, { body })).status === 401, `signed out, ${method} ${path} is refused`);
  const unknown = await call(anon, 'GET', '/api/v1/no-such-thing');
  ok(unknown.status === 404 && !/<html/i.test(unknown.text), 'an API address that does not exist answers “not found”, not the app’s page');

  // ── 2. What the server says about itself ──
  const health = await call(anon, 'GET', '/api/health');
  ok(health.status === 200 && health.json.ok === true, 'the health check answers');
  if (DEPLOYED) ok(Object.keys(health.json).join() === 'ok', 'on a deployed server the health check says nothing else: not which providers are set up, not the stage');
  const home = await call(anon, 'GET', '/');
  ok(home.headers['x-content-type-options'] === 'nosniff', 'pages are served with “nosniff”');
  ok(/SAMEORIGIN|DENY/i.test(home.headers['x-frame-options'] || '') && /frame-ancestors 'self'/.test(home.headers['content-security-policy'] || ''), 'the app may not be framed by another site');
  ok(!!home.headers['referrer-policy'], 'a referrer policy is set');
  ok(!home.headers['x-powered-by'], 'the server does not announce what it is built with');
  if (DEPLOYED) ok(/max-age=\d{7,}/.test(home.headers['strict-transport-security'] || ''), 'browsers are told to use HTTPS only');

  // ── 3. Files that are not the app ──
  for (const path of ['/.env', '/.git/config', '/package.json', '/server/src/config.ts', '/%2e%2e/%2e%2e/etc/passwd', '/assets/..%2f..%2fpackage.json']) {
    const r = await call(anon, 'GET', path);
    ok(!/DATABASE_URL|\[core\]|"dependencies"|root:x:|process\.env/.test(r.text), `asking for ${path} returns nothing from the server’s own files`);
  }
  const script = (home.text.match(/src="(\/assets\/[^"]+\.js)"/) || [])[1];
  ok(!!script, 'the app’s script is found on the page');
  const map = await call(anon, 'GET', `${script}.map`);
  ok(!/"sourcesContent"|"sources":/.test(map.text), 'the app’s source code is not published beside its script');

  // ── 4. Errors say what went wrong, not how the server is built ──
  const broken = await call(anon, 'POST', '/api/auth/sign-in/email', { raw: '{"email":', headers: { 'content-type': 'application/json' } });
  ok(broken.status >= 400 && broken.status < 500, 'a request that is not valid JSON is refused as the caller’s mistake');
  ok(!/\n\s+at |node_modules|\/app\/|\.ts:\d+/.test(broken.text), 'and the answer carries no stack trace or file path');
  // The server answers before the body has arrived and then drops that connection, so this caller is used once and thrown away.
  const flood = await request.newContext();
  const big = await call(flood, 'POST', '/api/v1/commands', { raw: JSON.stringify({ pad: 'x'.repeat(1_200_000) }), headers: { 'content-type': 'application/json' } });
  await flood.dispose();
  ok(big.status === 413, 'a body over the size limit is refused before anything reads it');

  // ── 5. Webhooks must be signed ──
  const event = JSON.stringify({ type: 'gmail_new_gmail_message', data: { connection_id: 'anything' } });
  ok((await call(anon, 'POST', '/api/hooks/composio', { raw: event, headers: { 'content-type': 'application/json' } })).status === 401, 'a webhook with no signature is refused');
  const forged = { 'content-type': 'application/json', 'webhook-id': 'msg_1', 'webhook-timestamp': String(Math.floor(Date.now() / 1000)), 'webhook-signature': 'v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' };
  ok((await call(anon, 'POST', '/api/hooks/composio', { raw: event, headers: forged })).status === 401, 'a webhook with a made-up signature is refused');

  // ── 6. The endpoints the tests use are not open to anyone ──
  if (DEPLOYED) {
    ok((await call(anon, 'POST', '/api/test/fake', { body: { op: 'sent' } })).status === 404, 'the test endpoints answer “not found” without the test token');
    ok((await call(anon, 'POST', '/api/test/fake', { body: { op: 'sent' }, headers: { 'x-test-token': 'guess' } })).status === 404, 'and with a wrong one');
    ok((await call(anon, 'POST', '/api/test/release-holds', { body: {} })).status === 404, 'none of them, not only the first');
  }

  // A server where nobody may sign up (production, invite-only) gets the checks above and this one, and no account is made.
  if (process.env.OUTSIDE_NO_ACCOUNT) {
    const uninvited = await call(anon, 'POST', '/api/auth/sign-up/email', { body: { name: 'Uninvited', email: `uninvited.${stamp()}@example.test`, password: 'correct-horse-battery-9' } });
    ok(uninvited.status === 403 && /invite-only/.test(uninvited.text), 'an address nobody invited cannot create an account');
    await anon.dispose();
    return;
  }

  // ── 7. Another site cannot use a signed-in person’s browser ──
  const { page, context } = await open(browser);
  const me = await signUp(page, { name: 'Grace Hopper' });
  const signed = page.request;
  const files = async () => (await api(page, 'GET', '/api/v1/state')).body.slices['ws.files'] || {};
  const before = JSON.stringify(await files());
  const crossSite = await call(signed, 'POST', '/api/v1/commands', { body: { id: `x-${stamp()}`, action: { type: 'ws', ops: [{ op: 'put', col: 'files', item: { id: 'planted', name: 'Planted', kind: 'doc' } }] } }, headers: { origin: 'https://evil.example' } });
  ok(crossSite.status === 403, 'a write sent from another site with the person’s cookies is refused');
  const framed = await call(signed, 'POST', '/api/v1/commands', { body: { id: `x-${stamp()}`, action: { type: 'ws', ops: [] } }, headers: { 'sec-fetch-site': 'cross-site' } });
  ok(framed.status === 403, 'also when the browser itself says the request is cross-site');
  ok(JSON.stringify(await files()) === before, 'and nothing was changed');
  const preflight = await call(anon, 'OPTIONS', '/api/v1/state', { headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
  ok(!preflight.headers['access-control-allow-origin'] && !preflight.headers['access-control-allow-credentials'], 'another site is not given permission to read the API from a browser');
  const cookies = (await context.cookies()).filter((c) => /session/.test(c.name));
  ok(cookies.length > 0 && cookies.every((c) => c.httpOnly && /Lax|Strict/.test(c.sameSite) && (!DEPLOYED || c.secure)), 'the session cookie can’t be read by scripts, isn’t sent on cross-site writes, and is HTTPS-only on a deployed server');

  // ── 8. Requests that lean on how the server is written ──
  ok((await call(signed, 'GET', '/api/v1/commands')).status === 404, 'a write address does nothing when read');
  const proto = await api(page, 'POST', '/api/v1/commands', { id: `x-${stamp()}`, action: { type: 'ws', ops: [{ op: 'put', col: 'files', item: { id: 'constructor', name: 'x', kind: 'doc' } }] } });
  ok(proto.body.ok === false, 'a record named after something every object has is refused');
  const script1 = await api(page, 'POST', '/api/v1/commands', { id: `x-${stamp()}`, action: { type: 'ws', ops: [{ op: 'put', col: 'docs', item: { id: 'd-x', blocks: [{ id: 'b', type: 'p', text: 'x', rich: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(document.cookie)' } }] }] }] } }] } });
  ok(script1.body.ok === false, 'a page with a link that would run a script is refused');
  const script2 = await api(page, 'POST', '/api/v1/commands', { id: `x-${stamp()}`, action: { type: 'ws', ops: [{ op: 'put', col: 'docs', item: { id: 'd-y', blocks: [{ id: 'b', type: 'image', src: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' }] } }] } });
  ok(script2.body.ok === false, 'a picture that is really a web page is refused');
  const asOther = await api(page, 'POST', '/api/v1/commands', { id: `x-${stamp()}`, workspaceId: 'someone-elses', action: { type: 'ws', ops: [{ op: 'put', col: 'files', item: { id: 'mine-1', name: 'Mine', kind: 'doc' } }] } });
  ok(asOther.body.ok === true && !!(await files())['mine-1'], 'naming another workspace in a request changes nothing: the change lands in the person’s own');
  const forgedConnect = await call(signed, 'GET', '/api/v1/connections/callback?c=made-up&status=success&connected_account_id=ca_madeup');
  ok(forgedConnect.status === 302 && /connect=failed/.test(forgedConnect.headers.location || ''), 'a made-up “connection finished” link connects nothing');
  ok(Object.values((await api(page, 'GET', '/api/v1/state')).body.slices['conn.apps'] || {}).every((a) => !a.connected), 'and no app shows as connected');

  // ── 9. Signing in ──
  const wrong = await call(anon, 'POST', '/api/auth/sign-in/email', { body: { email: me.email, password: 'not-the-password-1' } });
  const nobody = await call(anon, 'POST', '/api/auth/sign-in/email', { body: { email: `nobody.${stamp()}@example.test`, password: 'not-the-password-1' } });
  ok(wrong.status === nobody.status && (wrong.json || {}).message === (nobody.json || {}).message, 'a wrong password and an unknown address get the same answer, so the form can’t be used to find who has an account');
  const away = await call(anon, 'POST', '/api/auth/sign-in/magic-link', { body: { email: me.email, callbackURL: 'https://evil.example/landing' } });
  ok(away.status >= 400 && away.status < 500, 'a sign-in link that would land on another site is refused');

  // A copied session stops working when the person signs out.
  const stolen = await request.newContext({ storageState: await context.storageState() });
  ok((await call(stolen, 'GET', '/api/v1/me')).status === 200, 'a copy of the session works while the person is signed in');
  ok((await call(signed, 'POST', '/api/auth/sign-out', { body: {} })).status === 200, 'the person signs out');
  ok((await call(stolen, 'GET', '/api/v1/me')).status === 401, 'and the copy is refused from then on');
  await stolen.dispose();

  // Guessing passwords is slowed down. Last, because it uses up this caller's attempts for a few seconds.
  if (DEPLOYED) {
    const tries = [];
    for (let i = 0; i < 8; i++) tries.push((await call(anon, 'POST', '/api/auth/sign-in/email', { body: { email: me.email, password: `guess-number-${i}` } })).status);
    ok(tries.includes(429), `repeated wrong passwords are slowed down (answers: ${tries.join(' ')})`);
  }
  await anon.dispose();
});
