-- ============================================================
-- Push alerts straight through Apple (no OneSignal, no Firebase).
-- The iPhone app gets a device token from Apple and saves it here.
-- Only the person's own app can add or remove their tokens, and nobody
-- can read them except the notify and dispatch functions (service role).
-- ============================================================
create table if not exists public.push_devices (
  token text primary key check (token ~ '^[0-9a-f]{64,200}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  updated_at timestamptz not null default now()
);
create index if not exists push_devices_user on public.push_devices(user_id);
alter table public.push_devices enable row level security;
revoke all on public.push_devices from anon, authenticated;

-- Saves this phone for the signed-in person. A phone that changes hands
-- (someone else signs in on it) moves to the new person.
create or replace function public.register_push_device(p_token text)
returns void language plpgsql security definer set search_path = public as $$
declare t text := lower(trim(coalesce(p_token, '')));
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if t !~ '^[0-9a-f]{64,200}$' then raise exception 'bad device token'; end if;
  insert into public.push_devices(token, user_id) values (t, auth.uid())
    on conflict (token) do update set user_id = excluded.user_id, updated_at = now();
  -- Keep the 10 newest phones per person.
  delete from public.push_devices where user_id = auth.uid() and token in (
    select token from public.push_devices where user_id = auth.uid()
    order by updated_at desc offset 10);
end $$;
revoke execute on function public.register_push_device(text) from public, anon;
grant execute on function public.register_push_device(text) to authenticated;

-- Called on sign out so the phone stops getting this person's alerts.
create or replace function public.unregister_push_device(p_token text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  delete from public.push_devices where token = lower(trim(coalesce(p_token, ''))) and user_id = auth.uid();
end $$;
revoke execute on function public.unregister_push_device(text) from public, anon;
grant execute on function public.unregister_push_device(text) to authenticated;

-- ============================================================
-- Plan details for the Plan page: monthly or yearly, card or invoice,
-- and whether it's set to end. Written only by the Stripe webhook.
-- ============================================================
alter table public.departments add column if not exists plan_interval text check (plan_interval in ('month', 'year'));
alter table public.departments add column if not exists plan_invoice boolean not null default false;
alter table public.departments add column if not exists plan_cancel_at timestamptz;
grant select (plan_interval, plan_invoice, plan_cancel_at) on public.departments to authenticated;
