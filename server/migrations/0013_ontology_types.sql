-- The ontology's next step: the kinds of thing a workspace's trade is about (deals, properties, candidates…).
-- A kind is only read out of the mail once a person has accepted it. This migration only adds: no existing
-- row is changed or removed.

-- The kinds a workspace tracks, has been offered, or has turned down.
create table tracked_type (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  -- The kind in one fixed spelling ("deal", "purchase order"). What is seen in the mail is matched against it,
  -- and it is how a dismissed kind is remembered so it is not proposed again. Renaming changes `name`, never this.
  key text not null,
  name text not null,
  -- The fields kept for each thing of this kind, in order: [{"key":"close_date","label":"close date"}].
  -- The first one names the thing.
  fields jsonb not null default '[]',
  -- proposed: offered, nothing is read for it yet. certified: a person accepted it. dismissed: a person said no.
  status text not null check (status in ('proposed', 'certified', 'dismissed')),
  -- trade: it came with the trade chosen at sign-up. seen: Timmy noticed it in the mail.
  source text not null check (source in ('trade', 'seen')),
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, key)
);

-- A thing of a tracked kind is an entity like a person or a company, with the same evidence behind it.
-- The list of allowed types gains one value; every existing row already satisfies it.
alter table entity drop constraint entity_type_check;
alter table entity add constraint entity_type_check check (type in ('person', 'organization', 'meeting', 'document', 'commitment', 'thing'));
-- Which kind a thing is. When a kind's row goes, so does everything learned of it.
alter table entity add column type_id text references tracked_type(id) on delete cascade;
alter table entity add constraint entity_thing_has_type check ((type = 'thing') = (type_id is not null));
create index entity_of_type on entity (type_id, last_seen desc) where type_id is not null;

-- What one message said about a thing: the field values its sentence gave. A thing's fields are always what
-- its remaining evidence says, so when a message is deleted the values only it gave are forgotten with it.
alter table evidence add column fields jsonb;

-- A kind of thing noticed in a thread that fits nothing the workspace tracks. These are only counted: one row
-- per kind and thread. A kind seen in enough threads is offered to the person, with these rows as its examples.
-- Each row points at the message it was read from and goes when that message goes.
create table type_sighting (
  id bigserial primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  kind text not null,
  connection_id text not null references connection(id) on delete cascade,
  thread_key text not null,
  item_id text not null references item(id) on delete cascade,
  name text not null,
  -- [["price", "$450,000"], …]: field names and values as read, each value checked against the thread.
  fields jsonb not null default '[]',
  quote text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, kind, connection_id, thread_key)
);
create index type_sighting_item on type_sighting (item_id);

do $$
declare t text;
begin
  foreach t in array array['tracked_type', 'type_sighting'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy ws_isolation on %I using (workspace_id = app_workspace()) with check (workspace_id = app_workspace())', t);
    execute format('grant select, insert, update, delete on %I to timmy_app', t);
  end loop;
end $$;
grant usage, select on all sequences in schema public to timmy_app;
