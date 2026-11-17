-- The website chat, second pass: limits every server shares, and the bot check's spent challenges.

-- How often one network address (or one visitor's browser) used the public chat routes in the current window.
-- Every server counts here, so a limit holds however many servers answer. The key is a keyed fingerprint of
-- what is counted, never the address itself, so the table holds no one's address. A window that has ended is
-- started again by the next use, and the rows are swept once they are past.
-- Only the system role reads and writes it: it belongs to no workspace, and the app role has no access to it.
create table chat_limit (
  key text primary key,
  n int not null,
  until timestamptz not null
);
create index chat_limit_until on chat_limit (until);

-- The bot check: a visitor's browser does a small piece of work for a challenge the server signed before its
-- first message can start a conversation. A challenge starts one conversation at most, so each one used is
-- kept here until it would have expired anyway.
create table chat_challenge (
  workspace_id text not null references workspace(id) on delete cascade,
  nonce text not null,
  expires_at timestamptz not null,
  conversation_id text,
  primary key (workspace_id, nonce)
);
create index chat_challenge_expires on chat_challenge (expires_at);

alter table chat_challenge enable row level security;
alter table chat_challenge force row level security;
create policy ws_isolation on chat_challenge using (workspace_id = app_workspace()) with check (workspace_id = app_workspace());
grant select, insert, delete on chat_challenge to timmy_app;
