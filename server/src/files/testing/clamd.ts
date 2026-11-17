/**
 * A stand-in for ClamAV's daemon, for tests and the browser suites: a tiny TCP server on this machine that speaks
 * enough of clamd's protocol for Timmy's scanner (PING and INSTREAM, in the "z" form with zero-byte endings, and
 * the "n" form with newlines). It reports the EICAR test file, the harmless string every virus scanner agrees to
 * flag, as a virus, and everything else as clean. It never listens beyond 127.0.0.1.
 */
import { createServer, type Server, type Socket } from 'node:net';

/**
 * The EICAR test string, put together at run time so that this source file is not itself flagged by a scanner on
 * a developer's machine. It is a harmless string that scanners report on purpose, for testing.
 */
export const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join('');

export interface StandInClamd {
  port: number;
  /** How many streams it has been asked to scan. */
  scans: number;
  close(): Promise<void>;
}

/** Starts the stand-in on a free port. `maxBytes` mirrors clamd's StreamMaxLength: a longer stream is answered with an error. */
export async function startStandInClamd(opts: { maxBytes?: number } = {}): Promise<StandInClamd> {
  const maxBytes = opts.maxBytes ?? 25 * 1024 * 1024;
  const open = new Set<Socket>();
  const me: StandInClamd = { port: 0, scans: 0, close: async () => {} };
  const server: Server = createServer((socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('error', () => socket.destroy());
    let buffer = Buffer.alloc(0);
    let command: string | null = null;
    let end = '\0';
    let received: Buffer[] = [];
    let size = 0;
    socket.on('data', (d: Buffer) => {
      buffer = Buffer.concat([buffer, d]);
      if (command === null) {
        const z = buffer[0] === 0x7a ? buffer.indexOf(0) : -1;
        const n = buffer[0] === 0x6e ? buffer.indexOf(0x0a) : -1;
        const at = z >= 0 ? z : n;
        if (at < 0) return;
        end = z >= 0 ? '\0' : '\n';
        command = buffer.subarray(1, at).toString('latin1');
        buffer = buffer.subarray(at + 1);
        if (command === 'PING') return void socket.end(`PONG${end}`);
        if (command !== 'INSTREAM') return void socket.end(`UNKNOWN COMMAND${end}`);
      }
      // INSTREAM: chunks, each with its length first, until a chunk of length zero.
      while (buffer.length >= 4) {
        const len = buffer.readUInt32BE(0);
        if (len === 0) {
          me.scans++;
          const all = Buffer.concat(received);
          received = [];
          return void socket.end(all.includes(EICAR, 0, 'latin1') ? `stream: Eicar-Test-Signature FOUND${end}` : `stream: OK${end}`);
        }
        if (buffer.length < 4 + len) return;
        size += len;
        if (size > maxBytes) return void socket.end(`INSTREAM size limit exceeded. ERROR${end}`);
        received.push(Buffer.from(buffer.subarray(4, 4 + len)));
        buffer = buffer.subarray(4 + len);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  me.port = (server.address() as { port: number }).port;
  me.close = () =>
    new Promise<void>((resolve) => {
      for (const s of open) s.destroy();
      server.close(() => resolve());
    });
  return me;
}
