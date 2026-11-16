// Live mode: the website chat, end to end, in two browsers.
// The owner sets the chat up and switches it on. A visitor, on a page of the owner's website that carries the
// real code snippet, gets a help desk answer, leaves an email and asks for a person. The owner sees the chat
// marked urgent and the lead, takes over and replies, and the visitor sees the reply.
// The "website" is a page Playwright serves at the configured address, so the browser itself checks that the
// chat's frame may be shown there and nowhere else.
const { chromium } = require('playwright');
const { BASE, ok, open, signUp, api, run, stamp } = require('./lib.cjs');

run('live-chat', async (browser) => {
  const { page, errors } = await open(browser);
  const company = `Harbor Tools ${stamp()}`;
  await signUp(page, { name: 'Grace Hopper', company });
  const origin = new URL(BASE).origin;
  const slices = async () => (await api(page, 'GET', '/api/v1/state')).body.slices;
  const site = async () => (await slices())['ws.chat'].site;
  const until = async (fn, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      if (await fn()) return true;
      await page.waitForTimeout(250);
    }
    return false;
  };
  const domain = `harbor-${stamp()}.example`;
  const ANSWER = 'Plans start at $29 a seat, billed monthly.';

  /* ── Set up, as the owner ── */
  await page.click('button[aria-label="Outbound"]');
  await page.getByRole('tab', { name: /Website chat/ }).click();
  await page.waitForSelector('.wc-setup');
  ok(/Enter your website above first/.test(await page.locator('.wc-form').innerText()), 'before a website is named there is no snippet to paste');
  ok((await page.locator('.wc-radio.unavailable input').isDisabled()) && (await page.locator('.wc-check').count()) === 0 && /Booking a call from the chat isn’t available yet/.test(await page.locator('.wc-form').innerText()), 'booking a call can’t be picked, and the screen says it is not available yet');

  // Switching on without a website is refused, with the reason, and the chat stays off.
  const power = page.getByRole('switch', { name: 'Show the chat on your website' });
  await power.click();
  await page.locator('.toast', { hasText: /Set your website first/ }).waitFor();
  ok((await site()).on === false, 'the chat can’t be switched on before a website is named');

  const website = page.locator('.wc-domain input');
  await website.fill(domain);
  await website.blur();
  ok(await until(async () => !!(await site()).siteKey), 'naming the website makes the key for the snippet');
  const key = (await site()).siteKey;
  await page.locator('.wc-code').waitFor();
  const snippet = (await page.locator('.wc-code code').innerText()).trim();
  ok(snippet === `<script src="${origin}/chat.js" data-site="${key}" async></script>`, `the snippet loads the real loader with this workspace’s key (${snippet.slice(0, 60)}…)`);

  await page.getByLabel('Help desk question').fill('How much does it cost?');
  await page.getByLabel('Help desk answer').fill(ANSWER);
  await page.getByRole('button', { name: 'Add answer' }).click();
  await page.getByLabel('New question').fill('What’s your company called?');
  await page.getByLabel('New question').press('Enter');
  ok(await until(async () => (await site()).faq.length === 1 && (await site()).questions.length === 1), 'the help desk answer and the question are kept');
  const policy = `https://${domain}/privacy`;
  await page.getByPlaceholder('https://your-site.com/privacy').fill(policy);
  await page.getByPlaceholder('https://your-site.com/privacy').blur();
  ok((await until(async () => (await site()).privacyUrl === policy)) && (await page.getByLabel('Keep chats for').inputValue()) === '12', 'the privacy policy link is kept, and chats are kept for 12 months unless the owner chooses otherwise');

  // The preview answers the way a real visitor will be answered: from the settings, with no call offered.
  const preview = page.locator('.wc-site');
  await preview.getByLabel('Message').fill('can I talk to a person?');
  await preview.getByLabel('Message').press('Enter');
  await preview.locator('.wc-bubble.timmy', { hasText: /I’ve let .* know/ }).waitFor();
  ok(new RegExp(`I’ve let ${company} know`).test(await preview.locator('.wc-body').innerText()) && (await preview.locator('.wc-slot').count()) === 0 && (await preview.getByLabel('Attach a picture').count()) === 0, 'the preview names the business, offers no call and no picture upload');

  // Before it is switched on, the website shows nothing.
  ok((await api(page, 'GET', `/api/public/chat/${key}/config`)).status === 404, 'until it is switched on, the chat does not exist for visitors');
  await power.click();
  ok(await until(async () => (await site()).on === true), 'the owner switches the chat on');
  ok((await api(page, 'GET', `/api/public/chat/${key}/config`)).status === 200, 'and now it answers for its site key');

  /* ── A visitor on the owner's website ── */
  // A separate browser: no sign-in, no cookies. The website is served here at the address the owner named.
  // (The switches let a page on a made-up public address load from this machine, which a real deployment never needs.)
  const outside = await chromium.launch({ args: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessRespectPreflightResults', '--allow-running-insecure-content'] });
  try {
    const visitor = await open(outside);
    const pageHtml = (title) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${snippet}</head><body><h1>${title}</h1><p>Scheduling for busy teams.</p></body></html>`;
    await visitor.context.route(`https://${domain}/**`, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: pageHtml('Harbor Tools') }));
    await visitor.context.route('https://copycat.example/**', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: pageHtml('Copycat') }));
    const v = visitor.page;
    await v.goto(`https://${domain}/pricing`);
    const holder = v.locator('iframe[title="Chat"]');
    await holder.waitFor({ state: 'attached' });
    const chat = v.frameLocator('iframe[title="Chat"]');
    await chat.locator('.tc-launcher').waitFor();
    const size = async () => {
      const box = await holder.boundingBox();
      return box ? [Math.round(box.width), Math.round(box.height)] : [0, 0];
    };
    ok((await size()).join('x') === '92x92', 'the loader adds a frame the size of the bubble, in the corner');
    ok((await v.evaluate(() => { try { return String(document.querySelector('iframe').contentWindow.document.body.innerText); } catch { return 'blocked'; } })) === 'blocked', 'the website cannot reach into the chat’s frame');
    await chat.locator('.tc-launcher').click();
    await chat.locator('.tc-window').waitFor();
    ok((await size())[0] === 404, 'opening the chat makes the frame the size of the window');
    ok(new RegExp(company).test(await chat.locator('.tc-head').innerText()) && (await chat.locator('.tc-bubble').count()) === 1, 'the window shows the business’s name and greeting');

    const say = async (text) => {
      await chat.getByLabel('Message').fill(text);
      await chat.getByLabel('Message').press('Enter');
    };
    const hears = (text) => chat.locator('.tc-row:not(.visitor) .tc-bubble', { hasText: text }).first().waitFor({ timeout: 15000 });
    await say('How much does it cost?');
    await hears(ANSWER);
    await hears('What’s the best email to reach you?');
    ok((await chat.locator('.tc-row:not(.visitor) .tc-bubble p', { hasText: ANSWER }).first().innerText()) === ANSWER, 'a question gets the help desk answer, word for word');
    const notice = chat.locator('.tc-bubble', { hasText: 'What’s the best email to reach you?' }).locator('.tc-privacy a');
    ok((await notice.count()) === 1 && (await notice.getAttribute('href')) === policy && /noopener/.test(await notice.getAttribute('rel')), 'the email question comes with a notice that links to the owner’s privacy policy');
    await say('lin@visitor.example');
    await hears('Thanks, Lin! What’s your company called?');
    await say('<b>Visitor</b> & Co <img src=x onerror=alert(1)>');
    await hears(`Thanks! ${company} will be in touch at lin@visitor.example.`);
    ok((await chat.locator('.tc-body b, .tc-body img:not(.tc-face img)').count()) === 0 && /<b>Visitor<\/b> & Co <img src=x onerror=alert\(1\)>/.test(await chat.locator('.tc-body').innerText()), 'markup a visitor types is shown as the characters they typed');
    await say('Can I talk to a person?');
    await hears(`I’ve let ${company} know. They’ll reply here, or by email at lin@visitor.example`);
    ok(true, 'leaving an email and asking for a person are answered by the rules');

    /* ── The owner sees it ── */
    await page.getByRole('radio', { name: /Chats/ }).click();
    const card = page.locator('.wc-card', { hasText: 'Lin' });
    await card.waitFor({ timeout: 15000 });
    ok(/Wants a person/.test(await card.innerText()), 'the chat arrives on the Chats screen, marked as wanting a person');
    await card.click();
    ok(/lin@visitor\.example/.test(await page.locator('.wc-thread-head').innerText()) && /\/pricing/.test(await page.locator('.wc-thread-head').innerText()), 'with the visitor’s email and the page they were on');
    ok(/What’s your company called\s+<b>Visitor<\/b> & Co/.test(await page.locator('.wc-facts').innerText()) && (await page.locator('.wc-thread b, .wc-thread-body img').count()) === 0, 'their answer is shown as text, with nothing in it run or drawn');
    const state = await slices();
    const leads = Object.values(state['out.leads']);
    ok(leads.length === 1 && leads[0].email === 'lin@visitor.example' && leads[0].source === 'chat' && Object.values(leads[0].extra).includes('<b>Visitor</b> & Co <img src=x onerror=alert(1)>'), 'the visitor became one lead, from the website chat, with their answer');
    ok(state.activity.some((a) => /asked for a person/.test(a.text)) && state.activity.some((a) => /New lead from your website chat/.test(a.text)), 'the activity log says a lead arrived and that someone asked for a person');
    await page.getByRole('tab', { name: /^Leads/ }).click();
    ok(/Website chat/.test(await page.locator('button.lead-name', { hasText: 'Lin' }).innerText()), 'the lead is listed in Leads as coming from the website chat');

    /* ── Take over and reply ── */
    await page.getByRole('tab', { name: /Website chat/ }).click();
    await page.getByRole('radio', { name: /Chats/ }).click();
    await page.getByRole('tab', { name: 'All', exact: true }).click();
    await page.locator('.wc-card', { hasText: 'Lin' }).click();
    ok(await page.getByLabel('Your reply').isDisabled(), 'the owner can’t reply while Timmy is answering');
    await page.getByRole('switch', { name: 'Take over this chat' }).click();
    await page.locator('.wc-live').waitFor();
    await page.getByLabel('Your reply').fill('Hi Lin, Grace here. Happy to help.');
    await page.getByLabel('Your reply').press('Enter');
    await chat.locator('.tc-row:not(.visitor) .tc-bubble', { hasText: 'Hi Lin, Grace here. Happy to help.' }).waitFor({ timeout: 15000 });
    ok(!/Grace Hopper/.test(await chat.locator('.tc-body').innerText()), 'the visitor sees the owner’s reply, without being told who wrote it');
    ok(await until(async () => (await page.locator('.wc-bubble.you', { hasText: 'Hi Lin, Grace here.' }).count()) === 1), 'the owner’s screen shows the reply once');

    // A follow-up by email is an ordinary draft: it opens in the compose window and goes nowhere unless it is sent.
    await page.getByRole('button', { name: 'Email', exact: true }).click();
    const compose = page.getByRole('dialog', { name: 'New message' });
    await compose.waitFor();
    ok(/Lin/.test(await compose.innerText()) && (await compose.locator('.draft-subject').inputValue()) === 'Following up on your chat' && /\nGrace$/.test((await compose.getByRole('textbox', { name: 'Message' }).inputValue()).trim()), 'Email opens an ordinary draft to the visitor, signed by the person signed in');
    await compose.getByRole('button', { name: 'Close' }).click();
    ok(((await api(page, 'GET', '/api/v1/audit?limit=500')).body.entries.filter((e) => e.action === 'effect.proposed' && e.detail.kind !== 'chat.reply').length) === 0, 'and nothing is sent by opening it');

    // Timmy has stopped: the next question waits for the person, and arrives on the owner's screen.
    const answersBefore = await chat.locator('.tc-row:not(.visitor) .tc-bubble', { hasText: ANSWER }).count();
    await say('And how much was it again?');
    await page.locator('.wc-bubble.visitor', { hasText: 'And how much was it again?' }).waitFor({ timeout: 15000 });
    await v.waitForTimeout(1200);
    ok((await chat.locator('.tc-row:not(.visitor) .tc-bubble', { hasText: ANSWER }).count()) === answersBefore, 'once the owner has taken over, Timmy says nothing more');

    // Every message the visitor was shown went through the Action gateway.
    const audit = (await api(page, 'GET', '/api/v1/audit?limit=500')).body.entries;
    const shown = await chat.locator('.tc-row:not(.visitor) .tc-bubble').count();
    ok(audit.filter((e) => e.action === 'effect.completed').length === shown - 1 && audit.some((e) => e.action === 'chat.switched_on') && audit.some((e) => e.action === 'chat.taken_over'), `each reply the visitor saw has its record in the audit log (${shown - 1}), with who switched the chat on and who took over`);

    // The visitor comes back later: the conversation is still theirs.
    await v.reload();
    await chat.locator('.tc-launcher').click();
    await chat.locator('.tc-row:not(.visitor) .tc-bubble', { hasText: 'Hi Lin, Grace here. Happy to help.' }).waitFor({ timeout: 15000 });
    ok((await chat.locator('.tc-row.visitor').count()) === 5, 'after a reload the visitor has their conversation back');

    // The same snippet on someone else's website shows nothing: the browser refuses to draw the frame there.
    const copy = await visitor.context.newPage();
    await copy.goto('https://copycat.example/');
    await copy.locator('iframe[title="Chat"]').waitFor({ state: 'attached' });
    await copy.waitForTimeout(2500);
    ok((await copy.locator('iframe[title="Chat"]').evaluate((f) => getComputedStyle(f).display)) === 'none', 'pasted into another website, the chat stays hidden');
    await copy.close();

    /* ── Privacy: the owner deletes the chat ── */
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Delete this chat' }).click();
    ok(await until(async () => Object.keys((await slices())['ws.chats']).length === 0), 'the owner deletes the chat, and it leaves the Chats screen');
    await say('Are you still there?');
    await chat.locator('.tc-notice', { hasText: /This conversation has ended/ }).waitFor({ timeout: 15000 });
    ok(true, 'the visitor is told the conversation has ended, in a plain sentence');

    // Switched off, the bubble is gone from the website.
    await page.getByRole('radio', { name: 'Set up' }).click();
    await page.getByRole('switch', { name: 'Show the chat on your website' }).click();
    ok(await until(async () => (await site()).on === false), 'the owner switches the chat off');
    await v.reload();
    await v.locator('iframe[title="Chat"]').waitFor({ state: 'attached' });
    await v.waitForTimeout(2000);
    ok((await v.locator('iframe[title="Chat"]').evaluate((f) => getComputedStyle(f).display)) === 'none', 'and the website shows no chat');
    const outsideErrors = visitor.errors.filter((e) => !/frame-ancestors|Refused to frame|404|403|429/.test(e));
    ok(outsideErrors.length === 0, `no errors on the website (${outsideErrors.join(' | ')})`);
  } finally {
    await outside.close();
  }

  ok(errors.filter((e) => !/400|404|409/.test(e)).length === 0, `no page errors in the app (${errors.join(' | ')})`);
});
