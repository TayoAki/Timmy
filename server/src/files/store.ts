/**
 * Where the bytes of uploaded files are kept. Everything else in the server talks to this small interface and
 * never to the bucket itself, so the same code runs against the real bucket and against the stand-in.
 *
 * A server that was given a bucket keeps files there. Without one (tests, a developer's machine) the stand-in
 * (testing/file-store.ts) keeps them in memory, or in a folder when one is named. A deployed server with neither
 * says files aren't set up, rather than quietly keeping them somewhere they would be lost. See `storeKind`.
 */
import { config } from '../config';
import { FolderStore, MemoryStore } from '../testing/file-store';
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
export const storageKey = (workspaceId: string, assetId: string) => `${workspaceId}/${assetId}`;

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
