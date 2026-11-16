-- The ontology, first version: who and what a workspace's mail, calendar and files are about.
-- Every entity and every link between two entities points at the stored item it came from, and that
-- pointer goes when the item goes: disconnecting an account takes what was learned from it with it.

alter table item add column if not exists ontology_at timestamptz;
create index if not exists item_ontology_todo on item (workspace_id, created_at) where ontology_at is null;

create table entity (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  type text not null check (type in ('person', 'organization', 'meeting', 'document', 'commitment')),
  -- What makes two sightings the same thing: an email address, a domain, the provider's id for an event or file.
  key text not null,
  name text not null default '',
  attrs jsonb not null default '{}',
  mentions integer not null default 0,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  unique (workspace_id, type, key)
);
create index entity_recent on entity (workspace_id, type, last_seen desc);
create index entity_name on entity using gin (to_tsvector('simple', name || ' ' || key));

create table relation (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  kind text not null check (kind in ('works_at', 'attended', 'owns', 'promised_by', 'owed_to')),
  from_id text not null references entity(id) on delete cascade,
  to_id text not null references entity(id) on delete cascade,
  unique (workspace_id, kind, from_id, to_id)
);
create index relation_to on relation (workspace_id, to_id);

-- Why Timmy believes something: the item it was read from, and for anything a model read, the words it rests on.
create table evidence (
  id bigserial primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  entity_id text references entity(id) on delete cascade,
  relation_id text references relation(id) on delete cascade,
  item_id text not null references item(id) on delete cascade,
  quote text,
  created_at timestamptz not null default now(),
  check (entity_id is not null or relation_id is not null)
);
create unique index evidence_entity_once on evidence (entity_id, item_id) where relation_id is null;
create unique index evidence_relation_once on evidence (relation_id, item_id) where relation_id is not null;
create index evidence_item on evidence (item_id);

-- Other names the same person or company goes by, as seen in their own mail.
create table term (
  workspace_id text not null references workspace(id) on delete cascade,
  entity_id text not null references entity(id) on delete cascade,
  term text not null,
  primary key (entity_id, term)
);

do $$
declare t text;
begin
  foreach t in array array['entity', 'relation', 'evidence', 'term'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy ws_isolation on %I using (workspace_id = app_workspace()) with check (workspace_id = app_workspace())', t);
    execute format('grant select, insert, update, delete on %I to timmy_app', t);
  end loop;
end $$;
grant usage, select on all sequences in schema public to timmy_app;
