/**
 * A stand-in for Treg's routed lookups, used by the tests and by servers run on stand-ins. It answers with made-up
 * companies and people on `.example` domains (a name reserved for examples, so nothing here is a real business or
 * person), the way Treg's normalized `output` would, and charges like Treg does: a found email costs, a miss is free,
 * and a replay of the same idempotency key is answered again at no charge. Every call is kept in `calls`.
 */
import type { TregCall, TregEngine, TregRequest } from '../treg/client';
import { TregError, tregRefusal } from '../treg/errors';

/** What each lookup costs here, in millionths of a dollar. */
export const FAKE_TREG_COST: Record<string, number> = {
  'treg.companies.search': 30_000,
  'treg.people.search': 10_000,
  'treg.people.email.find': 5_000,
  'treg.people.email.verify': 1_000,
  'treg.companies.enrich': 2_000,
  'treg.web.extract': 250,
};

const PREFIX = ['Cedar', 'Summit', 'Harbor', 'Bright', 'Willow', 'Granite', 'Lakeside', 'Pioneer', 'Evergreen', 'Riverbend', 'Northgate', 'Maple'];
const KIND: Record<string, string[]> = {
  dental: ['Dental Studio', 'Family Dental', 'Smiles'],
  clinic: ['Medical Group', 'Family Clinic', 'Health Partners'],
  logistics: ['Freight', 'Logistics', 'Distribution'],
  staffing: ['Staffing', 'Talent', 'Workforce'],
  default: ['Group', 'Partners', 'Co'],
};
const FIRST = ['Ava', 'Marcus', 'Priya', 'Daniel', 'Sofia', 'Ethan', 'Leah', 'Omar', 'Grace', 'Noah', 'Isla', 'Victor'];
const LAST = ['Chen', 'Alvarez', 'Okafor', 'Novak', 'Reyes', 'Larsen', 'Brennan', 'Haddad', 'Ito', 'Mensah', 'Varga', 'Quinn'];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

function kindOf(words: string): keyof typeof KIND {
  const w = words.toLowerCase();
  if (/dent/.test(w)) return 'dental';
  if (/clinic|medical|health|doctor/.test(w)) return 'clinic';
  if (/freight|logistic|truck/.test(w)) return 'logistics';
  if (/staff|recruit/.test(w)) return 'staffing';
  return 'default';
}

/** The made-up companies a search for these words finds, the same ones every time. */
export function fakeCompanies(words: string, n: number, offset = 0) {
  const kind = kindOf(words);
  const city = /austin/i.test(words) ? 'Austin, TX, US' : /denver/i.test(words) ? 'Denver, CO, US' : 'Portland, OR, US';
  return Array.from({ length: n }, (_, j) => {
    const i = j + offset;
    // A name of its own for each: after the first dozen, a number tells them apart.
    const name = `${PREFIX[i % PREFIX.length]} ${KIND[kind]![i % KIND[kind]!.length]}${i >= PREFIX.length ? ` ${Math.floor(i / PREFIX.length) + 1}` : ''}`;
    const domain = `${slug(name)}.example`;
    const industry = kind === 'dental' ? 'Dental Practices' : kind === 'clinic' ? 'Medical Practices' : kind === 'logistics' ? 'Logistics & Supply Chain' : kind === 'staffing' ? 'Staffing & Recruiting' : 'Professional Services';
    return { name, domain, industry, employees: 12 + ((hash(domain) % 9) * 11), location: city, description: `${name} is a ${industry.toLowerCase()} business in ${city.split(',')[0]} with ${2 + (hash(domain) % 4)} locations.` };
  });
}

export class FakeTreg implements TregEngine {
  calls: TregRequest[] = [];
  failNext: Record<string, { status: number; body: Record<string, unknown>; treg?: boolean; retryAfter?: string }> = {};
  private seen = new Set<string>();
  private n = 0;

  reset() {
    this.calls = [];
    this.failNext = {};
    this.seen.clear();
  }

  async call<T>(req: TregRequest): Promise<TregCall<T>> {
    // Treg refuses a malformed tag bag before relaying anything.
    if (!/^([a-z_]+=[A-Za-z0-9._:-]{1,128})(,[a-z_]+=[A-Za-z0-9._:-]{1,128}){0,4}$/.test(req.meta) || /@/.test(req.meta)) throw tregRefusal(422, { error: 'invalid_tags' }, true, null);
    this.calls.push(req);
    const f = this.failNext[req.route];
    if (f) {
      delete this.failNext[req.route];
      throw tregRefusal(f.status, f.body, f.treg ?? true, f.retryAfter ?? null);
    }
    const replay = this.seen.has(req.idempotencyKey);
    this.seen.add(req.idempotencyKey);
    const b = req.body;
    let output: Record<string, unknown>;
    let charged = true;
    let verification: { verdict: string } | undefined;
    switch (req.route) {
      case 'treg.companies.search': {
        const words = [b.q, b.industry, b.name].filter(Boolean).join(' ');
        const offset = Number(b.cursor ?? 0) || 0;
        const limit = Math.min(Number(b.limit ?? 10) || 10, 50);
        output = { companies: fakeCompanies(words, limit, offset), count: limit, next_cursor: String(offset + limit) };
        break;
      }
      case 'treg.people.search': {
        const domain = String(b.company_domain ?? '');
        const title = String(b.title ?? 'Owner');
        const limit = Math.min(Number(b.limit ?? 10) || 10, 10);
        // A company whose name says it has nobody listed answers with no one, as a real miss does.
        if (/maple/.test(domain)) {
          output = { people: [], count: 0, next_cursor: null };
          charged = false;
          break;
        }
        const h = hash(domain);
        output = {
          people: Array.from({ length: Math.min(limit, 1) }, (_, i) => {
            const first = FIRST[(h + i) % FIRST.length]!;
            const last = LAST[(h >> 3) % LAST.length]!;
            return { full_name: `${first} ${last}`, first_name: first, last_name: last, title, company_domain: domain, linkedin_url: `https://www.linkedin.com/in/${slug(`${first}-${last}`)}-example` };
          }),
          count: 1,
          next_cursor: null,
        };
        break;
      }
      case 'treg.people.email.find': {
        const domain = String(b.domain ?? '');
        const first = String(b.first_name ?? String(b.full_name ?? '').split(' ')[0] ?? '').toLowerCase();
        const last = String(b.last_name ?? String(b.full_name ?? '').split(' ').slice(1).join(' ') ?? '').toLowerCase();
        // One kind of company has no findable address; another's can't be confirmed (it accepts all mail).
        if (!domain || !first || /northgate/.test(domain)) {
          output = { email: null };
          charged = false;
          break;
        }
        output = { email: `${first}.${last}@${domain}`, confidence: 0.92, first_name: b.first_name, last_name: b.last_name, verified: !/granite/.test(domain) };
        if (req.headers?.['x-treg-route-verify'] === 'true') verification = { verdict: /granite/.test(domain) ? 'accept_all' : 'valid' };
        break;
      }
      case 'treg.people.email.verify': {
        const email = String(b.email ?? '');
        output = { valid: !/invalid|granite/.test(email), status: /granite/.test(email) ? 'accept_all' : /invalid/.test(email) ? 'invalid' : 'valid', score: /invalid/.test(email) ? 5 : 95 };
        break;
      }
      case 'treg.companies.enrich': {
        const domain = String(b.domain ?? '');
        const c = fakeCompanies(domain, 1)[0]!;
        output = { ...c, domain, website: `https://${domain}` };
        break;
      }
      case 'treg.web.extract': {
        const url = String(b.url ?? '');
        const host = url.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
        const brand = host.split('.')[0]!.replace(/(^|-)([a-z])/g, (_m, s: string, c: string) => `${s ? ' ' : ''}${c.toUpperCase()}`);
        output = {
          pages: [
            {
              url,
              // A page with "no-proof" in its address has no customer result on it.
              markdown: `# ${brand}\n\n${brand} sends text reminders that cut no-shows for dental practices.\n\nDental practices with 5 to 50 staff use ${brand} to fill their chairs.\n\n${/no-proof/.test(url) ? '' : `Clinics that switched to ${brand} cut missed appointments by 30% in three months.\n\n`}Book a 15-minute demo to see it on your own schedule.`,
            },
          ],
          count: 1,
        };
        break;
      }
      default:
        throw new TregError(404, 'Unknown lookup.');
    }
    const found = charged && !(req.route === 'treg.people.email.find' && !output.email);
    const cost = replay || !found ? 0 : FAKE_TREG_COST[req.route] ?? 0;
    this.n += 1;
    return { answer: { output: output as T, _treg: { served_by: 'sample', ...(verification ? { verification } : {}) } }, costMicro: cost, callId: `fake-call-${this.n}`, servedBy: 'sample' };
  }
}
