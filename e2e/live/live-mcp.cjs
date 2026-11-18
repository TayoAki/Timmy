// Using Timmy from another AI app over MCP (server/src/http/mcp.ts, src/live/Connect.tsx, src/live/ConnectedApps.tsx):
// the app registers and sends the person to Timmy; they sign in, the one workspace is chosen by itself, they see what
// the app may do and allow it; the app trades the code for a token and calls tools; Disconnect stops it at once.
// The test plays the app from Node and the person in the browser.
const crypto = require('node:crypto');
const { BASE, ok, open, signUp, api, connectGmail, run } = require('./lib.cjs');

const ORIGIN = BASE.replace(/\/$/, '');
const REDIRECT = 'http://127.0.0.1:9999/callback';

async function post(path, body, form = false) {
  const res = await fetch(`${ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' }, body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function mcp(token, method, params = {}) {
  const res = await fetch(`${ORIGIN}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const text = await res.text();
  const data = text.includes('data: ') ? text.split('\n').find((l) => l.startsWith('data: ')).slice(6) : text;
  return { status: res.status, body: data ? JSON.parse(data) : {} };
}

run('live-mcp', async (browser) => {
  const owner = await open(browser);
  const me = await signUp(owner.page, { name: 'Grace Hopper' });
  await connectGmail(owner.page, 'grace@mycompany.test');
  await api(owner.page, 'POST', '/api/test/fake', { op: 'deliver', message: { from: 'Dana Whitfield <dana@acme.test>', subject: 'Renewal terms', body: 'Can you confirm the renewal terms by Friday?' } });
  for (let i = 0; i < 60; i++) {
    if ((await api(owner.page, 'GET', '/api/v1/state')).body.slices.threads.length) break;
    await owner.page.waitForTimeout(200);
  }

  // The app finds Timmy's sign-in from the endpoint itself.
  const challenge = await fetch(`${ORIGIN}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  ok(challenge.status === 401 && /resource_metadata=/.test(challenge.headers.get('www-authenticate') || ''), 'without a token, /mcp says where to sign in');
  const reg = await post('/api/auth/oauth2/register', { client_name: 'Live test client', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  ok(reg.status === 201 && reg.body.client_id, 'the app registers itself');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 'st', scope: 'openid offline_access', resource: `${ORIGIN}/mcp` });

  // The person, in a browser that isn't signed in.
  const person = await open(browser);
  let landed = null;
  await person.page.route('http://127.0.0.1:9999/**', (route) => {
    landed = route.request().url();
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Back in the app</p>' });
  });
  await person.page.goto(`${ORIGIN}/api/auth/oauth2/authorize?${q}`);
  await person.page.getByRole('heading', { name: 'Sign in to connect Live test client' }).waitFor();
  ok(true, 'Timmy asks the person to sign in, naming the app');
  await person.page.getByLabel('Work email').fill(me.email);
  await person.page.getByLabel('Password').fill(me.password);
  await person.page.getByRole('button', { name: 'Sign in' }).click();
  // One workspace: nothing to choose. Straight on to what the app may do.
  await person.page.getByRole('heading', { name: `Let Live test client use Timmy in ${me.company}?` }).waitFor();
  const consent = await person.page.locator('.live-card').innerText();
  ok(/can’t send an email, change your mailbox or save a rule without your OK/.test(consent) && /you go back to 127\.0\.0\.1:9999/.test(consent), 'the consent page says what the app may and may not do, and where it goes back to');
  await person.page.getByRole('button', { name: 'Allow', exact: true }).click();
  for (let i = 0; i < 50 && !landed; i++) await person.page.waitForTimeout(100);
  const code = landed && new URL(landed).searchParams.get('code');
  ok(!!code && new URL(landed).searchParams.get('state') === 'st', 'allowing sends the person back to the app with a code');

  const tok = await post('/api/auth/oauth2/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: reg.body.client_id, code_verifier: verifier, resource: `${ORIGIN}/mcp` }, true);
  ok(tok.status === 200 && tok.body.access_token && tok.body.refresh_token, 'the app trades the code for a token');
  const listed = await mcp(tok.body.access_token, 'tools/list');
  ok(listed.body.result && listed.body.result.tools.some((t) => t.name === 'whats_waiting'), 'the app sees Timmy’s tools');
  const waiting = await mcp(tok.body.access_token, 'tools/call', { name: 'whats_waiting', arguments: {} });
  ok(/Renewal terms/.test(waiting.body.result.content[0].text), 'and the person’s own mail through them');

  // Rules & settings › Approvals lists it, and Disconnect stops it at once.
  await owner.page.reload();
  await owner.page.locator('.main').waitFor();
  await owner.page.click('button[aria-label="Rules & settings"]');
  await owner.page.getByRole('tab', { name: 'Approvals' }).click();
  const apps = owner.page.getByRole('list', { name: 'Connected apps' });
  await apps.waitFor();
  ok(/Live test client/.test(await apps.innerText()), 'Settings lists the connected app');
  ok((await owner.page.getByLabel('Timmy’s MCP address').inputValue()) === `${ORIGIN}/mcp`, 'and shows the address to paste into an AI app');
  await apps.getByRole('button', { name: 'Disconnect' }).click();
  await apps.waitFor({ state: 'detached' });
  const after = await mcp(tok.body.access_token, 'tools/call', { name: 'whats_waiting', arguments: {} });
  ok(after.status === 403, 'after Disconnect the app gets nothing, though its token has not expired');

  ok(owner.errors.length === 0 && person.errors.length === 0, `no page errors (${[...owner.errors, ...person.errors].join(' | ')})`);
});
