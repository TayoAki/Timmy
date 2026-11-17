import pg from 'pg';
import { createHmac } from 'node:crypto';
import { config } from '../config';
import { addSecret } from '../lib/log';

// bigint and numeric columns here are revisions, counters and dollar amounts: all fit a double.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export type Tx = pg.PoolClient;

/*
 * Two database roles, two connections. The system connection signs in as the role that owns the schema; the app
 * connection signs in as `timmy_app`, which row-level security applies to. Each role can have its own password,
 * held apart from the other (config.systemDatabaseUrl, config.appDatabaseUrl). Without them, the system connection
 * is DATABASE_URL and the app role's password is derived from it, as it always was.
 */

/** A password held apart is masked in every log line, like the server's other secrets. Returns the URL unchanged. */
function heldApart(url: string): string {
  const password = new URL(url).password;
  addSecret(password);
  // And as it is sent to the database: in a URL, a password's special characters are escaped.
  try {
    addSecret(decodeURIComponent(password));
  } catch {
    // Not a valid escape, so there is no other form to mask; the text as written is masked above.
  }
  return url;
}

/** Where the system connection signs in. */
export function systemDatabaseUrl(): string {
  return config.systemDatabaseUrl ? heldApart(config.systemDatabaseUrl) : config.databaseUrl;
}

/** Whether the app role's password is the owner's to set (TIMMY_APP_DATABASE_URL), instead of derived and set at boot. */
export const appPasswordHeldApart = () => !!config.appDatabaseUrl;

/**
 * Where the app connection signs in: the URL held apart when there is one; otherwise `timmy_app` on the system
 * connection's server and database, with the derived password.
 */
export function appDatabaseUrl(): string {
  if (config.appDatabaseUrl) return heldApart(config.appDatabaseUrl);
  const url = new URL(systemDatabaseUrl());
  url.username = 'timmy_app';
  url.password = appRolePassword();
  return url.toString();
}

// Masked from the start, before anything has connected with them.
if (config.appDatabaseUrl) heldApart(config.appDatabaseUrl);

/**
 * The system pool connects as the database owner, or the system role when it has its own credential. It runs
 * migrations, Better Auth, the job queue and webhook intake. Request handlers must not use it for workspace
 * data: they go through `withWorkspace`, which is bound by row-level security.
 */
export const sysPool = new pg.Pool({ connectionString: systemDatabaseUrl(), max: 6, application_name: 'timmy-sys' });

/** Better Auth's tables live in their own schema, which the app role cannot read. */
export const authPool = new pg.Pool({ connectionString: systemDatabaseUrl(), max: 4, application_name: 'timmy-auth', options: '-c search_path=auth' });

/**
 * Unless it is held apart, the app role's password is derived from the system connection's, so there is no
 * second secret to store. Knowing it gives less access than the system role already has.
 */
export function appRolePassword(): string {
  const owner = decodeURIComponent(new URL(systemDatabaseUrl()).password || 'timmy');
  return createHmac('sha256', owner).update('timmy_app').digest('hex');
}

let app: pg.Pool | null = null;
export function appPool(): pg.Pool {
  if (!app) app = new pg.Pool({ connectionString: appDatabaseUrl(), max: 12, application_name: 'timmy-app' });
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

export async function closePools() {
  await Promise.allSettled([sysPool.end(), authPool.end(), app?.end()]);
  app = null;
}
