const { chromium } = require('playwright');
const assert = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('ok -', m); };
// A stand-in for the browser's speech recognition that "hears" a fixed phrase.
const STUB = (phrase) => `
  window.__heard = ${JSON.stringify(phrase)};
  class FakeRec {
    constructor() { this.lang = 'en-US'; this.continuous = false; this.interimResults = false; }
    start() { this._t = setTimeout(() => this.onresult && this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: window.__heard }], { isFinal: true })] }), 150); }
    stop() { clearTimeout(this._t); setTimeout(() => this.onend && this.onend(), 30); }
    abort() { clearTimeout(this._t); }
  }
  window.webkitSpeechRecognition = FakeRec; window.SpeechRecognition = FakeRec;
  localStorage.setItem('timmy-voice-v1', JSON.stringify({ engine: 'browser' }));
`;
(async () => {
  const b = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone', 'clipboard-read', 'clipboard-write'] });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await p.addInitScript(STUB('tell dana whitefield at north peak that the brightwave form arrived'));
  await p.goto('http://localhost:5173/');
  await p.evaluate(() => { localStorage.removeItem('timmy-state-v3'); });
  await p.reload();
  await p.waitForTimeout(700);

  // Reply box: mic button inserts at the end with the dictionary applied.
  await p.locator('.urg-row', { hasText: 'Jordan Kim' }).locator('button').last().click().catch(async () => {
    await p.click('button[aria-label="Today & mail"]');
  });
  await p.waitForTimeout(400);
  // Open a thread without a draft so the reply box shows: Leo's intro (inbox).
  await p.evaluate(() => {});
  await p.click('.side .nav-item:has-text("Inbox")');
  await p.waitForTimeout(300);
  await p.locator('.row', { hasText: 'Intro to Dana' }).click();
  await p.waitForTimeout(400);
  const reply = p.locator('textarea[aria-label="Reply"]');
  assert(await reply.count() === 1, 'reply box is open on the thread');
  await p.click('button[aria-label="Dictate your reply"]');
  await p.waitForSelector('.mic-live .mic-level', { timeout: 4000 });
  await p.waitForTimeout(500);
  await p.screenshot({ path: 'shots/voice-reply-listening.png' });
  await p.click('button[aria-label="Stop and insert"]');
  await p.waitForTimeout(500);
  const val = await reply.inputValue();
  assert(/Hi Leo,\n\nTell Dana Whitfield at Northpeak that the Brightwave form arrived$/.test(val), `reply got the corrected transcript: ${JSON.stringify(val)}`);

  // Escape cancels a live dictation and doesn't navigate back.
  await p.click('button[aria-label="Dictate your reply"]');
  await p.waitForSelector('.mic-live', { timeout: 4000 });
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  assert(await p.locator('.mic-live').count() === 0 && await reply.count() === 1, 'Esc cancels dictation and stays on the thread');
  assert((await reply.inputValue()) === val, 'cancel leaves the text alone');

  // Push-to-talk into the focused reply at the cursor (after "Hi Leo,").
  await reply.click();
  await p.evaluate(() => { const t = document.querySelector('textarea[aria-label="Reply"]'); t.setSelectionRange(7, 7); });
  await p.evaluate(() => { window.__heard = 'thanks for asking'; });
  await p.keyboard.down('Control'); await p.keyboard.down('Shift'); await p.keyboard.down('Space');
  await p.waitForSelector('.ptt .mic-level', { timeout: 4000 });
  await p.waitForTimeout(600);
  await p.screenshot({ path: 'shots/voice-ptt.png' });
  const dest = await p.locator('.ptt-dest').innerText();
  assert(/Into: Reply/.test(dest), `indicator says where the text goes: ${dest}`);
  await p.keyboard.up('Space'); await p.keyboard.up('Shift'); await p.keyboard.up('Control');
  await p.waitForTimeout(600);
  const v2 = await reply.inputValue();
  assert(v2.startsWith('Hi Leo, thanks for asking\n\nTell'), `push-to-talk typed at the cursor: ${JSON.stringify(v2.slice(0, 40))}`);

  // Tap to toggle: tap, it keeps listening, tap again to insert.
  await p.evaluate(() => { const t = document.querySelector('textarea[aria-label="Reply"]'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); window.__heard = 'talk soon'; });
  await p.keyboard.press('Control+Shift+Space');
  await p.waitForTimeout(700);
  assert(await p.locator('.ptt').count() === 1, 'a tap keeps listening');
  await p.keyboard.press('Control+Shift+Space');
  await p.waitForTimeout(600);
  assert(/talk soon$/i.test(await reply.inputValue()), 'second tap inserts');

  // No field focused: event to the chat, else clipboard.
  await p.evaluate(() => { document.activeElement && document.activeElement.blur(); window.__heard = 'what needs my approval'; window.__got = null; window.addEventListener('timmy:voice', (e) => { window.__got = e.detail.text; e.preventDefault(); }, { once: true }); });
  await p.keyboard.down('Control'); await p.keyboard.down('Shift'); await p.keyboard.down('Space');
  await p.waitForTimeout(600);
  await p.keyboard.up('Space'); await p.keyboard.up('Shift'); await p.keyboard.up('Control');
  await p.waitForTimeout(500);
  assert((await p.evaluate(() => window.__got)) === 'what needs my approval', 'no field focused: timmy:voice event carries the text');
  // Timmy opened with that question; close it so nothing is focused again.
  await p.waitForTimeout(2500); await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  await p.evaluate(() => { document.activeElement && document.activeElement.blur(); window.__heard = 'copy me please'; });
  await p.keyboard.down('Control'); await p.keyboard.down('Shift'); await p.keyboard.down('Space');
  await p.waitForTimeout(600);
  await p.keyboard.up('Space'); await p.keyboard.up('Shift'); await p.keyboard.up('Control');
  await p.waitForTimeout(600);
  // With the chat docked, words spoken with nothing focused go to Ask Timmy.
  await p.waitForTimeout(400); const asked = await p.locator('.ai-msg.me', { hasText: /copy me please/i }).count(); await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  assert(asked === 1, `no field focused: sent to Ask Timmy (${asked})`);

  // Compose: mic button inserts into the body.
  await p.keyboard.press('Escape');
  await p.evaluate(() => { window.__heard = 'could you send the signed form by friday'; });
  await p.keyboard.press('c');
  await p.waitForSelector('.compose');
  await p.click('button[aria-label="Dictate the message"]');
  await p.waitForSelector('.compose .mic-live .mic-level', { timeout: 4000 });
  await p.waitForTimeout(400);
  await p.screenshot({ path: 'shots/voice-compose.png' });
  await p.click('.compose button[aria-label="Stop and insert"]');
  await p.waitForTimeout(500);
  assert((await p.locator('#compose-body').inputValue()) === 'Could you send the signed form by friday', 'compose body got the transcript, capitalised');
  await p.click('.compose button[aria-label="Close"]');

  // Settings › Voice
  await p.click('button[aria-label="Rules & settings"]');
  await p.click('.side .nav-item:has-text("Voice")');
  await p.waitForTimeout(400);
  assert(await p.locator('h1:has-text("Voice")').count() === 1, 'Settings › Voice opens');
  await p.fill('input[aria-label="Add to dictionary"]', 'Okafor');
  await p.click('.voice-add button[type=submit]');
  assert(await p.locator('.voice-word', { hasText: /^Okafor$/ }).count() === 1, 'dictionary word added');
  await p.click('button[aria-label="Remove Okafor"]');
  assert(await p.locator('.voice-word', { hasText: /^Okafor$/ }).count() === 0, 'dictionary word removed');
  await p.selectOption('select[aria-label="Push-to-talk shortcut"]', 'f9');
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem('timmy-voice-v1')));
  assert(saved.shortcut === 'f9' && saved.engine === 'browser', 'voice settings saved in the browser');
  await p.screenshot({ path: 'shots/voice-settings.png', fullPage: false });
  // F9 now works, Ctrl+Shift+Space no longer does.
  await p.evaluate(() => { const t = document.querySelector('textarea[aria-label="Dictation test"]'); t.focus(); window.__heard = 'hello northwind'; });
  await p.keyboard.down('F9'); await p.waitForTimeout(600); await p.keyboard.up('F9');
  await p.waitForTimeout(500);
  assert((await p.locator('textarea[aria-label="Dictation test"]').inputValue()) === 'Hello Northwind', 'F9 push-to-talk into the test box');

  console.log('errors', errors);
  await b.close();
  if (errors.length) process.exit(1);
})().catch((e) => { console.error(e.message); process.exit(1); });
