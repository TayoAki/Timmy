/**
 * Fetching a file that a Composio tool hands back as an address rather than as bytes (OneDrive's download tool puts
 * the file in Composio's store and returns a short-lived link to it).
 *
 * The address comes from Composio's answer, not from whoever wrote the file, but it is checked before anything is
 * asked of it all the same: https only, a host on the list in config, a host that does not lead to a private
 * address, no redirects, a time limit, and the body is read only up to `maxBytes`. A larger file is refused, not cut,
 * because half a zip archive is not a file anyone can read.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class DownloadRefused extends Error {}

/** Whether a host is on the list: an entry is a whole host name, or ".example.com" for any host ending in it. */
export function allowedHost(host: string, list: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return list.some((entry) => (entry.startsWith('.') ? h.endsWith(entry) && h.length > entry.length : h === entry));
}

/** Loopback, private, link-local, shared and reserved addresses: nothing a file store on the internet lives at. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)?.[1];
  if (mapped) return isPrivateAddress(mapped);
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff') || v6.startsWith('64:ff9b:');
}

export async function fetchFileBytes(url: string, maxBytes: number, hosts: string[], timeoutMs = 20_000): Promise<Uint8Array> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new DownloadRefused('the file’s address is not an address');
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) throw new DownloadRefused('the file’s address is not a plain https address');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) || !allowedHost(host, hosts)) throw new DownloadRefused('the file is not in a store Timmy fetches from');
  const addresses = await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) throw new DownloadRefused('the file’s host does not lead to a public address');

  const res = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: '*/*' } });
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw new DownloadRefused(`the file store answered ${res.status}`);
  }
  const told = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(told) && told > maxBytes) {
    await res.body.cancel().catch(() => {});
    throw new DownloadRefused('the file is larger than Timmy reads');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new DownloadRefused('the file is larger than Timmy reads');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
