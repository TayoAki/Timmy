-- What synced files say, kept so Ask can find a file by a word inside it (Google Drive and OneDrive).
-- This migration only adds: no existing row is changed or removed.
--
-- A file's words live in item_body, like a message's, and are found through the full-text index item_body already
-- has (item_body_fts, over the generated `tsv`). They go when the file's item goes: when the file is deleted or
-- thrown away, and when its account is disconnected (the item's rows cascade).

-- Which version of the file the words were read from: its last-changed time as the drive reported it. When the drive
-- reports a newer one, the words are read again; until then the file is not asked for twice.
alter table item_body add column if not exists version text;
-- Why a file has no words stored, when it has none: too large, a kind Timmy can't open, damaged, or refused.
alter table item_body add column if not exists note text;

-- Finding the files whose words still need reading, and the files the nightly check asks about: a connection's
-- files, newest first.
create index if not exists item_file_changed on item (connection_id, occurred_at desc) where kind = 'file';
