-- Version history for pages (the docs written in Timmy).
--
-- A page's current contents live in the workspace's state (the `ws.docs` slice). Each row here is an
-- earlier copy: what the page held just before a change replaced it. Copies are numbered per page,
-- 1, 2, 3 and so on. A copy is never changed after it is kept, so the app role may add, read and
-- delete rows but not update them.

create table doc_revision (
  workspace_id text not null references workspace(id) on delete cascade,
  file_id text not null,                       -- the page's id in the workspace's state
  version integer not null,                    -- running number per page
  blocks jsonb not null,                       -- the page's blocks as they were
  icon text,
  cover jsonb,
  -- Who made the change these contents were kept ahead of. Null when nobody was at the keyboard
  -- (a job or an automation wrote into the page).
  author text,
  reason text not null check (reason in ('edit', 'before-timmy', 'before-restore')),
  -- Worked out once, when the copy is kept, so listing a page's versions never has to open their blocks.
  preview text not null default '',
  block_count integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (workspace_id, file_id, version)
);
-- For the job that removes copies past their keeping time.
create index doc_revision_age on doc_revision (created_at);

alter table doc_revision enable row level security;
alter table doc_revision force row level security;
create policy ws_isolation on doc_revision using (workspace_id = app_workspace()) with check (workspace_id = app_workspace());
grant select, insert, delete on doc_revision to timmy_app;

-- The job that empties the trash asks which pages have been there longest. Trash rows are a sliver of
-- state_doc, so they get an index of their own instead of a scan of every stored thread and task.
create index state_doc_trash_age on state_doc (updated_at) where slice = 'ws.trash';
