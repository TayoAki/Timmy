/**
 * Sample contracting data, in Kontract's own shapes (kontract-api.ts): the sample demo's Bids screens show it, and
 * the server's stand-in engine (server/src/testing/kontract.ts) answers with it. Every notice, agency office,
 * business and award here is made up, and each notice is marked as a sample, so nothing links to a real record.
 */
import type { BidDetails, Breakdown, Opportunity, PastAward, PermitContractor, PricingStats, RecipientSummary, SiteFacts, FoundSub } from './kontract-api';

const DAY = 86_400_000;
const at = (now: Date, days: number, hour = 17) => {
  const d = new Date(now.getTime() + days * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

/** The sample notices, dated from `now` so their deadlines are always ahead. */
export function sampleOpportunities(now: Date): Opportunity[] {
  const base = { contacts: [], attachments: null, source: 'sample' as const, isSample: true };
  return [
    {
      ...base,
      id: 'sample-janitorial-va',
      title: 'Janitorial Services, Cascade VA Medical Center',
      solicitationNumber: 'SAMPLE-36C260-0142',
      agency: 'Department of Veterans Affairs',
      office: 'Network Contracting Office 20 (sample)',
      postedDate: at(now, -5, 15),
      responseDeadline: at(now, 12),
      type: 'Combined Synopsis/Solicitation',
      setAside: 'Total Small Business Set-Aside (FAR 19.5)',
      setAsideCode: 'SBA',
      naicsCode: '561720',
      pscCode: 'S201',
      placeOfPerformance: { city: 'Portland', state: 'OR', country: 'USA' },
      samUrl: '',
      level: 'federal',
      serviceKind: 'service',
      description:
        'The medical center needs daily janitorial services for Buildings 100 and 101 (about 84,000 square feet), with quarterly floor care.\n\nThe contract is one base year and four option years. Offers are evaluated on lowest price, technically acceptable.',
    },
    {
      ...base,
      id: 'sample-grounds-usfs',
      title: 'Grounds Maintenance, Three Ranger Stations',
      solicitationNumber: 'SAMPLE-1240BF-0087',
      agency: 'Department of Agriculture',
      office: 'Forest Service, Pacific Northwest Region (sample)',
      postedDate: at(now, -3, 15),
      responseDeadline: at(now, 20),
      type: 'Solicitation',
      setAside: 'Service-Disabled Veteran-Owned Small Business Set-Aside',
      setAsideCode: 'SDVOSBC',
      naicsCode: '561730',
      pscCode: 'S208',
      placeOfPerformance: { city: 'Eugene', state: 'OR', country: 'USA' },
      samUrl: '',
      level: 'federal',
      serviceKind: 'service',
      description: 'Mowing, edging, leaf removal and shrub care at three ranger stations, April through October, for one base year and two option years.',
    },
    {
      ...base,
      id: 'sample-hvac-gsa',
      title: 'HVAC Preventive Maintenance, Federal Building',
      solicitationNumber: 'SAMPLE-47PL01-0311',
      agency: 'General Services Administration',
      office: 'Public Buildings Service, Region 10 (sample)',
      postedDate: at(now, -9, 15),
      responseDeadline: at(now, 8),
      type: 'Solicitation',
      setAside: null,
      setAsideCode: null,
      naicsCode: '238220',
      pscCode: 'J041',
      placeOfPerformance: { city: 'Seattle', state: 'WA', country: 'USA' },
      samUrl: '',
      level: 'federal',
      serviceKind: 'service',
      description: 'Quarterly preventive maintenance and on-call repair for the building’s chillers, air handlers and rooftop units.',
    },
    {
      ...base,
      id: 'sample-snow-boise',
      title: 'Snow and Ice Removal, City Facilities 2026–27',
      solicitationNumber: 'SAMPLE-ITB-26-114',
      agency: 'City of Boise (sample)',
      office: 'Purchasing',
      postedDate: at(now, -2, 15),
      responseDeadline: at(now, 15),
      type: 'Invitation to Bid',
      setAside: null,
      setAsideCode: null,
      naicsCode: '561790',
      pscCode: null,
      placeOfPerformance: { city: 'Boise', state: 'ID', country: 'USA' },
      samUrl: '',
      level: 'local',
      portal: 'City of Boise Purchasing (sample)',
      source: 'sled',
      serviceKind: 'service',
      description: 'Plowing and de-icing at 14 city parking lots and walkways, on call from November through March.',
    },
    {
      ...base,
      id: 'sample-paper-dla',
      title: 'Copy Paper, 8.5 x 11, 5,000 Cases',
      solicitationNumber: 'SAMPLE-SPE8E7-0420',
      agency: 'Defense Logistics Agency',
      office: 'DLA Troop Support (sample)',
      postedDate: at(now, -1, 15),
      responseDeadline: at(now, 6),
      type: 'Solicitation',
      setAside: 'Total Small Business Set-Aside (FAR 19.5)',
      setAsideCode: 'SBA',
      naicsCode: '322121',
      pscCode: '7530',
      placeOfPerformance: { city: 'Philadelphia', state: 'PA', country: 'USA' },
      samUrl: '',
      level: 'federal',
      serviceKind: 'product',
      description: 'Delivery of 5,000 cases of white copy paper to a depot.',
    },
  ];
}

/** The sample notices' documents: the text Kontract would read, by document. Every fact below is quoted from here. */
export function sampleDocuments(id: string, now: Date): { name: string; text: string }[] {
  if (id === 'sample-janitorial-va') {
    return [
      {
        name: 'Statement of Work.pdf',
        text: `[Page 1]\nThe contractor shall provide daily janitorial services for Buildings 100 and 101, about 84,000 square feet in all.\n\nThe estimated annual value is $180,000 to $240,000.\n\nThe period of performance is one base year and four option years.\n\n[Page 2]\nFloors in patient corridors shall be stripped and waxed once a quarter.\n\nAll cleaning staff must pass a VA background check before starting work.`,
      },
      {
        name: 'Solicitation.pdf',
        text: `[Page 1]\nA site visit will be held on ${at(now, 4).slice(0, 10)} at 10:00 AM; attendance is not mandatory.\n\nQuestions are due by ${at(now, 6).slice(0, 10)}.\n\nAward will be made on a lowest price, technically acceptable basis.\n\nOfferors must complete and return the SF 1449 and Attachment B, the price schedule.`,
      },
      { name: 'Attachment B - Price Schedule.xlsx', text: 'Line 0001: Daily cleaning, Buildings 100 and 101, per month\nLine 0002: Floor stripping and waxing, per quarter' },
    ];
  }
  const o = sampleOpportunities(now).find((x) => x.id === id);
  return o ? [{ name: 'Notice.pdf', text: `[Page 1]\n${o.description ?? o.title}` }] : [];
}

/** What Kontract's free rules find in the sample documents, each fact with the words it came from. */
export function sampleDetails(id: string, now: Date): BidDetails {
  const docs = sampleDocuments(id, now);
  const documents = docs.map((d, i) => ({ id: `doc-${i + 1}`, name: d.name, url: '', size: d.text.length * 10, postedDate: at(now, -5, 15), read: 'read' as const, pages: d.name.endsWith('.pdf') ? 2 : undefined, chars: d.text.length }));
  const base: BidDetails = { noticeId: id, readAt: new Date(now).toISOString(), fingerprint: `fp-${id}`, documents, budget: null, bonds: null, siteVisit: null, questionsDue: null, period: null, wageDeterminations: [], evaluation: null, sizes: [], requirements: [], forms: [], priceForm: null };
  if (id !== 'sample-janitorial-va') return base;
  return {
    ...base,
    budget: { value: { low: 180000, high: 240000, kind: 'estimate' }, quote: 'The estimated annual value is $180,000 to $240,000.', doc: 'Statement of Work.pdf' },
    siteVisit: { value: { date: at(now, 4).slice(0, 10), mandatory: false }, quote: `A site visit will be held on ${at(now, 4).slice(0, 10)} at 10:00 AM; attendance is not mandatory.`, doc: 'Solicitation.pdf' },
    questionsDue: { value: at(now, 6).slice(0, 10), quote: `Questions are due by ${at(now, 6).slice(0, 10)}.`, doc: 'Solicitation.pdf' },
    period: { value: 'One base year and four option years', quote: 'The period of performance is one base year and four option years.', doc: 'Statement of Work.pdf' },
    wageDeterminations: ['WD 2015-5541 (sample)'],
    evaluation: { value: 'Lowest price, technically acceptable', quote: 'Award will be made on a lowest price, technically acceptable basis.', doc: 'Solicitation.pdf' },
    requirements: [{ value: 'Cleaning staff must pass a VA background check', quote: 'All cleaning staff must pass a VA background check before starting work.', doc: 'Statement of Work.pdf' }],
    forms: ['SF 1449', 'Attachment B - Price Schedule.xlsx'],
    priceForm: { doc: 'Attachment B - Price Schedule.xlsx', rows: ['Daily cleaning, Buildings 100 and 101, per month', 'Floor stripping and waxing, per quarter'] },
  };
}

/** A plain-English read of a sample notice, as Kontract's rules would give it (no Claude). */
export function sampleBreakdown(id: string, now: Date): Breakdown {
  const o = sampleOpportunities(now).find((x) => x.id === id);
  if (id === 'sample-janitorial-va') {
    return {
      plainEnglish: 'Clean two hospital buildings every day and strip and wax the corridor floors four times a year, for up to five years.',
      workType: 'service',
      whoDoesTheWork: 'A local commercial cleaning company with staff who can pass a VA background check.',
      subcontractorSearchTerms: ['commercial cleaning', 'janitorial services'],
      pricingStructure: 'A fixed price per month for daily cleaning, and a price per quarter for floor care.',
      suggestedLines: [
        { description: 'Daily cleaning, Buildings 100 and 101', unit: 'month', quantityPerPeriod: 12 },
        { description: 'Floor stripping and waxing', unit: 'quarter', quantityPerPeriod: 4 },
      ],
      contractLength: 'One base year and four option years',
      periods: 5,
      keyRequirements: ['VA background checks for every cleaner', 'Quarterly floor care in patient corridors'],
      questionsForSubs: ['Can your staff pass a VA background check?', 'What do you charge per month for about 84,000 square feet?', 'Do you strip and wax floors yourselves?'],
      redFlags: ['Lowest price wins, so margins will be thin.'],
      difficulty: 'moderate',
      source: 'rules',
    };
  }
  return {
    plainEnglish: o?.description ?? 'A contract opportunity.',
    workType: o?.serviceKind === 'product' ? 'product' : 'service',
    whoDoesTheWork: o?.serviceKind === 'product' ? 'A supplier who can deliver the goods.' : 'A local company that does this work.',
    subcontractorSearchTerms: [o?.title.split(',')[0]?.toLowerCase() ?? 'contractor'],
    pricingStructure: 'A fixed price per period.',
    suggestedLines: [{ description: o?.title.split(',')[0] ?? 'The work', unit: 'year', quantityPerPeriod: 1 }],
    contractLength: 'See the notice',
    periods: 1,
    keyRequirements: [],
    questionsForSubs: [],
    redFlags: [],
    difficulty: 'easy',
    source: 'rules',
  };
}

/** Past awards like a sample notice's, with their statistics and who won them. */
export function samplePricing(keywords: string[]): { awards: PastAward[]; stats: PricingStats; recipients: RecipientSummary[] } {
  const k = keywords.join(' ').toLowerCase();
  const kind = /clean|janitor/.test(k) ? 'Janitorial services' : /ground|mow|landscap/.test(k) ? 'Grounds maintenance' : /hvac|heat|air/.test(k) ? 'HVAC maintenance' : 'Services';
  const awards: PastAward[] = [
    ['Northwest Building Care (sample)', 1_050_000, 210_000, 'OR', 2023],
    ['Cascade Facility Services (sample)', 960_000, 192_000, 'OR', 2022],
    ['Pioneer Janitorial (sample)', 1_240_000, 248_000, 'WA', 2024],
    ['Northwest Building Care (sample)', 880_000, 176_000, 'OR', 2021],
  ].map(([recipient, amount, annual, state, year], i) => ({
    id: `sample-award-${i + 1}`,
    awardId: `SAMPLE-AWD-${1000 + i}`,
    recipient: recipient as string,
    amount: amount as number,
    annualAmount: annual as number,
    agency: 'Department of Veterans Affairs',
    subAgency: 'Veterans Health Administration',
    startDate: `${year}-10-01`,
    endDate: `${(year as number) + 5}-09-30`,
    years: 5,
    description: `${kind}, medical center (sample)`,
    naics: '561720',
    psc: 'S201',
    state: state as string,
    url: '',
    likelyRelated: true,
  }));
  const annual = awards.map((a) => a.annualAmount!).sort((a, b) => a - b);
  const totals = awards.map((a) => a.amount).sort((a, b) => a - b);
  const median = (xs: number[]) => (xs.length % 2 ? xs[(xs.length - 1) / 2]! : (xs[xs.length / 2 - 1]! + xs[xs.length / 2]!) / 2);
  const stats: PricingStats = { count: awards.length, medianTotal: median(totals), lowTotal: totals[0]!, highTotal: totals.at(-1)!, medianAnnual: median(annual), lowAnnual: annual[0]!, highAnnual: annual.at(-1)!, annualCount: annual.length };
  const by = new Map<string, RecipientSummary>();
  for (const a of awards) {
    const r = by.get(a.recipient) ?? { name: a.recipient, awards: 0, total: 0, states: [], latest: null };
    r.awards += 1;
    r.total += a.amount;
    if (a.state && !r.states.includes(a.state)) r.states.push(a.state);
    if (!r.latest || (a.startDate && a.startDate > r.latest)) r.latest = a.startDate;
    by.set(a.recipient, r);
  }
  return { awards, stats, recipients: [...by.values()].sort((a, b) => b.total - a.total) };
}

/** Local businesses for a search, as Kontract answers when it has no business-search key: marked as samples. */
export function sampleSubs(query: string, location: string): FoundSub[] {
  const what = query.trim() || 'contractor';
  const where = location.trim() || 'your area';
  return [
    { name: 'Evergreen Commercial Cleaning (sample)', phone: '(503) 555-0142', website: 'https://evergreen-clean.example', address: `${where}`, category: what, rating: 4.7, reviewCount: 112, source: 'sample' },
    { name: 'Rose City Janitorial (sample)', phone: '(503) 555-0187', website: 'https://rosecity-janitorial.example', address: `${where}`, category: what, rating: 4.4, reviewCount: 58, source: 'sample' },
    { name: 'Summit Facility Services (sample)', phone: '(503) 555-0110', address: `${where}`, category: what, rating: 4.1, reviewCount: 23, source: 'sample' },
  ];
}

/** What a sample business's website says. */
export function sampleSite(url: string, now: Date): SiteFacts {
  const host = url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return { url, emails: [`bids@${host}`], phones: ['(503) 555-0142'], licenses: ['OR CCB 000000 (sample)'], services: ['Commercial cleaning', 'Floor care'], serviceArea: 'Portland metro', insured: true, experience: 'Since 2009', pages: [url], readAt: now.toISOString() };
}

/** Businesses pulling permits near a sample job: a free second source of subs. */
export function samplePermitContractors(state: string, city?: string): PermitContractor[] {
  const market = `${(city ?? 'portland').toLowerCase().replace(/\s+/g, '-')}-${state.toLowerCase()}`;
  return [
    { key: 'columbia mechanical sample', name: 'Columbia Mechanical (sample)', phone: '(503) 555-0199', license: 'OR CCB 111111 (sample)', permits: 14, jobs: 11, latest: new Date().toISOString().slice(0, 10), types: ['Mechanical'], market },
    { key: 'bridgetown builders sample', name: 'Bridgetown Builders (sample)', phone: '(503) 555-0123', permits: 9, jobs: 7, latest: new Date().toISOString().slice(0, 10), types: ['Alteration'], market },
  ];
}
