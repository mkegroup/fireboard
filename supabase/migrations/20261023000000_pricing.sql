-- ============================================================
-- Pricing and hardening update
--  * Free trial is 7 days.
--  * Wrong invite codes are rate limited so codes can't be guessed.
--  * Grace period for failed or late payments is measured from when the
--    payment went past due, not from the billing period end. With yearly
--    billing the period end is a year away, so the old rule gave a year
--    of free access after a failed payment.
-- ============================================================

alter table public.departments
  alter column trial_ends_at set default (now() + interval '7 days');

alter table public.departments
  add column if not exists past_due_since timestamptz;

grant select (past_due_since) on public.departments to authenticated;

-- Trial running, paid, or past due for less than 14 days.
-- Invoiced departments get 30 days to pay before an invoice is past due,
-- then 14 more days before the board locks.
create or replace function public.dept_has_access(d uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.departments
    where id = d and (
      now() < trial_ends_at
      or subscription_status in ('active','trialing')
      or (subscription_status = 'past_due' and coalesce(past_due_since, now()) + interval '14 days' > now())
    ))
$$;

-- Bulk roster import for officers. Takes a JSON array of
-- {name, rank, crew, phone} and skips names already on the roster.
create or replace function public.import_roster(p_dept uuid, p_people jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int := 0; p jsonb; nm text;
begin
  if not public.can_command(p_dept) then raise exception 'not allowed'; end if;
  if jsonb_typeof(p_people) <> 'array' or jsonb_array_length(p_people) > 300 then
    raise exception 'send up to 300 people at a time';
  end if;
  for p in select * from jsonb_array_elements(p_people) loop
    nm := left(trim(coalesce(p->>'name', '')), 80);
    continue when nm = '';
    continue when exists(select 1 from public.members
      where dept_id = p_dept and active and lower(name) = lower(nm));
    insert into public.members(dept_id, user_id, role, name, rank, crew, phone)
      values (p_dept, null, 'member', nm,
        coalesce(nullif(left(trim(p->>'rank'), 40), ''), 'Firefighter'),
        nullif(left(trim(p->>'crew'), 40), ''),
        nullif(left(trim(p->>'phone'), 30), ''));
    n := n + 1;
  end loop;
  return n;
end $$;

revoke execute on function public.import_roster(uuid, jsonb) from public, anon;
grant execute on function public.import_roster(uuid, jsonb) to authenticated;

-- ------------------------------------------------------------
-- Invite codes: rate limit wrong guesses.
-- 32^6 possible codes, and at most 10 wrong tries per account per hour,
-- so guessing a real code is not practical.
-- ------------------------------------------------------------
create table if not exists public.invite_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  at timestamptz not null default now()
);
create index if not exists invite_attempts_user_at on public.invite_attempts(user_id, at);
alter table public.invite_attempts enable row level security;
revoke all on public.invite_attempts from anon, authenticated;

create or replace function public.invite_guard()
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if (select count(*) from public.invite_attempts
      where user_id = auth.uid() and at > now() - interval '1 hour') >= 10 then
    raise exception 'too many invite attempts';
  end if;
  delete from public.invite_attempts where at < now() - interval '1 day';
end $$;
revoke execute on function public.invite_guard() from public, anon, authenticated;

-- Shows the department name for an invite code before joining.
-- Returns null for a wrong code (and counts it as a wrong guess).
create or replace function public.invite_preview(p_code text)
returns text language plpgsql security definer set search_path = public as $$
declare n text;
begin
  perform public.invite_guard();
  select name into n from public.departments where invite_code = upper(trim(p_code));
  if n is null then insert into public.invite_attempts(user_id) values (auth.uid()); end if;
  return n;
end $$;
revoke execute on function public.invite_preview(text) from public, anon;
grant execute on function public.invite_preview(text) to authenticated;

-- People removed by an officer can't rejoin with the invite code.
-- An officer re-adds them with "Allow back" (allow_member_back).
alter table public.members add column if not exists removed_at timestamptz;

create or replace function public.remove_member(p_member uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d uuid; target_role text;
begin
  select dept_id, role into d, target_role from public.members where id = p_member;
  if d is null then raise exception 'member not found'; end if;
  if not public.is_officer(d) then raise exception 'not allowed'; end if;
  if target_role = 'owner' then raise exception 'owners cannot be removed'; end if;
  if target_role = 'officer' and not public.is_owner(d) then raise exception 'only the owner can remove officers'; end if;
  update public.members set active = false, role = 'member', removed_at = now() where id = p_member;
  -- Stop their location showing on any board right away.
  delete from public.incident_locations l using public.members m
    where m.id = p_member and l.user_id = m.user_id and l.dept_id = d;
  update public.departments set seat_count =
    (select count(*) from public.members where dept_id = d and user_id is not null and active)
    where id = d;
end $$;

create or replace function public.allow_member_back(p_member uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d uuid;
begin
  select dept_id into d from public.members where id = p_member;
  if d is null or not public.is_officer(d) then raise exception 'not allowed'; end if;
  update public.members set removed_at = null where id = p_member;
end $$;
revoke execute on function public.allow_member_back(uuid) from public, anon;
grant execute on function public.allow_member_back(uuid) to authenticated;

-- Same as before, but a wrong code returns null (so the failed attempt is
-- recorded instead of rolled back) and guessing is rate limited.
create or replace function public.join_department(p_code text, p_member_name text, p_rank text default 'Firefighter', p_crew text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare d uuid; existing uuid;
begin
  perform public.invite_guard();
  if length(trim(coalesce(p_member_name, ''))) = 0 then raise exception 'name required'; end if;
  select id into d from public.departments where invite_code = upper(trim(p_code));
  if d is null then
    insert into public.invite_attempts(user_id) values (auth.uid());
    return null;
  end if;
  select id into existing from public.members where dept_id = d and user_id = auth.uid();
  if existing is not null and (select removed_at from public.members where id = existing) is not null then
    -- An officer removed this person. The invite code alone can't bring them back.
    raise exception 'removed from this department';
  end if;
  if existing is not null then
    update public.members set active = true where id = existing;
  else
    insert into public.members(dept_id, user_id, role, name, rank, crew)
      values (d, auth.uid(), 'member', left(trim(p_member_name), 80), coalesce(nullif(trim(p_rank), ''), 'Firefighter'), nullif(trim(p_crew), ''));
  end if;
  update public.departments set seat_count =
    (select count(*) from public.members where dept_id = d and user_id is not null and active)
    where id = d;
  return d;
end $$;
revoke execute on function public.join_department(text, text, text, text) from public, anon;
grant execute on function public.join_department(text, text, text, text) to authenticated;
