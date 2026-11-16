-- Timmy backend, first migration.
-- Run as the database owner. Request handlers and jobs connect as `timmy_app`,
-- which cannot bypass row-level security and has no access to the auth schema.

create extension if not exists vector;
create extension if not exists pgcrypto;

create schema if not exists auth;

do $$ begin
  if not exists (select from pg_roles where rolname = 'timmy_app') then
    create role timmy_app login nobypassrls nosuperuser nocreatedb nocreaterole;
  end if;
end $$;

grant usage on schema public to timmy_app;
revoke all on schema auth from timmy_app;

/** The workspace the current transaction is scoped to, or null when none is set. */
create or replace function app_workspace() returns text
  language sql stable as $$ select nullif(current_setting('app.workspace_id', true), '') $$;

/* ───────────── Workspaces ───────────── */

create table workspace (
  id text primary key,                         -- the Better Auth organization id
  name text not null,
  trade text not null default 'other',
  parent_id text references workspace(id) on delete set null,
  timezone text not null default 'UTC',
  owner_name text,
  owner_email text,
  model_id text,                               -- null means the default model
  approval_mode text not null default 'ask' check (approval_mode in ('ask', 'auto')),
  max_concurrent_runs int not null default 2,
  monthly_spend_cap_usd numeric(10, 2) not null default 50,
  kill_switch boolean not null default false,  -- stops every outside write for this workspace
  state_rev bigint not null default 0,
  ord_seq bigint not null default 0,
  created_at timestamptz not null default now()
);

/* ───────────── Client state: what the screens show ───────────── */

-- One row per entity, in the frontend's shape. `slice` is the path in the
-- reducer's state ("threads", "ws.tasks", "out.leads", "schedule").
create table state_doc (
  workspace_id text not null references workspace(id) on delete cascade,
  slice text not null,
  id text not null,
  data jsonb not null,
  ord double precision not null default 0,     -- position inside array slices
  rev bigint not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, slice, id)
);
create index state_doc_order on state_doc (workspace_id, slice, ord);

-- Patches by revision, so every open tab can catch up from the last one it saw.
create table state_change (
  workspace_id text not null references workspace(id) on delete cascade,
  rev bigint not null,
  patches jsonb not null,
  origin text,
  at timestamptz not null default now(),
  primary key (workspace_id, rev)
);

-- Every command a client sent, with what it changed, for idempotent retries and undo.
create table command (
  workspace_id text not null references workspace(id) on delete cascade,
  id text not null,
  user_id text not null,
  action jsonb not null,
  result jsonb,
  pre jsonb,                                   -- the documents as they were before, for undo
  rev bigint,
  undone_at timestamptz,
  at timestamptz not null default now(),
  primary key (workspace_id, id)
);

/* ───────────── Connections and sync ───────────── */

create table connection (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  user_id text not null,
  app_id text not null,                        -- the frontend's app id: gmail, gcal, gdrive, outlook…
  toolkit text not null,                       -- Composio toolkit slug
  composio_user_id text not null,
  connected_account_id text,
  auth_config_id text,
  status text not null default 'pending' check (status in ('pending', 'active', 'failed', 'disconnected')),
  account_label text,                          -- the address or account name
  purpose text not null default 'primary' check (purpose in ('primary', 'sending')),
  meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disconnected_at timestamptz
);
create unique index connection_account on connection (connected_account_id) where connected_account_id is not null;
create index connection_ws on connection (workspace_id, app_id);

create table sync_cursor (
  connection_id text not null references connection(id) on delete cascade,
  workspace_id text not null references workspace(id) on delete cascade,
  kind text not null,                          -- backfill | history | events
  cursor jsonb not null default '{}',
  state text not null default 'idle',
  items_done int not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (connection_id, kind)
);

create table trigger_instance (
  id text primary key,                         -- Composio trigger id
  connection_id text not null references connection(id) on delete cascade,
  workspace_id text not null references workspace(id) on delete cascade,
  slug text not null,
  created_at timestamptz not null default now()
);

-- Raw provider events, kept 7 days. No workspace is known until the event is routed,
-- so only the system role can read this table.
create table webhook_event (
  id text primary key,
  source text not null,
  connected_account_id text,
  workspace_id text,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text
);
create index webhook_event_received on webhook_event (received_at);

/* ───────────── Items: every message, event, file and record ───────────── */

create table item (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  connection_id text not null references connection(id) on delete cascade,
  kind text not null check (kind in ('message', 'event', 'file', 'record')),
  external_id text not null,
  thread_key text,
  occurred_at timestamptz not null,
  sender text,
  recipients jsonb not null default '[]',
  subject text,
  snippet text,
  labels text[] not null default '{}',
  direction text check (direction in ('in', 'out')),
  meta jsonb not null default '{}',
  embedding vector(1536),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, connection_id, kind, external_id)
);
create index item_thread on item (workspace_id, thread_key, occurred_at);
create index item_recent on item (workspace_id, kind, occurred_at desc);
create index item_fts on item using gin (to_tsvector('english', coalesce(subject, '') || ' ' || coalesce(snippet, '') || ' ' || coalesce(sender, '')));

-- Bodies live apart from the index row so they can expire on their own schedule.
create table item_body (
  item_id text primary key references item(id) on delete cascade,
  workspace_id text not null references workspace(id) on delete cascade,
  text text not null default '',
  tsv tsvector generated always as (to_tsvector('english', left(text, 200000))) stored,
  expires_at timestamptz
);
create index item_body_fts on item_body using gin (tsv);

/* ───────────── Runs ───────────── */

create table run (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  user_id text,
  kind text not null,                          -- ask | draft | read | routine
  attended boolean not null default true,      -- false: no person is watching; only rules may send
  status text not null check (status in ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled')),
  thread_id text,                              -- the chat conversation, when there is one
  input jsonb not null,
  model text not null,
  effort text,
  lease_owner text,
  lease_until timestamptz,
  fence bigint not null default 0,             -- goes up on every claim; a stale worker's writes fail
  step int not null default 0,
  read_outside boolean not null default false, -- the run has read fetched mail, files or web pages
  waiting_effect_id text,
  result jsonb,
  error text,
  cost_usd numeric(12, 6) not null default 0,
  tokens_in bigint not null default 0,
  tokens_out bigint not null default 0,
  tokens_reasoning bigint not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
create index run_claimable on run (status, lease_until);
create index run_ws on run (workspace_id, created_at desc);

create table run_checkpoint (
  run_id text not null references run(id) on delete cascade,
  workspace_id text not null references workspace(id) on delete cascade,
  seq int not null,
  fence bigint not null,
  messages jsonb not null,                     -- the transcript so far
  pending jsonb,                               -- the tool call waiting on an effect, if any
  created_at timestamptz not null default now(),
  primary key (run_id, seq)
);

/* ───────────── Effects: every outside write ───────────── */

create table policy (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  kind text not null,                          -- the effect kind this rule covers
  scope jsonb not null default '{}',           -- conditions the effect must match
  enabled boolean not null default true,
  label text not null,
  created_by text not null,                    -- always a person
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table effect (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  kind text not null,
  payload jsonb not null,
  payload_hash text not null,
  preview jsonb not null default '{}',
  target text,
  risk text not null default 'normal' check (risk in ('low', 'normal', 'high')),
  idempotency_key text not null,
  status text not null check (status in ('intended', 'approved', 'executing', 'completed', 'uncertain', 'failed', 'declined', 'cancelled')),
  source text not null check (source in ('user', 'agent', 'rule', 'routine')),
  run_id text references run(id) on delete set null,
  command_id text,
  requested_by text not null,
  on_behalf_of text,
  approver_route text not null default 'user' check (approver_route in ('user', 'exec', 'revops')),
  approved_by text,
  approved_via text check (approved_via in ('click', 'rule', 'auto')),
  policy_id text references policy(id) on delete set null,
  approved_at timestamptz,
  hold_until timestamptz,                      -- sends wait here so they can be undone
  attempt int not null default 0,
  executing_at timestamptz,
  completed_at timestamptz,
  result jsonb,
  error text,
  external_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);
create index effect_due on effect (status, hold_until);
create index effect_ws on effect (workspace_id, created_at desc);

-- The state machine lives in the database, so no code path can skip a step:
-- nothing reaches `executing` unless it was `approved` by someone or by a rule.
create or replace function effect_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'intended' then
      if new.approved_by is not null then raise exception 'effect %: an intended effect cannot carry an approver', new.id; end if;
    elsif new.status = 'approved' then
      if new.approved_by is null or new.approved_via is null then raise exception 'effect %: approved without an approver', new.id; end if;
      if new.approved_via = 'rule' and new.policy_id is null then raise exception 'effect %: rule approval without a rule', new.id; end if;
    else
      raise exception 'effect %: cannot be created as %', new.id, new.status;
    end if;
    return new;
  end if;

  if new.kind is distinct from old.kind or new.payload is distinct from old.payload
     or new.payload_hash is distinct from old.payload_hash or new.idempotency_key is distinct from old.idempotency_key
     or new.workspace_id is distinct from old.workspace_id or new.requested_by is distinct from old.requested_by
     or new.source is distinct from old.source then
    raise exception 'effect %: what was approved cannot change', old.id;
  end if;

  if new.status is distinct from old.status then
    if not (
      (old.status = 'intended'  and new.status in ('approved', 'declined', 'cancelled')) or
      (old.status = 'approved'  and new.status in ('executing', 'cancelled')) or
      (old.status = 'executing' and new.status in ('completed', 'uncertain', 'failed')) or
      (old.status = 'uncertain' and new.status in ('completed', 'failed'))
    ) then
      raise exception 'effect %: % cannot become %', old.id, old.status, new.status;
    end if;
    if new.status = 'approved' and (new.approved_by is null or new.approved_via is null) then
      raise exception 'effect %: approved without an approver', old.id;
    end if;
    if new.status = 'approved' and new.approved_via = 'rule' and new.policy_id is null then
      raise exception 'effect %: rule approval without a rule', old.id;
    end if;
    if new.status = 'executing' and old.approved_by is null then
      raise exception 'effect %: cannot run without an approval', old.id;
    end if;
  elsif old.status <> 'intended' and (new.approved_by is distinct from old.approved_by or new.approved_via is distinct from old.approved_via) then
    raise exception 'effect %: the approval cannot change', old.id;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger effect_guard before insert or update on effect for each row execute function effect_guard();

create table approval (
  id bigserial primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  effect_id text not null references effect(id) on delete cascade,
  decision text not null check (decision in ('approve', 'decline', 'undo')),
  decided_by text not null,
  via text not null check (via in ('click', 'rule', 'auto')),
  note text,
  at timestamptz not null default now()
);

-- Append-only: who asked, who approved, on whose behalf, what ran.
create table audit_log (
  id bigserial primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  at timestamptz not null default now(),
  actor text not null,
  on_behalf_of text,
  action text not null,
  effect_id text,
  run_id text,
  detail jsonb not null default '{}'
);
create index audit_ws on audit_log (workspace_id, at desc);
create or replace function audit_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'the audit log is append-only';
end $$;
create trigger audit_no_update before update or delete on audit_log for each row execute function audit_append_only();
create trigger audit_no_truncate before truncate on audit_log for each statement execute function audit_append_only();

/* ───────────── Usage and cost ───────────── */

create table usage_event (
  id bigserial primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  at timestamptz not null default now(),
  route text not null,
  model text not null,
  provider text,
  run_id text,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  tokens_reasoning int not null default 0,
  tokens_cached int not null default 0,
  tokens_cache_write int not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  generation_id text,
  ms int,
  ok boolean not null default true
);
create index usage_ws on usage_event (workspace_id, at);

create table provider_call (
  id bigserial primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  at timestamptz not null default now(),
  provider text not null,
  op text not null,
  phase text not null,                         -- connect | backfill | sync | agent | send
  ok boolean not null default true,
  ms int
);
create index provider_call_ws on provider_call (workspace_id, at);

/* ───────────── System-only tables ───────────── */

create table app_secret (
  name text primary key,
  value text not null,
  created_at timestamptz not null default now()
);

-- Sign-in links and invitations wait here until a mail provider is configured.
create table email_outbox (
  id bigserial primary key,
  to_address text not null,
  subject text not null,
  body text not null,
  kind text not null,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

/* ───────────── Row-level security ───────────── */

alter table workspace enable row level security;
alter table workspace force row level security;
create policy ws_isolation on workspace using (id = app_workspace()) with check (id = app_workspace());
grant select, update on workspace to timmy_app;

do $$
declare t text;
begin
  foreach t in array array[
    'state_doc', 'state_change', 'command', 'connection', 'sync_cursor', 'trigger_instance',
    'item', 'item_body', 'run', 'run_checkpoint', 'policy', 'effect', 'approval', 'audit_log',
    'usage_event', 'provider_call'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy ws_isolation on %I using (workspace_id = app_workspace()) with check (workspace_id = app_workspace())', t);
    execute format('grant select, insert, update, delete on %I to timmy_app', t);
  end loop;
end $$;

-- The app role may add to the audit log and read it, nothing else.
revoke update, delete on audit_log from timmy_app;
-- Effects are never deleted.
revoke delete on effect from timmy_app;
revoke delete on approval from timmy_app;
revoke update on approval from timmy_app;

grant usage, select on all sequences in schema public to timmy_app;

-- webhook_event, app_secret and email_outbox stay with the system role: no grants to timmy_app.
alter table webhook_event enable row level security;
alter table app_secret enable row level security;
alter table email_outbox enable row level security;
