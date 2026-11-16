// Fix 1 (Ask Timmy handles everyday asks) and fix 3 (drafts on request read like email).
const { chromium } = require('playwright');
const assert = (c, m) => { if (!c) { throw new Error('FAIL: ' + m); } console.log('ok -', m); };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => m.type() === 'error' && errors.push(m.text()));
  const fresh = async () => { await p.goto('http://localhost:5173/'); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(700); };
  const state = async () => { await p.waitForTimeout(500); return p.evaluate(() => JSON.parse(localStorage.getItem('timmy-state-v3') || '{}')); };
  const openThread = async (subject) => {
    await p.keyboard.press('Control+k'); await p.waitForTimeout(150);
    await p.keyboard.type(subject); await p.waitForTimeout(250);
    await p.keyboard.press('Enter'); await p.waitForTimeout(400);
  };
  const ask = async (q) => {
    if (!(await p.locator('.ai-shell').count())) { await p.keyboard.press('Control+i'); await p.waitForTimeout(200); }
    const nc = p.locator('.ai-shell button:has-text("New chat")');
    if (await nc.count()) { await nc.first().click(); await p.waitForTimeout(100); }
    await p.locator('.ai-input').fill(q);
    await p.keyboard.press('Enter');
    await p.waitForTimeout(300);
    await p.waitForFunction(() => !document.querySelector('.ai-send .ai-spin'), null, { timeout: 8000 });
    await p.waitForTimeout(250);
    const msgs = await p.locator('.ai-msg').allInnerTexts();
    return msgs[msgs.length - 1] || '';
  };
  const press = async (label) => { await p.locator(`.ai-shell .aw-choices button:has-text("${label}")`).last().click(); await p.waitForTimeout(250); };
  const close = async () => { if (await p.locator('.ai-shell').count()) { await p.keyboard.press('Escape'); await p.waitForTimeout(150); } };

  await fresh();

  // Who owes me / nudge the late ones
  let a = await ask('who owes me feedback?');
  assert(/4 people owe you something\. Marcus and Priya are late/.test(a), 'who owes me: names the late people');
  assert(/Waiting on others/.test(a) && /Kenji: updated onboarding mockups/.test(a), 'who owes me: Waiting widget lists each item');
  a = await ask('Who owes me something and is late? Nudge them.');
  assert(/I drafted a nudge to Priya\. Marcus already has one waiting/.test(a), 'nudge them: drafts Priya, notes Marcus is ready');
  let s = await state();
  const priya = s.threads.find(t => t.id === 'travel-budget').draft;
  assert(priya && priya.kind === 'nudge' && /^Hi Priya,/.test(priya.body) && !/On your note|priya owes/.test(priya.body), 'Priya nudge is a real email (no pasted internal note)');
  assert(/whether the travel budget for Acme onsite \(\$2,140\) is approved\?/.test(priya.body), `Priya nudge asks the right thing: ${priya.body.split('\n')[2]}`);

  // Nudge a person
  a = await ask('nudge Kenji');
  assert(/Kenji owes you the updated onboarding mockups/.test(a) && /Could you send the updated onboarding mockups by Wednesday\?/.test(a), 'nudge Kenji: drafts a clean nudge');

  // What's late, deals at risk
  a = await ask("what's late?");
  assert(/Marcus owes you the signed pilot SOW, 3 days late/.test(a) && /Priya hasn’t answered/.test(a), "what's late: lists late promises");
  a = await ask('which deals are late?');
  assert(/1 deal needs attention/.test(a) && /Northwind Health \(Contracting/.test(a), 'which deals are late: Northwind');

  // One deal
  a = await ask('brief me on the Acme deal');
  assert(/Here’s where Acme Corp stands/.test(a) && /Deal: Negotiation, \$74,400/.test(a) && /Next meeting: Acme renewal sync/.test(a), 'brief on Acme: deal, next step and next meeting');
  a = await ask('brief me on the pipeline');
  assert(/open across 3 deals/.test(a), 'pipeline brief still works');

  // Meeting prep
  a = await ask('What do I need to do before my 3pm with Priya?');
  assert(/“1:1 with Priya” is today 3:00 PM/.test(a) && /On the agenda: Travel budget approval/.test(a), 'prep: finds the 3pm 1:1 and its agenda');
  a = await ask('Prep me for the Northwind pilot planning meeting');
  assert(/“Northwind pilot planning” is today 10:30 AM/.test(a), 'prep: finds the Northwind meeting by its name');

  // Calendar for a named day
  a = await ask('calendar Thursday');
  assert(/Thursday, Nov 19/.test(a) && /Northwind kickoff planning/.test(a), 'calendar Thursday shows Thursday, not today');

  // Find time / block time with day, length and topic
  a = await ask('Block 90 minutes of focus time tomorrow for the Q1 campaign brief');
  assert(/You’re free Tue, Nov 17, 9:15 AM–10:45 AM\. Block it for “Q1 campaign brief”/.test(a), 'block: honours tomorrow, 90 minutes and the topic');
  await press('Block 9:15 AM–10:45 AM');
  s = await state();
  const ev = Object.values(s.ws.events).find(e => e.title === 'Focus: Q1 campaign brief');
  assert(ev && ev.start.startsWith('2026-11-17') && (new Date(ev.end) - new Date(ev.start)) === 90 * 60000, 'block: 90-minute event added tomorrow');
  await close();
  a = await ask('find me 30 min with Priya');
  assert(/Send Priya an invite for “Time with Priya”/.test(a), 'find time with a person proposes an invite');

  // Reschedule
  a = await ask('Move my 1:1 with Priya to tomorrow afternoon');
  assert(/Move “1:1 with Priya” from today 3:00 PM to tomorrow 12:00 PM\? Priya gets the updated invite/.test(a), 'move the 1:1: proposes tomorrow afternoon');
  await press('Move to tomorrow 12:00 PM');
  s = await state();
  assert(s.ws.events['priya-1on1'].start.startsWith('2026-11-17'), 'the 1:1 moved to tomorrow');
  await close();

  // Deal edits
  a = await ask('update the Brightwave deal value to $40,000');
  assert(/Update Brightwave: \$36,000 → \$40,000\?/.test(a), 'deal edit: proposes the change instead of a pipeline brief');
  await press('Update Brightwave');
  s = await state();
  assert(s.deals.brightwave.value === 40000 && s.approvalLog.some(r => /Update Brightwave/.test(r.title)), 'deal edit: value changed and logged');
  await close();

  // Honest about what it can't do
  a = await ask('any angry customers?');
  assert(/I don’t judge tone yet/.test(a), 'angry customers: honest');
  a = await ask("text the tech that he's late");
  assert(/couldn’t find that lead|agreed to texts/.test(a) && !/Here’s the text/.test(a), 'texting someone who isn’t an opted-in lead: honest');
  a = await ask('post on instagram about the spring tune-up');
  assert(/I can’t use Instagram yet/.test(a), 'instagram: honest');
  a = await ask('cancel my 3pm');
  assert(/I can’t cancel things from the chat yet/.test(a), 'cancel: honest');
  a = await ask('draft a reply to the customer complaining about the AC install');
  assert(/I couldn’t find an email about “the ac install”/.test(a), 'reply to an unknown email: honest');
  a = await ask('what did timmy do overnight?');
  assert(/Since the morning run, Timmy did/.test(a) && /Triaged 33 new emails/.test(a), 'overnight: activity log');
  a = await ask('draft a quick investor update');
  assert(/I started an investor update/.test(a) && /Pipeline/.test(a), 'investor update: a starting draft');

  // Fix 3: reply in your words, shorter
  await close();
  await openThread('Intro to Dana');
  a = await ask('draft a reply, tell him sure happy to do the intro this week');
  assert(/Hi Leo,\s+Sure, happy to do the intro this week\.\s+Best,\s+Taylor/.test(a), 'reply in your words: says what you asked');
  await press('Use this draft');
  s = await state();
  assert(/Sure, happy to do the intro this week\./.test(s.threads.find(t => t.id === 'leo-intro').draft.body), 'draft saved on the thread');
  await openThread('Intro to Dana');
  a = await ask("make it shorter and say yes, I'll intro him Thursday");
  assert(/Yes, I'll intro you Thursday\./.test(a) && /replaces the current draft/.test(a), 'say yes Thursday: rewrites, you not him');
  await close();
  await openThread('Revised quote for 120');
  a = await ask('make it shorter');
  assert(/Here’s a shorter version/.test(a) && /Could you confirm by Friday, Nov 20/.test(a) && /\$83,520/.test(a), 'shorter: keeps the ask and the numbers');
  await press('Use the shorter version');
  s = await state();
  assert(!/That keeps the order form on track/.test(s.threads.find(t => t.id === 'acme-quote').draft.body), 'shorter version applied');
  await close();

  // D key on a Waiting thread: a nudge, not a template
  await openThread('travel budget');
  s = await state();
  if (s.threads.find(t => t.id === 'travel-budget').draft) {
    await p.locator('.draft button:has-text("Discard")').click();
    await p.waitForTimeout(200);
  }
  await p.keyboard.press('d');
  await p.waitForTimeout(300);
  s = await state();
  const d = s.threads.find(t => t.id === 'travel-budget').draft;
  assert(d && d.kind === 'nudge' && /^Hi Priya,/.test(d.body) && /Best,\nTaylor$/.test(d.body), 'D drafts a proper nudge with your sign-off');

  // Regulars still work
  a = await ask('plan my day');
  assert(/4 things need you today/.test(a), 'plan my day');
  a = await ask('move my morning brief to 7:30');
  assert(/Move the morning run from 8:00 AM to 7:30 AM/.test(a), 'schedule change');
  a = await ask('remind me to call Marcus tomorrow at 2pm');
  assert(/Add “Call Marcus at 2pm”, due Tue, Nov 17/.test(a), 'remind me');

  assert(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await b.close();
})().catch(e => { console.error(e.message); process.exit(1); });
