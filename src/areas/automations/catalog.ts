/*
 * The blocks you can put on an automation's canvas: triggers (what starts
 * it), actions (what Timmy does) and logic (if / else, wait). Each block says
 * what settings it has, how to sum them up on the card, and what a test run
 * with sample data shows. Test runs never send anything.
 */
import {
  Bell,
  CalendarClock,
  CheckCircle2,
  Clock,
  FilePlus2,
  FileText,
  FolderInput,
  GitBranch,
  Handshake,
  ListTodo,
  Mail,
  Megaphone,
  PenLine,
  Send,
  TrendingUp,
  Timer,
  type LucideIcon,
} from 'lucide-react';
import type { AutoNode } from '../../data/ws-types';

export type Role = 'trigger' | 'action' | 'logic';

export interface Field {
  id: string;
  label: string;
  type: 'text' | 'select' | 'template';
  options?: string[];
  placeholder?: string;
  hint?: string;
}

export interface Kind {
  id: string;
  role: Role;
  label: string;
  /** Where it happens, shown on the card and the automation list. */
  app: string;
  icon: LucideIcon;
  color: string;
  description: string;
  fields: Field[];
  /** For triggers: the fields a run carries, offered as {{chips}} in later steps. */
  sample?: Record<string, string>;
  summary: (c: Record<string, string>) => string;
  /** What a test run shows for this step. */
  test: (c: Record<string, string>, data: Record<string, string>) => string;
}

const fill = (t: string, data: Record<string, string>) => (t ?? '').replace(/\{\{(\w+)\}\}/g, (_, k: string) => data[k] ?? `{{${k}}}`);
const cut = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const FORMS = ['Website: Book a demo', 'Typeform: Pilot application', 'Facebook Lead Ads', 'Any form: webhook'];
export const STAGES = ['New lead', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost'];
export const FOLDERS = ['[02] Work › [99] Receipts', '[02] Work › [10] Acme', '[03] Reference Documents', '[06] Temporary'];

export const KINDS: Kind[] = [
  /* ── Triggers ── */
  {
    id: 'email',
    role: 'trigger',
    label: 'New email',
    app: 'Gmail',
    icon: Mail,
    color: 'var(--c-red)',
    description: 'When an email arrives that matches',
    fields: [
      { id: 'from', label: 'From contains', type: 'text', placeholder: 'Any sender address, or part of one' },
      { id: 'subject', label: 'Subject contains', type: 'text', placeholder: 'Any subject' },
    ],
    sample: { name: 'Jamie Lee', email: 'jamie@brightwave.co', company: 'Brightwave', subject: 'Quote for 40 seats?', snippet: 'Hi Taylor, could you send pricing for 40 seats starting in January?' },
    summary: (c) => [c.from && `from “${c.from}”`, c.subject && `subject has “${c.subject}”`].filter(Boolean).join(', ') || 'Any new email',
    test: (_c, d) => `Email from ${d.name} <${d.email}>: “${d.subject}”`,
  },
  {
    id: 'form',
    role: 'trigger',
    label: 'Form submitted',
    app: 'Forms',
    icon: FilePlus2,
    color: 'var(--c-teal)',
    description: 'When someone fills in one of your lead forms',
    fields: [{ id: 'form', label: 'Form', type: 'select', options: FORMS }],
    sample: { name: 'Jamie Lee', email: 'jamie@brightwave.co', company: 'Brightwave', budget: '8000', message: 'Looking to start in January with 40 seats.' },
    summary: (c) => c.form || 'Pick a form',
    test: (c, d) => `${d.name} from ${d.company} filled in ${c.form || 'a form'} (budget $${Number(d.budget).toLocaleString()})`,
  },
  {
    id: 'drive',
    role: 'trigger',
    label: 'File added to a folder',
    app: 'Google Drive',
    icon: FolderInput,
    color: 'var(--c-sky)',
    description: 'When a file lands in a Drive folder',
    fields: [{ id: 'folder', label: 'Folder', type: 'select', options: FOLDERS }],
    sample: { file: '2026-11-16 Figma — Receipt.pdf', folder: '[99] Receipts', owner: 'You', amount: '45' },
    summary: (c) => (c.folder ? `In ${c.folder}` : 'Pick a folder'),
    test: (_c, d) => `“${d.file}” was added to ${d.folder}`,
  },
  {
    id: 'meeting',
    role: 'trigger',
    label: 'Meeting ends',
    app: 'Calendar',
    icon: CalendarClock,
    color: 'var(--c-violet)',
    description: 'Right after a meeting on your calendar',
    fields: [{ id: 'with', label: 'With', type: 'select', options: ['Anyone', 'Clients only', 'My team only'] }],
    sample: { title: 'Acme renewal sync', name: 'Dana Whitfield', email: 'dana@acme.com', company: 'Acme', ended: '11:30 AM' },
    summary: (c) => `With ${(c.with || 'Anyone').toLowerCase()}`,
    test: (_c, d) => `“${d.title}” with ${d.name} ended at ${d.ended}`,
  },
  {
    id: 'deal',
    role: 'trigger',
    label: 'Deal stage changes',
    app: 'CRM',
    icon: TrendingUp,
    color: 'var(--c-green)',
    description: 'When a deal moves to a stage',
    fields: [{ id: 'stage', label: 'Moves to', type: 'select', options: STAGES }],
    sample: { deal: 'Acme renewal', name: 'Dana Whitfield', email: 'dana@acme.com', company: 'Acme', stage: 'Proposal', value: '58000' },
    summary: (c) => (c.stage ? `Moves to ${c.stage}` : 'Any stage'),
    test: (c, d) => `${d.deal} moved to ${c.stage || d.stage} ($${Number(d.value).toLocaleString()})`,
  },
  {
    id: 'schedule',
    role: 'trigger',
    label: 'On a schedule',
    app: 'Timmy',
    icon: Clock,
    color: 'var(--c-slate)',
    description: 'Every day, week or month',
    fields: [{ id: 'every', label: 'Runs', type: 'select', options: ['Weekdays at 8:00 AM', 'Mondays at 9:00 AM', 'Fridays at 4:00 PM', 'The 1st of each month'] }],
    sample: { date: 'Mon, Nov 16', name: 'Taylor', email: 'taylor@timmy.app', company: 'Timmy' },
    summary: (c) => c.every || 'Pick when',
    test: (c, d) => `${c.every || 'Scheduled'}: ran for ${d.date}`,
  },

  /* ── Actions ── */
  {
    id: 'draft',
    role: 'action',
    label: 'Draft a reply',
    app: 'Timmy',
    icon: PenLine,
    color: 'var(--accent)',
    description: 'Timmy writes it in your voice; you check it',
    fields: [
      { id: 'message', label: 'Starting point', type: 'template', placeholder: 'Hi {{name}}, thanks for…' },
      { id: 'tone', label: 'Tone', type: 'select', options: ['Like my emails', 'Brief', 'Warm', 'Formal'] },
    ],
    summary: (c) => (c.message ? `“${cut(c.message, 44)}”` : 'Timmy writes it from scratch'),
    test: (c, d) => `Drafted to ${d.email}: “${cut(fill(c.message || `Hi ${d.name}, thanks for reaching out.`, d), 70)}”`,
  },
  {
    id: 'approve',
    role: 'action',
    label: 'Ask me first',
    app: 'Approvals',
    icon: CheckCircle2,
    color: 'var(--c-amber)',
    description: 'Waits in Approvals until you say yes',
    fields: [{ id: 'note', label: 'Note for you', type: 'template', placeholder: 'Check the price before it goes' }],
    summary: (c) => (c.note ? cut(c.note, 46) : 'Waits for your OK'),
    test: () => 'Waiting in Approvals (the test run carries on as if you said yes)',
  },
  {
    id: 'send',
    role: 'action',
    label: 'Send the email',
    app: 'Gmail',
    icon: Send,
    color: 'var(--c-red)',
    description: 'Sends the draft from your mailbox',
    fields: [{ id: 'when', label: 'When', type: 'select', options: ['Right away', 'Within business hours', 'Tomorrow at 9:00 AM'] }],
    summary: (c) => c.when || 'Right away',
    test: (c, d) => `Would send to ${d.email} ${(c.when || 'right away').toLowerCase()} (not sent: test run)`,
  },
  {
    id: 'crm',
    role: 'action',
    label: 'Update the CRM',
    app: 'CRM',
    icon: Handshake,
    color: 'var(--c-green)',
    description: 'Add the person, or move their deal',
    fields: [
      { id: 'stage', label: 'Stage', type: 'select', options: STAGES },
      { id: 'value', label: 'Deal value', type: 'template', placeholder: '{{budget}}' },
    ],
    summary: (c) => (c.stage ? `Stage: ${c.stage}` : 'Add the contact'),
    test: (c, d) => `${d.name} (${d.company}) set to ${c.stage || 'New lead'}${c.value ? `, value $${Number(fill(c.value, d)).toLocaleString() || fill(c.value, d)}` : ''}`,
  },
  {
    id: 'task',
    role: 'action',
    label: 'Create a task',
    app: 'Tasks',
    icon: ListTodo,
    color: 'var(--c-indigo)',
    description: 'Adds a to-do with a due date',
    fields: [
      { id: 'title', label: 'Task', type: 'template', placeholder: 'Follow up with {{name}}' },
      { id: 'due', label: 'Due', type: 'select', options: ['Today', 'Tomorrow', 'In 3 days', 'Next week'] },
    ],
    summary: (c) => (c.title ? `“${cut(c.title, 40)}”, ${(c.due || 'Today').toLowerCase()}` : 'Name the task'),
    test: (c, d) => `Task “${fill(c.title || `Follow up with ${d.name}`, d)}”, due ${(c.due || 'today').toLowerCase()}`,
  },
  {
    id: 'file',
    role: 'action',
    label: 'Save to Drive',
    app: 'Google Drive',
    icon: FolderInput,
    color: 'var(--c-sky)',
    description: 'Files the attachment with a clear name',
    fields: [
      { id: 'folder', label: 'Folder', type: 'select', options: FOLDERS },
      { id: 'name', label: 'File name', type: 'template', placeholder: '{{date}} {{company}} — Receipt' },
    ],
    summary: (c) => (c.folder ? `To ${c.folder}` : 'Pick a folder'),
    test: (c, d) => `Saved as “${fill(c.name || '{{file}}', d)}” in ${c.folder || 'Drive'}`,
  },
  {
    id: 'doc',
    role: 'action',
    label: 'Add to a doc',
    app: 'Docs',
    icon: FileText,
    color: 'var(--c-sky)',
    description: 'Adds a line to running notes',
    fields: [
      { id: 'doc', label: 'Doc', type: 'select', options: ['Acme Renewal — Running notes', 'Northwind Pilot — Running notes', 'Weekly review — Template'] },
      { id: 'line', label: 'Line', type: 'template', placeholder: '{{title}} with {{name}}' },
    ],
    summary: (c) => (c.doc ? `To ${cut(c.doc, 38)}` : 'Pick a doc'),
    test: (c, d) => `Added “${cut(fill(c.line || '{{title}}', d), 50)}” to ${c.doc || 'the doc'}`,
  },
  {
    id: 'campaign',
    role: 'action',
    label: 'Add to a campaign',
    app: 'Outbound',
    icon: Megaphone,
    color: 'var(--c-pink)',
    description: 'Puts the person in an email sequence',
    fields: [{ id: 'campaign', label: 'Campaign', type: 'select', options: ['Nurture: monthly tips', 'Dental practices, Austin', 'Re-engage: quiet leads'] }],
    summary: (c) => c.campaign || 'Pick a campaign',
    test: (c, d) => `${d.name} added to “${c.campaign || 'a campaign'}”`,
  },
  {
    id: 'notify',
    role: 'action',
    label: 'Notify me',
    app: 'Slack',
    icon: Bell,
    color: 'var(--c-amber)',
    description: 'A heads-up in Timmy or Slack',
    fields: [
      { id: 'where', label: 'Where', type: 'select', options: ['Timmy (Today page)', 'Slack: #sales', 'Slack: direct message'] },
      { id: 'message', label: 'Message', type: 'template', placeholder: 'New lead: {{name}} from {{company}}' },
    ],
    summary: (c) => c.where || 'Timmy (Today page)',
    test: (c, d) => `Would post to ${c.where || 'Timmy'}: “${cut(fill(c.message || 'New: {{name}}', d), 50)}”`,
  },

  /* ── Logic ── */
  {
    id: 'condition',
    role: 'logic',
    label: 'If / else',
    app: 'Logic',
    icon: GitBranch,
    color: 'var(--c-brown)',
    description: 'Go one way or the other',
    fields: [
      { id: 'field', label: 'If', type: 'select', options: ['budget', 'company', 'subject', 'email', 'stage', 'value', 'amount'] },
      { id: 'op', label: 'Is', type: 'select', options: ['more than', 'less than', 'contains', 'is'] },
      { id: 'value', label: 'Value', type: 'text', placeholder: '5000' },
    ],
    summary: (c) => (c.field ? `If ${c.field} ${c.op || 'is'} ${c.value || '…'}` : 'Set the rule'),
    test: (c, d) => `${c.field} is “${d[c.field] ?? '—'}”: ${evaluate(c, d) ? 'yes' : 'no'}`,
  },
  {
    id: 'wait',
    role: 'logic',
    label: 'Wait',
    app: 'Logic',
    icon: Timer,
    color: 'var(--c-slate)',
    description: 'Pause before the next step',
    fields: [{ id: 'for', label: 'For', type: 'select', options: ['5 minutes', '1 hour', '1 day', '3 days', 'Until business hours'] }],
    summary: (c) => c.for || '5 minutes',
    test: (c) => `Waited ${c.for || '5 minutes'} (skipped in a test run)`,
  },
];

export const KIND: Record<string, Kind> = Object.fromEntries(KINDS.map((k) => [k.id, k]));

export const ROLE_LABEL: Record<Role, string> = { trigger: 'Trigger', action: 'Action', logic: 'Logic' };

export function evaluate(c: Record<string, string>, d: Record<string, string>) {
  const v = d[c.field ?? ''] ?? '';
  const want = c.value ?? '';
  switch (c.op) {
    case 'more than':
      return Number(v) > Number(want);
    case 'less than':
      return Number(v) < Number(want);
    case 'contains':
      return v.toLowerCase().includes(want.toLowerCase());
    default:
      return v.toLowerCase() === want.toLowerCase();
  }
}

/** Every setting filled in? (The card's status dot.) */
export const ready = (n: AutoNode) => {
  const k = KIND[n.kind];
  if (!k) return false;
  if (k.id === 'condition') return !!(n.config.field && n.config.value);
  return k.fields.filter((f) => f.type === 'select').every((f) => n.config[f.id]);
};

export { fill };
