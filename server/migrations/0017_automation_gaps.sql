-- Closing the automation engine's known gaps.

-- A New-email automation that is on while no mailbox is connected can't fire. It is paused rather than switched off:
-- it stays on, says why it is paused, and carries on by itself once a mailbox is connected again.
alter table automation_live add column paused_reason text;

-- How many runs are being carried out right now in a workspace: the workspace's limit on work at once counts them.
create index automation_run_running on automation_run (workspace_id) where status = 'running';
