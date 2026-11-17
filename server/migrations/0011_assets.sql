-- Uploaded files: pictures on pages, page covers, the website chat's picture, and files sent with email.
-- A row is made when the browser announces an upload; the bytes go to the bucket under `storage_key`, which
-- always starts with the workspace's id. `uploaded_at` stays empty until the bytes have arrived and matched
-- what was announced, and until then nothing may use the asset.

create table asset (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  purpose text not null check (purpose in ('page-image', 'page-cover', 'chat-icon', 'attachment')),
  content_type text not null,
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  storage_key text not null unique,
  name text,
  -- The SHA-256 of the bytes, set when they arrive. An email's approval names this, so what is approved is what is sent.
  sha256 text,
  created_by text not null,
  created_at timestamptz not null default now(),
  uploaded_at timestamptz,
  -- A key that did not start with its workspace's id would let one workspace's row point at another's file.
  check (storage_key = workspace_id || '/' || id),
  check ((uploaded_at is null) = (sha256 is null))
);
create index asset_workspace on asset (workspace_id, created_at);
create index asset_never_uploaded on asset (created_at) where uploaded_at is null;

alter table asset enable row level security;
alter table asset force row level security;
create policy ws_isolation on asset using (workspace_id = app_workspace()) with check (workspace_id = app_workspace());
grant select, insert, update, delete on asset to timmy_app;
