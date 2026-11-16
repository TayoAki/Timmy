/*
 * Enrichment and lead finding for the preview. In the product these calls go
 * to the connected provider: Treg (one token for many data providers), or
 * Apollo, Clay, People Data Labs, Hunter or your own API through Composio.
 * Here they return sample data, deterministically, so nothing leaves the
 * browser. Enrichment only fills fields that are empty.
 */
import type { Lead, Offer } from '../data/outbound-types';
import { hash } from './outbound';

const FIRST = ['Ava', 'Marcus', 'Priya', 'Daniel', 'Sofia', 'Ethan', 'Leah', 'Omar', 'Grace', 'Noah', 'Isla', 'Victor', 'Hana', 'Felix', 'Rosa', 'Caleb', 'Nina', 'Theo', 'Mira', 'Jonah'];
const LAST = ['Chen', 'Alvarez', 'Okafor', 'Novak', 'Reyes', 'Larsen', 'Brennan', 'Haddad', 'Ito', 'Mensah', 'Varga', 'Quinn', 'Sato', 'Duarte', 'Kowalski', 'Ward', 'Ibrahim', 'Castillo', 'Moreau', 'Hart'];
const CITIES = ['Austin, TX', 'Denver, CO', 'Columbus, OH', 'Raleigh, NC', 'Phoenix, AZ', 'Nashville, TN', 'Portland, OR', 'Tampa, FL', 'Madison, WI', 'Boise, ID'];
const PREFIX = ['Cedar', 'Summit', 'Harbor', 'Bright', 'North', 'Willow', 'Granite', 'Blue Ridge', 'Lakeside', 'Pioneer', 'Evergreen', 'Riverbend'];
const SUFFIX: Record<string, string[]> = {
  health: ['Health Partners', 'Medical Group', 'Clinic'],
  medical: ['Medical Group', 'Family Medicine', 'Clinics'],
  dental: ['Dental', 'Dental Studio', 'Smiles'],
  staffing: ['Staffing', 'Talent', 'Workforce'],
  logistics: ['Freight', 'Logistics', 'Distribution'],
  facilities: ['Facility Services', 'Building Services', 'Maintenance'],
  veterinary: ['Veterinary', 'Animal Hospital', 'Pet Clinic'],
  default: ['Group', 'Partners', 'Co.'],
};
const INDUSTRY: Record<string, string> = {
  health: 'Hospitals & Health Care',
  medical: 'Medical Practices',
  dental: 'Dental Practices',
  staffing: 'Staffing & Recruiting',
  logistics: 'Logistics & Supply Chain',
  facilities: 'Facilities Services',
  veterinary: 'Veterinary Services',
};
const TITLE: Record<string, string> = {
  operations: 'Director of Operations',
  coo: 'COO',
  'chief operating': 'Chief Operating Officer',
  'practice manager': 'Practice Manager',
  'chief of staff': 'Chief of Staff',
};

const pick = <T,>(xs: T[], n: number) => xs[Math.abs(n) % xs.length]!;
const slug = (x: string) => x.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The fields enrichment fills, in the order a person reads them. */
export const ENRICH_FIELDS: (keyof Lead)[] = ['title', 'phone', 'linkedin', 'website', 'employees', 'industry', 'city'];

/** Fills what's missing on a lead. Returns the patch and the names of the fields it filled. */
export function enrichLead(lead: Lead, provider: string): { patch: Partial<Lead>; filled: string[] } {
  const h = hash(`${lead.id}:${provider}`);
  const domain = lead.email.split('@')[1] ?? `${slug(lead.company)}.example`;
  const guess: Partial<Lead> = {
    title: TITLE[pick(Object.keys(TITLE), h)],
    phone: `+1 555 0${String(100 + (h % 899)).padStart(3, '0')}`,
    linkedin: `linkedin.com/in/${slug(`${lead.first}-${lead.last}`)}-${(h % 90) + 10}`,
    website: domain,
    employees: 20 + (h % 230),
    industry: INDUSTRY[pick(Object.keys(INDUSTRY), h >> 3)],
    city: pick(CITIES, h >> 5),
  };
  const patch: Partial<Lead> = {};
  const filled: string[] = [];
  for (const k of ENRICH_FIELDS) {
    if (lead[k] === undefined || lead[k] === '' || lead[k] === null) {
      (patch as Record<string, unknown>)[k] = guess[k];
      filled.push(String(k));
    }
  }
  return { patch, filled };
}

/** Reads "find 10 dental clinics in Austin" into a count, an industry and a city. */
export function readFind(q: string): { count: number; industry?: string; city?: string } {
  const l = q.toLowerCase();
  const n = Number(l.match(/\b(\d{1,3})\b/)?.[1] ?? 10);
  // A named industry wins; "clinics" or "practices" alone mean medical.
  const industry = Object.keys(INDUSTRY).find((k) => l.includes(k)) ?? (/\bvet/.test(l) ? 'veterinary' : /clinic|practice|doctor/.test(l) ? 'medical' : undefined);
  const city = CITIES.find((c) => l.includes(c.split(',')[0]!.toLowerCase()));
  return { count: Math.max(1, Math.min(n, 50)), industry, city };
}

/**
 * Sample leads that fit your offer's ideal customer. In the product this is a
 * search on the connected provider, filtered by the same fit rules.
 */
export function findLeads(offer: Offer, want: { count: number; industry?: string; city?: string }, taken: Set<string>, seed: number, at: Date): Lead[] {
  const out: Lead[] = [];
  const inds = want.industry ? [want.industry] : offer.icp.industries.map((x) => x.toLowerCase()).filter((x) => INDUSTRY[x]);
  const titles = offer.icp.titles.map((t) => TITLE[t.toLowerCase()] ?? t);
  for (let i = 0; out.length < want.count && i < want.count * 4; i++) {
    const h = hash(`${seed}:${i}`);
    const ind = pick(inds.length ? inds : ['health'], h);
    const company = `${pick(PREFIX, h >> 2)} ${pick(SUFFIX[ind] ?? SUFFIX.default!, h >> 4)}`;
    const first = pick(FIRST, h >> 6);
    const last = pick(LAST, h >> 9);
    const domain = `${slug(company)}.example`;
    const email = `${first.toLowerCase()}.${last.toLowerCase()}@${domain}`;
    if (taken.has(email)) continue;
    taken.add(email);
    const span = Math.max(1, offer.icp.maxEmployees - offer.icp.minEmployees);
    out.push({
      id: `found-${seed.toString(36)}-${i}`,
      first,
      last,
      email,
      title: pick(titles.length ? titles : ['Director of Operations'], h >> 11),
      company,
      website: domain,
      employees: offer.icp.minEmployees + (h % span),
      industry: INDUSTRY[ind] ?? 'Professional Services',
      city: want.city ?? pick(CITIES, h >> 13),
      source: 'found',
      list: 'list-found',
      added: at,
      status: 'new',
    });
  }
  return out;
}
