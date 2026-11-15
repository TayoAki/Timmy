import type {
  Activity,
  CalEvent,
  Deal,
  Doc,
  Label,
  Person,
  Relationship,
  Rule,
  Thread,
} from './types';

/** The prototype runs on a fixed clock so dates in the mock data stay meaningful. */
export const NOW = new Date(2026, 10, 16, 8, 12);

const d = (day: number, h = 9, m = 0) => new Date(2026, 10, day, h, m);
const oct = (day: number, h = 9, m = 0) => new Date(2026, 9, day, h, m);

export const ME = 'me';

export const PEOPLE: Record<string, Person> = {
  me: { id: 'me', name: 'Taylor Morgan', email: 'taylor@northpeak.io', title: 'Account Executive', company: 'Northpeak', internal: true },
  dana: { id: 'dana', name: 'Dana Whitfield', email: 'dana.whitfield@acme.com', title: 'Head of Procurement', company: 'Acme Corp' },
  raj: { id: 'raj', name: 'Raj Patel', email: 'raj.patel@acme.com', title: 'IT Director', company: 'Acme Corp' },
  marcus: { id: 'marcus', name: 'Marcus Lee', email: 'marcus@northwindhealth.com', title: 'Operations Lead', company: 'Northwind Health' },
  leo: { id: 'leo', name: 'Leo Grant', email: 'leo@brightwave.co', title: 'Founder', company: 'Brightwave' },
  elena: { id: 'elena', name: 'Elena Rossi', email: 'elena@brightwave.co', title: 'Procurement', company: 'Brightwave' },
  priya: { id: 'priya', name: 'Priya Raman', email: 'priya@northpeak.io', title: 'VP Sales', company: 'Northpeak', internal: true },
  hannah: { id: 'hannah', name: 'Hannah Ito', email: 'hannah@northpeak.io', title: 'Legal Counsel', company: 'Northpeak', internal: true },
  sofia: { id: 'sofia', name: 'Sofia Alvarez', email: 'sofia@northpeak.io', title: 'Recruiting Partner', company: 'Northpeak', internal: true },
  ben: { id: 'ben', name: 'Ben Carter', email: 'ben@northpeak.io', title: 'Finance', company: 'Northpeak', internal: true },
  kenji: { id: 'kenji', name: 'Kenji Watanabe', email: 'kenji@northpeak.io', title: 'Product Designer', company: 'Northpeak', internal: true },
  nina: { id: 'nina', name: 'Nina Okafor', email: 'nina@northpeak.io', title: 'Operations', company: 'Northpeak', internal: true },
  pricing: { id: 'pricing', name: 'Pricing Weekly', email: 'hello@pricingweekly.com', bot: true },
  it: { id: 'it', name: 'IT Helpdesk', email: 'it@northpeak.io', bot: true, internal: true },
  figma: { id: 'figma', name: 'Figma Billing', email: 'billing@figma.com', bot: true },
  linkedin: { id: 'linkedin', name: 'LinkedIn', email: 'notifications@linkedin.com', bot: true },
};

export const BOXES: Label[] = [
  { id: 'inbox', num: '00', name: 'Inbox', hint: 'Not sorted yet', color: 'var(--c-slate)' },
  { id: 'follow-up', num: '01', name: 'Follow Up', hint: 'You owe an action', color: 'var(--c-red)' },
  { id: 'waiting', num: '02', name: 'Waiting', hint: 'Someone owes you', color: 'var(--c-amber)' },
  { id: 'read-through', num: '03', name: 'Read Through', hint: 'Reference to revisit', color: 'var(--c-sky)' },
  { id: 'archived', num: '99', name: 'Archived', hint: 'Done, still searchable', color: 'var(--c-brown)' },
];

export const PROJECTS: Label[] = [
  { id: 'acme', num: '10', name: 'Acme Renewal', hint: 'Acme Corp', color: 'var(--c-green)' },
  { id: 'northwind', num: '11', name: 'Northwind Pilot', hint: 'Northwind Health', color: 'var(--c-violet)' },
  { id: 'qbr', num: '12', name: 'Q4 QBR', hint: 'Internal', color: 'var(--c-pink)' },
  { id: 'hiring', num: '13', name: 'Hiring · Platform', hint: 'Internal', color: 'var(--c-teal)' },
];

export const LABEL_GUIDE: Record<string, { title: string; body: string; rule: string }> = {
  inbox: {
    title: 'Unsorted mail',
    body: 'Timmy sorts new mail every morning and leaves only the messages it is unsure about here. Work through them oldest first.',
    rule: 'Every email ends up in Follow Up, Waiting, Read Through or the archive.',
  },
  'follow-up': {
    title: 'You owe an action',
    body: 'If a reply takes about two minutes, send it now. If it needs real work, it stays here until it is done. Then clear the label.',
    rule: 'Quick replies are drafted for you. Longer work gets a task and a calendar block.',
  },
  waiting: {
    title: 'Someone owes you',
    body: 'Threads move here when you send a request. They stay until the promised item arrives. "I’ll send it Friday" still leaves it in Waiting.',
    rule: 'Timmy records the promised date and drafts a nudge when it slips.',
  },
  'read-through': {
    title: 'Reference to revisit',
    body: 'Reports, how-to emails and material you expect to consult again. Routine mail is archived instead.',
    rule: 'Industry reports and instructions land here automatically.',
  },
  archived: {
    title: 'Done, still searchable',
    body: 'Archived mail is never deleted. Search by the person who sent it. You usually remember who, not when.',
    rule: 'Calendar replies, receipts and notifications are archived without asking.',
  },
};

export const DOCS: Record<string, Doc> = {
  'proposal-v3': { id: 'proposal-v3', name: '2026-Q4 Acme — Renewal proposal v3', kind: 'slides', path: ['My Drive', '[02] Work', '[10] Acme'], updated: d(12, 13, 50), owner: 'me' },
  'proposal-v4': { id: 'proposal-v4', name: '2026-Q4 Acme — Renewal proposal v4 (draft)', kind: 'slides', path: ['My Drive', '[02] Work', '[10] Acme'], updated: d(16, 8, 3), owner: 'me', createdByTimmy: true },
  'pricing-tiers': { id: 'pricing-tiers', name: 'Pricing tiers 2026 — Working sheet', kind: 'sheet', path: ['My Drive', '[03] Reference Documents'], updated: d(2, 9, 0), owner: 'priya' },
  'acme-call-notes': { id: 'acme-call-notes', name: '2026-11-13 Acme — Call notes', kind: 'doc', path: ['My Drive', '[02] Work', '[10] Acme'], updated: d(13, 11, 40), owner: 'me' },
  'acme-stakeholders': { id: 'acme-stakeholders', name: '2026-11-06 Acme — Stakeholder map', kind: 'pdf', path: ['My Drive', '[02] Work', '[10] Acme'], updated: d(6, 10, 22), owner: 'me', createdByTimmy: true },
  'acme-msa': { id: 'acme-msa', name: '2026-11-12 Acme — MSA redlines', kind: 'pdf', path: ['My Drive', '[02] Work', '[10] Acme'], updated: d(12, 16, 28), owner: 'me', createdByTimmy: true },
  'northwind-sow': { id: 'northwind-sow', name: 'Northwind — Pilot SOW (final)', kind: 'doc', path: ['My Drive', '[02] Work', '[11] Northwind'], updated: d(9, 10, 2), owner: 'me' },
  'qbr-deck': { id: 'qbr-deck', name: '2026-Q4 QBR — Briefing slides', kind: 'slides', path: ['My Drive', '[02] Work', '[12] Q4 QBR'], updated: d(14, 11, 12), owner: 'priya' },
  'jordan-notes': { id: 'jordan-notes', name: '2026-11-13 Jordan Kim — Interview notes', kind: 'doc', path: ['My Drive', '[02] Work', '[13] Hiring'], updated: d(13, 15, 30), owner: 'me' },
  'priya-1on1': { id: 'priya-1on1', name: 'Taylor / Priya — 1:1 notes', kind: 'doc', path: ['My Drive', '[02] Work', '[01] Management'], updated: d(16, 8, 4), owner: 'priya' },
  'harbor-receipt': { id: 'harbor-receipt', name: '2026-10-21 Harbor Grill — Receipt', kind: 'pdf', path: ['My Drive', '[02] Work', '[99] Receipts'], updated: oct(21, 21, 40), owner: 'me', createdByTimmy: true },
  'figma-receipt': { id: 'figma-receipt', name: '2026-11-15 Figma — Receipt', kind: 'pdf', path: ['My Drive', '[02] Work', '[99] Receipts'], updated: d(16, 8, 2), owner: 'me', createdByTimmy: true },
  'offsite-agenda': { id: 'offsite-agenda', name: '2027-Q1 Planning offsite — Agenda', kind: 'doc', path: ['My Drive', '[02] Work', '[01] Management'], updated: d(16, 6, 45), owner: 'nina' },
};

export const DEALS: Record<string, Deal> = {
  acme: {
    id: 'acme', company: 'Acme Corp', name: 'Renewal 2027', stage: 'Negotiation', value: 74400, contact: 'dana',
    lastTouch: 'Nov 15 · Dana asked for 120 seats', next: 'Send revised quote', owner: 'me', due: d(17, 17),
    suggestion: 'After you send the quote, update the value to $83,520 and the stage to Proposal sent.',
  },
  northwind: {
    id: 'northwind', company: 'Northwind Health', name: 'Pilot', stage: 'Contracting', value: 18000, contact: 'marcus',
    lastTouch: 'Nov 15 · Marcus asked about Dec 1', next: 'Signed SOW', owner: 'marcus', due: d(13, 17),
  },
  brightwave: {
    id: 'brightwave', company: 'Brightwave', name: 'New business', stage: 'Contract sent', value: 36000, contact: 'elena',
    lastTouch: 'Nov 15 · Countersigned order form', next: 'Schedule kickoff', owner: 'me', due: d(20, 17),
    suggestion: 'The countersigned order form arrived. Move to Closed won?',
  },
};

export const RELATIONSHIPS: Relationship[] = [
  { person: 'dana', priority: true, cadence: 'Weekly', last: 'Nov 15 · Asked for a 120-seat quote', next: 'Send revised quote', owner: 'me', due: d(17, 17), deal: 'acme', threadId: 'acme-quote' },
  { person: 'marcus', priority: true, cadence: 'Weekly', last: 'Nov 15 · Asked about the Dec 1 start', next: 'Send the signed SOW', owner: 'marcus', due: d(13, 17), deal: 'northwind', threadId: 'northwind-sow' },
  { person: 'elena', cadence: 'Monthly', last: 'Nov 15 · Countersigned the order form', next: 'Schedule kickoff', owner: 'me', due: d(20, 17), deal: 'brightwave', threadId: 'brightwave-signed' },
  { person: 'leo', cadence: 'Monthly', last: 'Nov 15 · Asked for an intro to Dana', next: 'Reply about the intro', owner: 'me', due: d(17, 17), threadId: 'leo-intro' },
  { person: 'raj', cadence: 'Monthly', last: 'Nov 16 · Asked about SSO', next: 'Answered in your reply to Dana', owner: 'me', deal: 'acme', threadId: 'raj-sso' },
  { person: 'priya', cadence: 'Weekly 1:1', last: 'Nov 14 · Asked you to own QBR slides', next: 'Approve travel budget', owner: 'priya', threadId: 'travel-budget' },
  { person: 'hannah', cadence: 'As needed', last: 'Nov 12 · Promised MSA comments', next: 'MSA redline comments', owner: 'hannah', due: d(19, 17), threadId: 'msa-redlines' },
];

export const EVENTS: CalEvent[] = [
  { id: 'standup', title: 'Team standup', start: d(16, 9, 0), end: d(16, 9, 15), with: ['priya', 'kenji'] },
  {
    id: 'northwind-sync', title: 'Northwind pilot planning', start: d(16, 10, 30), end: d(16, 11, 0), with: ['marcus'],
    note: 'The signed SOW is 3 days late. Ask Marcus about it in person.', docs: ['northwind-sow'], threadId: 'northwind-sow',
  },
  {
    id: 'focus-acme', title: 'Focus: Revised Acme quote', start: d(16, 13, 0), end: d(16, 14, 30), with: [], focus: true,
    note: 'Blocked by Timmy for the quote due Tuesday.', docs: ['proposal-v4', 'pricing-tiers'], threadId: 'acme-quote',
  },
  {
    id: 'priya-1on1', title: '1:1 with Priya', start: d(16, 15, 0), end: d(16, 15, 30), with: ['priya'],
    note: 'Timmy added to the agenda: travel budget approval (no reply in 6 days).', docs: ['priya-1on1'], threadId: 'travel-budget',
  },
  {
    id: 'debrief', title: 'Interview debrief: Jordan Kim', start: d(16, 16, 30), end: d(16, 17, 0), with: ['sofia'],
    note: 'Your scorecard is due before this.', docs: ['jordan-notes'], threadId: 'interview-feedback',
  },
];

export const ARCHIVED_BASE = 2418;

export const THREADS: Thread[] = [
  // ───────────── [01] Follow Up — you owe ─────────────
  {
    id: 'acme-quote',
    subject: 'Revised quote for 120 seats?',
    box: 'follow-up',
    project: 'acme',
    participants: ['dana', 'raj', 'me'],
    unread: true,
    starred: true,
    ask: 'Send Dana a revised quote for 120 seats by Tue, Nov 17',
    context: 'Dana takes the quote to her CFO on Wednesday. She asked about volume pricing, and Raj wants to know whether SSO is a separate add-on.',
    due: d(17, 17),
    effort: 'focus',
    deal: 'acme',
    docs: ['proposal-v4', 'proposal-v3', 'pricing-tiers', 'acme-call-notes'],
    messages: [
      {
        id: 'aq1', from: 'me', to: ['dana'], cc: ['raj'], at: d(12, 14, 5),
        body: ['Hi Dana,', 'Thanks for the time on Thursday. Attached is the renewal proposal (v3) for 100 seats on the annual plan, as discussed.', 'Happy to walk your CFO through it if that helps.', 'Best,\nTaylor'],
        attachments: ['proposal-v3'],
      },
      {
        id: 'aq2', from: 'dana', to: ['me'], cc: ['raj'], at: d(15, 18, 48),
        body: ['Hi Taylor,', 'Thanks for this. After Friday’s planning session we’re expanding to 120 seats starting in January.', 'Could you send a revised quote by Tuesday? I’m taking it to our CFO on Wednesday. If there’s any flexibility on the per-seat price at that volume, that would help.', 'Raj is cc’d — he had a question about whether SSO is a separate add-on.', 'Thanks,\nDana'],
      },
    ],
    draft: {
      kind: 'reply',
      to: ['dana'],
      cc: ['raj'],
      subject: 'Approval by Fri: revised quote for 120 seats',
      body:
        'Hi Dana,\n\nCould you confirm by Friday, Nov 20 whether your CFO approves the revised quote below? That keeps the order form on track for a January 1 start.\n\n• 120 seats at $58 per seat per month (our 101–250 tier), billed annually: $83,520\n• That’s $4 less per seat than the 100-seat price in proposal v3\n• Raj: SSO is included at this tier, so there’s no separate add-on\n\nThe updated proposal is attached.\n\nBest,\nTaylor',
      sources: ['proposal-v3', 'pricing-tiers', 'acme-call-notes'],
      attachments: ['proposal-v4'],
      trackAs: { on: 'dana', item: 'CFO approval on the 120-seat quote', due: d(20, 17) },
    },
    steps: [
      { id: 's1', text: 'Create task: revise quote to 120 seats', done: true, byTimmy: true },
      { id: 's2', text: 'Update the quote tracker; the summary doc refreshes from it', done: false, href: 'file:acme-quote' },
      { id: 's3', text: 'Check proposal v4: Timmy updated seats and tier price', done: false, href: 'file:proposal-v4' },
      { id: 's4', text: 'Send reply and track CFO approval in Waiting', done: false },
      { id: 's5', text: 'Update deal value to $83,520', done: false },
    ],
    history: [
      { at: d(16, 8, 3), text: 'Sorted to [01] Follow Up: Dana asked you for a revised quote' },
      { at: d(16, 8, 3), text: 'Created task “Revise quote to 120 seats”, due Tue' },
      { at: d(16, 8, 3), text: 'Copied proposal v3 to v4 and updated seats and tier price' },
      { at: d(16, 8, 4), text: 'Drafted a reply from Pricing tiers 2026 and the Nov 13 call notes' },
      { at: d(16, 8, 4), text: 'Blocked 1:00–2:30 PM today for focus time' },
    ],
  },
  {
    id: 'northwind-date',
    subject: 'Quick one: still good for a Dec 1 pilot start?',
    box: 'follow-up',
    project: 'northwind',
    participants: ['marcus', 'me'],
    unread: true,
    ask: 'Confirm the Dec 1 pilot start with Marcus. He needs it today',
    context: 'About a 2-minute reply. The signed SOW he promised for Friday hasn’t arrived, so the draft asks for it.',
    due: d(16, 17),
    effort: 'quick',
    deal: 'northwind',
    docs: ['northwind-sow'],
    messages: [
      {
        id: 'nd1', from: 'marcus', to: ['me'], at: d(15, 21, 20),
        body: ['Hi Taylor,', 'Quick one — are we still good for a December 1 pilot start? I need to tell my team today.', 'Marcus'],
      },
    ],
    draft: {
      kind: 'reply',
      to: ['marcus'],
      subject: 'Re: Quick one: still good for a Dec 1 pilot start?',
      body: 'Hi Marcus,\n\nYes, December 1 still works on our side. The signed SOW is the last thing we need to lock it in. Could you send it by Wednesday?\n\nKickoff invite to follow.\n\nTaylor',
      sources: ['northwind-sow'],
    },
    steps: [
      { id: 's1', text: 'Send the reply', done: false },
      { id: 's2', text: 'Send a kickoff invite for Dec 1', done: false },
    ],
    history: [{ at: d(16, 8, 3), text: 'Sorted to [01] Follow Up and marked Quick (about 2 min)' }],
  },
  {
    id: 'interview-feedback',
    subject: 'Feedback for Jordan Kim by end of day?',
    box: 'follow-up',
    project: 'hiring',
    participants: ['sofia', 'me'],
    unread: true,
    ask: 'Add your Jordan Kim scorecard before the 4:30 PM debrief',
    context: 'Your Friday interview notes are in [02] Work › [13] Hiring. Timmy summarized them in the scorecard format.',
    due: d(16, 16, 30),
    effort: 'quick',
    docs: ['jordan-notes'],
    messages: [
      {
        id: 'if1', from: 'sofia', to: ['me'], at: d(16, 7, 41),
        body: ['Hi Taylor!', 'Could you add your feedback for Jordan Kim (Platform Engineer, onsite Friday) to the scorecard by end of day? The debrief is at 4:30.', 'Thank you!\nSofia'],
      },
    ],
    draft: {
      kind: 'reply',
      to: ['sofia'],
      subject: 'Re: Feedback for Jordan Kim by end of day?',
      body: 'Hi Sofia,\n\nMy scorecard is in. Short version: strong hire on systems design and solid on debugging. I’d like a second read on collaboration from the team lunch.\n\nTaylor',
      sources: ['jordan-notes'],
    },
    steps: [
      { id: 's1', text: 'Paste Timmy’s summary into the scorecard', done: false },
      { id: 's2', text: 'Send reply', done: false },
    ],
    history: [{ at: d(16, 8, 6), text: 'Sorted to [01] Follow Up, due before the 4:30 PM debrief' }],
  },
  {
    id: 'expense-receipt',
    subject: 'October expense report: missing receipt',
    box: 'follow-up',
    participants: ['ben', 'me'],
    ask: 'Send Ben the Oct 21 dinner receipt ($186.40) by Wed, Nov 18',
    context: 'Timmy found the receipt in a Harbor Grill email from Oct 21 and attached it to the draft.',
    due: d(18, 17),
    effort: 'quick',
    docs: ['harbor-receipt'],
    messages: [
      {
        id: 'er1', from: 'ben', to: ['me'], at: d(13, 15, 2),
        body: ['Hi Taylor,', 'Your October expense report is missing the receipt for the Oct 21 client dinner ($186.40). Could you attach it by Wednesday so we can close the month?', 'Thanks,\nBen'],
      },
    ],
    draft: {
      kind: 'reply',
      to: ['ben'],
      subject: 'Re: October expense report: missing receipt',
      body: 'Hi Ben,\n\nThe receipt for the Oct 21 client dinner ($186.40) is attached.\n\nThanks,\nTaylor',
      sources: ['harbor-receipt'],
      attachments: ['harbor-receipt'],
    },
    history: [{ at: d(16, 8, 5), text: 'Found the Oct 21 receipt and attached it to a draft' }],
  },
  {
    id: 'qbr-slides',
    subject: 'Q4 QBR deck: can you own slides 6–9?',
    box: 'follow-up',
    project: 'qbr',
    participants: ['priya', 'me'],
    ask: 'Fill in QBR slides 6–9 (pipeline and renewals) by Fri, Nov 20',
    context: 'The dry run is Monday, Nov 23. Acme and Northwind are the two open numbers.',
    due: d(20, 17),
    effort: 'focus',
    docs: ['qbr-deck', 'pricing-tiers'],
    messages: [
      {
        id: 'qb1', from: 'priya', to: ['me'], at: d(14, 11, 20),
        body: ['Hey Taylor,', 'I’ve put the skeleton in the 2026-Q4 QBR briefing slides. Can you own slides 6–9 (pipeline and renewals)?', 'I need them by Friday so we can do a dry run Monday morning.', 'Thanks!\nPriya'],
      },
    ],
    draft: {
      kind: 'reply',
      to: ['priya'],
      subject: 'Re: Q4 QBR deck: can you own slides 6–9?',
      body: 'Hi Priya,\n\nYes. Slides 6–9 will be in the deck by Thursday end of day, so you have a day to review before the dry run.\n\nTaylor',
      sources: ['qbr-deck'],
    },
    steps: [
      { id: 's1', text: 'Reply to confirm you own slides 6–9', done: false },
      { id: 's2', text: 'Block 2 hours on Thursday', done: false },
      { id: 's3', text: 'Pull renewal numbers from the pricing sheet', done: false },
    ],
    history: [{ at: d(14, 11, 25), text: 'Sorted to [01] Follow Up as needing focus time' }],
  },

  // ───────────── [02] Waiting — someone owes you ─────────────
  {
    id: 'northwind-sow',
    subject: 'Northwind pilot SOW for signature',
    box: 'waiting',
    project: 'northwind',
    participants: ['marcus', 'me'],
    starred: true,
    ask: 'Marcus owes you the signed SOW, promised for Fri, Nov 13',
    context: 'A promise isn’t the item, so this stays in Waiting until the signed SOW arrives. It’s 3 days late, and you’re meeting Marcus at 10:30 today.',
    deal: 'northwind',
    docs: ['northwind-sow'],
    waiting: { on: 'marcus', item: 'Signed pilot SOW', due: d(13, 17), since: d(10, 13, 40) },
    messages: [
      {
        id: 'ns1', from: 'me', to: ['marcus'], at: d(9, 10, 15),
        body: ['Hi Marcus,', 'Here’s the final pilot SOW for signature. Once it’s back we can lock the December 1 start.', 'Taylor'],
        attachments: ['northwind-sow'],
      },
      { id: 'ns2', from: 'marcus', to: ['me'], at: d(10, 13, 40), body: ['Thanks Taylor — I’ll send the signed contract Friday.', 'Marcus'] },
    ],
    draft: {
      kind: 'nudge',
      to: ['marcus'],
      subject: 'Signed SOW by Wed? Keeps the Dec 1 start',
      body: 'Hi Marcus,\n\nCould you send the signed SOW by Wednesday? It’s the last thing we need to keep the December 1 pilot start.\n\nHappy to resend the file if that’s easier.\n\nTaylor',
      sources: ['northwind-sow'],
      trackAs: { on: 'marcus', item: 'Signed pilot SOW', due: d(18, 17) },
    },
    history: [
      { at: d(10, 13, 41), text: 'Moved to [02] Waiting: Marcus promised the signed SOW Friday' },
      { at: d(16, 8, 5), text: 'Drafted a nudge, 3 days past the promised date' },
    ],
  },
  {
    id: 'msa-redlines',
    subject: 'Acme MSA redlines — can you review?',
    box: 'waiting',
    project: 'acme',
    participants: ['hannah', 'me'],
    ask: 'Hannah owes you MSA redline comments by Thu, Nov 19',
    deal: 'acme',
    docs: ['acme-msa'],
    waiting: { on: 'hannah', item: 'MSA redline comments', due: d(19, 17), since: d(12, 17, 5) },
    messages: [
      {
        id: 'ms1', from: 'me', to: ['hannah'], at: d(12, 16, 30),
        body: ['Hi Hannah,', 'Acme sent back redlines on the MSA (attached). Could you review the liability and data-processing changes?', 'Thanks,\nTaylor'],
        attachments: ['acme-msa'],
      },
      { id: 'ms2', from: 'hannah', to: ['me'], at: d(12, 17, 5), body: ['On it — I’ll have comments back to you by Thursday.', 'Hannah'] },
    ],
    history: [{ at: d(12, 17, 6), text: 'Moved to [02] Waiting: Hannah promised comments Thursday' }],
  },
  {
    id: 'mockups',
    subject: 'Updated onboarding mockups',
    box: 'waiting',
    participants: ['kenji', 'me'],
    ask: 'Kenji owes you the updated onboarding mockups by Wed, Nov 18',
    waiting: { on: 'kenji', item: 'Updated onboarding mockups', due: d(18, 17), since: d(11, 10, 2) },
    messages: [
      { id: 'mk1', from: 'me', to: ['kenji'], at: d(11, 9, 30), body: ['Hi Kenji — could you share the updated onboarding mockups once the review notes are in?', 'Taylor'] },
      { id: 'mk2', from: 'kenji', to: ['me'], at: d(11, 10, 2), body: ['Yep, Wednesday at the latest.', 'Kenji'] },
    ],
    history: [{ at: d(11, 10, 3), text: 'Moved to [02] Waiting: Kenji promised Wednesday' }],
  },
  {
    id: 'travel-budget',
    subject: 'Approval needed: travel budget for Acme onsite ($2,140)',
    box: 'waiting',
    project: 'acme',
    participants: ['priya', 'me'],
    ask: 'Priya owes you a travel budget approval. No reply in 6 days',
    context: 'No date was promised. Timmy added it to the agenda for your 3:00 PM 1:1 with Priya.',
    docs: ['priya-1on1'],
    waiting: { on: 'priya', item: 'Travel budget approval', since: d(10, 9, 5) },
    messages: [
      {
        id: 'tb1', from: 'me', to: ['priya'], at: d(10, 9, 5),
        body: ['Hi Priya,', 'Could you approve the travel budget for the Acme onsite on Dec 3 ($2,140: flights and one night)? I’d like to book this week while fares hold.', 'Thanks,\nTaylor'],
      },
    ],
    history: [
      { at: d(10, 9, 6), text: 'Moved to [02] Waiting after you asked Priya for approval' },
      { at: d(16, 8, 4), text: 'Added “Travel budget approval” to your 1:1 notes with Priya' },
    ],
  },

  // ───────────── [03] Read Through — reference ─────────────
  {
    id: 'pricing-report',
    subject: 'State of B2B SaaS Pricing 2026',
    box: 'read-through',
    participants: ['pricing', 'me'],
    kind: 'report',
    ask: 'Industry report: seat-based vs. usage pricing benchmarks',
    messages: [
      {
        id: 'pr1', from: 'pricing', to: ['me'], at: d(14, 6, 0),
        body: ['This year’s report covers 400 B2B SaaS companies.', 'Headline: 61% now combine a seat price with a usage component, up from 44% last year. Median discount at 100+ seats is 7%.', 'Read the full report →'],
      },
    ],
  },
  {
    id: 'ramp-howto',
    subject: 'How to submit expenses in Ramp',
    box: 'read-through',
    participants: ['it', 'me'],
    kind: 'howto',
    ask: 'Step-by-step guide for the new expense tool',
    messages: [
      {
        id: 'rh1', from: 'it', to: ['me'], at: d(9, 11, 0),
        body: ['Starting November, all expenses go through Ramp.', '1. Forward receipts to receipts@ramp.com\n2. Match them to card transactions in the app\n3. Submit your report by the 5th of each month'],
      },
    ],
  },
  {
    id: 'acme-stakeholders',
    subject: 'Acme stakeholder map',
    box: 'read-through',
    project: 'acme',
    participants: ['dana', 'me'],
    kind: 'reference',
    ask: 'Who signs off at Acme: CFO, IT and Procurement',
    docs: ['acme-stakeholders'],
    messages: [
      {
        id: 'as1', from: 'dana', to: ['me'], at: d(6, 10, 20),
        body: ['Hi Taylor, as promised, here’s who’s involved on our side for the renewal.', 'Dana'],
        attachments: ['acme-stakeholders'],
      },
    ],
  },

  // ───────────── [00] Inbox — waiting for your call ─────────────
  {
    id: 'calendar-accept',
    subject: 'Accepted: Weekly 1:1 — Taylor / Priya',
    box: 'inbox',
    participants: ['priya', 'me'],
    ask: 'Priya accepted the recurring 1:1',
    messages: [{ id: 'ca1', from: 'priya', to: ['me'], at: d(15, 17, 2), body: ['Priya Raman has accepted this invitation.'] }],
    suggestion: { box: 'archived', confidence: 'high', reason: 'Calendar reply. Matches your rule: archive calendar acceptances.' },
  },
  {
    id: 'figma-receipt',
    subject: 'Your Figma receipt — November',
    box: 'inbox',
    participants: ['figma', 'me'],
    ask: 'Receipt for $45.00',
    docs: ['figma-receipt'],
    messages: [{ id: 'fr1', from: 'figma', to: ['me'], at: d(15, 19, 30), body: ['Thanks for your payment of $45.00.'], attachments: ['figma-receipt'] }],
    suggestion: { box: 'archived', confidence: 'high', reason: 'Receipt. Saved as “2026-11-15 Figma — Receipt” in [02] Work › [99] Receipts.' },
  },
  {
    id: 'brightwave-signed',
    subject: 'Countersigned: Brightwave order form',
    box: 'inbox',
    participants: ['elena', 'me'],
    ask: 'Elena sent the countersigned order form',
    deal: 'brightwave',
    messages: [{ id: 'bw1', from: 'elena', to: ['me'], at: d(15, 20, 14), body: ['Hi Taylor,', 'Countersigned order form attached. Looking forward to getting started!', 'Elena'] }],
    suggestion: {
      box: 'archived', confidence: 'high',
      reason: 'This is the item you were waiting on.',
      extra: 'Link to the Brightwave deal and move it to Closed won ($36,000)',
    },
  },
  {
    id: 'leo-intro',
    subject: 'Intro to Dana at Acme?',
    box: 'inbox',
    participants: ['leo', 'me'],
    ask: 'Leo is asking for an intro to Dana Whitfield',
    messages: [{ id: 'li1', from: 'leo', to: ['me'], at: d(15, 22, 40), body: ['Hey Taylor — would you be up for introducing me to Dana at Acme? We’re working on procurement tooling and I’d love her take.', 'Leo'] }],
    suggestion: { box: 'follow-up', confidence: 'medium', effort: 'quick', reason: 'Leo is asking you for something. A reply takes about 2 minutes.' },
  },
  {
    id: 'raj-sso',
    subject: 'Re: SSO add-on — separate contract?',
    box: 'inbox',
    project: 'acme',
    participants: ['raj', 'me'],
    ask: 'Raj asks whether SSO needs a separate contract',
    messages: [{ id: 'rs1', from: 'raj', to: ['me'], at: d(16, 6, 10), body: ['Taylor, following up on Dana’s note: would SSO be a separate contract, or part of the renewal?', 'Raj'] }],
    suggestion: {
      box: 'follow-up', confidence: 'low',
      reason: 'Your drafted reply to Dana already answers this. Archive it, or keep it in Follow Up to reply to Raj directly.',
    },
  },
  {
    id: 'offsite',
    subject: 'Q1 planning offsite: logistics',
    box: 'inbox',
    participants: ['nina', 'me'],
    ask: 'Venue, travel and agenda for the January offsite',
    docs: ['offsite-agenda'],
    messages: [{ id: 'of1', from: 'nina', to: ['me'], at: d(16, 6, 45), body: ['Hi all, logistics for the Jan 12–13 planning offsite are below and in the agenda doc.'] }],
    suggestion: { box: 'read-through', confidence: 'medium', reason: 'Reference you’ll need in January.' },
  },
  {
    id: 'linkedin',
    subject: '3 people viewed your profile',
    box: 'inbox',
    participants: ['linkedin', 'me'],
    ask: 'Notification',
    messages: [{ id: 'ln1', from: 'linkedin', to: ['me'], at: d(16, 7, 0), body: ['See who’s viewed your profile this week.'] }],
    suggestion: { box: 'archived', confidence: 'high', reason: 'Notification. Nothing to do.' },
  },

  // ───────────── [99] Archived ─────────────
  {
    id: 'acme-recap',
    subject: 'Recap: Acme renewal call, Nov 13',
    box: 'archived',
    project: 'acme',
    participants: ['me', 'dana', 'raj'],
    ask: 'Decisions: annual plan, January start. Open: seat count, SSO',
    docs: ['acme-call-notes'],
    messages: [
      {
        id: 'ar1', from: 'me', to: ['dana'], cc: ['raj'], at: d(13, 12, 10),
        body: ['Decided: annual plan, January 1 start.', 'Open: final seat count (Dana, by Friday) and SSO packaging (Taylor).', 'Notes are in the call notes doc.'],
        attachments: ['acme-call-notes'],
      },
    ],
  },
];

export const ACTIVITY: Activity[] = [
  { id: 'a1', at: d(16, 8, 2), kind: 'triage', text: 'Triaged 33 new emails: archived 24, filed 2 to Follow Up, left 7 for you' },
  { id: 'a2', at: d(16, 8, 2), kind: 'file', text: 'Saved the Figma receipt as “2026-11-15 Figma — Receipt” in [02] Work › [99] Receipts', threadId: 'figma-receipt' },
  { id: 'a3', at: d(16, 8, 3), kind: 'task', text: 'Created task “Revise quote to 120 seats”, due Tue', threadId: 'acme-quote' },
  { id: 'a4', at: d(16, 8, 3), kind: 'file', text: 'Copied proposal v3 to v4 and updated seats and tier price', threadId: 'acme-quote' },
  { id: 'a5', at: d(16, 8, 4), kind: 'draft', text: 'Drafted a reply to Dana Whitfield from Pricing tiers 2026 and the Nov 13 call notes', threadId: 'acme-quote' },
  { id: 'a6', at: d(16, 8, 4), kind: 'calendar', text: 'Blocked 1:00–2:30 PM for “Focus: Revised Acme quote”', threadId: 'acme-quote' },
  { id: 'a7', at: d(16, 8, 4), kind: 'calendar', text: 'Added “Travel budget approval” to your 1:1 notes with Priya', threadId: 'travel-budget' },
  { id: 'a8', at: d(16, 8, 5), kind: 'draft', text: 'Drafted a nudge to Marcus Lee: the signed SOW is 3 days late', threadId: 'northwind-sow' },
  { id: 'a9', at: d(16, 8, 5), kind: 'file', text: 'Found the Oct 21 Harbor Grill receipt and attached it to a reply to Ben', threadId: 'expense-receipt' },
  { id: 'a10', at: d(16, 8, 6), kind: 'triage', text: 'Sorted “Feedback for Jordan Kim” to [01] Follow Up, due before 4:30 PM', threadId: 'interview-feedback' },
  { id: 'a11', at: d(14, 11, 25), kind: 'triage', text: 'Sorted “Q4 QBR deck” to [01] Follow Up as needing focus time', threadId: 'qbr-slides' },
  { id: 'a12', at: d(12, 17, 6), kind: 'move', text: 'Moved “Acme MSA redlines” to [02] Waiting: Hannah promised Thursday', threadId: 'msa-redlines' },
  { id: 'a13', at: d(12, 16, 28), kind: 'file', text: 'Saved Acme’s redlines as “2026-11-12 Acme — MSA redlines” in [02] Work › [10] Acme', threadId: 'msa-redlines' },
  { id: 'a14', at: d(10, 13, 41), kind: 'move', text: 'Moved “Northwind pilot SOW” to [02] Waiting: Marcus promised Friday', threadId: 'northwind-sow' },
];

export const RULES: Rule[] = [
  { id: 'r1', group: 'triage', text: 'If a reply takes about two minutes, draft it and mark it Quick.', enabled: true, hits: 42 },
  { id: 'r2', group: 'triage', text: 'When I send a request, move the thread to Waiting and record the date they promise.', enabled: true, hits: 18 },
  { id: 'r3', group: 'triage', text: 'Keep a thread in Waiting until the item arrives. A promise to send it is not the item.', enabled: true, hits: 6 },
  { id: 'r4', group: 'triage', text: 'Archive calendar acceptances, receipts and social notifications without asking.', enabled: true, hits: 311 },
  { id: 'r5', group: 'triage', text: 'Industry reports and how-to emails go to Read Through.', enabled: true, hits: 27 },
  { id: 'r6', group: 'triage', text: 'Show me the oldest unsorted mail first.', enabled: true, hits: 0 },
  { id: 'u1', group: 'urgency', text: 'Anything due today or already late is urgent.', enabled: true, hits: 31 },
  { id: 'u2', group: 'urgency', text: 'A promise that’s past its date, or a request with no reply in 5 days, needs a nudge.', enabled: true, hits: 12 },
  { id: 'u3', group: 'urgency', text: 'Words like “urgent”, “today”, “ASAP” or “end of day” raise urgency.', enabled: true, hits: 19 },
  { id: 'u4', group: 'urgency', text: 'Mail from my priority contacts ranks higher.', enabled: true, hits: 23 },
  { id: 'u5', group: 'urgency', text: 'Mail about an open deal ranks higher, more so above $50,000.', enabled: true, hits: 17 },
  { id: 'u6', group: 'urgency', text: 'If I’m meeting the sender today, their mail ranks higher.', enabled: true, hits: 8 },
  { id: 'u7', group: 'urgency', text: 'Newsletters, receipts and notifications are never urgent.', enabled: true, hits: 204 },
  { id: 'p1', group: 'approvals', text: 'Never send an email for me without my approval.', enabled: true, hits: 96, locked: true },
  { id: 'p2', group: 'approvals', text: 'Ask before changing a deal’s stage or value in the CRM.', enabled: true, hits: 11 },
  { id: 'p3', group: 'approvals', text: 'Ask before sending or accepting calendar invites for me.', enabled: true, hits: 7 },
  { id: 'p4', group: 'approvals', text: 'Bring any discount, price change or hiring call to me as a decision, with the numbers.', enabled: true, hits: 5 },
  { id: 'p5', group: 'approvals', text: 'File receipts and archive calendar replies and newsletters without asking.', enabled: true, hits: 311 },
  { id: 'w1', group: 'writing', text: 'Put the action in the subject line and the first sentence.', enabled: true, hits: 64 },
  { id: 'w2', group: 'writing', text: 'In long threads, lead with what was decided and what still needs action. Put background at the bottom.', enabled: true, hits: 9 },
  { id: 'w3', group: 'writing', text: 'Sign off with “Best, Taylor”. No exclamation marks in customer emails.', enabled: true, hits: 58 },
  { id: 'w4', group: 'writing', text: 'For customer replies, read the current proposal, the pricing sheet and the latest call notes first.', enabled: true, hits: 21 },
  { id: 'f1', group: 'files', text: 'Name saved attachments “YYYY-MM-DD Project — Subject”. Use YYYY-Qn for quarterly files.', enabled: true, hits: 88 },
  { id: 'f2', group: 'files', text: 'Save files where they will be used, not where they came from: [02] Work › the project folder.', enabled: true, hits: 73 },
  { id: 'f3', group: 'files', text: 'Receipts go to [02] Work › [99] Receipts.', enabled: true, hits: 40 },
  { id: 'f4', group: 'files', text: 'When a file is shared with me, add a shortcut instead of making a copy.', enabled: false, hits: 0 },
  { id: 's1', group: 'schedule', text: 'Run the morning brief on weekdays at 8:00 AM.', enabled: true, hits: 52 },
  { id: 's2', group: 'schedule', text: 'Block focus time for any Follow Up that needs more than 30 minutes.', enabled: true, hits: 14 },
  { id: 's3', group: 'schedule', text: 'Add stalled Waiting items to my next 1:1 with the person who owes them.', enabled: true, hits: 3 },
  { id: 's4', group: 'schedule', text: 'Never star more than 5 threads. If everything is starred, nothing is.', enabled: true, hits: 2 },
];

export const FOLDERS = [
  { num: '01', name: 'Personal', color: 'var(--c-green)' },
  {
    num: '02', name: 'Work', color: 'var(--c-sky)', open: true,
    children: [
      { num: '01', name: 'Management', color: 'var(--c-slate)' },
      { num: '10', name: 'Acme', color: 'var(--c-green)' },
      { num: '11', name: 'Northwind', color: 'var(--c-violet)' },
      { num: '12', name: 'Q4 QBR', color: 'var(--c-pink)' },
      { num: '13', name: 'Hiring', color: 'var(--c-teal)' },
      { num: '99', name: 'Receipts', color: 'var(--c-brown)' },
    ],
  },
  { num: '03', name: 'Reference Documents', color: 'var(--c-sky)' },
  { num: '04', name: 'Quick Share', color: 'var(--c-violet)' },
  { num: '05', name: 'Backups', color: 'var(--c-indigo)' },
  { num: '06', name: 'Temporary (to delete)', color: 'var(--c-amber)' },
  { num: '99', name: 'Archived', color: 'var(--c-brown)' },
];
