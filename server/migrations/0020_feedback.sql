-- Feedback people send from inside Timmy (http/feedback.ts). It is for the people who run Timmy, not for the
-- workspace: it is written by the system role and the app's own role can't read it.

create table feedback (
  id bigserial primary key,
  user_id text not null,
  user_email text,
  workspace_id text,
  workspace_name text,
  text text not null check (length(text) between 2 and 5000),
  -- Which screen it was sent from ("today/triage"): the screen's name only, never what was on it.
  page text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index feedback_by_user on feedback (user_id, created_at desc);
