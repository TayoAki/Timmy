/**
 * The stand-in file stores, used where there is no bucket: tests, the browser suites and a developer's machine.
 * Which store a server uses is decided in files/store.ts (`storeKind`); these only keep the bytes.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { FileStore } from '../files/store';

/** The shape of every storage key (see `storageKey`). The folder store refuses anything else, so a key can't climb out of its folder. */
const KEY = /^[\w-]{1,120}\/[\w-]{1,120}$/;

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
