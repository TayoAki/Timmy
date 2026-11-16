/*
 * Sending-domain checks: SPF, DKIM and DMARC for each domain you send cold
 * email from. In the product these are live DNS lookups; in this preview the
 * sample domains pass and new ones get a deterministic result so you can see
 * what a failing check looks like and how to fix it.
 */
import { hash } from './outbound';

export interface DnsCheck {
  key: 'spf' | 'dkim' | 'dmarc';
  label: string;
  ok: boolean;
  fix: string;
}

const KNOWN = new Set(['trynorthpeak.io', 'getnorthpeak.io', 'northpeak.io']);

export function dnsFor(domain: string): DnsCheck[] {
  const h = hash(domain);
  const known = KNOWN.has(domain);
  return [
    { key: 'spf', label: 'SPF', ok: known || h % 5 !== 0, fix: `Add your mail provider to the SPF record for ${domain} (for Google Workspace: include:_spf.google.com). Keep it under 10 lookups.` },
    { key: 'dkim', label: 'DKIM', ok: known || h % 3 !== 0, fix: `Turn on DKIM signing for ${domain} in your mail admin console and publish the TXT record it gives you.` },
    { key: 'dmarc', label: 'DMARC', ok: known || h % 4 !== 0, fix: `Publish a TXT record at _dmarc.${domain}: v=DMARC1; p=none; rua=mailto:dmarc@${domain}` },
  ];
}

export const domainOf = (address: string) => address.split('@')[1]?.toLowerCase() ?? '';
