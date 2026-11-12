-- ============================================================
-- Closing the gaps someone could use to pay less than they should
--  * One free trial per person: a second department made by someone who
--    already owns one ends its trial on the same day as their first, so
--    trials can't be chained. (Admin can still extend a trial by hand.)
--  * Accounts are personal: alerts go to at most 3 phones and 3 browsers per
--    person, so one login can't be shared across a whole crew.
-- ============================================================

create or replace function public.create_department(p_name text, p_member_name text, p_rank text default 'Chief')
returns uuid language plpgsql security definer set search_path = public as $$
declare d uuid; first_end timestamptz;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if (select count(*) from public.members where user_id = auth.uid() and role = 'owner' and active) >= 5 then
    raise exception 'department limit reached';
  end if;
  -- Earliest trial end of any department this person made or owns.
  select min(x.trial_ends_at) into first_end from public.departments x
   where x.created_by = auth.uid()
      or x.id in (select dept_id from public.members where user_id = auth.uid() and role = 'owner');
  insert into public.departments(name, created_by) values (trim(p_name), auth.uid()) returning id into d;
  if first_end is not null then
    update public.departments set trial_ends_at = least(trial_ends_at, greatest(first_end, now())) where id = d;
  end if;
  insert into public.members(dept_id, user_id, role, name, rank)
    values (d, auth.uid(), 'owner', trim(p_member_name), coalesce(nullif(trim(p_rank), ''), 'Chief'));
  update public.departments set seat_count = 1 where id = d;
  return d;
end $$;

create or replace function public.register_push_device(p_token text)
returns void language plpgsql security definer set search_path = public as $$
declare t text := lower(trim(coalesce(p_token, '')));
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if t !~ '^[0-9a-f]{64,200}$' then raise exception 'bad device token'; end if;
  insert into public.push_devices(token, user_id) values (t, auth.uid())
    on conflict (token) do update set user_id = excluded.user_id, updated_at = now();
  -- Keep the 3 newest phones per person.
  delete from public.push_devices where user_id = auth.uid() and token in (
    select token from public.push_devices where user_id = auth.uid()
    order by updated_at desc offset 3);
end $$;

create or replace function public.register_web_push(p_endpoint text, p_p256dh text, p_auth text, p_device text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if p_endpoint is null or p_endpoint !~ '^https://' or length(p_endpoint) > 1000 then raise exception 'bad endpoint'; end if;
  if coalesce(p_p256dh, '') !~ '^[A-Za-z0-9_-]{40,200}$' or coalesce(p_auth, '') !~ '^[A-Za-z0-9_-]{8,100}$' then raise exception 'bad keys'; end if;
  insert into public.web_push_subs(endpoint, user_id, p256dh, auth, device)
    values (p_endpoint, auth.uid(), p_p256dh, p_auth, left(p_device, 120))
    on conflict (endpoint) do update set user_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device, created_at = now();
  -- Keep the 3 newest browsers per person.
  delete from public.web_push_subs where user_id = auth.uid() and endpoint in (
    select endpoint from public.web_push_subs where user_id = auth.uid() order by created_at desc offset 3);
end $$;
