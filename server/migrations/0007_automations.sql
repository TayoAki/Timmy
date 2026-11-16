-- The automation engine, version 1.
--
-- The drawing itself (name, steps, connections, the On switch the screens show) stays in the workspace's
-- state, where the canvas reads it. These tables hold what the engine needs to run it safely:
--   automation_version  a frozen copy of the steps, made each time one is switched on or saved while on;
--   automation_live     which version runs now, and the engine's own bookkeeping for the automation;
--   automation_run      one run of a version for one trigger event;
--   automation_step     what each step of a run did.

create table automation_version (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  automation_id text not null,                 -- the id the automation has in the workspace's state
  name text not null,
  graph jsonb not null,                        -- the steps and connections exactly as they will run
  graph_hash text not null,
  created_by text not null,                    -- the owner or admin whose action froze it
  created_at timestamptz not null default now()
);
create index automation_version_of on automation_version (workspace_id, automation_id, created_at desc);

create table automation_live (
  workspace_id text not null references workspace(id) on delete cascade,
  automation_id text not null,
  version_id text not null references automation_version(id) on delete cascade,
  enabled boolean not null default true,
  trigger_kind text not null,
  enabled_by text not null,
  enabled_at timestamptz not null default now(),
  next_fire_at timestamptz,                    -- "On a schedule": the next time it is due
  failures_in_a_row int not null default 0,
  off_reason text,                             -- why it is off, when Timmy or a person switched it off
  updated_at timestamptz not null default now(),
  primary key (workspace_id, automation_id)
);
create index automation_live_schedule on automation_live (next_fire_at) where enabled and next_fire_at is not null;

create table automation_run (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  automation_id text not null,
  version_id text not null references automation_version(id) on delete cascade,
  trigger_event_id text not null,              -- the stored email, or the scheduled time, that started it
  status text not null check (status in ('queued', 'running', 'waiting', 'done', 'failed', 'cancelled')),
  context jsonb not null default '{}',         -- the trigger's fields and each step's output
  cursor text,                                 -- the step to run next
  depth int not null default 0 check (depth between 0 and 3), -- how many automations led to this one
  origin jsonb not null default '[]',          -- the runs that led to this one, oldest first
  wake_at timestamptz,                         -- waiting for a time
  waiting_effect_id text,                      -- waiting for a person's decision on this effect
  lease_token text,                            -- held by the worker running it; a worker that lost it writes nothing
  lease_until timestamptz,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
-- One run per automation and trigger event, whatever its version: a repeated webhook or a retried job
-- finds the run that already exists. (This is stronger than one per version and event, and implies it.)
create unique index automation_run_once on automation_run (workspace_id, automation_id, trigger_event_id);
create index automation_run_recent on automation_run (workspace_id, automation_id, created_at desc);
create index automation_run_due on automation_run (status, wake_at);

create table automation_step (
  run_id text not null references automation_run(id) on delete cascade,
  workspace_id text not null references workspace(id) on delete cascade,
  node_id text not null,
  seq int not null,                            -- the order in which the run reached it
  kind text not null,
  status text not null check (status in ('running', 'waiting', 'done', 'failed', 'cancelled')),
  input jsonb not null default '{}',
  output jsonb not null default '{}',
  effect_id text references effect(id) on delete set null, -- when the step proposed an effect record
  attempt int not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (run_id, node_id)
);
create index automation_step_effect on automation_step (effect_id) where effect_id is not null;

/* ───────────── Row-level security, the same as every other workspace table ───────────── */

do $$
declare t text;
begin
  foreach t in array array['automation_version', 'automation_live', 'automation_run', 'automation_step'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy ws_isolation on %I using (workspace_id = app_workspace()) with check (workspace_id = app_workspace())', t);
    execute format('grant select, insert, update, delete on %I to timmy_app', t);
  end loop;
end $$;

-- A version is frozen: the app role can add one and read it, and nothing else.
revoke update, delete on automation_version from timmy_app;
