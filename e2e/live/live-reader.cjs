// Reading email the way a mail app shows it (src/components/EmailBody.tsx, server/src/mail/original.ts): the sender's
// full address, every recipient on request, HTML mail as its sender laid it out in a frame that runs nothing,
// pictures from other sites hidden until asked for, links that open in a new tab, plain text with clickable links
// and the quoted history folded.
const { ok, open, signUp, api, connectGmail, run } = require('./lib.cjs');

const HTML = `<html><head><style>.btn{background:#635bff;color:#fff;padding:8px 14px;border-radius:6px}</style><script>window.parent.document.title='pwned'</script></head>
<body><img src="https://images.example.test/logo.png" alt="Northwind" width="120"><h2>Your receipt from Northwind Cloud</h2>
<table><tr><td>Team plan</td><td>$240.00</td></tr></table><p><a class="btn" href="https://billing.northwind.test/invoices/1042">View invoice</a>
<a href="javascript:window.parent.document.title='pwned'">Click me</a></p><form action="https://evil.test"><input name="password"></form></body></html>`;

run('live-reader', async (browser) => {
  const { page, errors } = await open(browser);
  await signUp(page, { name: 'Grace Hopper' });
  await connectGmail(page, 'grace@navy.test');
  await api(page, 'POST', '/api/test/fake', { op: 'deliver', message: { from: 'Northwind Cloud <receipts@northwind.test>', subject: 'Your receipt from Northwind Cloud', body: 'Your receipt. Total $258.00.', html: HTML } });
  await api(page, 'POST', '/api/test/fake', {
    op: 'deliver',
    message: {
      from: 'Dana Whitfield <dana@acmecorp.test>',
      to: ['grace@navy.test', 'sam@acmecorp.test'],
      cc: ['legal@acmecorp.test'],
      subject: 'Revised quote for 120 seats',
      body: 'Hi Grace,\n\nThe revised quote is here: https://drive.example.test/acme/quote-v3\n\nOr email me at dana@acmecorp.test.\n\nDana\n\nOn Mon, Nov 16, 2026 at 9:02 AM Grace Hopper <grace@navy.test> wrote:\n> Could you send the revised numbers?',
    },
  });
  for (let i = 0; i < 80; i++) {
    if ((await api(page, 'GET', '/api/v1/state')).body.slices.threads.length >= 2) break;
    await page.waitForTimeout(150);
  }
  const title = await page.title();
  await page.getByRole('tab', { name: /Triage/ }).click();

  // HTML mail, as its sender laid it out.
  await page.locator('.triage-subject', { hasText: 'Your receipt from Northwind Cloud' }).first().click();
  const head = page.locator('.msg-head').first();
  await head.waitFor();
  ok(/Northwind Cloud\s*<receipts@northwind\.test>/.test(await head.innerText()), 'the sender shows with their full address');
  const mail = page.frameLocator('iframe.mail-frame');
  await mail.getByText('Your receipt from Northwind Cloud').waitFor();
  ok(true, 'the HTML email is shown as its sender laid it out');
  const invoice = mail.getByRole('link', { name: 'View invoice' });
  ok((await invoice.getAttribute('href')) === 'https://billing.northwind.test/invoices/1042' && (await invoice.getAttribute('target')) === '_blank', 'its links work and open in a new tab');
  ok((await mail.locator('script, form, input').count()) === 0, 'nothing in it can run or ask for a password');
  ok((await mail.getByText('Click me').getAttribute('href')) === null, 'a javascript: link is left with nowhere to go');
  ok((await page.locator('iframe.mail-frame').getAttribute('sandbox')) === 'allow-same-origin allow-popups allow-popups-to-escape-sandbox', 'the frame is sandboxed with no scripts allowed');
  ok((await page.title()) === title, 'the email’s script did not touch the app');
  ok((await mail.locator('img[src*="images.example.test"]').count()) === 0, 'pictures from other sites are hidden at first');
  await page.getByText('Pictures in this email are hidden, so the sender can’t tell you opened it.').waitFor();
  await page.getByRole('button', { name: 'Show pictures' }).click();
  await mail.locator('img[src="https://images.example.test/logo.png"]').waitFor({ state: 'attached' });
  ok((await page.locator('.mail-images-off').count()) === 0, 'Show pictures brings them in and the notice goes');

  // Plain text, with its people in full.
  await page.keyboard.press('Escape');
  await page.click('button[aria-label="Today & mail"]');
  await page.getByRole('tab', { name: /Triage/ }).click();
  await page.locator('.triage-subject', { hasText: 'Revised quote for 120 seats' }).first().click();
  const to = page.locator('.msg-to').first();
  await to.waitFor();
  ok(/to me, Sam, cc Legal/.test(await to.innerText()), 'who it went to, in short, under the sender');
  await to.click();
  const details = await page.locator('.msg-details').innerText();
  ok(/Dana Whitfield <dana@acmecorp\.test>/.test(details) && /me <grace@navy\.test>/.test(details) && /sam@acmecorp\.test/.test(details) && /legal@acmecorp\.test/.test(details), 'the details list every address in full');
  const link = page.locator('.mail-text a', { hasText: 'https://drive.example.test/acme/quote-v3' });
  ok((await link.getAttribute('href')) === 'https://drive.example.test/acme/quote-v3' && (await link.getAttribute('target')) === '_blank', 'a web address in plain text is a link');
  ok((await page.locator('.mail-text a[href="mailto:dana@acmecorp.test"]').count()) === 1, 'so is an email address');
  ok(!(await page.locator('.mail-text').innerText()).includes('Could you send the revised numbers?'), 'the quoted history is folded');
  await page.locator('.mail-quoted-toggle').click();
  await page.locator('.mail-quoted', { hasText: 'Could you send the revised numbers?' }).waitFor();
  ok(true, 'and opens with •••');

  ok(errors.length === 0, `no page errors (${errors.join(' | ')})`);
});
