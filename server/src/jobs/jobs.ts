/**
 * Background work. In production every job goes through pg-boss, which keeps
 * them in Postgres and retries them. Tests use the inline runner (testing/jobs.ts),
 * which runs the same handlers on demand so a test decides when time passes.
 */
import { PgBoss } from 'pg-boss';
import { systemDatabaseUrl } from '../db/pool';
import { log } from '../lib/log';
import { InlineJobs } from '../testing/jobs';
import type { JobName, JobPayloads } from './payloads';

/** Runs one job, given what it was queued with. */
export type Handler<N extends JobName> = (data: JobPayloads[N]) => Promise<void>;

export interface JobOptions {
  startAfter?: Date | number;
  /** Only one job with this key may be waiting at a time. */
  singletonKey?: string;
}

/**
 * A queue. Every job name and payload is checked against `JobPayloads`. The two queues below accept any name, so
 * a test can drive them by a name it holds in a variable; the server only reaches them through this interface.
 */
export interface Jobs {
  enqueue<N extends JobName>(name: N, data: JobPayloads[N], opts?: JobOptions): Promise<void>;
  stop(): Promise<void>;
}

/** A handler as the queues hold it: the payload comes back from the queue under the name it was queued with. */
type StoredHandler = (data: Record<string, unknown>) => Promise<void>;

const handlers = new Map<string, StoredHandler>();
const crons = new Map<string, string>();

export function defineJob<N extends JobName>(name: N, handler: Handler<N>, cron?: string) {
  handlers.set(name, handler as StoredHandler);
  if (cron) crons.set(name, cron);
}

/** Where a job's place in the queue is written in its data. */
const SEQ = '__seq';
let queued = 0;

export class BossJobs implements Jobs {
  constructor(
    private boss: PgBoss,
    private schema = 'pgboss',
  ) {}
  async enqueue(name: string, data: Record<string, unknown>, opts: JobOptions = {}) {
    // pg-boss keeps a job's key but only enforces it on queues made with one of its special policies, and ours use
    // the standard one (which every other job needs). So the wrapper checks itself: while a job with this key is
    // still waiting, another is not queued. Two callers at the same instant can both get through; the jobs are
    // safe to run twice, so the worst case is one call too many, never a missed run.
    if (opts.singletonKey) {
      const waiting = await this.boss.getDb().executeSql(`select 1 from ${this.schema}.job where name = $1 and singleton_key = $2 and state in ('created', 'retry') limit 1`, [name, opts.singletonKey]);
      if (waiting.rows.length) return;
    }
    // Numbered as queued: the queue's creation times come back to the millisecond, and jobs queued within one
    // millisecond would otherwise run in any order (see batchHandler).
    await this.boss.send(name, { ...data, [SEQ]: ++queued }, { ...(opts.startAfter !== undefined ? { startAfter: opts.startAfter } : {}), ...(opts.singletonKey ? { singletonKey: opts.singletonKey } : {}) });
  }
  async stop() {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }
}

// Until the real queue is started (tests never start it), jobs wait in the inline runner.
let jobs: Jobs = new InlineJobs((name) => handlers.get(name));
export const getJobs = () => jobs;
export const inlineJobs = () => (jobs instanceof InlineJobs ? jobs : null);
export function setJobs(j: Jobs) {
  jobs = j;
}

/** Enqueue without making the caller wait or fail: a job that can't be queued is picked up by the sweep. */
export function enqueueSoon<N extends JobName>(name: N, data: JobPayloads[N], opts?: JobOptions) {
  void jobs.enqueue(name, data, opts).catch((e) => log.warn('could not queue job', { name, error: (e as Error).message }));
}

/** Jobs that are quick and can arrive by the hundred. */
const BURSTY = new Set(['effect.execute', 'mail.ingest', 'mail.read']);

/**
 * How a queue is polled. Short jobs that can come in bursts (a person accepting a hundred suggestions, a burst of new
 * mail) are fetched ten at a time, and fetched again at once while batches come back full: one at a time with a pause
 * between them, a thousand filings took a quarter of an hour.
 */
export const workOptions = (name: string) => ({ pollingIntervalSeconds: name === 'effect.execute' ? 1 : 2, ...(BURSTY.has(name) ? { batchSize: 10, burstWhenBatchFull: true, includeMetadata: true as const } : {}) });

/**
 * Runs a fetched batch in the order it was queued, one job after another, so two changes to the same thread still
 * land in order. One job failing doesn't stop the rest; the batch is then reported failed, so the queue tries it again
 * where it retries (every job is safe to run twice), and the sweeps pick up what it doesn't.
 */
export const batchHandler = (name: string, handler: (data: Record<string, unknown>) => Promise<unknown>) => async (batch: { data?: unknown; createdOn?: Date | string }[]) => {
  let failed: unknown = null;
  // The queue hands batches over in order, but not the jobs inside one: they are put back in the order they were
  // queued, by creation time and then by the number each was given when queued.
  const at = (j: { createdOn?: Date | string }) => (j.createdOn ? new Date(j.createdOn).getTime() : 0);
  const seq = (j: { data?: unknown }) => Number((j.data as Record<string, unknown> | undefined)?.[SEQ] ?? 0);
  for (const job of [...batch].sort((a, b) => at(a) - at(b) || seq(a) - seq(b))) {
    try {
      await handler((job.data ?? {}) as Record<string, unknown>);
    } catch (e) {
      log.error('job failed', { name, error: (e as Error).message });
      failed = failed ?? e;
    }
  }
  if (failed) throw failed;
};

export async function startBoss(): Promise<Jobs> {
  // The queue's tables belong to the system role, like the rest of the schema.
  const boss = new PgBoss({ connectionString: systemDatabaseUrl(), schema: 'pgboss', max: 4 });
  boss.on('error', (e) => log.error('job queue error', { error: (e as Error).message }));
  await boss.start();
  for (const [name, handler] of handlers) {
    await boss.createQueue(name, { retryLimit: name.startsWith('effect.') ? 0 : 3, retryBackoff: true, expireInSeconds: 900 });
    await boss.work(name, workOptions(name), batchHandler(name, handler));
  }
  for (const [name, cron] of crons) await boss.schedule(name, cron);
  jobs = new BossJobs(boss);
  return jobs;
}
