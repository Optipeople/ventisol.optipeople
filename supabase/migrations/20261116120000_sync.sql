-- What the sync jobs (apps/web/lib/sync) keep for themselves and nobody else
-- may read: the cached OptiCloud service token, the login backoff after a
-- rejected password, the lease that keeps two runs apart, and the list of
-- changes not yet handed to the read model writer.
--
-- Why not rows in app.sync_state: that table is selectable by the admin role
-- (the settings page shows it), and a bearer token must never reach a
-- browser. Here there is no policy and no grant, so only service code
-- (the connection's own role) gets in.

create table app.sync_private (
  name       text primary key,
  value      jsonb not null,
  -- For leases and backoffs: the row counts for nothing after this instant.
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);
comment on table app.sync_private is 'Secrets and bookkeeping of the sync jobs (token cache, login backoff, lease, pending read model changes). Service only.';

alter table app.sync_private enable row level security;
-- Service only: no policy, no grant.
