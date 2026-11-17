-- Closing known gaps in pages, uploaded files and the ontology's kinds. This migration only adds:
-- no existing row is changed or removed.

/* ───────────── Page versions outlive a deleted page, for the trash period ───────────── */

-- When a page is deleted for good its versions are not removed at once: they are hidden, and marked with the
-- moment the page went, so that Undo of the deletion can bring them back. The trash job removes them once the
-- trash period has passed; deleting the workspace removes them with everything else.
alter table doc_revision add column page_gone_at timestamptz;
create index doc_revision_page_gone on doc_revision (page_gone_at) where page_gone_at is not null;
-- The app role may set and clear that mark, and nothing else: a kept version's contents are still never rewritten.
grant update (page_gone_at) on doc_revision to timmy_app;

/* ───────────── Uploaded files: scanned for viruses, and cleaned up when nothing uses them ───────────── */

-- Whether a virus scanner looked at the file before it could be used. "clean": the scanner found nothing.
-- "not-scanned": no scanner was set up when it arrived. Empty for an upload still on its way, and for files
-- that arrived before this column existed (treated like "not-scanned").
alter table asset add column scan text check (scan in ('clean', 'not-scanned'));
-- The first time the clean-up job found nothing using the file. Cleared again whenever something uses it.
-- A file is only removed once it has gone unused for the whole grace period.
alter table asset add column unused_since timestamptz;

/* ───────────── The ontology's kinds ───────────── */

-- A kind that was tracked and then stopped, as against one that was only ever turned down: the screen says which.
alter table tracked_type add column stopped_at timestamptz;
-- How the look back through recent mail went when the kind was accepted: how many threads were read, how many
-- things were found, and whether it finished or why it stopped.
alter table tracked_type add column reread jsonb;

-- Two things of one kind that a person said are not the same, so they are not offered as "same thing?" again.
-- Either thing going takes the row with it.
create table thing_apart (
  workspace_id text not null references workspace(id) on delete cascade,
  a text not null references entity(id) on delete cascade,
  b text not null references entity(id) on delete cascade,
  decided_by text,
  decided_at timestamptz not null default now(),
  primary key (workspace_id, a, b),
  check (a < b)
);
create index thing_apart_b on thing_apart (b);

alter table thing_apart enable row level security;
alter table thing_apart force row level security;
create policy ws_isolation on thing_apart using (workspace_id = app_workspace()) with check (workspace_id = app_workspace());
grant select, insert, update, delete on thing_apart to timmy_app;
