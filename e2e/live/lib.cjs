// Shared helpers for the live-mode suites. They drive the real app against the API with fake providers.
const { chromium, devices, request } = require('playwright');

const BASE = (process.env.BASE || 'http://localhost:8787/').replace(/\/?$/, '/');
const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

let passed = 0;
const ok = (cond, message) => {
  if (!cond) throw new Error('FAIL: ' + message);
  passed++;
  console.log('ok -', message);
};

/** Opens a browser page that records page errors and console errors. */
async function open(browser, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource.*(401|403|409)/.test(m.text()) && errors.push(m.text()));
  return { context, page, errors };
}

/** Signs up a new person and creates their workspace. Returns what was used. */
async function signUp(page, { name = 'Ada Lovelace', company = `Analytical ${stamp()}`, trade = 'sales' } = {}) {
  const email = `ada.${stamp()}@example.test`;
  const password = 'correct-horse-battery-9';
  await page.goto(BASE);
  await page.getByRole('heading', { name: 'Sign in to Timmy' }).waitFor();
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Name your workspace' }).waitFor();
  await page.getByLabel('Workspace name').fill(company);
  await page.getByLabel('What kind of work is it?').selectOption(trade);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.locator('.main').waitFor();
  return { name, email, password, company };
}

/**
 * The API sends dates tagged, as {"$date": "2026-11-17T09:00:00.000Z"}, so that text shaped like a timestamp is
 * never mistaken for one (src/live/patches.ts). The suites compare dates as ISO strings, so a tag is read as its string.
 */
const parse = (text) => JSON.parse(text, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.$date === 'string' ? v.$date : v));

/** Calls the API with the page's own session (its cookies), without going through the page's console. */
async function api(page, method, path, body) {
  // A browser always sends Origin on a write; the API checks it, so the helper sends it too.
  // Test hooks on a deployed server (staging) need the test token.
  const headers = { ...(method === 'GET' ? {} : { origin: new URL(BASE).origin }), ...(path.startsWith('/api/test/') && process.env.TEST_TOKEN ? { 'x-test-token': process.env.TEST_TOKEN } : {}) };
  // TEST_PROXY (optional): send test-hook calls through an HTTPS proxy that adds the test token, for runners
  // that hold the token in a proxy rather than in TEST_TOKEN (Node also needs the proxy's CA in NODE_EXTRA_CA_CERTS).
  // The page's own session cookies go along.
  if (process.env.TEST_PROXY && path.startsWith('/api/test/')) {
    const ctx = await request.newContext({ proxy: { server: process.env.TEST_PROXY }, storageState: await page.context().storageState() });
    try {
      const r = await ctx.fetch(new URL(path, BASE).toString(), { method, data: body, failOnStatusCode: false, headers });
      const text = await r.text();
      try {
        return { status: r.status(), body: parse(text) };
      } catch {
        return { status: r.status(), body: text };
      }
    } finally {
      await ctx.dispose();
    }
  }
  const r = await page.request.fetch(new URL(path, BASE).toString(), { method, data: body, failOnStatusCode: false, headers });
  const text = await r.text();
  try {
    return { status: r.status(), body: parse(text) };
  } catch {
    return { status: r.status(), body: text };
  }
}

/** Connects a stand-in account for an app by pressing Connect on its card, the way a person would. `name` is the app's name on the card. */
async function connectApp(page, name, address) {
  await api(page, 'POST', '/api/test/fake', { op: 'address', address });
  await page.click('button[aria-label="Connections"]');
  const card = page.locator('li.conn-card', { has: page.getByText(name, { exact: true }) }).first();
  await card.getByRole('button', { name: 'Connect' }).click();
  // The address bar may still say "connect=ok" from an earlier connect in the same test, so that alone proves nothing.
  // What is waited for is this connect's own return trip: the server's answer to the callback, then the page it lands on.
  const back = page.waitForResponse((r) => r.url().includes('/api/v1/connections/callback'), { timeout: 30000 });
  await page.getByRole('button', { name: `Continue to ${name}` }).click();
  await back;
  await page.waitForURL(/connect=ok/, { timeout: 15000 });
  await page.waitForLoadState('load');
  await page.locator('.main').waitFor();
}
const connectGmail = (page, address) => connectApp(page, 'Gmail', address);

/** Writes and sends a new email from the compose window. */
async function compose(page, { to, subject, body }) {
  await page.keyboard.press('Escape');
  await page.click('button[aria-label="Today & mail"]');
  await page.getByRole('button', { name: 'New email' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New message' });
  await dialog.getByPlaceholder('Name or email').fill(to);
  await page.keyboard.press('Enter');
  await dialog.locator('.draft-subject').fill(subject);
  await dialog.getByRole('textbox', { name: 'Message' }).fill(body);
  await dialog.getByRole('button', { name: /^Send/ }).first().click();
}

const deliver = (page, message) => api(page, 'POST', '/api/test/fake', { op: 'deliver', message });
const sentMail = async (page) => (await api(page, 'POST', '/api/test/fake', { op: 'sent' })).body.sent;
const releaseHolds = (page) => api(page, 'POST', '/api/test/release-holds', {});

async function run(name, fn) {
  const browser = await chromium.launch();
  try {
    await fn(browser);
    console.log(`PASS ${name} (${passed} checks)`);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

module.exports = { BASE, ok, open, signUp, api, connectApp, connectGmail, compose, deliver, sentMail, releaseHolds, run, devices, stamp };
