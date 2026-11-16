/**
 * Where the bytes of uploaded files are kept. Everything else in the server talks to this small interface and
 * never to the bucket itself, so the same code runs against the real bucket and against the stand-in.
 *
 * A server that was given a bucket keeps files there. Without one (tests, a developer's machine) the stand-in
 * keeps them in memory, or in a folder when one is named. A deployed server with neither says files aren't set
 * up, rather than quietly keeping them somewhere they would be lost. See `storeKind`.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { config } from '../config';
import { BucketStore } from './bucket';

export interface FileStore {
  readonly kind: 'bucket' | 'memory' | 'folder';
  /** Keeps `bytes` under `key`. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** The bytes kept under `key`, or null when there are none. */
  get(key: string): Promise<Uint8Array | null>;
  /** Forgets what is kept under `key`. Removing something that isn't there is not an error. */
  remove(key: string): Promise<void>;
  /** Every key that starts with `prefix`. */
  list(prefix: string): Promise<string[]>;
}

/** A key is the workspace's id, a slash, and the asset's id. Nothing else is ever asked of a store. */
const KEY = /^[\w-]{1,120}\/[\w-]{1,120}$/;
export const storageKey = (workspaceId: string, assetId: string) => `${workspaceId}/${assetId}`;

/** The stand-in: files live in this process's memory and are gone when it stops. */
export class MemoryStore implements FileStore {
  readonly kind = 'memory';
  files = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array, _contentType?: string) {
    this.files.set(key, new Uint8Array(bytes));
  }
  async get(key: string) {
    const b = this.files.get(key);
    return b ? new Uint8Array(b) : null;
  }
  async remove(key: string) {
    this.files.delete(key);
  }
  async list(prefix: string) {
    return [...this.files.keys()].filter((k) => k.startsWith(prefix));
  }
}

/** The stand-in on disk, for a developer who wants uploads to survive a restart. */
export class FolderStore implements FileStore {
  readonly kind = 'folder';
  constructor(private root: string) {
    this.root = resolve(root);
  }
  private path(key: string): string {
    if (!KEY.test(key)) throw new Error('not a storage key');
    return join(this.root, key);
  }
  async put(key: string, bytes: Uint8Array, _contentType?: string) {
    const file = this.path(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  async get(key: string) {
    return readFile(this.path(key)).then(
      (b) => new Uint8Array(b),
      () => null,
    );
  }
  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }
  async list(prefix: string) {
    const [folder = '', start = ''] = prefix.split('/');
    if (!/^[\w-]{1,120}$/.test(folder)) return [];
    const names = await readdir(join(this.root, folder)).catch(() => [] as string[]);
    return names.filter((n) => n.startsWith(start)).map((n) => `${folder}/${n}`);
  }
}

const bucketConfigured = () => !!(config.bucket.endpoint && config.bucket.name && config.bucket.accessKeyId && config.bucket.secretAccessKey);

/**
 * Which store this server uses, or null when it has none.
 * A server that was given a bucket uses it. Without one, the stand-in is used where the other stand-ins are
 * (the stand-in providers switched on) and on a developer's machine. A deployed server with no bucket has no
 * store. TIMMY_FILE_STORE settles it by hand: "standin" keeps a server with a bucket off it, "bucket" insists on it.
 */
export function storeKind(): 'bucket' | 'standin' | null {
  if (config.files.store === 'standin') return 'standin';
  if (bucketConfigured()) return 'bucket';
  if (config.files.store === 'bucket') return null;
  return config.fakeProviders || config.stage === 'development' || config.stage === 'test' ? 'standin' : null;
}

let store: FileStore | null = null;

export const filesReady = () => !!store || storeKind() !== null;

export function fileStore(): FileStore {
  if (!store) {
    const kind = storeKind();
    if (kind === 'bucket') store = new BucketStore(config.bucket);
    else if (kind === 'standin') store = config.files.dir ? new FolderStore(config.files.dir) : new MemoryStore();
    else throw new Error('File storage is not configured: set the BUCKET_ variables');
  }
  return store;
}

/** Tests put their own store in place (one that fails, one that points at a local stand-in for the bucket). */
export function setFileStoreForTests(s: FileStore | null) {
  store = s;
}
