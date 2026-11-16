import { initial, type State } from '../state/store';
import { DEFAULT_SCHEDULE } from '../state/schedule';
import { WS_COLLECTIONS } from './patches';

/** Rules every new workspace starts with. The demo's own rules about its sample folders and deals are left out. */
const STARTER_RULES = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'u1', 'u2', 'u3', 'u4', 'u6', 'u7', 'p1', 'p2', 'p3', 'p4', 'p5', 'w1', 'w2', 'w3', 's1', 's2', 's4'];

export interface BlankOptions {
  /** The person's first name, for the sign-off rule. */
  first: string;
  /** The workspace's name. */
  company: string;
}

/**
 * A new workspace before anything is connected: no mail, no deals, no leads.
 * Settings start at the product's defaults; nothing from the demo's sample data comes along.
 */
export function blankState({ first, company }: BlankOptions): State {
  const seed = initial.out;
  return {
    ...initial,
    threads: [],
    deals: {},
    activity: [],
    rules: initial.rules
      .filter((r) => STARTER_RULES.includes(r.id))
      .map((r) => ({ ...r, hits: 0, text: r.id === 'w3' ? `Sign off with “Best, ${first}”. No exclamation marks in customer emails.` : r.text })),
    route: { view: 'today', tab: 'brief' },
    back: { view: 'today', tab: 'brief' },
    highlight: '',
    highlightDone: false,
    dismissed: [],
    toasts: [],
    ws: {
      ...(Object.fromEntries(WS_COLLECTIONS.map((c) => [c, {}])) as unknown as State['ws']),
      // The website chat's settings always exist, switched off and empty until the person sets it up.
      chat: {
        site: { id: 'site', on: false, domain: '', name: company, color: '#3f51d9', greeting: `Hi! Ask a question, or leave your email and ${first} will follow up.`, questions: [], faq: [], handoff: 'notify', booking: false },
      },
    },
    decisions: [],
    approvalLog: [],
    schedule: DEFAULT_SCHEDULE,
    focus: false,
    scope: null,
    calm: false,
    showDeals: true,
    out: {
      leads: {},
      lists: {},
      offer: { name: `${company} offer`, product: company, audience: '', pain: '', outcome: '', proof: '', cta: 'Open to a quick call next week?', icp: { titles: [], industries: [], minEmployees: 1, maxEmployees: 10000 } },
      templates: Object.fromEntries(Object.values(seed.templates).filter((t) => t.builtIn).map((t) => [t.id, t])),
      campaigns: {},
      mailboxes: {},
      channels: Object.fromEntries(Object.values(seed.channels).map((c) => [c.id, { id: c.id, name: c.name, connected: false, use: c.use, ...(c.dailyLimit ? { dailyLimit: c.dailyLimit, sentToday: 0 } : {}) }])),
      limits: seed.limits,
      messages: [],
      forms: {},
      posts: {},
    },
    conn: {
      apps: {},
      crm: { approver: 'me', revops: '', activity: true },
      delegate: { on: false, me: '', exec: '', external: true, decisions: true },
      enrich: { credits: 0, monthly: 0, autoFind: false, perDay: 25, foundToday: 0 },
      held: [],
    },
    clients: { active: 'own', names: { own: company }, stash: {} },
    pending: [],
    run: null,
  };
}
