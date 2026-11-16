// Shared helpers for the live-mode suites. They drive the real app against the API with fake providers.
const { chromium, devices } = require('playwright');

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

/** Calls the API with the page's own session (its cookies), without going through the page's console. */
async function api(page, method, path, body) {
  // A browser always sends Origin on a write; the API checks it, so the helper sends it too.
  const r = await page.request.fetch(new URL(path, BASE).toString(), { method, data: body, failOnStatusCode: false, headers: method === 'GET' ? {} : { origin: new URL(BASE).origin } });
  const text = await r.text();
  try {
    return { status: r.status(), body: JSON.parse(text) };
  } catch {
    return { status: r.status(), body: text };
  }
}

/** Connects the fake Gmail mailbox by pressing Connect, the way a person would. */
async function connectGmail(page, address) {
  await api(page, 'POST', '/api/test/fake', { op: 'address', address });
  await page.click('button[aria-label="Connections"]');
  const card = page.locator('li', { has: page.getByText('Gmail', { exact: true }) }).first();
  await card.getByRole('button', { name: 'Connect' }).click();
  await page.getByRole('button', { name: 'Continue to Gmail' }).click();
  await page.waitForURL(/connect=ok/, { timeout: 15000 });
  await page.locator('.main').waitFor();
}

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

module.exports = { BASE, ok, open, signUp, api, connectGmail, compose, deliver, sentMail, releaseHolds, run, devices, stamp };
