-- When the workspace's last scheduled morning run started. One run a day, in the workspace's own time zone.
alter table workspace add column morning_run_at timestamptz;
