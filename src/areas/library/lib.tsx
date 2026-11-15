/*
 * AI library helpers: prompt outputs and use cases, and what a routine's
 * saved links point at.
 */
import { CalendarDays, ChartColumn, FileText, FolderKanban, House, Library, ListChecks, Mail, MessageSquare, Presentation, Tag, User, Users, type LucideIcon } from 'lucide-react';
import { BOXES, PEOPLE } from '../../data/mock';
import type { Prompt, WS } from '../../data/ws-types';
import { kindMeta } from '../../components/DocBits';
import { shortPath } from '../files/drive';

export type Output = NonNullable<Prompt['output']>;

export const OUTPUTS: { id: Output; label: string; icon: LucideIcon }[] = [
  { id: 'email', label: 'Email', icon: Mail },
  { id: 'doc', label: 'Doc', icon: FileText },
  { id: 'slides', label: 'Slides', icon: Presentation },
  { id: 'analysis', label: 'Analysis', icon: ChartColumn },
];

export const outputMeta = (o?: Output) => OUTPUTS.find((x) => x.id === o);

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const filedPrompts = (ws: WS) => Object.values(ws.prompts).filter((p) => p.status === 'filed');
export const capturedPrompts = (ws: WS) =>
  Object.values(ws.prompts)
    .filter((p) => p.status === 'captured')
    .sort((a, b) => b.created.getTime() - a.created.getTime());

/** Use cases in use, alphabetically, with how many filed prompts each holds. */
export const useCases = (ws: WS) => {
  const counts = new Map<string, number>();
  for (const p of filedPrompts(ws)) counts.set(p.useCase ?? 'Other', (counts.get(p.useCase ?? 'Other') ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count }));
};

/* ───────────── Routine links ───────────── */

export interface LinkInfo {
  label: string;
  where: string;
  icon: LucideIcon;
}

const SECTIONS: Record<string, { label: string; where: string; icon: LucideIcon }> = {
  today: { label: 'Today', where: 'Brief and triage', icon: House },
  tasks: { label: 'Tasks board', where: 'Tasks', icon: ListChecks },
  calendar: { label: 'This week’s calendar', where: 'Calendar, week view', icon: CalendarDays },
  people: { label: 'People', where: 'CRM, priority contacts', icon: Users },
  docs: { label: 'Docs', where: 'Recent docs', icon: FileText },
  library: { label: 'AI library', where: 'Prompts', icon: Library },
};

/** What a saved link opens, in words, e.g. "Sheet in [02] Work › [12] Q4 QBR". */
export const linkInfo = (ws: WS, href: string): LinkInfo => {
  const [kind, id = ''] = href.split(':');
  switch (kind) {
    case 'file': {
      const f = ws.files[id];
      if (!f) return { label: 'Missing file', where: 'File no longer exists', icon: FileText };
      return { label: f.name, where: `${kindMeta(f.kind).label} in ${shortPath(ws, f.folder)}`, icon: kindMeta(f.kind).icon };
    }
    case 'box': {
      const b = BOXES.find((x) => x.id === id);
      const p = ws.projects[id];
      if (b) return { label: `[${b.num}] ${b.name}`, where: 'Mail label', icon: Tag };
      if (p) return { label: `[${p.num}] ${p.name}`, where: 'Project mail label', icon: Tag };
      return { label: id, where: 'Mail label', icon: Tag };
    }
    case 'thread':
      return { label: 'Email thread', where: 'Mail', icon: MessageSquare };
    case 'project': {
      const p = ws.projects[id];
      return { label: p?.name ?? id, where: 'Project page', icon: FolderKanban };
    }
    case 'contact':
      return { label: ws.contacts[id]?.name ?? PEOPLE[id]?.name ?? id, where: 'Contact', icon: User };
    default:
      return SECTIONS[kind ?? ''] ?? SECTIONS.today!;
  }
};

/** Everything a routine can link to, grouped for a picker. */
export const linkOptions = (ws: WS) => {
  const files = Object.values(ws.files)
    .filter((f) => !f.shortcutOf && f.folder !== 'filing')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => ({ href: `file:${f.id}`, label: f.name }));
  const labels = [
    ...BOXES.map((b) => ({ href: `box:${b.id}`, label: `[${b.num}] ${b.name}` })),
    ...Object.values(ws.projects)
      .filter((p) => p.status === 'active')
      .map((p) => ({ href: `box:${p.id}`, label: `[${p.num}] ${p.name}` })),
  ];
  const sections = [
    ...Object.entries(SECTIONS).map(([href, s]) => ({ href, label: s.label })),
    ...Object.values(ws.projects)
      .filter((p) => p.status === 'active')
      .map((p) => ({ href: `project:${p.id}`, label: `${p.name} project page` })),
  ];
  return [
    { group: 'Files', items: files },
    { group: 'Mail labels', items: labels },
    { group: 'App sections', items: sections },
  ];
};
