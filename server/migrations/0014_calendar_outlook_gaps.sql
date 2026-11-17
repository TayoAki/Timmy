-- Changes picked up from the mailbox: what each message carried the first time Timmy saw it.
--
-- A message can arrive already carrying one of Timmy's labels or categories that the person never put there: Outlook
-- keeps categories on mail sent within one company, so a colleague who files with Timmy too sends mail marked
-- "Timmy Follow Up"; a Gmail filter can label mail as it arrives. Such a mark is recorded here and never acted on.
-- Only a change on a message Timmy has already seen can move a thread (see server/src/sync/mailbox-changes.ts).
-- The row holds a message's id and which of Timmy's three places it was marked with, nothing of what it says.
-- It goes with its connection.
create table mailbox_message_seen (
  connection_id text not null references connection(id) on delete cascade,
  workspace_id text not null references workspace(id) on delete cascade,
  message_id text not null,
  -- Timmy's places the message carried when first seen and still counts as carrying from someone else.
  labels text[] not null default '{}',
  seen_at timestamptz not null default now(),
  primary key (connection_id, message_id)
);
create index mailbox_message_seen_age on mailbox_message_seen (connection_id, seen_at);

alter table mailbox_message_seen enable row level security;
alter table mailbox_message_seen force row level security;
create policy ws_isolation on mailbox_message_seen using (workspace_id = app_workspace()) with check (workspace_id = app_workspace());
grant select, insert, update, delete on mailbox_message_seen to timmy_app;
