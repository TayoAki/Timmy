/**
 * Virus scanning for uploaded files.
 *
 * The rest of the server talks to the small `VirusScanner` interface. The one real scanner is ClamAV, spoken to
 * over TCP with its own protocol (clamd's INSTREAM command): the bytes are streamed in chunks, each preceded by
 * its length, and clamd answers "stream: OK" or "stream: <name> FOUND". Tests and the browser suites point it at
 * a stand-in that speaks the same protocol on this machine (testing/clamd.ts); nothing here ever reaches out
 * unless CLAMAV_HOST says where to.
 *
 * With no scanner set up, uploads work as before and their answer says the file was not scanned. With one set up,
 * a file is scanned before it is kept, and only a clean file can be used; see assets.ts.
 */
import { connect } from 'node:net';
import { config } from '../config';

export type Verdict = { clean: true } | { clean: false; virus: string };

export interface VirusScanner {
  /** Scans the bytes. Throws when the scanner can't be asked or doesn't give a clear answer. */
  scan(bytes: Uint8Array): Promise<Verdict>;
}

/** The scanner could not be asked, or did not give a clear answer. The message is safe to log. */
export class ScannerUnavailable extends Error {}

/** clamd's limit on one chunk of a stream is set by its own configuration; this stays well under every default. */
const CHUNK = 64 * 1024;

/** A virus's name as clamd reports it, kept to plain characters before it is shown or written anywhere. */
const virusName = (raw: string) => raw.replace(/[^\w.:/-]+/g, ' ').trim().slice(0, 100) || 'a virus';

export class ClamAV implements VirusScanner {
  constructor(
    private host: string,
    private port: number,
    private timeoutMs = 30_000,
  ) {}

  scan(bytes: Uint8Array): Promise<Verdict> {
    return new Promise<Verdict>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        fn();
      };
      const fail = (why: string) => done(() => reject(new ScannerUnavailable(why)));
      const answer = (reply: string) => {
        const line = reply.trim();
        if (/^stream: OK$/.test(line)) return done(() => resolve({ clean: true }));
        const found = /^stream: (.+) FOUND$/.exec(line);
        if (found) return done(() => resolve({ clean: false, virus: virusName(found[1]!) }));
        // "INSTREAM size limit exceeded. ERROR", a closed connection, or anything else: no clear answer.
        fail(line ? `the virus scanner gave no clear answer (${line.slice(0, 80)})` : 'the virus scanner closed the connection without an answer');
      };
      const socket = connect({ host: this.host, port: this.port });
      const timer = setTimeout(() => fail('the virus scanner did not answer in time'), this.timeoutMs);
      socket.on('error', (e) => fail(`the virus scanner could not be reached (${(e as NodeJS.ErrnoException).code ?? 'error'})`));
      socket.on('connect', () => {
        // "z" commands end with a zero byte, and so does the answer.
        socket.write('zINSTREAM\0');
        for (let at = 0; at < bytes.length; at += CHUNK) {
          const part = bytes.subarray(at, at + CHUNK);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(part.length);
          socket.write(size);
          socket.write(part);
        }
        // A chunk of length zero ends the stream.
        socket.write(Buffer.alloc(4));
      });
      socket.on('data', (d: Buffer) => {
        chunks.push(d);
        const text = Buffer.concat(chunks).toString('latin1');
        const end = text.indexOf('\0');
        if (end >= 0 || text.length > 4096) answer(text.slice(0, end >= 0 ? end : 4096));
      });
      socket.on('end', () => answer(Buffer.concat(chunks).toString('latin1').replace(/\0.*$/s, '')));
    });
  }
}

let override: VirusScanner | null | undefined;

/** The scanner uploads go through, or null when none is set up. */
export function virusScanner(): VirusScanner | null {
  if (override !== undefined) return override;
  return config.clamav.host ? new ClamAV(config.clamav.host, config.clamav.port, config.clamav.timeoutMs) : null;
}

/** Whether uploads are scanned on this server. While they are, only a file scanned clean can be used. */
export const scanning = () => virusScanner() !== null;

/** Tests and the browser suites put a scanner in place (one pointing at the stand-in), or null for none. `undefined` goes back to the configured one. */
export function setScannerForTests(s: VirusScanner | null | undefined) {
  override = s;
}
