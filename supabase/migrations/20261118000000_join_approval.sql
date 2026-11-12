-- ============================================================
-- "New people need approval" (off by default)
-- When an owner or officer turns it on, someone who joins with the invite
-- code waits as pending until an officer approves them. Pending people
-- can't see the department, don't use a seat and aren't billed.
-- A pending person is a members row with active = false and pending_at set.
-- ============================================================

alter table public.departments add column if not exists join_approval boolean not null default false;
grant select (join_approval) on public.departments to authenticated;
alter table public.members add column if not exists pending_at timestamptz;

create or replace function public.join_department(p_code text, p_member_name text, p_rank text default 'Firefighter', p_crew text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare d uuid; existing public.members; needs_ok boolean; dname text;
begin
  perform public.invite_guard();
  if length(trim(coalesce(p_member_name, ''))) = 0 then raise exception 'name required'; end if;
  select id, join_approval, name into d, needs_ok, dname from public.departments where invite_code = upper(trim(p_code));
  if d is null then
    insert into public.invite_attempts(user_id) values (auth.uid());
    return null;
  end if;
  select * into existing from public.members where dept_id = d and user_id = auth.uid();
  if existing.id is not null and existing.removed_at is not null then
    -- An officer removed (or declined) this person. The invite code alone can't bring them back.
    raise exception 'removed from this department';
  end if;
  if existing.id is not null and existing.active then
    return d; -- already in
  end if;
  if existing.id is not null and existing.pending_at is not null then
    raise exception 'Your request to join % is waiting for an officer to approve it.', dname;
  end if;

  if needs_ok then
    if existing.id is not null then
      update public.members set pending_at = now(), name = left(trim(p_member_name), 80) where id = existing.id;
    else
      insert into public.members(dept_id, user_id, role, name, rank, crew, active, pending_at)
        values (d, auth.uid(), 'member', left(trim(p_member_name), 80), coalesce(nullif(trim(p_rank), ''), 'Firefighter'), nullif(trim(p_crew), ''), false, now());
    end if;
    return d;
  end if;

  if existing.id is not null then
    update public.members set active = true, pending_at = null where id = existing.id;
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

-- Owners and officers turn approval on or off.
create or replace function public.set_join_approval(p_dept uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_officer(p_dept) then raise exception 'not allowed'; end if;
  update public.departments set join_approval = coalesce(p_on, false) where id = p_dept;
end $$;

-- People waiting, for officers. Email helps spot someone who isn't on the crew.
create or replace function public.list_join_requests(p_dept uuid)
returns table(id uuid, name text, rank text, crew text, email text, requested_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_officer(p_dept) then raise exception 'not allowed'; end if;
  return query
    select m.id, m.name, m.rank, m.crew, u.email::text, m.pending_at
      from public.members m left join auth.users u on u.id = m.user_id
     where m.dept_id = p_dept and m.pending_at is not null and not m.active and m.removed_at is null
     order by m.pending_at;
end $$;

create or replace function public.approve_join(p_member uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d uuid;
begin
  select dept_id into d from public.members where id = p_member and pending_at is not null;
  if d is null or not public.is_officer(d) then raise exception 'not allowed'; end if;
  update public.members set active = true, pending_at = null where id = p_member;
  update public.departments set seat_count =
    (select count(*) from public.members where dept_id = d and user_id is not null and active)
    where id = d;
end $$;

-- Declining works like removing: they can't ask again with the code
-- unless an officer uses "Allow back".
create or replace function public.decline_join(p_member uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d uuid;
begin
  select dept_id into d from public.members where id = p_member and pending_at is not null;
  if d is null or not public.is_officer(d) then raise exception 'not allowed'; end if;
  update public.members set pending_at = null, removed_at = now() where id = p_member;
end $$;

-- What the signed-in person is waiting on.
create or replace function public.my_join_requests()
returns table(dept_id uuid, dept_name text, requested_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.dept_id, d.name, m.pending_at from public.members m join public.departments d on d.id = m.dept_id
   where m.user_id = auth.uid() and m.pending_at is not null and not m.active and m.removed_at is null
   order by m.pending_at desc
$$;

-- A person can cancel their own request.
create or replace function public.cancel_join_request(p_dept uuid)
returns void language sql security definer set search_path = public as $$
  delete from public.members where dept_id = p_dept and user_id = auth.uid() and pending_at is not null and not active
    and not exists (select 1 from public.incident_personnel p where p.member_id = members.id);
$$;

revoke execute on function public.set_join_approval(uuid, boolean) from public, anon;
revoke execute on function public.list_join_requests(uuid) from public, anon;
revoke execute on function public.approve_join(uuid) from public, anon;
revoke execute on function public.decline_join(uuid) from public, anon;
revoke execute on function public.my_join_requests() from public, anon;
revoke execute on function public.cancel_join_request(uuid) from public, anon;
grant execute on function public.set_join_approval(uuid, boolean) to authenticated;
grant execute on function public.list_join_requests(uuid) to authenticated;
grant execute on function public.approve_join(uuid) to authenticated;
grant execute on function public.decline_join(uuid) to authenticated;
grant execute on function public.my_join_requests() to authenticated;
grant execute on function public.cancel_join_request(uuid) to authenticated;
