-- Changes from the security audit of Nov 16, 2026.

-- Work nobody asked for (reading incoming mail) is counted apart, so it can have its own share of the monthly limit.
alter table usage_event add column unattended boolean not null default false;
-- The whole service's spend for the month is summed across workspaces.
create index usage_month on usage_event (at);

-- One everyday mailbox per workspace, enforced by the database: two connects finishing at the same moment
-- cannot both become it. This migration changes no existing row. If some workspace already has two active
-- mailboxes the index is not created here (it would fail); the application's own check still applies, and
-- the index can be added once a person has chosen which mailbox stays.
do $$
begin
  if not exists (select 1 from connection where status = 'active' and toolkit in ('gmail', 'outlook') group by workspace_id having count(*) > 1) then
    create unique index connection_one_mailbox on connection (workspace_id) where status = 'active' and toolkit in ('gmail', 'outlook');
  else
    raise notice 'connection_one_mailbox was not created: a workspace has two active mailboxes';
  end if;
end $$;

-- A deleted workspace is closed at once and its data is removed after the retention period.
alter table workspace add column deleted_at timestamptz;

-- The audit log stays append-only. The one exception is the purge of a workspace that was deleted and has
-- passed its retention period: the purge job, running as the owner, says so for the length of its transaction.
create or replace function audit_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('timmy.purge', true) = 'on' and current_user <> 'timmy_app' then
    return old;
  end if;
  raise exception 'the audit log is append-only';
end $$;
