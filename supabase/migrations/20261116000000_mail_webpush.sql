-- ============================================================
-- Emails to department owners, and alerts on Android and computers
--  * owner_emails: one row per email sent to a department's owners, so each
--    one goes out once (welcome, trial ending, trial ended, seat added,
--    payment failed). Server only.
--  * web_push_subs: browsers that turned on call alerts (Android phones,
--    computers). Same alerts as the iPhone app. People register their own.
-- ============================================================

create table if not exists public.owner_emails (
  dept_id uuid not null references public.departments(id) on delete cascade,
  kind text not null,
  ref text not null default '',
  sent_at timestamptz not null default now(),
  primary key (dept_id, kind, ref)
);
alter table public.owner_emails enable row level security;
revoke all on public.owner_emails from anon, authenticated;

create table if not exists public.web_push_subs (
  endpoint text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  device text,
  created_at timestamptz not null default now()
);
create index if not exists web_push_subs_user on public.web_push_subs(user_id);
alter table public.web_push_subs enable row level security;
revoke all on public.web_push_subs from anon, authenticated;

create or replace function public.register_web_push(p_endpoint text, p_p256dh text, p_auth text, p_device text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_endpoint is null or p_endpoint !~ '^https://' or length(p_endpoint) > 1000 then raise exception 'bad endpoint'; end if;
  if coalesce(p_p256dh, '') !~ '^[A-Za-z0-9_-]{40,200}$' or coalesce(p_auth, '') !~ '^[A-Za-z0-9_-]{8,100}$' then raise exception 'bad keys'; end if;
  insert into public.web_push_subs(endpoint, user_id, p256dh, auth, device)
    values (p_endpoint, auth.uid(), p_p256dh, p_auth, left(p_device, 120))
    on conflict (endpoint) do update set user_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device, created_at = now();
  -- Ten browsers per person is plenty. Drop the oldest.
  delete from public.web_push_subs where user_id = auth.uid() and endpoint in (
    select endpoint from public.web_push_subs where user_id = auth.uid() order by created_at desc offset 10);
end $$;

create or replace function public.unregister_web_push(p_endpoint text)
returns void language sql security definer set search_path = public as $$
  delete from public.web_push_subs where endpoint = p_endpoint and user_id = auth.uid();
$$;

revoke execute on function public.register_web_push(text, text, text, text) from public, anon;
revoke execute on function public.unregister_web_push(text) from public, anon;
grant execute on function public.register_web_push(text, text, text, text) to authenticated;
grant execute on function public.unregister_web_push(text) to authenticated;
