/**
 * Background work. In production every job goes through pg-boss, which keeps
 * them in Postgres and retries them. Tests use the inline runner, which runs the
 * same handlers on demand so a test decides when time passes.
 */
import { PgBoss } from 'pg-boss';
import { config } from '../config';
import { log } from '../lib/log';

export type Handler = (data: Record<string, unknown>) => Promise<void>;

export interface JobOptions {
  startAfter?: Date | number;
  /** Only one job with this key may be waiting at a time. */
  singletonKey?: string;
}

export interface Jobs {
  enqueue(name: string, data: Record<string, unknown>, opts?: JobOptions): Promise<void>;
  stop(): Promise<void>;
}

const handlers = new Map<string, Handler>();
const crons = new Map<string, string>();

export function defineJob(name: string, handler: Handler, cron?: string) {
  handlers.set(name, handler);
  if (cron) crons.set(name, cron);
}

class BossJobs implements Jobs {
  constructor(private boss: PgBoss) {}
  async enqueue(name: string, data: Record<string, unknown>, opts: JobOptions = {}) {
    await this.boss.send(name, data, { ...(opts.startAfter !== undefined ? { startAfter: opts.startAfter } : {}), ...(opts.singletonKey ? { singletonKey: opts.singletonKey } : {}) });
  }
  async stop() {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }
}

/** Runs jobs in-process when asked. For tests and for local runs without a queue. */
export class InlineJobs implements Jobs {
  queue: { name: string; data: Record<string, unknown>; opts: JobOptions }[] = [];
  async enqueue(name: string, data: Record<string, unknown>, opts: JobOptions = {}) {
    if (opts.singletonKey && this.queue.some((j) => j.name === name && j.opts.singletonKey === opts.singletonKey)) return;
    this.queue.push({ name, data, opts });
  }
  /** Runs everything queued (and whatever those jobs queue), whatever their start time. */
  async drain(only?: string): Promise<number> {
    let ran = 0;
    for (let guard = 0; guard < 200; guard++) {
      const i = this.queue.findIndex((j) => !only || j.name === only);
      if (i < 0) break;
      const [job] = this.queue.splice(i, 1);
      const h = handlers.get(job!.name);
      if (h) await h(job!.data);
      ran++;
    }
    return ran;
  }
  async stop() {
    this.queue = [];
  }
}

let jobs: Jobs = new InlineJobs();
export const getJobs = () => jobs;
export const inlineJobs = () => (jobs instanceof InlineJobs ? jobs : null);
export function setJobs(j: Jobs) {
  jobs = j;
}

/** Enqueue without making the caller wait or fail: a job that can't be queued is picked up by the sweep. */
export function enqueueSoon(name: string, data: Record<string, unknown>, opts?: JobOptions) {
  void jobs.enqueue(name, data, opts).catch((e) => log.warn('could not queue job', { name, error: (e as Error).message }));
}

export async function startBoss(): Promise<Jobs> {
  const boss = new PgBoss({ connectionString: config.databaseUrl, schema: 'pgboss', max: 4 });
  boss.on('error', (e) => log.error('job queue error', { error: (e as Error).message }));
  await boss.start();
  for (const [name, handler] of handlers) {
    await boss.createQueue(name, { retryLimit: name.startsWith('effect.') ? 0 : 3, retryBackoff: true, expireInSeconds: 900 });
    await boss.work(name, { pollingIntervalSeconds: name === 'effect.execute' ? 1 : 2 }, async (batch) => {
      for (const job of batch) {
        try {
          await handler((job.data ?? {}) as Record<string, unknown>);
        } catch (e) {
          log.error('job failed', { name, error: (e as Error).message });
          throw e;
        }
      }
    });
  }
  for (const [name, cron] of crons) await boss.schedule(name, cron);
  jobs = new BossJobs(boss);
  return jobs;
}
