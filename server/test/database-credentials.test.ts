/**
 * Database credentials held apart (TIMMY_SYSTEM_DATABASE_URL, TIMMY_APP_DATABASE_URL).
 *
 * Without them the server signs in as it always has: the system connection with DATABASE_URL, and `timmy_app` with
 * a password derived from it, which every boot sets. With them, each connection signs in with its own; migrations
 * leave the app role's password alone; an app connection that row-level security would not bind is refused; and
 * neither password reaches a log line.
 *
 * The settings are read once at start, so these tests change the loaded config and put it back after each test.
 * They never change a role's password: the one password held apart that can sign in is the one the role already has.
 */
import { createHmac } from 'node:crypto';
import pg from 'pg';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config';
import { assertAppRoleIsBound, migrate } from '../src/db/migrate';
import { appDatabaseUrl, appPasswordHeldApart, appRolePassword, sysPool, systemDatabaseUrl } from '../src/db/pool';
import { log, recent } from '../src/lib/log';
import { boot } from './helpers';

const saved = { system: config.systemDatabaseUrl, app: config.appDatabaseUrl };

beforeAll(async () => {
  await boot();
});

afterEach(() => {
  config.systemDatabaseUrl = saved.system;
  config.appDatabaseUrl = saved.app;
  vi.restoreAllMocks();
});

/** The test database, signed in as `user` with `password`. */
function signedInAs(user: string, password: string): string {
  const url = new URL(config.databaseUrl);
  url.username = user;
  url.password = password;
  return url.toString();
}

/** The app role's password as derived from a system connection's password. */
const derivedFrom = (systemUrl: string) => createHmac('sha256', decodeURIComponent(new URL(systemUrl).password)).update('timmy_app').digest('hex');

/** Who a connection URL really signs in as. */
async function whoSignsIn(url: string): Promise<string> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query('select current_user as name')).rows[0].name as string;
  } finally {
    await c.end();
  }
}

/** Runs the migrations and returns every statement they sent on the system connection. */
async function migrateAndListStatements(): Promise<string[]> {
  const sent: string[] = [];
  const connect = sysPool.connect.bind(sysPool) as () => Promise<pg.PoolClient>;
  vi.spyOn(sysPool, 'connect').mockImplementationOnce((async () => {
    const client = await connect();
    // The client goes back to the pool afterwards, so it is watched through a wrapper and never changed itself.
    return new Proxy(client, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (key === 'query') return (text: unknown, ...rest: unknown[]) => (sent.push(String(text)), (value as (...a: unknown[]) => unknown).apply(target, [text, ...rest]));
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }) as never);
  await migrate();
  return sent;
}

const setsAppPassword = (statements: string[]) => statements.some((s) => /alter role timmy_app login password/i.test(s));

describe('database credentials held apart', () => {
  it('without them, the system connection is DATABASE_URL and the app role’s password is derived from it, as before', async () => {
    config.systemDatabaseUrl = '';
    config.appDatabaseUrl = '';
    expect(systemDatabaseUrl()).toBe(config.databaseUrl);
    expect(sysPool.options.connectionString).toBe(config.databaseUrl);
    expect(appPasswordHeldApart()).toBe(false);
    const app = new URL(appDatabaseUrl());
    const system = new URL(config.databaseUrl);
    expect(app.username).toBe('timmy_app');
    expect(app.password).toBe(derivedFrom(config.databaseUrl));
    expect(appRolePassword()).toBe(derivedFrom(config.databaseUrl));
    expect([app.host, app.pathname]).toEqual([system.host, system.pathname]);
    expect(await whoSignsIn(appDatabaseUrl())).toBe('timmy_app');
    // Every boot sets the derived password, so the app role can always sign in with it.
    expect(setsAppPassword(await migrateAndListStatements())).toBe(true);
  });

  it('with them, each connection uses its own credential instead of the derived one', () => {
    config.systemDatabaseUrl = signedInAs('timmy_system', `system-${'s'.repeat(24)}`);
    config.appDatabaseUrl = signedInAs('timmy_app', `app-${'a'.repeat(24)}`);
    expect(systemDatabaseUrl()).toBe(config.systemDatabaseUrl);
    expect(appDatabaseUrl()).toBe(config.appDatabaseUrl);
    expect(appPasswordHeldApart()).toBe(true);
  });

  it('with only the system role’s held apart, the app role’s password is derived from that one', () => {
    config.systemDatabaseUrl = signedInAs('timmy_system', `system-${'s'.repeat(24)}`);
    config.appDatabaseUrl = '';
    const app = new URL(appDatabaseUrl());
    expect(app.username).toBe('timmy_app');
    expect(app.password).toBe(derivedFrom(config.systemDatabaseUrl));
    expect(appPasswordHeldApart()).toBe(false);
  });

  it('the app connection signs in with the password held apart, not the derived one', async () => {
    config.appDatabaseUrl = signedInAs('timmy_app', 'not-the-app-role-password-0123456789');
    await expect(whoSignsIn(appDatabaseUrl())).rejects.toThrow(/password authentication failed/);
    await expect(assertAppRoleIsBound()).rejects.toThrow(/password authentication failed/);
    // The role's real password, now given as one held apart: it signs in.
    config.appDatabaseUrl = signedInAs('timmy_app', derivedFrom(config.databaseUrl));
    expect(await whoSignsIn(appDatabaseUrl())).toBe('timmy_app');
    await expect(assertAppRoleIsBound()).resolves.toBeUndefined();
  });

  it('migrations leave a password held apart alone', async () => {
    config.appDatabaseUrl = signedInAs('timmy_app', derivedFrom(config.databaseUrl));
    const statements = await migrateAndListStatements();
    expect(statements.length).toBeGreaterThan(0);
    expect(setsAppPassword(statements)).toBe(false);
  });

  it('refuses to start when the app connection held apart would not be bound by row-level security', async () => {
    // The test database's owner is a superuser: every request would see every workspace.
    config.appDatabaseUrl = config.databaseUrl;
    await expect(migrate()).rejects.toThrow(/TIMMY_APP_DATABASE_URL must sign in as timmy_app/);
    // The migration lock was let go: the next boot migrates as usual.
    config.appDatabaseUrl = saved.app;
    await expect(migrate()).resolves.toEqual([]);
  });

  it('never writes a password held apart to the log, as written or escaped in the URL', () => {
    const systemPassword = `Sys-${'q7W'.repeat(8)}`;
    const appPassword = `App/${'r8E'.repeat(8)}@:`;
    config.systemDatabaseUrl = signedInAs('timmy_system', systemPassword);
    config.appDatabaseUrl = signedInAs('timmy_app', appPassword);
    const escaped = new URL(config.appDatabaseUrl).password;
    expect(escaped).not.toBe(appPassword);
    expect(systemDatabaseUrl()).toBe(config.systemDatabaseUrl);
    expect(appDatabaseUrl()).toBe(config.appDatabaseUrl);
    log.error('could not sign in to the database', { error: `refused ${systemPassword} and ${appPassword}`, detail: { url: config.appDatabaseUrl, escaped } });
    log.warn(`a line that names ${systemPassword}, ${appPassword} and ${escaped}`);
    // Taken back out of the shared list once read: other files check that list for the test database's own
    // password, which is part of these URLs' names.
    const lines = recent.splice(-2).join('\n');
    expect(lines.split('\n')).toHaveLength(2);
    expect(lines).toContain('[redacted]');
    for (const secret of [systemPassword, appPassword, escaped]) expect(lines).not.toContain(secret);
  });
});
