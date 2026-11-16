import { PEOPLE } from './mock';
import type {
  Contact,
  Deck,
  DocBody,
  Folder,
  Interaction,
  LearnedRule,
  Project,
  Prompt,
  QuickNote,
  Routine,
  Sheet,
  Task,
  WEvent,
  WFile,
  WS,
} from './ws-types';

const d = (day: number, h = 9, m = 0) => new Date(2026, 10, day, h, m);
const oct = (day: number, h = 9, m = 0) => new Date(2026, 9, day, h, m);

const byId = <T extends { id: string }>(items: T[]) => Object.fromEntries(items.map((i) => [i.id, i])) as Record<string, T>;

/* ───────────── Drive ───────────── */

const folders: Folder[] = [
  { id: 'f01', num: '01', name: 'Personal', parent: null, color: 'var(--c-green)' },
  { id: 'f02', num: '02', name: 'Work', parent: null, color: 'var(--c-sky)' },
  { id: 'f02-01', num: '01', name: 'Management', parent: 'f02', color: 'var(--c-slate)' },
  { id: 'f02-10', num: '10', name: 'Acme', parent: 'f02', color: 'var(--c-green)' },
  { id: 'f02-11', num: '11', name: 'Northwind', parent: 'f02', color: 'var(--c-violet)' },
  { id: 'f02-12', num: '12', name: 'Q4 QBR', parent: 'f02', color: 'var(--c-pink)' },
  { id: 'f02-13', num: '13', name: 'Hiring', parent: 'f02', color: 'var(--c-teal)' },
  { id: 'f02-14', num: '14', name: 'Brightwave', parent: 'f02', color: 'var(--c-amber)' },
  { id: 'f02-99', num: '99', name: 'Receipts', parent: 'f02', color: 'var(--c-brown)' },
  { id: 'f03', num: '03', name: 'Reference Documents', parent: null, color: 'var(--c-sky)' },
  { id: 'f04', num: '04', name: 'Quick Share', parent: null, color: 'var(--c-violet)' },
  { id: 'f05', num: '05', name: 'Backups', parent: null, color: 'var(--c-indigo)' },
  { id: 'f06', num: '06', name: 'Temporary (to delete)', parent: null, color: 'var(--c-amber)' },
  { id: 'f99', num: '99', name: 'Archived', parent: null, color: 'var(--c-brown)' },
  { id: 'f99-09', num: '09', name: 'Q3 QBR', parent: 'f99', color: 'var(--c-pink)' },
];

/** Virtual folders: files waiting for a decision live here until they are placed. */
export const SHARED_FOLDER = 'shared';
export const FILING_FOLDER = 'filing';

const files: WFile[] = [
  // [02] Work › [10] Acme
  { id: 'proposal-v3', name: '2026-Q4 Acme — Renewal proposal v3', kind: 'slides', folder: 'f02-10', updated: d(12, 13, 50), owner: 'me', project: 'acme' },
  { id: 'proposal-v4', name: '2026-Q4 Acme — Renewal proposal v4 (draft)', kind: 'slides', folder: 'f02-10', updated: d(16, 8, 3), owner: 'me', createdByTimmy: true, project: 'acme' },
  { id: 'acme-quote', name: '2026-Q4 Acme — Quote tracker', kind: 'sheet', folder: 'f02-10', updated: d(13, 12, 0), owner: 'me', starred: true, project: 'acme' },
  { id: 'acme-quote-summary', name: '2026-11-16 Acme — Revised quote summary', kind: 'doc', folder: 'f02-10', updated: d(16, 8, 4), owner: 'me', createdByTimmy: true, project: 'acme' },
  { id: 'acme-call-notes', name: '2026-11-13 Acme — Call notes', kind: 'doc', folder: 'f02-10', updated: d(13, 11, 40), owner: 'me', project: 'acme' },
  { id: 'acme-running-notes', name: 'Acme Renewal — Running notes', kind: 'doc', folder: 'f02-10', updated: d(13, 12, 5), owner: 'me', project: 'acme' },
  { id: 'acme-stakeholders', name: '2026-11-06 Acme — Stakeholder map', kind: 'pdf', folder: 'f02-10', updated: d(6, 10, 22), owner: 'me', createdByTimmy: true, project: 'acme', format: 'pdf', sample: '/samples/acme-stakeholders.pdf' },
  { id: 'acme-msa', name: '2026-11-12 Acme — MSA redlines', kind: 'pdf', folder: 'f02-10', updated: d(12, 16, 28), owner: 'me', createdByTimmy: true, project: 'acme', format: 'pdf', sample: '/samples/acme-msa.pdf' },
  // [02] Work › [11] Northwind
  { id: 'northwind-sow', name: 'Northwind — Pilot SOW (final)', kind: 'doc', folder: 'f02-11', updated: d(9, 10, 2), owner: 'me', project: 'northwind' },
  { id: 'acme-order-form', name: '2026-11-16 Acme — Order form (draft)', kind: 'doc', folder: 'f02-10', updated: d(16, 8, 4), owner: 'me', createdByTimmy: true, project: 'acme', format: 'docx', sample: '/samples/acme-order-form.docx', description: 'order form contract 120 seats signature' },
  { id: 'northwind-budget', name: 'Northwind Pilot — Budget', kind: 'sheet', folder: 'f02-11', updated: d(9, 11, 20), owner: 'marcus', project: 'northwind', format: 'xlsx', sample: '/samples/northwind-budget.xlsx', description: 'pilot budget seats onboarding migration' },
  { id: 'hiring-loop', name: 'Platform Engineer — Interview loop', kind: 'slides', folder: 'f02-13', updated: d(10, 16, 5), owner: 'sofia', project: 'hiring', format: 'pptx', sample: '/samples/hiring-loop.pptx', description: 'interview loop scorecard criteria' },
  { id: 'northwind-notes', name: 'Northwind Pilot — Running notes', kind: 'doc', folder: 'f02-11', updated: d(10, 14, 0), owner: 'me', project: 'northwind' },
  // [02] Work › [12] Q4 QBR
  { id: 'qbr-deck', name: '2026-Q4 QBR — Briefing slides', kind: 'slides', folder: 'f02-12', updated: d(14, 11, 12), owner: 'priya', project: 'qbr' },
  // [02] Work › [13] Hiring
  { id: 'jordan-notes', name: '2026-11-13 Jordan Kim — Interview notes', kind: 'doc', folder: 'f02-13', updated: d(13, 15, 30), owner: 'me', project: 'hiring' },
  // [02] Work › [01] Management
  { id: 'priya-1on1', name: 'Taylor / Priya — 1:1 notes', kind: 'doc', folder: 'f02-01', updated: d(16, 8, 4), owner: 'priya', starred: true },
  { id: 'offsite-agenda', name: '2027-Q1 Planning offsite — Agenda', kind: 'doc', folder: 'f02-01', updated: d(16, 6, 45), owner: 'nina' },
  // [02] Work › [99] Receipts
  { id: 'harbor-receipt', name: '2026-10-21 Harbor Grill — Receipt', kind: 'pdf', folder: 'f02-99', updated: oct(21, 21, 40), owner: 'me', createdByTimmy: true, format: 'pdf', sample: '/samples/harbor-receipt.pdf' },
  { id: 'figma-receipt', name: '2026-11-15 Figma — Receipt', kind: 'pdf', folder: 'f02-99', updated: d(16, 8, 2), owner: 'me', createdByTimmy: true, format: 'pdf', sample: '/samples/figma-receipt.pdf' },
  // [03] Reference Documents
  { id: 'pricing-tiers', name: 'Pricing tiers 2026 — Working sheet', kind: 'sheet', folder: 'f03', updated: d(2, 9, 0), owner: 'priya', starred: true },
  { id: 'weekly-template', name: 'Weekly review — Template', kind: 'doc', folder: 'f03', updated: oct(5, 9, 0), owner: 'me' },
  { id: 'gym-card', name: 'Gym membership card', kind: 'image', folder: 'f03', updated: oct(2, 18, 0), owner: 'me', description: 'gym barcode member' },
  // [04] Quick Share
  { id: 'qbr-subset', name: '2026-Q4 QBR — Slides 6–9 for Raj', kind: 'slides', folder: 'f04', updated: d(14, 16, 0), owner: 'me' },
  // [05] Backups
  { id: 'contacts-backup', name: '2026-11 Contacts — Backup', kind: 'sheet', folder: 'f05', updated: d(1, 9, 0), owner: 'me' },
  // [99] Archived › [09] Q3 QBR
  { id: 'q3-deck', name: '2026-Q3 QBR — Briefing slides', kind: 'slides', folder: 'f99-09', updated: new Date(2026, 7, 28, 10, 0), owner: 'priya', project: 'q3-qbr' },
  // Shared with you, waiting for a decision
  { id: 'brand-guidelines', name: 'Northpeak — Brand guidelines 2026', kind: 'slides', folder: SHARED_FOLDER, updated: d(13, 10, 0), owner: 'kenji', sharedBy: 'kenji', share: 'pending' },
  { id: 'pipeline-tracker', name: 'Q4 Pipeline tracker', kind: 'sheet', folder: SHARED_FOLDER, updated: d(16, 6, 30), owner: 'priya', sharedBy: 'priya', share: 'pending' },
  { id: 'offsite-rsvp', name: 'Offsite RSVP and dietary needs', kind: 'doc', folder: SHARED_FOLDER, updated: d(16, 6, 46), owner: 'nina', sharedBy: 'nina', share: 'pending' },
  // Attachments waiting to be filed
  {
    id: 'att-brightwave', name: 'Brightwave_OrderForm_countersigned.pdf', kind: 'pdf', folder: FILING_FOLDER, updated: d(15, 20, 14), owner: 'elena', format: 'pdf', sample: '/samples/att-brightwave.pdf',
    filing: { folder: 'f02-14', name: '2026-11-15 Brightwave — Signed order form', fromThread: 'brightwave-signed' },
  },
  {
    id: 'att-pricing-report', name: 'State_of_B2B_SaaS_Pricing_2026.pdf', kind: 'pdf', folder: FILING_FOLDER, updated: d(14, 6, 0), owner: 'pricing', format: 'pdf', sample: '/samples/att-pricing-report.pdf',
    filing: { folder: 'f03', name: '2026 B2B SaaS pricing — Report', fromThread: 'pricing-report' },
  },
  {
    id: 'att-venue', name: 'venue-map-final.png', kind: 'image', folder: FILING_FOLDER, updated: d(16, 6, 45), owner: 'nina',
    filing: { folder: 'f02-01', name: '2027-Q1 Planning offsite — Venue map', fromThread: 'offsite' },
  },
];

/* ───────────── Docs ───────────── */

let b = 0;
const id = () => `b${++b}`;
const h2 = (text: string) => ({ id: id(), type: 'h2' as const, text });
const p = (text: string) => ({ id: id(), type: 'p' as const, text });
const li = (text: string) => ({ id: id(), type: 'bullet' as const, text });
const todo = (text: string, checked = false) => ({ id: id(), type: 'todo' as const, text, checked });

const docs: DocBody[] = [
  {
    id: 'acme-call-notes',
    template: 'team-meeting',
    blocks: [
      p('Nov 13 renewal call with Dana Whitfield and Raj Patel.'),
      h2('Decisions'),
      li('Annual plan, starting January 1.'),
      li('Taylor sends a revised proposal once Acme confirms seats.'),
      h2('Open questions'),
      li('Final seat count: Dana confirms after Friday planning.'),
      li('Is SSO a separate add-on? Raj needs Okta SCIM support.'),
      h2('Action items'),
      todo('Dana: confirm seat count by Fri, Nov 14', true),
      todo('Taylor: answer the SSO question'),
      { id: id(), type: 'file', file: 'proposal-v3' },
    ],
  },
  {
    id: 'acme-running-notes',
    template: 'running-notes',
    blocks: [
      p('Decisions and status for the Acme renewal, newest first. Linked from the project page.'),
      { id: id(), type: 'table', columns: ['Date', 'Decision or update', 'Source'], rows: [
        ['Nov 13', 'Annual plan, January 1 start agreed on the renewal call', 'Call notes'],
        ['Nov 12', 'MSA redlines sent to Legal; Hannah to reply by Thursday', 'Email'],
        ['Nov 6', 'Stakeholders: Dana (procurement), Raj (IT), CFO Mark Chen signs', 'Stakeholder map'],
      ] },
      h2('Links'),
      { id: id(), type: 'file', file: 'acme-quote' },
      { id: id(), type: 'file', file: 'proposal-v4' },
    ],
  },
  {
    id: 'acme-quote-summary',
    template: 'blank',
    blocks: [
      p('Revised quote for 120 seats, for Dana to take to her CFO on Wednesday. Figures are linked to the quote tracker and refresh when it changes.'),
      { id: id(), type: 'linked-table', sheet: 'acme-quote' },
      h2('Notes'),
      li('101–250 seat tier applies; SSO included at this tier.'),
      li('Ask for CFO approval by Friday, Nov 20 to keep the January 1 start.'),
    ],
  },
  {
    id: 'northwind-sow',
    template: 'blank',
    blocks: [
      h2('Scope'),
      p('A 90-day pilot for Northwind Health’s operations team, starting December 1.'),
      h2('Success criteria'),
      li('30 active users by week 4'),
      li('Two workflows moved off spreadsheets'),
      h2('Fees'),
      p('$18,000 for the pilot, credited toward an annual contract.'),
    ],
  },
  {
    id: 'northwind-notes',
    template: 'running-notes',
    blocks: [
      { id: id(), type: 'table', columns: ['Date', 'Decision or update', 'Source'], rows: [
        ['Nov 10', 'Marcus promised the signed SOW by Friday', 'Email'],
        ['Nov 9', 'Final SOW sent for signature', 'Email'],
      ] },
    ],
  },
  {
    id: 'jordan-notes',
    template: 'private-notes',
    blocks: [
      p('Onsite, Friday Nov 13. Platform Engineer.'),
      h2('Strengths'),
      li('Systems design: clear trade-offs on the queueing question'),
      li('Debugging: methodical, narrated well'),
      h2('Concerns'),
      li('Collaboration: little evidence; check with the lunch panel'),
    ],
  },
  {
    id: 'priya-1on1',
    template: 'one-on-one',
    event: 'priya-1on1',
    blocks: [
      p('Weekly 1:1, linked from the calendar invite. Either of us can add a topic before the meeting.'),
      { id: id(), type: 'table', columns: ['Date', 'Agenda', 'Notes', 'Action items'], rows: [
        ['Nov 16', 'Travel budget approval for the Acme onsite (added by Timmy); QBR slides 6–9 plan', '', ''],
        ['Nov 9', 'Acme renewal timeline; Northwind pilot risks', 'Acme likely to expand; SOW pending', 'Taylor: send revised proposal once seats confirmed'],
        ['Nov 2', 'Q4 targets; hiring loop for Platform', 'On track for 92% of target', 'Priya: share QBR skeleton'],
      ] },
    ],
  },
  {
    id: 'offsite-agenda',
    template: 'blank',
    blocks: [h2('Day 1 — Jan 12'), li('Company priorities for 2027'), li('Team planning sessions'), h2('Day 2 — Jan 13'), li('Customer panel'), li('Retro and commitments')],
  },
  {
    id: 'offsite-rsvp',
    template: 'blank',
    blocks: [p('Please add your name, travel needs and any dietary requirements by Dec 1.'), { id: id(), type: 'table', columns: ['Name', 'Travel', 'Dietary'], rows: [['Nina Okafor', 'Local', 'None']] }],
  },
  {
    id: 'weekly-template',
    template: 'private-notes',
    blocks: [
      h2('Process'),
      todo('Clear the quick-capture queue'),
      todo('Review Waiting: nudge anything past its date'),
      todo('Check the CRM for people due a check-in'),
      h2('Plan next week'),
      todo('Pick a highlight for each day'),
      todo('Block focus time for every Follow Up over 30 minutes'),
    ],
  },
];

/* ───────────── Sheets ───────────── */

const sheets: Sheet[] = [
  {
    id: 'pricing-tiers',
    table: 'Tiers',
    columns: [
      { key: 'tier', name: 'Tier', type: 'text' },
      { key: 'from', name: 'Seats from', type: 'number' },
      { key: 'to', name: 'Seats to', type: 'number' },
      { key: 'price', name: 'Price per seat', type: 'currency' },
    ],
    rows: [
      { tier: 'Starter', from: 1, to: 25, price: 72 },
      { tier: 'Growth', from: 26, to: 100, price: 62 },
      { tier: 'Scale', from: 101, to: 250, price: 58 },
      { tier: 'Enterprise', from: 251, to: '', price: '' },
    ],
  },
  {
    id: 'acme-quote',
    table: 'Quote',
    columns: [
      { key: 'option', name: 'Option', type: 'text' },
      { key: 'seats', name: 'Seats', type: 'number' },
      { key: 'price', name: 'Price', type: 'currency' },
      { key: 'annual', name: 'Annual', type: 'currency', formula: '[Seats] * [Price] * 12' },
    ],
    rows: [
      { option: 'Current (v3)', seats: 100, price: 62 },
      { option: 'Revised (v4)', seats: 120, price: 58 },
    ],
  },
  {
    id: 'pipeline-tracker',
    table: 'Pipeline',
    columns: [
      { key: 'account', name: 'Account', type: 'text' },
      { key: 'stage', name: 'Stage', type: 'text' },
      { key: 'value', name: 'Value', type: 'currency' },
      { key: 'close', name: 'Close date', type: 'date' },
    ],
    rows: [
      { account: 'Acme Corp', stage: 'Negotiation', value: 74400, close: '2026-12-15' },
      { account: 'Northwind Health', stage: 'Contracting', value: 18000, close: '2026-11-30' },
      { account: 'Brightwave', stage: 'Contract sent', value: 36000, close: '2026-11-20' },
    ],
  },
  {
    id: 'contacts-backup',
    table: 'Contacts',
    columns: [
      { key: 'name', name: 'Name', type: 'text' },
      { key: 'company', name: 'Company', type: 'text' },
      { key: 'email', name: 'Email', type: 'text' },
    ],
    rows: [
      { name: 'Dana Whitfield', company: 'Acme Corp', email: 'dana.whitfield@acme.com' },
      { name: 'Marcus Lee', company: 'Northwind Health', email: 'marcus@northwindhealth.com' },
    ],
  },
];

/* ───────────── Slides ───────────── */

const decks: Deck[] = [
  {
    id: 'proposal-v3',
    slides: [
      { id: 's1', title: 'Acme renewal proposal', layout: 'title' },
      { id: 's2', title: 'What Acme gets', layout: 'bullets', bullets: ['100 seats, annual plan', 'Priority support', 'Quarterly business reviews'] },
      { id: 's3', title: 'Pricing: 100 seats', layout: 'chart', notes: 'Floor price is $56 if they push. Do not share.', confidential: true },
      { id: 's4', title: 'Next steps', layout: 'bullets', bullets: ['Confirm seat count', 'Order form', 'January 1 start'] },
    ],
  },
  {
    id: 'proposal-v4',
    slides: [
      { id: 's1', title: 'Acme renewal proposal', layout: 'title' },
      { id: 's2', title: 'What Acme gets', layout: 'bullets', bullets: ['120 seats, annual plan', 'SSO included', 'Priority support'] },
      { id: 's3', title: 'Pricing: 120 seats at $58', layout: 'chart', notes: 'Floor price is $56. Internal only.', confidential: true },
      { id: 's4', title: 'Why the Scale tier', layout: 'bullets', bullets: ['$4 less per seat than v3', 'SSO and SCIM included'] },
      { id: 's5', title: 'Next steps', layout: 'bullets', bullets: ['CFO approval by Nov 20', 'Order form', 'January 1 start'] },
    ],
  },
  {
    id: 'qbr-deck',
    slides: [
      { id: 's1', title: 'Q4 business review', layout: 'title' },
      { id: 's2', title: 'Quarter at a glance', layout: 'chart' },
      { id: 's3', title: 'Wins', layout: 'bullets', bullets: ['Brightwave closed', 'Two expansions'] },
      { id: 's4', title: 'Losses and lessons', layout: 'bullets', bullets: ['Lost Halcyon on price'], confidential: true, notes: 'Halcyon churn details are confidential.' },
      { id: 's5', title: 'Team', layout: 'bullets', bullets: ['Hiring two Platform engineers'] },
      { id: 's6', title: 'Pipeline', layout: 'chart', notes: 'Taylor to fill' },
      { id: 's7', title: 'Renewals', layout: 'chart', notes: 'Taylor to fill' },
      { id: 's8', title: 'Acme expansion', layout: 'bullets', bullets: ['100 → 120 seats'], notes: 'Taylor to fill' },
      { id: 's9', title: 'Northwind pilot', layout: 'bullets', bullets: ['Dec 1 start'], notes: 'Taylor to fill' },
      { id: 's10', title: 'Asks', layout: 'quote' },
    ],
  },
  {
    id: 'qbr-subset',
    slides: [
      { id: 's6', title: 'Pipeline', layout: 'chart' },
      { id: 's7', title: 'Renewals', layout: 'chart' },
      { id: 's8', title: 'Acme expansion', layout: 'bullets', bullets: ['100 → 120 seats'] },
      { id: 's9', title: 'Northwind pilot', layout: 'bullets', bullets: ['Dec 1 start'] },
    ],
  },
  {
    id: 'brand-guidelines',
    slides: [
      { id: 's1', title: 'Northpeak brand 2026', layout: 'title' },
      { id: 's2', title: 'Logo use', layout: 'bullets', bullets: ['Clear space', 'Minimum size'] },
      { id: 's3', title: 'Slide layouts', layout: 'bullets', bullets: ['Title', 'Two column', 'Chart'] },
    ],
  },
  { id: 'q3-deck', slides: [{ id: 's1', title: 'Q3 business review', layout: 'title' }] },
];

/* ───────────── Tasks and quick notes ───────────── */

const tasks: Task[] = [
  { id: 't-acme-quote', title: 'Revise Acme quote to 120 seats', status: 'todo', project: 'acme', due: d(17, 17), priority: 'high', created: d(16, 8, 3), thread: 'acme-quote', contact: 'dana', event: 'focus-acme' },
  { id: 't-scorecard', title: 'Add Jordan Kim scorecard', status: 'doing', project: 'hiring', due: d(16, 16, 30), priority: 'high', created: d(16, 8, 6), thread: 'interview-feedback' },
  { id: 't-qbr', title: 'Fill in QBR slides 6–9 (pipeline and renewals)', status: 'todo', project: 'qbr', due: d(20, 17), priority: 'normal', created: d(14, 11, 25), thread: 'qbr-slides', event: 'qbr-prep' },
  { id: 't-kickoff', title: 'Send Northwind kickoff invite for Dec 1', status: 'todo', project: 'northwind', due: d(18, 17), priority: 'normal', created: d(16, 8, 3), contact: 'marcus' },
  { id: 't-receipt', title: 'Send Ben the Oct 21 dinner receipt', status: 'todo', due: d(18, 17), priority: 'low', created: d(13, 15, 5), thread: 'expense-receipt' },
  { id: 't-flights', title: 'Book flights for the Acme onsite', status: 'todo', project: 'acme', due: d(20, 12), priority: 'low', created: d(10, 9, 6), notes: 'Waiting on Priya’s travel budget approval.' },
  { id: 't-msa', title: 'Send MSA redlines to Hannah', status: 'done', project: 'acme', priority: 'normal', created: d(12, 9, 0) },
  { id: 't-criteria', title: 'Draft Northwind pilot success criteria', status: 'done', project: 'northwind', priority: 'normal', created: d(9, 9, 0) },
  { id: 't-stakeholders', title: 'Prepare questions for Acme stakeholders', status: 'done', project: 'acme', priority: 'normal', created: d(6, 9, 0) },
];

const notes: QuickNote[] = [
  { id: 'n-prepay', text: 'Offer Acme a two-year prepay option at the Scale tier?', kind: 'thought', created: d(16, 7, 50) },
  { id: 'n-report', text: '61% of SaaS companies now pair seats with usage. Mention in QBR slide 6.', kind: 'note', source: 'State of B2B SaaS Pricing 2026', created: d(14, 8, 10) },
  { id: 'n-raise', text: 'Ask Priya about timing for a compensation conversation', kind: 'thought', created: d(15, 18, 30) },
  { id: 'n-scim', text: 'Raj: SSO must support Okta SCIM provisioning', kind: 'note', source: 'Acme call, Nov 13', created: d(13, 11, 20) },
  { id: 'n-sow', text: 'Call Marcus about the SOW', kind: 'thought', created: d(12, 8, 0), processed: 'task' },
];

/* ───────────── Calendar: the week of Nov 16 ───────────── */

const events: WEvent[] = [
  ...[16, 17, 18, 19].map((day) => ({ id: `standup-${day}`, title: 'Team standup', start: d(day, 9), end: d(day, 9, 15), kind: 'meeting' as const, with: ['priya', 'kenji'], recurring: 'weekly' as const })),
  { id: 'northwind-sync', title: 'Northwind pilot planning', start: d(16, 10, 30), end: d(16, 11), kind: 'meeting', with: ['marcus'], note: 'The signed SOW is 3 days late. Ask Marcus about it in person.', docs: ['northwind-sow'], thread: 'northwind-sow' },
  { id: 'focus-acme', title: 'Focus: Revised Acme quote', start: d(16, 13), end: d(16, 14, 30), kind: 'focus', with: [], note: 'Blocked by Timmy for the quote due Tuesday.', docs: ['acme-quote', 'proposal-v4'], thread: 'acme-quote', task: 't-acme-quote' },
  { id: 'priya-1on1', title: '1:1 with Priya', start: d(16, 15), end: d(16, 15, 30), kind: 'meeting', with: ['priya'], note: 'Timmy added to the agenda: travel budget approval (no reply in 6 days).', notesDoc: 'priya-1on1', thread: 'travel-budget', recurring: 'weekly' },
  { id: 'debrief', title: 'Interview debrief: Jordan Kim', start: d(16, 16, 30), end: d(16, 17), kind: 'meeting', with: ['sofia'], note: 'Your scorecard is due before this.', docs: ['jordan-notes'], thread: 'interview-feedback' },
  { id: 'gym-17', title: 'Gym', start: d(17, 7), end: d(17, 8), kind: 'personal', with: [] },
  { id: 'acme-sync', title: 'Acme renewal sync', start: d(17, 11), end: d(17, 11, 30), kind: 'meeting', with: ['dana', 'raj'], docs: ['proposal-v4', 'acme-quote-summary'], notesDoc: 'acme-running-notes' },
  { id: 'hiring-sync', title: 'Hiring sync', start: d(18, 10), end: d(18, 10, 30), kind: 'meeting', with: ['sofia'] },
  { id: 'qbr-prep', title: 'Focus: QBR slides 6–9', start: d(18, 14), end: d(18, 16), kind: 'focus', with: [], task: 't-qbr', docs: ['qbr-deck', 'pipeline-tracker'] },
  { id: 'gym-19', title: 'Gym', start: d(19, 7), end: d(19, 8), kind: 'personal', with: [] },
  { id: 'ev-out-lead-14', title: 'Intro call: Logan Petrov, Fairhaven Imaging', start: d(19, 16, 30), end: d(19, 17), kind: 'meeting', with: ['lead-14'], note: 'Booked from outbound: Ops pilot, healthcare & services.' },
  { id: 'kickoff-plan', title: 'Northwind kickoff planning', start: d(19, 11), end: d(19, 12), kind: 'meeting', with: ['marcus'], notesDoc: 'northwind-notes' },
  { id: 'weekly-review', title: 'Weekly review', start: d(20, 16), end: d(20, 16, 45), kind: 'review', with: [], note: 'Open the review queue: quick notes, Waiting, CRM check-ins.', docs: ['weekly-template'], recurring: 'weekly' },
];

/* ───────────── People ───────────── */

const crm: Record<string, Partial<Contact>> = {
  dana: { tracked: true, priority: true, cadence: 'weekly', phone: '+1 312 555 0142', location: 'Chicago, IL', last: d(15, 18, 48), next: 'Send revised quote', owner: 'me', due: d(17, 17), deal: 'acme', emails: 14, about: 'Head of Procurement. Prefers short emails with the numbers up front. CFO Mark Chen signs off.' },
  raj: { tracked: true, cadence: 'monthly', location: 'Chicago, IL', last: d(16, 6, 10), next: 'Answer the SSO question', owner: 'me', deal: 'acme', emails: 6 },
  marcus: { tracked: true, priority: true, cadence: 'weekly', phone: '+1 617 555 0199', location: 'Boston, MA', last: d(15, 21, 20), next: 'Signed SOW', owner: 'marcus', due: d(13, 17), deal: 'northwind', emails: 11, about: 'Runs operations. Replies fast on mobile; keep emails short.' },
  elena: { tracked: true, cadence: 'monthly', location: 'Austin, TX', last: d(15, 20, 14), next: 'Schedule kickoff', owner: 'me', due: d(20, 17), deal: 'brightwave', emails: 5 },
  leo: { tracked: true, cadence: 'monthly', location: 'Austin, TX', last: d(15, 22, 40), next: 'Reply about the intro to Dana', owner: 'me', due: d(17, 17), emails: 3 },
  priya: { tracked: true, cadence: 'weekly', last: d(16, 7, 0), next: 'Approve travel budget', owner: 'priya', emails: 22 },
  hannah: { tracked: true, cadence: 'monthly', last: d(12, 17, 5), next: 'MSA redline comments', owner: 'hannah', due: d(19, 17), emails: 4 },
  sofia: { emails: 9 },
  ben: { emails: 2 },
  kenji: { emails: 7 },
  nina: { emails: 5 },
};

const extraContacts: Contact[] = [
  { id: 'mark', name: 'Mark Chen', email: 'mark.chen@acme.com', title: 'CFO', company: 'Acme Corp', location: 'Chicago, IL', emails: 1 },
  { id: 'olivia', name: 'Olivia Brooks', email: 'olivia@northwindhealth.com', title: 'CEO', company: 'Northwind Health', location: 'Boston, MA', emails: 2 },
  { id: 'sam', name: 'Sam Rivera', email: 'sam.rivera@stripe.com', title: 'Former manager', company: 'Stripe', location: 'San Francisco, CA', emails: 1, about: 'Mentor. Catch up every quarter.' },
];

// The mail screens read names from PEOPLE, so every contact is listed there too.
for (const c of extraContacts) PEOPLE[c.id] = { id: c.id, name: c.name, email: c.email, title: c.title, company: c.company };

const contacts: Contact[] = [
  ...Object.values(PEOPLE)
    .filter((x) => x.id !== 'me' && !extraContacts.some((e) => e.id === x.id))
    .map((x) => ({ ...x, ...crm[x.id] }) as Contact),
  ...extraContacts,
];

const interactions: Interaction[] = [
  { id: 'i1', contact: 'dana', kind: 'email', text: 'Asked for a revised quote for 120 seats by Tuesday', at: d(15, 18, 48), by: 'dana', thread: 'acme-quote' },
  { id: 'i2', contact: 'dana', kind: 'reminder', text: 'Send the revised quote', at: d(17, 17), by: 'me', done: false },
  { id: 'i3', contact: 'dana', kind: 'call', text: 'Renewal call: annual plan, January 1 start', at: d(13, 11), by: 'me', file: 'acme-call-notes' },
  { id: 'i4', contact: 'dana', kind: 'note', text: 'Prefers the numbers in the first line. CFO Mark Chen signs off.', at: d(13, 11, 45), by: 'me' },
  { id: 'i5', contact: 'dana', kind: 'email', text: 'You sent renewal proposal v3', at: d(12, 14, 5), by: 'me', thread: 'acme-quote' },
  { id: 'i6', contact: 'dana', kind: 'file', text: 'Shared the Acme stakeholder map', at: d(6, 10, 20), by: 'dana', file: 'acme-stakeholders' },
  { id: 'i7', contact: 'dana', kind: 'meeting', text: 'Intro meeting with Dana and Raj', at: oct(30, 14), by: 'me' },
  { id: 'i8', contact: 'marcus', kind: 'email', text: 'Asked whether the Dec 1 pilot start still holds', at: d(15, 21, 20), by: 'marcus', thread: 'northwind-date' },
  { id: 'i9', contact: 'marcus', kind: 'email', text: 'Promised the signed SOW on Friday', at: d(10, 13, 40), by: 'marcus', thread: 'northwind-sow' },
  { id: 'i10', contact: 'marcus', kind: 'reminder', text: 'Chase the signed SOW', at: d(16, 10, 30), by: 'me', done: false },
  { id: 'i11', contact: 'marcus', kind: 'meeting', text: 'Pilot planning call', at: d(16, 10, 30), by: 'me' },
  { id: 'i12', contact: 'elena', kind: 'email', text: 'Sent the countersigned order form', at: d(15, 20, 14), by: 'elena', thread: 'brightwave-signed' },
  { id: 'i13', contact: 'leo', kind: 'email', text: 'Asked for an intro to Dana at Acme', at: d(15, 22, 40), by: 'leo', thread: 'leo-intro' },
  { id: 'i14', contact: 'raj', kind: 'email', text: 'Asked whether SSO needs a separate contract', at: d(16, 6, 10), by: 'raj', thread: 'raj-sso' },
  { id: 'i15', contact: 'priya', kind: 'meeting', text: 'Weekly 1:1', at: d(9, 15), by: 'me', file: 'priya-1on1' },
  { id: 'i16', contact: 'hannah', kind: 'email', text: 'Promised MSA comments by Thursday', at: d(12, 17, 5), by: 'hannah', thread: 'msa-redlines' },
  { id: 'i17', contact: 'sam', kind: 'note', text: 'Last catch-up in August: asked about my move to sales', at: new Date(2026, 7, 14, 12), by: 'me' },
];

/* ───────────── Projects ───────────── */

const projects: Project[] = [
  { id: 'acme', num: '10', name: 'Acme Renewal', color: 'var(--c-green)', status: 'active', client: 'Acme Corp', goal: 'Renew Acme for 2027 at 120 seats, signed before Dec 15.', folder: 'f02-10', deal: 'acme', notesDoc: 'acme-running-notes', sources: ['proposal-v4', 'acme-quote', 'pricing-tiers', 'acme-call-notes'] },
  { id: 'northwind', num: '11', name: 'Northwind Pilot', color: 'var(--c-violet)', status: 'active', client: 'Northwind Health', goal: 'Start the 90-day pilot on December 1.', folder: 'f02-11', deal: 'northwind', notesDoc: 'northwind-notes', sources: ['northwind-sow'] },
  { id: 'qbr', num: '12', name: 'Q4 QBR', color: 'var(--c-pink)', status: 'active', client: 'Internal', goal: 'Slides 6–9 ready for the dry run on Nov 23.', folder: 'f02-12', sources: ['qbr-deck', 'pipeline-tracker'] },
  { id: 'hiring', num: '13', name: 'Hiring · Platform', color: 'var(--c-teal)', status: 'active', client: 'Internal', goal: 'Two Platform engineers hired by January.', folder: 'f02-13', sources: ['jordan-notes'] },
  { id: 'q3-qbr', num: '09', name: 'Q3 QBR', color: 'var(--c-pink)', status: 'archived', client: 'Internal', goal: 'Presented Aug 28.', folder: 'f99-09', sources: ['q3-deck'] },
];

/* ───────────── AI library ───────────── */

const prompts: Prompt[] = [
  { id: 'p-recap', title: 'Decision-first recap', text: 'Rewrite this thread as: decisions, open actions with owners and dates, then background. Under 150 words.', status: 'captured', created: d(14, 8, 0) },
  { id: 'p-objections', title: 'Objections from call notes', text: 'List every objection raised in these call notes, with a one-line answer for each from our pricing sheet.', status: 'captured', created: d(15, 19, 0) },
  { id: 'p-quote', title: 'Revised quote reply', text: 'Using the current proposal and pricing sheet, draft a reply that states the new price in the first line and asks for approval by a date.', status: 'filed', useCase: 'Customer email', output: 'email', project: 'acme', created: d(2, 9, 0) },
  { id: 'p-update', title: 'Weekly project update', text: 'From the project’s running notes and tracker, write a five-line update: progress, numbers, risks, asks, next week.', status: 'filed', useCase: 'Internal update', output: 'doc', created: oct(20, 9, 0) },
  { id: 'p-slide', title: 'QBR slide from a tracker', text: 'Turn this table into one slide: a title that states the finding, three bullets, and the number that matters most.', status: 'filed', useCase: 'Slides', output: 'slides', project: 'qbr', created: oct(28, 9, 0) },
  { id: 'p-viral', title: 'Viral LinkedIn post', text: 'Write a viral LinkedIn post about productivity.', status: 'discarded', created: oct(12, 9, 0) },
];

const routines: Routine[] = [
  {
    id: 'r-pipeline', name: 'Weekly pipeline report', when: 'Fridays, 3:00 PM',
    links: [
      { label: 'Q4 Pipeline tracker', href: 'file:pipeline-tracker' },
      { label: 'Acme quote tracker', href: 'file:acme-quote' },
      { label: 'People: deals', href: 'people' },
      { label: 'QBR briefing slides', href: 'file:qbr-deck' },
    ],
  },
  {
    id: 'r-monday', name: 'Monday planning', when: 'Mondays, 8:30 AM',
    links: [
      { label: 'Tasks board', href: 'tasks' },
      { label: 'This week’s calendar', href: 'calendar' },
      { label: '[02] Waiting', href: 'box:waiting' },
    ],
  },
];

const learned: LearnedRule[] = [
  { id: 'l-marcus', text: 'Keep replies to Marcus Lee under 60 words.', evidence: 'You shortened 3 of Timmy’s drafts to Marcus by about 40% before sending.', group: 'writing' },
  { id: 'l-receipts', text: 'File Harbor Grill receipts under [02] Work › [99] Receipts without asking.', evidence: 'You moved the last 2 by hand.', group: 'files' },
];

export const WS_SEED: WS = {
  folders: byId(folders),
  files: byId(files),
  docs: byId(docs),
  sheets: byId(sheets),
  decks: byId(decks),
  tasks: byId(tasks),
  notes: byId(notes),
  events: byId(events),
  contacts: byId(contacts),
  interactions: byId(interactions),
  projects: byId(projects),
  prompts: byId(prompts),
  routines: byId(routines),
  learned: byId(learned),
};
