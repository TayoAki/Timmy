/**
 * The real job queue (pg-boss), not the in-process runner the other tests use. A job queued with a key is not
 * queued again while one with that key is still waiting: a burst of provider events makes one sync, not twenty.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgBoss } from 'pg-boss';
import { config } from '../src/config';
import { BossJobs, batchHandler, workOptions } from '../src/jobs/jobs';
import { sysPool } from './helpers';

const SCHEMA = 'pgboss_queue_test';
let boss: PgBoss;
let jobs: BossJobs;
const later = () => new Date(Date.now() + 3_600_000);
const count = async (name: string) => Number((await sysPool.query(`select count(*)::int as n from ${SCHEMA}.job where name = $1`, [name])).rows[0].n);

beforeAll(async () => {
  await sysPool.query(`drop schema if exists ${SCHEMA} cascade`);
  boss = new PgBoss({ connectionString: config.databaseUrl, schema: SCHEMA, max: 2, supervise: false, schedule: false });
  await boss.start();
  for (const q of ['sync.test', 'other.test', 'effect.execute', 'mail.ingest']) await boss.createQueue(q, { retryLimit: 0 });
  jobs = new BossJobs(boss, SCHEMA);
});

afterAll(async () => {
  await boss.stop({ graceful: false, timeout: 1000 });
  await sysPool.query(`drop schema if exists ${SCHEMA} cascade`);
});

describe('the real job queue', () => {
  it('a job with a key is queued once while one with that key is waiting', async () => {
    for (let i = 0; i < 5; i++) await jobs.enqueue('sync.test', { i }, { singletonKey: 'cal:conn-1', startAfter: later() });
    expect(await count('sync.test')).toBe(1);
  });

  it('another key, another queue, or no key at all is queued as usual', async () => {
    await jobs.enqueue('sync.test', {}, { singletonKey: 'cal:conn-2', startAfter: later() });
    await jobs.enqueue('other.test', {}, { singletonKey: 'cal:conn-1', startAfter: later() });
    await jobs.enqueue('other.test', {}, { startAfter: later() });
    await jobs.enqueue('other.test', {}, { startAfter: later() });
    expect(await count('sync.test')).toBe(2);
    expect(await count('other.test')).toBe(3);
  });

  it('once the waiting job has run, the key can be queued again', async () => {
    await sysPool.query(`update ${SCHEMA}.job set state = 'completed' where name = 'sync.test' and singleton_key = 'cal:conn-1'`);
    await jobs.enqueue('sync.test', {}, { singletonKey: 'cal:conn-1', startAfter: later() });
    expect(Number((await sysPool.query(`select count(*)::int as n from ${SCHEMA}.job where name = 'sync.test' and singleton_key = 'cal:conn-1' and state = 'created'`)).rows[0].n)).toBe(1);
  });
});

describe('working through a burst', () => {
  it('runs a hundred quick jobs in seconds, in the order they were queued, not one a second', async () => {
    const ran: number[] = [];
    await boss.work('effect.execute', workOptions('effect.execute'), batchHandler('effect.execute', async (d) => void ran.push(Number(d.i))));
    const started = Date.now();
    for (let i = 0; i < 100; i++) await jobs.enqueue('effect.execute', { i });
    for (let i = 0; i < 200 && ran.length < 100; i++) await new Promise((r) => setTimeout(r, 50));
    expect(ran).toHaveLength(100);
    // One at a time, with the one-second pause between fetches, this took more than a minute and a half.
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(ran).toEqual([...ran].sort((a, b) => a - b));
  });

  it('a job that fails doesn’t stop the rest of its batch', async () => {
    const ran: number[] = [];
    await boss.work('mail.ingest', workOptions('mail.ingest'), batchHandler('mail.ingest', async (d) => {
      if (d.i === 2) throw new Error('this one fails');
      ran.push(Number(d.i));
    }));
    for (let i = 0; i < 5; i++) await jobs.enqueue('mail.ingest', { i });
    for (let i = 0; i < 200 && ran.length < 4; i++) await new Promise((r) => setTimeout(r, 50));
    expect(ran.sort()).toEqual([0, 1, 3, 4]);
  });
});

