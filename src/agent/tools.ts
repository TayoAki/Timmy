/*
 * The widgets Timmy can put in the conversation, declared as AG-UI frontend
 * tools. Any AG-UI agent (the local one in agent.ts, or a server agent later)
 * receives these in RunAgentInput.tools and "calls" one to show live app UI;
 * the page renders the call with the matching widget in widgets.tsx.
 * Widgets that change something only do it when you press their button.
 */
import type { Tool } from '@ag-ui/core';

export type WidgetName = 'show_urgent' | 'show_approvals' | 'show_day' | 'show_pipeline' | 'show_thread' | 'show_answer';

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });

export const TOOLS: Tool[] = [
  {
    name: 'show_urgent',
    description: 'Show open email ranked by urgency, with the reasons and a way to open or draft each one.',
    parameters: obj({ limit: { type: 'number', description: 'How many threads to show' }, level: { type: 'string', enum: ['urgent', 'all'] } }),
  },
  {
    name: 'show_approvals',
    description: 'Show what is waiting for the user’s approval (emails to send, decisions, CRM updates, invites) with approve buttons.',
    parameters: obj({ limit: { type: 'number' }, kind: { type: 'string', enum: ['email', 'decision', 'crm', 'calendar'] } }),
  },
  {
    name: 'show_day',
    description: 'Show a day’s calendar with the free time between meetings.',
    parameters: obj({ date: { type: 'string', description: 'yyyy-mm-dd; today if omitted' } }),
  },
  {
    name: 'show_pipeline',
    description: 'Show open deals with stage, value, next step and due date.',
    parameters: obj({}),
  },
  {
    name: 'show_thread',
    description: 'Show one email thread: what it needs, its next actions and Timmy’s draft, with send buttons.',
    parameters: obj({ id: { type: 'string' } }, ['id']),
  },
  {
    name: 'show_answer',
    description:
      'Show bullet points, links into the app, and choices. A choice carries Timmy app actions (a focus block, a task, a schedule change, a new doc) that run only when the user presses it.',
    parameters: obj({ bullets: { type: 'array' }, links: { type: 'array' }, choices: { type: 'array' } }),
  },
];
