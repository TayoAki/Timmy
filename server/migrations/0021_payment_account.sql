-- Card payments for invoices (payments/accounts.ts): the Stripe account each business is paid into. Timmy makes it on
-- Stripe (Connect, Accounts v2) when an owner or admin presses Connect Stripe; the business fills in its details on
-- Stripe's own page. Kept on the server, never in the workspace's state, so no screen can point a business's
-- payments at another account.

create table payment_account (
  workspace_id text primary key references workspace(id) on delete cascade,
  provider text not null default 'stripe' check (provider in ('stripe')),
  account_id text not null,
  -- Card payments are switched on (Stripe's card_payments capability is active).
  ready boolean not null default false,
  -- The business has filled in Stripe's form and Stripe is checking it.
  submitted boolean not null default false,
  country text,
  connected_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Disconnected in Timmy: no new payment links. The account stays the business's on Stripe, and links already
  -- sent are still matched to their invoices when they are paid.
  disconnected_at timestamptz
);
create unique index payment_account_id on payment_account (account_id);

alter table payment_account enable row level security;
alter table payment_account force row level security;
create policy ws_isolation on payment_account using (workspace_id = app_workspace()) with check (workspace_id = app_workspace());
grant select, insert, update, delete on payment_account to timmy_app;
