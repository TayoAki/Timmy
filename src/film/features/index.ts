// The feature films, by id: ?film=<id>. See common.ts.
import type { Film } from '../script';
import approvals from './approvals';
import ask from './ask';
import automations from './automations';
import brief from './brief';
import chat from './chat';
import docs from './docs';
import files from './files';
import inbox from './inbox';
import leads from './leads';
import outreach from './outreach';
import plan from './plan';
import projects from './projects';
import setup from './setup';
import speed from './speed';

export const FEATURES: Record<string, () => Film> = { inbox, brief, approvals, ask, docs, files, plan, projects, leads, outreach, speed, chat, automations, setup };
