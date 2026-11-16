-- Timmy's own account mail is now delivered by a mail provider (Resend). Each message keeps a record of
-- whether it went: the provider's id for it, how many times it was tried, and the last error if it did not.
alter table email_outbox add column provider_id text;
alter table email_outbox add column attempts int not null default 0;
alter table email_outbox add column error text;
