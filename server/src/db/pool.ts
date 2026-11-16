import pg from 'pg';
import { createHmac } from 'node:crypto';
import { config } from '../config';

// bigint and numeric columns here are revisions, counters and dollar amounts: all fit a double.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export type Tx = pg.PoolClient;
export type Queryable = Pick<pg.PoolClient, 'query'>;

/**
 * The system pool connects as the database owner. It runs migrations, Better Auth,
 * the job queue and webhook intake. Request handlers must not use it for workspace
 * data: they go through `withWorkspace`, which is bound by row-level security.
 */
export const sysPool = new pg.Pool({ connectionString: config.databaseUrl, max: 6, application_name: 'timmy-sys' });

/** Better Auth's tables live in their own schema, which the app role cannot read. */
export const authPool = new pg.Pool({ connectionString: config.databaseUrl, max: 4, application_name: 'timmy-auth', options: '-c search_path=auth' });

/**
 * The app role's password is derived from the owner's, so there is no second
 * secret to store. Knowing it gives less access than the owner already has.
 */
export function appRolePassword(): string {
  const owner = decodeURIComponent(new URL(config.databaseUrl).password || 'timmy');
  return createHmac('sha256', owner).update('timmy_app').digest('hex');
}

let app: pg.Pool | null = null;
export function appPool(): pg.Pool {
  if (!app) {
    const url = new URL(config.databaseUrl);
    url.username = 'timmy_app';
    url.password = appRolePassword();
    app = new pg.Pool({ connectionString: url.toString(), max: 12, application_name: 'timmy-app' });
  }
  return app;
}

export interface Scope {
  workspaceId: string;
  userId?: string;
  /** Take the workspace's lock, so changes to its state apply one at a time. */
  lock?: boolean;
}

/**
 * Runs `fn` in a transaction that can only see one workspace's rows.
 * Row-level security reads `app.workspace_id`; with no value set, every table is empty.
 */
export async function withWorkspace<T>(scope: Scope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!scope.workspaceId) throw new Error('withWorkspace needs a workspace id');
  const c = await appPool().connect();
  try {
    await c.query('begin');
    await c.query("select set_config('app.workspace_id', $1, true), set_config('app.user_id', $2, true)", [scope.workspaceId, scope.userId ?? '']);
    if (scope.lock) await c.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`ws:${scope.workspaceId}`]);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function sysTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const c = await sysPool.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function closePools() {
  await Promise.allSettled([sysPool.end(), authPool.end(), app?.end()]);
  app = null;
}
