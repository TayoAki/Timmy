import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { appDatabaseUrl, appPasswordHeldApart, appRolePassword, sysPool } from './pool';

function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [process.env.MIGRATIONS_DIR, resolve(here, '../migrations'), resolve(here, '../../migrations'), resolve(process.cwd(), 'migrations'), resolve(process.cwd(), 'server/migrations')];
  const found = candidates.find((d) => d && existsSync(d));
  if (!found) throw new Error('migrations folder not found');
  return found;
}

/** Applies every migration that hasn't run yet, in name order, each in its own transaction. */
export async function migrate(log: (line: string) => void = () => {}): Promise<string[]> {
  const dir = migrationsDir();
  const c = await sysPool.connect();
  const applied: string[] = [];
  try {
    // One migrator at a time, even when several instances boot together.
    await c.query('select pg_advisory_lock(7411001)');
    await c.query('create table if not exists schema_migration (name text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await c.query('select name from schema_migration')).rows.map((r) => r.name as string));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(dir, file), 'utf8');
      await c.query('begin');
      try {
        await c.query(sql);
        await c.query('insert into schema_migration (name) values ($1)', [file]);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback');
        throw new Error(`migration ${file} failed: ${(e as Error).message}`);
      }
      applied.push(file);
      log(`applied ${file}`);
    }
    if (appPasswordHeldApart()) {
      // The owner set the app role's password and holds it apart; it is theirs to change, never overwritten here.
      await assertAppRoleIsBound();
    } else {
      // The app role signs in with a password derived from the system connection's (see pool.ts).
      const { rows } = await c.query("select format('alter role timmy_app login password %L', $1::text) as sql", [appRolePassword()]);
      await c.query(rows[0].sql);
    }
  } finally {
    await c.query('select pg_advisory_unlock(7411001)').catch(() => {});
    c.release();
  }
  return applied;
}

/**
 * Refuses to start when the app connection held apart signs in as a role that row-level security does not bind
 * (a superuser, or a role that bypasses it, such as the system role): every request would see every workspace.
 */
export async function assertAppRoleIsBound(): Promise<void> {
  const c = new pg.Client({ connectionString: appDatabaseUrl(), application_name: 'timmy-app-check' });
  await c.connect();
  try {
    const { rows } = await c.query('select rolsuper, rolbypassrls from pg_roles where rolname = current_user');
    const role = rows[0] as { rolsuper: boolean; rolbypassrls: boolean } | undefined;
    if (!role || role.rolsuper || role.rolbypassrls) throw new Error('TIMMY_APP_DATABASE_URL must sign in as timmy_app, a role row-level security applies to, not as the owner or a superuser.');
  } finally {
    await c.end().catch(() => {});
  }
}
