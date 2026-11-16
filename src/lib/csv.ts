/*
 * Reading a lead list: a small CSV parser (quotes, commas and line breaks in
 * quoted fields, tabs from a spreadsheet paste) and a guess at which column is
 * which, so most exports from Apollo, Clay, HubSpot or a spreadsheet map on
 * their own.
 */

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? '\t' : firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell.trim());
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

export type LeadField = 'first' | 'last' | 'name' | 'email' | 'phone' | 'title' | 'company' | 'website' | 'linkedin' | 'employees' | 'industry' | 'keywords' | 'city' | 'skip' | 'extra';

export const FIELD_LABELS: Record<LeadField, string> = {
  first: 'First name',
  last: 'Last name',
  name: 'Full name',
  email: 'Email',
  phone: 'Phone',
  title: 'Job title',
  company: 'Company',
  website: 'Website',
  linkedin: 'LinkedIn',
  employees: 'Employees',
  industry: 'Industry',
  keywords: 'Keywords',
  city: 'Location',
  extra: 'Keep as a custom field',
  skip: 'Don’t import',
};

const GUESS: [LeadField, RegExp][] = [
  ['email', /e-?mail/],
  ['first', /^first|first.?name|given/],
  ['last', /^last|last.?name|surname|family/],
  ['name', /^(full.?)?name$|^contact$|^person/],
  ['phone', /phone|mobile|cell|tel/],
  ['linkedin', /linkedin/],
  ['website', /website|domain|url|site/],
  ['title', /title|role|position|job/],
  ['company', /company|organi[sz]ation|account|business|employer/],
  ['employees', /employee|headcount|size|# ?emp/],
  ['industry', /industry|sector|vertical/],
  ['keywords', /keyword|tag|technolog/],
  ['city', /city|location|state|country|region|address/],
];

/** Best guess at what each column holds; anything unknown is kept as a custom field. */
export function guessFields(header: string[]): LeadField[] {
  const used = new Set<LeadField>();
  return header.map((h) => {
    const k = h.toLowerCase().trim();
    const hit = GUESS.find(([f, re]) => !used.has(f) && re.test(k))?.[0];
    if (hit) {
      used.add(hit);
      return hit;
    }
    return k ? 'extra' : 'skip';
  });
}

export const SAMPLE_CSV = `First Name,Last Name,Email,Title,Company,Website,Employees,Industry,City,Phone
Nora,Castellanos,nora@lakeview-dental.example,Practice Manager,Lakeview Dental,lakeview-dental.example,42,Dental Practices,"Denver, CO",+1 555 0141
Pete,Arbuckle,pete.arbuckle@tristate-staffing.example,VP of Operations,Tristate Staffing,tristate-staffing.example,130,Staffing & Recruiting,"Columbus, OH",+1 555 0142
Lena,Morales,lena@harbor-home-health.example,Director of Operations,Harbor Home Health,harbor-home-health.example,75,Home Health Care,"Tampa, FL",+1 555 0143
Ike,Bramwell,ike@bramwell-legal.example,Office Manager,Bramwell Legal,bramwell-legal.example,11,Law Practice,"Austin, TX",
Ruth,Okonkwo,ruth.okonkwo@greenway-logistics.example,COO,Greenway Logistics,greenway-logistics.example,220,Logistics & Supply Chain,"Atlanta, GA",+1 555 0145`;
