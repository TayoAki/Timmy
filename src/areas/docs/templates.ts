/* Doc templates: the starting blocks for each situation, and the slide layout sets. */
import { FileText, Flag, LayoutList, ListChecks, NotebookPen, Repeat, Users, type LucideIcon } from 'lucide-react';
import type { Block, DocTemplate, Project, Slide, WEvent } from '../../data/ws-types';
import { fmtDate, fmtLongDate } from '../../lib/format';
import { firstName, personName, uid } from '../../state/ws';
import type { Gran } from './naming';

export type TemplateKey = 'private-notes' | 'team-meeting' | 'one-on-one' | 'tracker' | 'project-recap' | 'running-notes' | 'blank';

export interface TemplateDef {
  key: TemplateKey;
  template: DocTemplate;
  name: string;
  blurb: string;
  icon: LucideIcon;
  gran: Gran;
  keyword: string;
  /** Headings shown on the template card. */
  outline: string[];
  /** Shown as a card on the Templates tab. */
  card: boolean;
}

export const TEMPLATES: TemplateDef[] = [
  {
    key: 'team-meeting',
    template: 'team-meeting',
    name: 'Team meeting',
    blurb: 'Decisions first, then notes, then action items with owners. Dated for the meeting.',
    icon: Users,
    gran: 'day',
    keyword: 'Meeting notes',
    outline: ['Date and attendees', 'Decisions', 'Notes', 'Action items'],
    card: true,
  },
  {
    key: 'one-on-one',
    template: 'one-on-one',
    name: '1:1 running notes',
    blurb: 'One doc for every 1:1, newest date on top. Link it from the invite so either of you can add a topic.',
    icon: Repeat,
    gran: 'none',
    keyword: '1:1 notes',
    outline: ['Date', 'Agenda', 'Notes', 'Action items'],
    card: true,
  },
  {
    key: 'tracker',
    template: 'running-notes',
    name: 'Team tracker',
    blurb: 'A shared table with one row per topic. Owners update their rows before the weekly sync.',
    icon: ListChecks,
    gran: 'quarter',
    keyword: 'Tracker',
    outline: ['Topic', 'Owner', 'Status', 'Next step'],
    card: true,
  },
  {
    key: 'project-recap',
    template: 'project-recap',
    name: 'Project recap',
    blurb: 'Close a project: what you set out to do, what happened and what the team learned.',
    icon: Flag,
    gran: 'quarter',
    keyword: 'Project recap',
    outline: ['Objective', 'What happened', 'What we learned', 'Next steps'],
    card: true,
  },
  {
    key: 'private-notes',
    template: 'private-notes',
    name: 'Private notes',
    blurb: 'Somewhere to think before you share. A heading and a blank page.',
    icon: NotebookPen,
    gran: 'day',
    keyword: 'Doc',
    outline: ['Heading', 'Your notes'],
    card: true,
  },
  {
    key: 'running-notes',
    template: 'running-notes',
    name: 'Decision log',
    blurb: 'A project’s running notes: one dated row per decision or update, newest first.',
    icon: LayoutList,
    gran: 'none',
    keyword: 'Running notes',
    outline: ['Date', 'Decision or update', 'Source'],
    card: false,
  },
  {
    key: 'blank',
    template: 'blank',
    name: 'Blank',
    blurb: 'An empty page. Type - for a bullet, [] for a to-do, ## for a heading.',
    icon: FileText,
    gran: 'day',
    keyword: 'Doc',
    outline: ['Text'],
    card: true,
  },
];

export const templateDef = (key: TemplateKey) => TEMPLATES.find((t) => t.key === key)!;

/** The template key for a doc template id (other screens pass the id). */
export const keyFor = (t?: DocTemplate): TemplateKey => (t === 'running-notes' ? 'running-notes' : t ?? 'blank');

export const TEMPLATE_LABEL: Record<DocTemplate, string> = {
  blank: 'Doc',
  'private-notes': 'Private notes',
  'team-meeting': 'Team meeting',
  'one-on-one': '1:1 running notes',
  'project-recap': 'Project recap',
  'running-notes': 'Running record',
};

export const bid = () => uid('b');
export const text = (type: 'h2' | 'h3' | 'p' | 'bullet', t = ''): Block => ({ id: bid(), type, text: t });
export const todo = (t = ''): Block => ({ id: bid(), type: 'todo', text: t, checked: false });
export const table = (columns: string[], rows: string[][]): Block => ({ id: bid(), type: 'table', columns, rows });
export const fileBlock = (file: string): Block => ({ id: bid(), type: 'file', file });

export interface TemplateContext {
  date: Date;
  subject: string;
  project?: Project;
  event?: WEvent;
}

const attendees = (e?: WEvent) => (e && e.with.length ? `With ${e.with.map(personName).join(', ')}` : 'Attendees:');

/** The blocks a new doc starts with. */
export const buildBlocks = (key: TemplateKey, ctx: TemplateContext): Block[] => {
  const { date, project, event } = ctx;
  const meetingFiles = (event?.docs ?? []).map(fileBlock);
  switch (key) {
    case 'team-meeting':
      return [
        text('p', `${fmtLongDate(date)} · ${attendees(event)}`),
        text('h2', 'Decisions'),
        text('bullet'),
        text('h2', 'Notes'),
        text('bullet'),
        text('h2', 'Action items'),
        todo(),
        ...(meetingFiles.length ? [text('h2', 'Files for this meeting'), ...meetingFiles] : []),
      ];
    case 'one-on-one': {
      const who = event?.with.length ? event.with.map(firstName).join(' and ') : 'your teammate';
      return [
        text('p', `Weekly 1:1 with ${who}, newest date on top. Linked from the calendar invite so either of you can add a topic before the meeting.`),
        table(['Date', 'Agenda', 'Notes', 'Action items'], [[fmtDate(date), '', '', '']]),
      ];
    }
    case 'tracker':
      return [
        text('p', 'One row per topic. Owners update their rows before the weekly sync; anyone can add a topic.'),
        table(['Topic', 'Owner', 'Status', 'Next step'], [
          ['', '', '', ''],
          ['', '', '', ''],
        ]),
      ];
    case 'running-notes':
      return [
        text('p', 'Decisions and status, newest first.'),
        table(['Date', 'Decision or update', 'Source'], [[fmtDate(date), '', '']]),
      ];
    case 'project-recap': {
      const sources = (project?.sources ?? []).map(fileBlock);
      return [
        text('h2', 'Objective'),
        text('p', project?.goal ?? ''),
        text('h2', 'What happened'),
        text('bullet'),
        text('h2', 'What we learned'),
        text('bullet'),
        text('h2', 'Next steps'),
        todo(),
        ...(sources.length ? [text('h2', 'Files'), ...sources] : []),
      ];
    }
    case 'private-notes':
      return [text('h2', ctx.subject || 'Notes'), text('p')];
    default:
      return [text('p')];
  }
};

/* ───────────── Slide layout sets ───────────── */

export interface LayoutSet {
  id: 'briefing' | 'update' | 'proposal';
  name: string;
  blurb: string;
  slides: Omit<Slide, 'id'>[];
}

export const LAYOUT_SETS: LayoutSet[] = [
  {
    id: 'briefing',
    name: 'Briefing',
    blurb: 'Title, agenda, the numbers, discussion, next steps.',
    slides: [
      { title: 'Title', layout: 'title' },
      { title: 'Agenda', layout: 'bullets', bullets: ['Where we are', 'What changed', 'What we need'] },
      { title: 'The numbers', layout: 'chart', notes: 'Figures come from the working sheet. Keep the detail there.' },
      { title: 'Discussion', layout: 'bullets', bullets: ['Open question 1', 'Open question 2'] },
      { title: 'Next steps', layout: 'bullets', bullets: ['Owner, action, date'] },
    ],
  },
  {
    id: 'update',
    name: 'Project update',
    blurb: 'Progress, metrics, risks and the asks, in five slides.',
    slides: [
      { title: 'Project update', layout: 'title' },
      { title: 'Progress', layout: 'bullets', bullets: ['Done', 'In progress', 'Next'] },
      { title: 'Metrics', layout: 'chart' },
      { title: 'Risks', layout: 'bullets', bullets: ['Risk and mitigation'] },
      { title: 'Asks', layout: 'quote' },
    ],
  },
  {
    id: 'proposal',
    name: 'Proposal',
    blurb: 'The problem, your approach, pricing and how to start.',
    slides: [
      { title: 'Proposal', layout: 'title' },
      { title: 'The problem', layout: 'bullets', bullets: ['What it costs today'] },
      { title: 'Our approach', layout: 'bullets', bullets: ['How it works', 'What changes'] },
      { title: 'Pricing', layout: 'chart', confidential: true, notes: 'Internal: floor price and discount room.' },
      { title: 'Next steps', layout: 'bullets', bullets: ['Approval', 'Order form', 'Start date'] },
    ],
  },
];
