-- ============================================================
-- Push alerts (iPhone app)
-- One row per alert sent, so the same alert can never be sent twice
-- (a double tap, a retry, or someone calling the function by hand).
-- Only the notify function (service role) touches this table.
-- ============================================================
create table if not exists public.push_log (
  incident_id uuid not null references public.incidents(id) on delete cascade,
  kind text not null check (kind in ('incident', 'par', 'missing')),
  ref text not null default '',
  sent_to int not null default 0,
  at timestamptz not null default now(),
  primary key (incident_id, kind, ref)
);
alter table public.push_log enable row level security;
revoke all on public.push_log from anon, authenticated;
