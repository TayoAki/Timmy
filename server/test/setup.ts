import pg from 'pg';

/** Starts every run from an empty database. Refuses to touch anything not named like a test database. */
export default async function setup() {
  const url = process.env.DATABASE_URL ?? 'postgres://timmy_owner:timmy@localhost:5432/timmy_test';
  const name = new URL(url).pathname.slice(1);
  if (!/test|e2e/.test(name)) throw new Error(`refusing to wipe "${name}": the test database must have "test" in its name`);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('drop schema if exists pgboss cascade; drop schema if exists auth cascade; drop schema if exists public cascade; create schema public;');
  await c.end();
}
