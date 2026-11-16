-- Picking up what the person changed in Gmail or Outlook itself.
--
-- What a connected mailbox last showed for a thread: whether it was in the inbox, which of Timmy's three labels
-- (categories, in Outlook) it carried, whether it was unread, and whether it had been deleted or marked as spam.
-- A later look at the mailbox is compared with this row, and only a difference counts as something the person
-- did there. The row holds a thread's key and nothing of what its messages say. It goes with its connection.
create table mailbox_seen (
  connection_id text not null references connection(id) on delete cascade,
  workspace_id text not null references workspace(id) on delete cascade,
  thread_key text not null,
  in_inbox boolean not null,
  -- Timmy's places the newest received message was marked with, and the one of them the thread counted as filed under.
  labels text[] not null default '{}',
  label text check (label in ('follow-up', 'waiting', 'read-through')),
  unread boolean not null,
  gone boolean not null default false,
  seen_at timestamptz not null default now(),
  primary key (connection_id, thread_key)
);

alter table mailbox_seen enable row level security;
alter table mailbox_seen force row level security;
create policy ws_isolation on mailbox_seen using (workspace_id = app_workspace()) with check (workspace_id = app_workspace());
grant select, insert, update, delete on mailbox_seen to timmy_app;

-- While a tab is open the mailbox is looked at only if someone did something in Timmy in the last half hour.
-- That question is asked every few minutes per open workspace, so the newest command must be quick to find.
create index if not exists command_recent on command (workspace_id, at desc);
