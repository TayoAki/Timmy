/*
 * Connections and the policies that ride on them:
 *  - apps connected through Composio (simulated in this preview),
 *  - CRM writes that wait for RevOps once HubSpot or Salesforce is connected,
 *  - delegate mode, where an assistant works for an exec and some things wait for the exec,
 *  - enrichment and leads Timmy finds and adds itself, within a credit budget.
 *
 * Actions that need someone else's OK are held, not dropped: they wait in
 * Approvals under that person's name and run as they were once approved.
 */
import { NOW, PEOPLE } from '../data/mock';
import { APP, APPS, APPS_SEED, type AppConn } from '../data/connections';
import type { Activity } from '../data/types';
import type { FormSource, Lead } from '../data/outbound-types';
import { enrichLead, findLeads, readFind } from '../lib/enrich';
import { money } from '../lib/format';
import type { Action, State, Toast } from './store';
import { fullName } from './outbound';

export interface CrmPolicy {
  /** Who approves deal and stage writes before they reach the CRM. */
  approver: 'me' | 'revops';
  revops: string;
  /** Log calls and emails as CRM activity. */
  activity: boolean;
}

export interface Delegate {
  on: boolean;
  /** You, the assistant. */
  me: string;
  /** The person you work for. */
  exec: string;
  /** What waits for the exec's OK. */
  external: boolean;
  decisions: boolean;
}

export interface Enrichment {
  credits: number;
  monthly: number;
  /** Timmy may add and enrich leads it finds on its own, up to perDay a day. */
  autoFind: boolean;
  perDay: number;
  foundToday: number;
}

export interface Held {
  id: string;
  key: string;
  title: string;
  detail: string;
  waitingOn: 'exec' | 'revops';
  who: string;
  action: Action;
  at: Date;
  by: string;
}

export interface Connect {
  apps: Record<string, AppConn>;
  crm: CrmPolicy;
  delegate: Delegate;
  enrich: Enrichment;
  held: Held[];
}

export const connectSeed = (): Connect => ({
  apps: { ...APPS_SEED },
  crm: { approver: 'revops', revops: 'Morgan Diaz', activity: true },
  delegate: { on: false, me: 'Jess Park', exec: 'Taylor Brooks', external: true, decisions: true },
  enrich: { credits: 500, monthly: 500, autoFind: true, perDay: 25, foundToday: 0 },
  held: [],
});

export type ConnOp =
  | { op: 'connect'; id: string }
  | { op: 'adminConsent'; id: string }
  | { op: 'disconnect'; id: string }
  | { op: 'crm'; patch: Partial<CrmPolicy> }
  | { op: 'delegate'; patch: Partial<Delegate> }
  | { op: 'enrichPolicy'; patch: Partial<Enrichment> }
  | { op: 'enrich'; ids: string[] }
  | { op: 'find'; query: string; quiet?: boolean };

export interface ConnHelpers {
  toast: (s: State, text: string, opts?: { undo?: boolean; tone?: Toast['tone'] }) => Toast[];
  log: (s: State, text: string, kind: Activity['kind']) => Activity[];
}

/* ───────────── Selectors ───────────── */

export const isOn = (s: Pick<State, 'conn'>, id: string) => !!s.conn.apps[id]?.connected;
export const crmApp = (s: Pick<State, 'conn'>) => ['hubspot', 'salesforce', 'pipedrive'].find((id) => isOn(s, id));
/** The product film (?film) names no data partner: the deal isn't public. */
const FILM = typeof window !== 'undefined' && /[?&]film(=|&|$)/.test(window.location.search);
/** The enrichment provider Timmy uses: one you connected yourself, or else Treg, which is on for every workspace. */
export const enrichApp = (s: Pick<State, 'conn'>) => {
  const app = APPS.find((a) => a.group === 'Enrichment' && a.id !== 'treg' && isOn(s, a.id)) ?? APPS.find((a) => a.id === 'treg' && isOn(s, a.id));
  return app && FILM ? { ...app, name: 'your data provider' } : app;
};
export const heldKeys = (s: Pick<State, 'conn'>) => new Set(s.conn.held.map((h) => h.key));
const execFirst = (s: State) => s.conn.delegate.exec.split(' ')[0]!;

/* Lead sources appear in Speed to lead as sources of new leads. */
const SOURCE_FORM: Record<string, FormSource> = {
  zillow: { id: 'src-zillow', name: 'Zillow Premier Agent', kind: 'zillow', connected: true, sla: 5, autoReply: false, textToo: true, slack: true, template: 'tpl-speed' },
  realtor: { id: 'src-realtor', name: 'Realtor.com', kind: 'realtor', connected: true, sla: 5, autoReply: false, textToo: true, slack: true, template: 'tpl-speed' },
  fub: { id: 'src-fub', name: 'Follow Up Boss', kind: 'fub', connected: true, sla: 5, autoReply: false, textToo: false, slack: true, template: 'tpl-speed' },
  fbleads: { id: 'form-fb', name: 'Facebook Lead Ads', kind: 'facebook', connected: true, sla: 5, autoReply: false, textToo: false, slack: false, template: 'tpl-speed' },
};

/* ───────────── The reducer ───────────── */

export function connect(s: State, a: ConnOp, h: ConnHelpers): State {
  const c = s.conn;
  switch (a.op) {
    case 'connect': {
      const app = APP[a.id];
      if (!app || app.soon) return s;
      // Microsoft 365: the tenant admin approves mail and calendar access first.
      if (a.id === 'outlook') {
        return {
          ...s,
          conn: { ...c, apps: { ...c.apps, outlook: { connected: false, pendingAdmin: true, account: app.account } } },
          toasts: h.toast(s, 'Consent link sent to your Microsoft 365 admin. Outlook connects as soon as they approve.'),
        };
      }
      let out = s.out;
      const form = SOURCE_FORM[a.id];
      if (form) out = { ...out, forms: { ...out.forms, [form.id]: { ...(out.forms[form.id] ?? form), connected: true } } };
      if (a.id === 'twilio') out = { ...out, channels: { ...out.channels, ...(out.channels.sms ? { sms: { ...out.channels.sms, connected: true } } : {}), ...(out.channels.call ? { call: { ...out.channels.call, connected: true } } : {}) } };
      if (a.id === 'slack' && out.channels.slack) out = { ...out, channels: { ...out.channels, slack: { ...out.channels.slack, connected: true } } };
      if (['hubspot', 'salesforce', 'pipedrive'].includes(a.id) && out.channels.crm) out = { ...out, channels: { ...out.channels, crm: { ...out.channels.crm, connected: true, account: app.name } } };
      const extra = form ? ' New leads from it show up in Speed to lead and on Today.' : app.group === 'CRM' ? ` Deal and stage changes go to ${c.crm.approver === 'revops' ? `${c.crm.revops} (RevOps)` : 'you'} for approval before they sync.` : app.group === 'Enrichment' ? ' Timmy can now enrich leads and add leads it finds.' : '';
      return {
        ...s,
        out,
        conn: { ...c, apps: { ...c.apps, [a.id]: { connected: true, account: app.account, at: NOW } } },
        activity: h.log(s, `Connected ${app.name}`, 'approval'),
        toasts: h.toast(s, `${app.name} connected.${extra}`, { undo: true }),
      };
    }

    case 'adminConsent': {
      const app = APP[a.id];
      if (!app) return s;
      return {
        ...s,
        conn: { ...c, apps: { ...c.apps, [a.id]: { connected: true, account: app.account, at: NOW } } },
        activity: h.log(s, `Connected ${app.name} after admin approval`, 'approval'),
        toasts: h.toast(s, `${app.name} connected. Mail and calendar from it show up alongside Gmail.`),
      };
    }

    case 'disconnect': {
      const app = APP[a.id];
      if (!app) return s;
      let out = s.out;
      const form = SOURCE_FORM[a.id];
      if (form && out.forms[form.id]) out = { ...out, forms: { ...out.forms, [form.id]: { ...out.forms[form.id]!, connected: false } } };
      if (a.id === 'twilio') out = { ...out, channels: { ...out.channels, ...(out.channels.sms ? { sms: { ...out.channels.sms, connected: false } } : {}), ...(out.channels.call ? { call: { ...out.channels.call, connected: false } } : {}) } };
      return {
        ...s,
        out,
        conn: { ...c, apps: { ...c.apps, [a.id]: { connected: false } } },
        activity: h.log(s, `Disconnected ${app.name}`, 'approval'),
        toasts: h.toast(s, `${app.name} disconnected. Timmy stops reading from it.`, { undo: true }),
      };
    }

    case 'crm':
      return { ...s, conn: { ...c, crm: { ...c.crm, ...a.patch } }, toasts: a.patch.approver ? h.toast(s, a.patch.approver === 'revops' ? `CRM changes now wait for ${c.crm.revops} (RevOps).` : 'CRM changes now wait for your OK.') : s.toasts };

    case 'delegate':
      return {
        ...s,
        conn: { ...c, delegate: { ...c.delegate, ...a.patch } },
        toasts: a.patch.on !== undefined ? h.toast(s, a.patch.on ? `You’re working for ${c.delegate.exec}. What needs ${execFirst(s)}’s OK goes to them, and the log records who did what.` : 'Delegate mode is off.') : s.toasts,
      };

    case 'enrichPolicy':
      return { ...s, conn: { ...c, enrich: { ...c.enrich, ...a.patch } } };

    case 'enrich': {
      const app = enrichApp(s);
      if (!app) return { ...s, toasts: h.toast(s, 'Connect an enrichment provider first (Connections › Enrichment).', { tone: 'warn' }) };
      const cost = app.credits ?? 1;
      const leads = { ...s.out.leads };
      let used = 0;
      let done = 0;
      let skipped = 0;
      for (const id of a.ids) {
        const l = leads[id];
        if (!l) continue;
        const { patch, filled } = enrichLead(l, app.id);
        if (!filled.length) {
          skipped++;
          continue;
        }
        if (c.enrich.credits - used < cost) break;
        leads[id] = { ...l, ...patch, enriched: { by: app.name, at: NOW, fields: filled } };
        used += cost;
        done++;
      }
      if (!done) return { ...s, toasts: h.toast(s, skipped ? 'Those leads already have every field enrichment fills.' : 'Not enough enrichment credits left this month.', { tone: 'warn' }) };
      return {
        ...s,
        out: { ...s.out, leads },
        conn: { ...c, enrich: { ...c.enrich, credits: c.enrich.credits - used } },
        activity: h.log(s, `Enriched ${done} lead${done === 1 ? '' : 's'} with ${app.name} (${used} credits)`, 'triage'),
        toasts: h.toast(s, `Enriched ${done} lead${done === 1 ? '' : 's'} with ${app.name}: ${used} credits, ${c.enrich.credits - used} left this month.${skipped ? ` ${skipped} already complete.` : ''}`, { undo: true }),
      };
    }

    case 'find': {
      const want = readFind(a.query);
      const room = Math.max(0, c.enrich.perDay - c.enrich.foundToday);
      const count = Math.min(want.count, room);
      if (!count) return { ...s, toasts: h.toast(s, `Timmy already added ${c.enrich.perDay} leads today, the daily limit you set.`, { tone: 'warn' }) };
      const taken = new Set(Object.values(s.out.leads).map((l) => l.email.toLowerCase()));
      let found = findLeads(s.out.offer, { ...want, count }, taken, Object.keys(s.out.leads).length + c.enrich.foundToday * 97 + 7, NOW);
      const app = enrichApp(s);
      let used = 0;
      if (app) {
        const cost = app.credits ?? 1;
        found = found.map((l) => {
          if (c.enrich.credits - used < cost) return l;
          const { patch, filled } = enrichLead(l, app.id);
          used += cost;
          return { ...l, ...patch, phone: patch.phone ?? l.phone, enriched: { by: app.name, at: NOW, fields: filled.length ? filled : ['phone'] } };
        });
      }
      const leads = { ...s.out.leads };
      for (const l of found) leads[l.id] = l;
      const lists = s.out.lists['list-found'] ? s.out.lists : { ...s.out.lists, 'list-found': { id: 'list-found', name: 'Found by Timmy', source: 'found' as const, created: NOW } };
      return {
        ...s,
        out: { ...s.out, leads, lists },
        conn: { ...c, enrich: { ...c.enrich, credits: c.enrich.credits - used, foundToday: c.enrich.foundToday + found.length } },
        activity: h.log(s, `Found and added ${found.length} leads that fit your offer${app ? `, enriched with ${app.name}` : ''}`, 'triage'),
        toasts: a.quiet ? s.toasts : h.toast(s, `Timmy added ${found.length} leads to “Found by Timmy”${app ? `, enriched with ${app.name} (${used} credits)` : ''}. Nothing was sent.`, { undo: true }),
      };
    }
  }
}

/* ───────────── Who has to say yes ───────────── */

const isExternal = (ids: string[]) => ids.some((id) => !PEOPLE[id]?.internal && id !== 'me');

/**
 * Returns a held version of the state when this action needs someone else's
 * OK first: CRM writes go to RevOps; in delegate mode, decisions and external
 * sends go to the exec. Returns null when the action can run now.
 */
export function gate(s: State, a: Action, h: ConnHelpers): State | null {
  if ('approved' in a && a.approved) return null;
  const c = s.conn;
  const hold = (held: Omit<Held, 'id' | 'at' | 'by'>): State => {
    if (c.held.some((x) => x.key === held.key)) return { ...s, toasts: h.toast(s, `Already waiting on ${held.who}.`) };
    const item: Held = { ...held, id: `held-${Date.now().toString(36)}-${c.held.length}`, at: NOW, by: c.delegate.on ? c.delegate.me : 'you' };
    return {
      ...s,
      conn: { ...c, held: [item, ...c.held] },
      activity: h.log(s, `Sent to ${held.who} for approval: ${held.title}`, 'approval'),
      toasts: h.toast(s, `Sent to ${held.who} for approval. ${held.waitingOn === 'revops' ? 'The CRM changes when they approve.' : 'It goes out when they approve.'}`),
    };
  };
  const revops = crmApp(s) && c.crm.approver === 'revops';

  if (revops && (a.type === 'applyDeal' || a.type === 'editDeal' || (a.type === 'resolve' && a.key.startsWith('crm:') && a.option === 'apply' && a.change))) {
    const id = a.type === 'resolve' ? a.key.slice(4) : a.id;
    const deal = s.deals[id];
    if (!deal) return null;
    const what =
      a.type === 'resolve' && a.change
        ? `${a.change.stage}, ${money(a.change.value)}`
        : a.type === 'editDeal'
          ? [a.stage, a.value !== undefined ? money(a.value) : ''].filter(Boolean).join(', ')
          : 'the change Timmy suggested';
    return hold({ key: `crm:${id}`, title: `Update ${deal.company}: ${what}`, detail: `${APP[crmApp(s)!]!.name} deal “${deal.company} ${deal.name}”. RevOps signs off on deal and stage writes.`, waitingOn: 'revops', who: `${c.crm.revops} (RevOps)`, action: { ...a, approved: true } as Action });
  }

  if (c.delegate.on) {
    if (c.delegate.decisions && a.type === 'resolve' && a.key.startsWith('dec:')) {
      const dec = s.decisions.find((x) => x.id === a.key.slice(4));
      const opt = dec?.options.find((o) => o.id === a.option);
      if (dec && opt && !dec.chosen) return hold({ key: a.key, title: `${dec.title} → ${opt.label}`, detail: `Your recommendation for ${execFirst(s)}: ${opt.label}.`, waitingOn: 'exec', who: c.delegate.exec, action: { ...a, approved: true } });
    }
    if (c.delegate.external && a.type === 'sendDraft') {
      const t = s.threads.find((x) => x.id === a.id);
      if (t?.draft && isExternal(t.draft.to)) return hold({ key: `draft:${t.id}`, title: `Send “${t.draft.subject}”`, detail: `To ${t.draft.to.map((p) => PEOPLE[p]?.name ?? p).join(', ')}, from ${execFirst(s)}’s mailbox.`, waitingOn: 'exec', who: c.delegate.exec, action: { ...a, approved: true } });
    }
  }
  return null;
}

/** For the lead table: who found or enriched this lead. */
export const leadOrigin = (l: Lead) => (l.source === 'found' ? 'Found by Timmy' : l.source === 'chat' ? 'Website chat' : l.enriched ? `Enriched · ${l.enriched.by}` : undefined);
export { fullName };
