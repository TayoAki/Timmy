# Separately held database credentials

Today the server derives the app role's database password from the owner role's, inside the process. These steps give each role its own password, so the running app never holds the superuser's. The server supports both ways; nothing changes until the variables below are set.

Do this on **staging first**, then production. Steps 2 to 4 belong together: between changing the password and the new deploy, the running server can't open new app connections, so expect about a minute of errors.

1. **Make two passwords**, for example `openssl rand -hex 32`, twice. Call them the app password and the system password. Hex needs no escaping in a URL.
2. **On the `app` service in Railway, add two variables, but don't deploy yet.** Use the same host, port, database and any `?query` as the service's current `DATABASE_URL` (or Railway references such as `${{pgvector.PGHOST}}` if the `pgvector` service lists them):
   - `TIMMY_APP_DATABASE_URL=postgresql://timmy_app:<app password>@<host>:<port>/<db>`
   - `TIMMY_SYSTEM_DATABASE_URL=postgresql://timmy_system:<system password>@<host>:<port>/<db>`
3. **Open psql as the database's superuser** (the user in the `pgvector` service's own `DATABASE_URL`; its public endpoint was removed, so connect from inside Railway, for example `railway ssh` into `pgvector` and then `psql "$DATABASE_URL"`). Run:
   - `alter role timmy_app with login password '<app password>';`
   - the script below, with `SYSTEM_PASSWORD_HERE` replaced. It creates `timmy_system` (can log in, bypasses row-level security, is not a superuser), lets it create in the database, and makes it the owner of the `public`, `auth` and `pgboss` schemas and everything in them except what extensions brought. Its last query should return no rows. If `create role` is refused, the user you connected as is not a superuser: stop there.
4. **Deploy.** The logs should show "Timmy API listening", with no "TIMMY_APP_DATABASE_URL must sign in…" and no "password authentication failed". Check `/api/health`, sign in, change a setting. On staging, also run the live suites.
5. **Remove `DATABASE_URL` from the `app` service only** and redeploy. With both new variables set the server never reads it, so the app no longer holds the superuser's password.

**Rollback:** put `DATABASE_URL` back, delete the two variables, deploy. The server derives `timmy_app`'s password and sets it at boot again.

**Afterwards:** a migration that needs a superuser (a new extension, for example) has to be applied by hand by whoever holds the superuser's password.

The server refuses to start if `TIMMY_APP_DATABASE_URL` signs in as a superuser or as a role that bypasses row-level security, and both passwords are masked in its logs.

```sql
create role timmy_system login bypassrls password 'SYSTEM_PASSWORD_HERE';
do $$
declare who text := 'timmy_system'; r record;
begin
  execute format('grant create on database %I to %I', current_database(), who);
  for r in select nspname from pg_namespace where nspname in ('public','auth','pgboss') loop
    execute format('alter schema %I owner to %I', r.nspname, who); end loop;
  for r in select n.nspname, c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public','auth','pgboss') and c.relkind in ('r','p','v','m','f')
      and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e') loop
    execute format('alter %s %I.%I owner to %I', case r.relkind when 'v' then 'view' when 'm' then 'materialized view' when 'f' then 'foreign table' else 'table' end, r.nspname, r.relname, who); end loop;
  for r in select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public','auth','pgboss') and c.relkind = 'S'
      and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype in ('a','i','e')) loop
    execute format('alter sequence %I.%I owner to %I', r.nspname, r.relname, who); end loop;
  for r in select p.oid::regprocedure as signature, p.prokind from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','auth','pgboss') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') loop
    execute format('alter %s %s owner to %I', case r.prokind when 'p' then 'procedure' when 'a' then 'aggregate' else 'function' end, r.signature, who); end loop;
  for r in select n.nspname, t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname in ('public','auth','pgboss') and t.typtype in ('e','d','r','m')
      and not exists (select 1 from pg_depend d where d.objid = t.oid and d.deptype = 'e') loop
    execute format('alter type %I.%I owner to %I', r.nspname, r.typname, who); end loop;
end $$;
select n.nspname, c.relname, pg_get_userbyid(c.relowner) from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public','auth','pgboss') and c.relkind in ('r','p','v','m','f','S') and pg_get_userbyid(c.relowner) <> 'timmy_system';
```

These steps were rehearsed on a local copy of the database (all browser suites passed with both variables set and `DATABASE_URL` pointing at nothing). The two Railway commands in step 3 were not tried against Railway.
