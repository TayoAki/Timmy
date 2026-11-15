/*
 * File bytes kept in this browser (IndexedDB): uploads, and saves from the
 * Craft apps. Metadata stays in the workspace store; only the bytes live here.
 * Every call fails soft: private windows and blocked storage still work, the
 * file just isn't kept after reload.
 */
const DB = 'timmy-files';
const STORE = 'blobs';

export interface StoredFile {
  name: string;
  bytes: ArrayBuffer;
  updated: number;
}

let opening: Promise<IDBDatabase> | null = null;

const open = () =>
  (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));

const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
};

export async function getBlob(id: string): Promise<StoredFile | undefined> {
  try {
    return (await run<StoredFile | undefined>('readonly', (s) => s.get(id))) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function putBlob(id: string, name: string, bytes: ArrayBuffer | Uint8Array): Promise<boolean> {
  try {
    const buf = bytes instanceof Uint8Array ? bytes.slice().buffer : bytes;
    await run('readwrite', (s) => s.put({ name, bytes: buf, updated: Date.now() } satisfies StoredFile, id));
    return true;
  } catch {
    return false;
  }
}

export async function deleteBlob(id: string) {
  try {
    await run('readwrite', (s) => s.delete(id));
  } catch {
    /* nothing to remove */
  }
}

export async function clearBlobs() {
  try {
    await run('readwrite', (s) => s.clear());
  } catch {
    /* storage unavailable */
  }
}
