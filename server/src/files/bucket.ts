/**
 * The bucket: an S3-compatible object store (Railway Buckets), spoken to over HTTPS.
 *
 * Requests are signed here, with the standard "AWS Signature Version 4", using Node's own crypto. The secret
 * key is used only to compute signatures: it is never put in an address, a header, an error or a log line.
 * Errors carry the store's status and its short error code, nothing else from the exchange.
 */
import { createHash, createHmac } from 'node:crypto';
import type { FileStore } from './store';

export interface BucketConfig {
  /** The store's base address, e.g. https://t3.storageapi.dev */
  endpoint: string;
  name: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Railway's buckets put the bucket's name in the host ("virtual"). Some other stores want it in the path. */
  urlStyle: 'virtual' | 'path';
}

/** The store refused, or could not be reached. The message is safe to log. */
export class BucketError extends Error {
  constructor(
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}

const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
/** Percent-encoding as the signature wants it: everything but letters, digits and - _ . ~ */
const encode = (text: string) => encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface Signable {
  method: string;
  /** The host exactly as it will be sent, with its port when that is not the default. */
  host: string;
  /** The path, not yet encoded. */
  path: string;
  query?: Record<string, string>;
  /** Headers to sign besides the host. Names in lower case. */
  headers: Record<string, string>;
  /** The SHA-256 of the body, in hex. */
  payloadHash: string;
  region: string;
  service?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** When the request is made. */
  at: Date;
}

/** The value of the Authorization header for a request, per AWS Signature Version 4. */
export function authorization(r: Signable): string {
  const amzDate = r.at.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const service = r.service ?? 's3';
  const headers: Record<string, string> = { ...r.headers, host: r.host };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, ' ')}\n`).join('');
  const canonicalQuery = Object.entries(r.query ?? {})
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalPath = r.path.split('/').map(encode).join('/') || '/';
  const canonicalRequest = [r.method, canonicalPath, canonicalQuery, canonicalHeaders, names.join(';'), r.payloadHash].join('\n');
  const scope = `${day}/${r.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${r.secretAccessKey}`, day), r.region), service), 'aws4_request');
  return `AWS4-HMAC-SHA256 Credential=${r.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${hmac(key, toSign).toString('hex')}`;
}

const EMPTY_HASH = sha256Hex('');
const unescapeXml = (t: string) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export class BucketStore implements FileStore {
  readonly kind = 'bucket';
  private base: URL;

  constructor(
    private cfg: BucketConfig,
    /** How long one request may take before it is given up. */
    private timeoutMs = 30_000,
  ) {
    this.base = new URL(cfg.endpoint);
    if (this.base.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(this.base.hostname)) throw new BucketError('The file store’s address must start with https://');
  }

  private async call(method: 'GET' | 'PUT' | 'DELETE', key: string, opts: { query?: Record<string, string>; body?: Uint8Array; contentType?: string } = {}): Promise<Response> {
    const virtual = this.cfg.urlStyle === 'virtual';
    const host = virtual ? `${this.cfg.name}.${this.base.host}` : this.base.host;
    const path = `${virtual ? '' : `/${this.cfg.name}`}/${key}`;
    const at = new Date();
    const payloadHash = opts.body ? sha256Hex(opts.body) : EMPTY_HASH;
    const signed = { 'x-amz-content-sha256': payloadHash, 'x-amz-date': at.toISOString().replace(/[-:]|\.\d{3}/g, '') };
    const auth = authorization({ method, host, path, query: opts.query, headers: signed, payloadHash, region: this.cfg.region, accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey, at });
    const search = Object.entries(opts.query ?? {})
      .map(([k, v]) => `${encode(k)}=${encode(v)}`)
      .join('&');
    const url = `${this.base.protocol}//${host}${path.split('/').map(encode).join('/')}${search ? `?${search}` : ''}`;
    let res: Response;
    try {
      res = await fetch(url, { method, headers: { ...signed, authorization: auth, ...(opts.contentType ? { 'content-type': opts.contentType } : {}) }, body: opts.body as BodyInit | undefined, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
    } catch (e) {
      // Only the kind of failure is passed on. The request itself (its address and headers) is not.
      throw new BucketError(`The file store could not be reached (${(e as Error).name}).`);
    }
    if (res.ok || (res.status === 404 && method !== 'PUT')) return res;
    const code = /<Code>([\w.-]{1,60})<\/Code>/.exec(await res.text().catch(() => ''))?.[1];
    throw new BucketError(`The file store answered ${res.status}${code ? ` (${code})` : ''} to a ${method}.`, res.status);
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.call('PUT', key, { body: bytes, contentType });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const res = await this.call('GET', key);
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async remove(key: string): Promise<void> {
    const res = await this.call('DELETE', key);
    await res.body?.cancel().catch(() => {});
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    // A thousand keys come back at a time; the store says when there are more.
    for (let page = 0; page < 1000; page++) {
      const res = await this.call('GET', '', { query: { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) } });
      if (res.status === 404) throw new BucketError('The file store says the bucket does not exist.', 404);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(unescapeXml(m[1]!));
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unescapeXml(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? '') : undefined;
      if (!token) break;
    }
    return keys;
  }
}
