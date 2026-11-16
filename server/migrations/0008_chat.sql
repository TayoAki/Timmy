-- The website chat: a chat bubble on a customer's own website, answered by Timmy from rules the owner set.
-- Strangers type into it, so everything here belongs to one workspace and is read through row-level security.
-- The one lookup made before a workspace is known (which workspace a site key belongs to) is made by the
-- system role, the same way an incoming webhook is matched to its connection.

-- One per workspace. The settings a visitor sees (name, greeting, questions, answers) stay in the workspace's
-- state, where the Set up screen edits them; this row holds what the public routes need to decide quickly:
-- the key in the code snippet, the website the chat is locked to, and whether it is switched on.
create table chat_widget (
  workspace_id text primary key references workspace(id) on delete cascade,
  site_key text not null unique,               -- unguessable; public once pasted into a website
  domain text not null default '',             -- the only website that may show the chat
  is_on boolean not null default false,
  retention_months int not null default 12 check (retention_months between 1 and 36),
  switched_on_by text,                         -- the owner or admin who last switched it on
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table chat_conversation (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  visitor_id text not null,                    -- an anonymous id the visitor's browser made up
  live boolean not null default false,         -- a teammate took over: Timmy stops answering
  urgent boolean not null default false,       -- the visitor asked for a person
  email text,
  name text,
  talk jsonb not null default '{}',            -- where the rule-based script is: next question, answers so far
  lead_id text,                                -- the lead made from this chat, once there is an email
  page text,                                   -- the page of the website the chat was opened on
  visitor_messages int not null default 0,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create index chat_conversation_recent on chat_conversation (workspace_id, last_message_at);

-- The order in which messages became visible to the visitor. A value is taken while the workspace's lock is
-- held, so within one conversation a higher number was always committed later.
create sequence chat_message_seq;

create table chat_message (
  id text primary key,
  workspace_id text not null references workspace(id) on delete cascade,
  conversation_id text not null references chat_conversation(id) on delete cascade,
  sender text not null check (sender in ('visitor', 'timmy', 'member')),
  member_id text,                              -- the teammate who wrote it
  member_name text,                            -- their name when they wrote it
  client_id text,                              -- the sender's own id for it, so a request sent twice is one message
  body text not null check (char_length(body) <= 4000),
  notice text check (notice in ('privacy')),   -- the privacy notice goes with this message
  effect_id text,                              -- a reply: the effect record that sent it
  seq bigint,                                  -- its place in what the visitor sees; null until it has reached them
  sent_at timestamptz,
  failed text,                                 -- why it never reached the visitor
  created_at timestamptz not null default now(),
  unique (conversation_id, client_id)
);
create index chat_message_seen on chat_message (conversation_id, seq);

-- The rule "nothing is shown to a visitor without an approved effect" lives in the database too, so no code
-- path can skip it. A reply (anything not written by the visitor) can only take its place in the conversation
-- while the effect record that carries it is running, which the effect table's own guard only allows after an
-- approval. And once written, a message's words, sender and place never change.
create or replace function chat_message_guard() returns trigger language plpgsql as $$
begin
  if new.sender <> 'visitor' and new.seq is not null and (tg_op = 'INSERT' or old.seq is null) then
    if new.effect_id is null or not exists (
      select 1 from effect e where e.id = new.effect_id and e.workspace_id = new.workspace_id and e.kind = 'chat.reply' and e.status = 'executing'
    ) then
      raise exception 'chat message %: a reply is shown only while its approved effect is running', new.id;
    end if;
  end if;
  if tg_op = 'UPDATE' then
    if new.body is distinct from old.body or new.sender is distinct from old.sender or new.conversation_id is distinct from old.conversation_id
       or new.workspace_id is distinct from old.workspace_id or new.effect_id is distinct from old.effect_id then
      raise exception 'chat message %: what was said cannot change', old.id;
    end if;
    if old.seq is not null and new.seq is distinct from old.seq then
      raise exception 'chat message %: its place in the conversation cannot change', old.id;
    end if;
  end if;
  return new;
end $$;
create trigger chat_message_guard before insert or update on chat_message for each row execute function chat_message_guard();

-- How many conversations were started and messages received per day, for the daily caps.
create table chat_counter (
  workspace_id text not null references workspace(id) on delete cascade,
  day date not null,
  conversations int not null default 0,
  messages int not null default 0,
  primary key (workspace_id, day)
);

do $$
declare t text;
begin
  foreach t in array array['chat_widget', 'chat_conversation', 'chat_message', 'chat_counter'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy ws_isolation on %I using (workspace_id = app_workspace()) with check (workspace_id = app_workspace())', t);
    execute format('grant select, insert, update, delete on %I to timmy_app', t);
  end loop;
end $$;

grant usage, select on sequence chat_message_seq to timmy_app;
