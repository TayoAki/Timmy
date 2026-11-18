-- Detecting projects: a scan groups a workspace's mail, meetings and files into the projects they seem to be about,
-- the person keeps, renames, merges or drops each, and what they keep becomes a project. A project then remembers
-- the files and meetings that belong to it, and whose new mail is filed into it.

create table project_scan (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  status text not null check (status in ('running', 'ready', 'failed', 'applied')),
  started_by text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error text,
  -- What the scan found: each proposed project with its threads, people, files and meetings.
  proposals jsonb not null default '[]',
  -- How much it looked at, for the screen.
  looked jsonb not null default '{}'
);
create index project_scan_recent on project_scan (workspace_id, started_at desc);

-- A file or a meeting (an item) that belongs to a project. It goes when the item goes.
create table project_link (
  workspace_id text not null references workspace(id) on delete cascade,
  project_id text not null,
  item_id text not null references item(id) on delete cascade,
  primary key (workspace_id, project_id, item_id)
);

-- Whose mail belongs to a project: an organisation's domain ('org:acme.com') or one person's address
-- ('person:dana@gmail.com'). New mail from them is filed into the project when exactly one project claims them.
create table project_key (
  workspace_id text not null references workspace(id) on delete cascade,
  project_id text not null,
  key text not null,
  primary key (workspace_id, key, project_id)
);

do $$
declare t text;
begin
  foreach t in array array['project_scan', 'project_link', 'project_key'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy ws_isolation on %I using (workspace_id = app_workspace()) with check (workspace_id = app_workspace())', t);
    execute format('grant select, insert, update, delete on %I to timmy_app', t);
  end loop;
end $$;
