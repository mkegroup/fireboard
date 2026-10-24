-- ============================================================
-- Fire Ground Board : initial schema
-- Multi-tenant: every row belongs to a department.
-- Every table has row level security. Clients only see their own
-- department. Billing columns can only be written by the service role.
-- ============================================================

-- ------------------------------------------------------------
-- Helpers
-- ------------------------------------------------------------
create or replace function public.gen_code(len int default 6)
returns text language sql volatile as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '')
  from generate_series(1, len)
$$;

create or replace function public.gen_token()
returns text language sql volatile as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
$$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ------------------------------------------------------------
-- Departments
-- ------------------------------------------------------------
create table public.departments (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 80),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  invite_code text not null unique default public.gen_code(6),
  dispatch_token text not null unique default public.gen_token(),
  scanner_url text check (scanner_url is null or scanner_url ~* '^https://'),
  scanner_label text check (scanner_label is null or length(scanner_label) <= 60),
  settings jsonb not null default '{"equipment_locations":["Station"]}'::jsonb,
  -- billing (service role only)
  trial_ends_at timestamptz not null default (now() + interval '30 days'),
  subscription_status text not null default 'none'
    check (subscription_status in ('none','trialing','active','past_due','canceled','incomplete','incomplete_expired','unpaid','paused')),
  current_period_end timestamptz,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  seat_count int not null default 0
);
create trigger departments_touch before update on public.departments
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- Members (the roster). user_id is null for people who are on the
-- roster but do not use the app. Only rows with a user_id are seats.
-- ------------------------------------------------------------
create table public.members (
  id uuid primary key default gen_random_uuid(),
  dept_id uuid not null references public.departments(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  role text not null default 'member' check (role in ('owner','officer','member')),
  active boolean not null default true,
  name text not null check (length(trim(name)) between 1 and 80),
  rank text not null default 'Firefighter',
  call_sign text,
  crew text,
  phone text,
  radio text,
  years int check (years is null or years between 0 and 80),
  certifications jsonb not null default '[]'::jsonb,
  notes text,
  ec_name text,
  ec_rel text,
  ec_phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (dept_id, user_id)
);
create index members_user_idx on public.members(user_id);
create trigger members_touch before update on public.members
  for each row execute function public.touch_updated_at();

-- Medical info is split out so it can be locked to officers + the member.
create table public.member_medical (
  member_id uuid primary key references public.members(id) on delete cascade,
  dept_id uuid not null references public.departments(id) on delete cascade,
  blood_type text,
  allergies text,
  conditions text,
  medications text,
  epipen text,
  updated_at timestamptz not null default now()
);
create trigger member_medical_touch before update on public.member_medical
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- Access helpers (security definer so policies can call them
-- without recursive RLS lookups)
-- ------------------------------------------------------------
create or replace function public.my_member_id(d uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.members where dept_id = d and user_id = auth.uid() and active
$$;

create or replace function public.is_member(d uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.members where dept_id = d and user_id = auth.uid() and active)
$$;

create or replace function public.is_officer(d uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.members
    where dept_id = d and user_id = auth.uid() and active and role in ('owner','officer'))
$$;

create or replace function public.is_owner(d uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.members
    where dept_id = d and user_id = auth.uid() and active and role = 'owner')
$$;

-- Trial running, paid, or paid-but-failing within a 7 day grace period.
create or replace function public.dept_has_access(d uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.departments
    where id = d and (
      now() < trial_ends_at
      or subscription_status in ('active','trialing')
      or (subscription_status = 'past_due' and coalesce(current_period_end, now()) + interval '7 days' > now())
    ))
$$;

create or replace function public.can_write(d uuid)
returns boolean language sql stable as $$
  select public.is_member(d) and public.dept_has_access(d)
$$;

create or replace function public.can_command(d uuid)
returns boolean language sql stable as $$
  select public.is_officer(d) and public.dept_has_access(d)
$$;

-- ------------------------------------------------------------
-- Incidents
-- ------------------------------------------------------------
create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  dept_id uuid not null references public.departments(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  address text,
  call_type text,
  status text not null default 'active' check (status in ('active','closed')),
  source text not null default 'app' check (source in ('app','dispatch')),
  started_at timestamptz not null default now(),
  started_by uuid references auth.users(id) on delete set null,
  closed_at timestamptz,
  par_started_at timestamptz,
  iocanc jsonb,
  updated_at timestamptz not null default now()
);
create index incidents_dept_idx on public.incidents(dept_id, status, started_at desc);
create trigger incidents_touch before update on public.incidents
  for each row execute function public.touch_updated_at();

-- Child rows inherit dept_id from their incident so a client can never
-- point a row at another department.
create or replace function public.set_dept_from_incident()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  select dept_id into new.dept_id from public.incidents where id = new.incident_id;
  if new.dept_id is null then
    raise exception 'incident not found';
  end if;
  return new;
end $$;

create table public.incident_apparatus (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents(id) on delete cascade,
  dept_id uuid not null references public.departments(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  kind text,
  status text not null default 'Responding'
    check (status in ('Responding','On Scene','Staged','Available','Out of Service','Returning')),
  created_at timestamptz not null default now()
);
create index incident_apparatus_idx on public.incident_apparatus(incident_id);
create trigger incident_apparatus_dept before insert or update of incident_id on public.incident_apparatus
  for each row execute function public.set_dept_from_incident();

create table public.incident_mutual_aid (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents(id) on delete cascade,
  dept_id uuid not null references public.departments(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  status text not null default 'Requested'
    check (status in ('Standby','Requested','Responding','On Scene','Released')),
  notes text,
  created_at timestamptz not null default now()
);
create index incident_mutual_aid_idx on public.incident_mutual_aid(incident_id);
create trigger incident_mutual_aid_dept before insert or update of incident_id on public.incident_mutual_aid
  for each row execute function public.set_dept_from_incident();

create table public.incident_personnel (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents(id) on delete cascade,
  dept_id uuid not null references public.departments(id) on delete cascade,
  member_id uuid references public.members(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  name text not null check (length(trim(name)) between 1 and 80),
  rank text,
  crew text,
  status text not null default 'Responding'
    check (status in ('Responding','Staged','IN','OUT','Rehab','Standby','MISSING')),
  no_radio boolean not null default false,
  apparatus_id uuid references public.incident_apparatus(id) on delete set null,
  mutual_aid_id uuid references public.incident_mutual_aid(id) on delete set null,
  par_ack_at timestamptz,
  status_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index incident_personnel_idx on public.incident_personnel(incident_id);
create unique index incident_personnel_member_uq on public.incident_personnel(incident_id, member_id)
  where member_id is not null;
create trigger incident_personnel_dept before insert or update of incident_id on public.incident_personnel
  for each row execute function public.set_dept_from_incident();

create or replace function public.personnel_before_write()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;
  if new.apparatus_id is not null and not exists(
      select 1 from public.incident_apparatus where id = new.apparatus_id and incident_id = new.incident_id) then
    raise exception 'apparatus is not on this incident';
  end if;
  if new.mutual_aid_id is not null and not exists(
      select 1 from public.incident_mutual_aid where id = new.mutual_aid_id and incident_id = new.incident_id) then
    raise exception 'mutual aid station is not on this incident';
  end if;
  return new;
end $$;
create trigger incident_personnel_z_check before insert or update on public.incident_personnel
  for each row execute function public.personnel_before_write();

create table public.incident_events (
  id bigint generated always as identity primary key,
  incident_id uuid not null references public.incidents(id) on delete cascade,
  dept_id uuid not null references public.departments(id) on delete cascade,
  at timestamptz not null default now(),
  actor text,
  kind text not null default 'note',
  message text not null check (length(message) <= 1000)
);
create index incident_events_idx on public.incident_events(incident_id, at);
create trigger incident_events_dept before insert on public.incident_events
  for each row execute function public.set_dept_from_incident();

create table public.incident_messages (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents(id) on delete cascade,
  dept_id uuid not null references public.departments(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null default auth.uid(),
  sender text,
  body text not null check (length(trim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index incident_messages_idx on public.incident_messages(incident_id, created_at);
create trigger incident_messages_dept before insert on public.incident_messages
  for each row execute function public.set_dept_from_incident();

create table public.incident_locations (
  incident_id uuid not null references public.incidents(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  dept_id uuid not null references public.departments(id) on delete cascade,
  name text,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  accuracy double precision,
  updated_at timestamptz not null default now(),
  primary key (incident_id, user_id)
);
create trigger incident_locations_dept before insert or update on public.incident_locations
  for each row execute function public.set_dept_from_incident();

-- Sender / display names come from the member record, never the client.
create or replace function public.stamp_actor_name()
returns trigger language plpgsql security definer set search_path = public as $$
declare n text;
begin
  select name into n from public.members
    where dept_id = new.dept_id and user_id = auth.uid() and active;
  if tg_table_name = 'incident_messages' then
    new.user_id := auth.uid();
    new.sender := coalesce(n, 'Unknown');
  elsif tg_table_name = 'incident_locations' then
    new.user_id := auth.uid();
    new.name := coalesce(n, 'Unknown');
    new.updated_at := now();
  elsif tg_table_name = 'incident_events' then
    new.actor := coalesce(n, new.actor, 'System');
  end if;
  return new;
end $$;
-- trigger names sort alphabetically, so "z_" runs after the dept trigger
create trigger z_incident_messages_actor before insert on public.incident_messages
  for each row execute function public.stamp_actor_name();
create trigger z_incident_locations_actor before insert or update on public.incident_locations
  for each row execute function public.stamp_actor_name();
create trigger z_incident_events_actor before insert on public.incident_events
  for each row execute function public.stamp_actor_name();

-- ------------------------------------------------------------
-- Automatic activity log
-- ------------------------------------------------------------
create or replace function public.log_personnel_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare who text;
begin
  select m.name into who from public.members m
    join public.incidents i on i.dept_id = m.dept_id
    where i.id = coalesce(new.incident_id, old.incident_id) and m.user_id = auth.uid() and m.active
    limit 1;
  who := coalesce(who, 'System');
  if tg_op = 'INSERT' then
    insert into public.incident_events(incident_id, dept_id, actor, kind, message)
      values (new.incident_id, new.dept_id, who, 'personnel', new.name || ' added to board (' || new.status || ')');
  elsif tg_op = 'DELETE' then
    insert into public.incident_events(incident_id, dept_id, actor, kind, message)
      values (old.incident_id, old.dept_id, who, 'personnel', old.name || ' removed from board');
  elsif new.status is distinct from old.status then
    insert into public.incident_events(incident_id, dept_id, actor, kind, message)
      values (new.incident_id, new.dept_id, who,
        case when new.status = 'MISSING' then 'missing' else 'status' end,
        new.name || ': ' || old.status || ' to ' || new.status);
  elsif new.apparatus_id is distinct from old.apparatus_id then
    insert into public.incident_events(incident_id, dept_id, actor, kind, message)
      values (new.incident_id, new.dept_id, who, 'apparatus',
        new.name || ' assigned to ' ||
        coalesce((select name from public.incident_apparatus where id = new.apparatus_id), 'no apparatus'));
  elsif new.par_ack_at is not null and old.par_ack_at is null then
    insert into public.incident_events(incident_id, dept_id, actor, kind, message)
      values (new.incident_id, new.dept_id, who, 'par', new.name || ' PAR confirmed');
  end if;
  return coalesce(new, old);
end $$;
create trigger incident_personnel_log after insert or update or delete on public.incident_personnel
  for each row execute function public.log_personnel_change();

create or replace function public.log_unit_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare who text; label text;
begin
  select name into who from public.members
    where dept_id = coalesce(new.dept_id, old.dept_id) and user_id = auth.uid() and active;
  who := coalesce(who, 'System');
  label := case when tg_table_name = 'incident_apparatus' then 'Apparatus ' else 'Mutual aid ' end;
  if tg_op = 'INSERT' then
    insert into public.incident_events(incident_id, dept_id, actor, kind, message)
      values (new.incident_id, new.dept_id, who, 'unit', label || new.name || ' added (' || new.status || ')');
  elsif tg_op = 'DELETE' then
    insert into public.incident_events(incident_id, dept_id, actor, kind, message)
      values (old.incident_id, old.dept_id, who, 'unit', label || old.name || ' removed');
  elsif new.status is distinct from old.status then
    insert into public.incident_events(incident_id, dept_id, actor, kind, message)
      values (new.incident_id, new.dept_id, who, 'unit', label || new.name || ': ' || old.status || ' to ' || new.status);
  end if;
  return coalesce(new, old);
end $$;
create trigger incident_apparatus_log after insert or update or delete on public.incident_apparatus
  for each row execute function public.log_unit_change();
create trigger incident_mutual_aid_log after insert or update or delete on public.incident_mutual_aid
  for each row execute function public.log_unit_change();

-- ------------------------------------------------------------
-- Department records: training and equipment
-- ------------------------------------------------------------
create table public.training_sessions (
  id uuid primary key default gen_random_uuid(),
  dept_id uuid not null references public.departments(id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 120),
  session_date date not null default current_date,
  location text,
  kind text,
  hours numeric(5,2) check (hours is null or hours between 0 and 500),
  instructor text,
  notes text,
  attendance_open boolean not null default false,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index training_sessions_idx on public.training_sessions(dept_id, session_date desc);
create trigger training_sessions_touch before update on public.training_sessions
  for each row execute function public.touch_updated_at();

create table public.training_attendance (
  session_id uuid not null references public.training_sessions(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  dept_id uuid not null references public.departments(id) on delete cascade,
  self_marked boolean not null default false,
  marked_at timestamptz not null default now(),
  primary key (session_id, member_id)
);
create or replace function public.check_attendance_scope()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  select dept_id into new.dept_id from public.training_sessions where id = new.session_id;
  if new.dept_id is null then raise exception 'session not found'; end if;
  if not exists(select 1 from public.members where id = new.member_id and dept_id = new.dept_id) then
    raise exception 'member is not in this department';
  end if;
  return new;
end $$;
create trigger training_attendance_scope before insert on public.training_attendance
  for each row execute function public.check_attendance_scope();

create table public.equipment (
  id uuid primary key default gen_random_uuid(),
  dept_id uuid not null references public.departments(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  category text,
  status text not null default 'Available'
    check (status in ('Available','Deployed','In Service','Out of Service','Missing')),
  serial text,
  qty int not null default 1 check (qty between 1 and 10000),
  location text,
  condition text,
  last_inspected date,
  next_service date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index equipment_idx on public.equipment(dept_id, name);
create trigger equipment_touch before update on public.equipment
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- Row level security
-- ------------------------------------------------------------
alter table public.departments enable row level security;
alter table public.members enable row level security;
alter table public.member_medical enable row level security;
alter table public.incidents enable row level security;
alter table public.incident_apparatus enable row level security;
alter table public.incident_mutual_aid enable row level security;
alter table public.incident_personnel enable row level security;
alter table public.incident_events enable row level security;
alter table public.incident_messages enable row level security;
alter table public.incident_locations enable row level security;
alter table public.training_sessions enable row level security;
alter table public.training_attendance enable row level security;
alter table public.equipment enable row level security;

-- Departments: members read, officers edit the safe columns only.
create policy dept_select on public.departments for select to authenticated
  using (public.is_member(id));
create policy dept_update on public.departments for update to authenticated
  using (public.is_officer(id)) with check (public.is_officer(id));
revoke insert, update, delete on public.departments from anon, authenticated;
grant update (name, scanner_url, scanner_label, settings) on public.departments to authenticated;

-- Officers should not read the dispatch token unless they are owners;
-- it is exposed through get_dispatch_token() instead.
revoke select on public.departments from anon, authenticated;
grant select (id, name, created_at, updated_at, invite_code, scanner_url, scanner_label, settings,
  trial_ends_at, subscription_status, current_period_end, seat_count) on public.departments to authenticated;

-- Members
create policy members_select on public.members for select to authenticated
  using (public.is_member(dept_id));
create policy members_insert on public.members for insert to authenticated
  with check (public.can_command(dept_id) and user_id is null and role = 'member');
create policy members_update on public.members for update to authenticated
  using (public.is_officer(dept_id) or user_id = auth.uid())
  with check (public.is_officer(dept_id) or user_id = auth.uid());
create policy members_delete on public.members for delete to authenticated
  using (public.is_officer(dept_id) and user_id is null);
revoke update on public.members from anon, authenticated;
grant update (name, rank, call_sign, crew, phone, radio, years, certifications, notes, ec_name, ec_rel, ec_phone)
  on public.members to authenticated;

-- Medical: officers and the member themselves only.
create policy medical_all on public.member_medical for all to authenticated
  using (public.is_officer(dept_id)
    or exists(select 1 from public.members m where m.id = member_id and m.user_id = auth.uid()))
  with check (
    exists(select 1 from public.members m where m.id = member_id and m.dept_id = member_medical.dept_id)
    and (public.is_officer(dept_id)
      or exists(select 1 from public.members m where m.id = member_id and m.user_id = auth.uid())));

-- Incidents
create policy incidents_select on public.incidents for select to authenticated
  using (public.is_member(dept_id));
create policy incidents_update on public.incidents for update to authenticated
  using (public.can_command(dept_id)) with check (public.can_command(dept_id));
revoke insert, update, delete on public.incidents from anon, authenticated;
grant update (name, address, call_type, iocanc) on public.incidents to authenticated;

-- Apparatus and mutual aid: any member with access can manage units
-- (crews often add their own truck), officers can delete.
create policy app_select on public.incident_apparatus for select to authenticated using (public.is_member(dept_id));
create policy app_insert on public.incident_apparatus for insert to authenticated with check (public.can_write(dept_id));
create policy app_update on public.incident_apparatus for update to authenticated
  using (public.can_write(dept_id)) with check (public.can_write(dept_id));
create policy app_delete on public.incident_apparatus for delete to authenticated using (public.can_command(dept_id));

create policy ma_select on public.incident_mutual_aid for select to authenticated using (public.is_member(dept_id));
create policy ma_insert on public.incident_mutual_aid for insert to authenticated with check (public.can_command(dept_id));
create policy ma_update on public.incident_mutual_aid for update to authenticated
  using (public.can_command(dept_id)) with check (public.can_command(dept_id));
create policy ma_delete on public.incident_mutual_aid for delete to authenticated using (public.can_command(dept_id));

-- Personnel: officers manage everyone, members manage their own row.
create policy pers_select on public.incident_personnel for select to authenticated using (public.is_member(dept_id));
create policy pers_insert on public.incident_personnel for insert to authenticated
  with check (public.can_command(dept_id));
create policy pers_update on public.incident_personnel for update to authenticated
  using (public.can_command(dept_id) or (user_id = auth.uid() and public.can_write(dept_id)))
  with check (public.can_command(dept_id) or (user_id = auth.uid() and public.can_write(dept_id)));
create policy pers_delete on public.incident_personnel for delete to authenticated
  using (public.can_command(dept_id) or (user_id = auth.uid() and public.can_write(dept_id)));
revoke update on public.incident_personnel from anon, authenticated;
grant update (status, no_radio, apparatus_id, mutual_aid_id, crew, rank, name) on public.incident_personnel to authenticated;

-- Events: append only.
create policy events_select on public.incident_events for select to authenticated using (public.is_member(dept_id));
create policy events_insert on public.incident_events for insert to authenticated
  with check (public.can_write(dept_id) and kind = 'note');
revoke update, delete on public.incident_events from anon, authenticated;

-- Chat: append only, sender stamped server side.
create policy msg_select on public.incident_messages for select to authenticated using (public.is_member(dept_id));
create policy msg_insert on public.incident_messages for insert to authenticated
  with check (public.can_write(dept_id) and user_id = auth.uid());
revoke update, delete on public.incident_messages from anon, authenticated;

-- Locations: everyone in the dept sees them, you only write your own.
create policy loc_select on public.incident_locations for select to authenticated using (public.is_member(dept_id));
create policy loc_insert on public.incident_locations for insert to authenticated
  with check (user_id = auth.uid() and public.can_write(dept_id));
create policy loc_update on public.incident_locations for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.can_write(dept_id));
create policy loc_delete on public.incident_locations for delete to authenticated
  using (user_id = auth.uid() or public.is_officer(dept_id));

-- Training
create policy tr_select on public.training_sessions for select to authenticated using (public.is_member(dept_id));
create policy tr_insert on public.training_sessions for insert to authenticated with check (public.can_command(dept_id));
create policy tr_update on public.training_sessions for update to authenticated
  using (public.can_command(dept_id)) with check (public.can_command(dept_id));
create policy tr_delete on public.training_sessions for delete to authenticated using (public.is_officer(dept_id));

create policy att_select on public.training_attendance for select to authenticated using (public.is_member(dept_id));
create policy att_insert on public.training_attendance for insert to authenticated
  with check (public.can_command(dept_id));
create policy att_delete on public.training_attendance for delete to authenticated using (public.is_officer(dept_id));

-- Equipment
create policy eq_select on public.equipment for select to authenticated using (public.is_member(dept_id));
create policy eq_insert on public.equipment for insert to authenticated with check (public.can_command(dept_id));
create policy eq_update on public.equipment for update to authenticated
  using (public.can_command(dept_id)) with check (public.can_command(dept_id));
create policy eq_delete on public.equipment for delete to authenticated using (public.is_officer(dept_id));

-- ------------------------------------------------------------
-- RPCs (the only way to do the privileged actions)
-- ------------------------------------------------------------
create or replace function public.create_department(p_name text, p_member_name text, p_rank text default 'Chief')
returns uuid language plpgsql security definer set search_path = public as $$
declare d uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if (select count(*) from public.members where user_id = auth.uid() and role = 'owner' and active) >= 5 then
    raise exception 'department limit reached';
  end if;
  insert into public.departments(name, created_by) values (trim(p_name), auth.uid()) returning id into d;
  insert into public.members(dept_id, user_id, role, name, rank)
    values (d, auth.uid(), 'owner', trim(p_member_name), coalesce(nullif(trim(p_rank), ''), 'Chief'));
  update public.departments set seat_count = 1 where id = d;
  return d;
end $$;

create or replace function public.join_department(p_code text, p_member_name text, p_rank text default 'Firefighter', p_crew text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare d uuid; existing uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select id into d from public.departments where invite_code = upper(trim(p_code));
  if d is null then raise exception 'invalid invite code'; end if;
  select id into existing from public.members where dept_id = d and user_id = auth.uid();
  if existing is not null then
    update public.members set active = true where id = existing;
  else
    insert into public.members(dept_id, user_id, role, name, rank, crew)
      values (d, auth.uid(), 'member', trim(p_member_name), coalesce(nullif(trim(p_rank), ''), 'Firefighter'), nullif(trim(p_crew), ''));
  end if;
  update public.departments set seat_count =
    (select count(*) from public.members where dept_id = d and user_id is not null and active)
    where id = d;
  return d;
end $$;

create or replace function public.leave_department(p_dept uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.is_owner(p_dept) and (select count(*) from public.members
      where dept_id = p_dept and role = 'owner' and active and user_id is not null) <= 1 then
    raise exception 'transfer ownership before leaving';
  end if;
  update public.members set active = false, role = 'member' where dept_id = p_dept and user_id = auth.uid();
  update public.departments set seat_count =
    (select count(*) from public.members where dept_id = p_dept and user_id is not null and active)
    where id = p_dept;
end $$;

create or replace function public.set_member_role(p_member uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare d uuid; target_user uuid; target_role text;
begin
  select dept_id, user_id, role into d, target_user, target_role from public.members where id = p_member;
  if d is null then raise exception 'member not found'; end if;
  if not public.is_owner(d) then raise exception 'only the department owner can change roles'; end if;
  if p_role not in ('owner','officer','member') then raise exception 'bad role'; end if;
  if target_user is null and p_role <> 'member' then raise exception 'roster entries without an account cannot be officers'; end if;
  if target_role = 'owner' and p_role <> 'owner' and (select count(*) from public.members
      where dept_id = d and role = 'owner' and active and user_id is not null) <= 1 then
    raise exception 'a department needs at least one owner';
  end if;
  update public.members set role = p_role where id = p_member;
end $$;

create or replace function public.remove_member(p_member uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d uuid; target_role text;
begin
  select dept_id, role into d, target_role from public.members where id = p_member;
  if d is null then raise exception 'member not found'; end if;
  if not public.is_officer(d) then raise exception 'not allowed'; end if;
  if target_role = 'owner' then raise exception 'owners cannot be removed'; end if;
  if target_role = 'officer' and not public.is_owner(d) then raise exception 'only the owner can remove officers'; end if;
  update public.members set active = false, role = 'member' where id = p_member;
  update public.departments set seat_count =
    (select count(*) from public.members where dept_id = d and user_id is not null and active)
    where id = d;
end $$;

create or replace function public.regenerate_invite_code(p_dept uuid)
returns text language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if not public.is_officer(p_dept) then raise exception 'not allowed'; end if;
  loop
    c := public.gen_code(6);
    exit when not exists(select 1 from public.departments where invite_code = c);
  end loop;
  update public.departments set invite_code = c where id = p_dept;
  return c;
end $$;

create or replace function public.get_dispatch_token(p_dept uuid)
returns text language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner(p_dept) then raise exception 'only the department owner can view this'; end if;
  return (select dispatch_token from public.departments where id = p_dept);
end $$;

create or replace function public.regenerate_dispatch_token(p_dept uuid)
returns text language plpgsql security definer set search_path = public as $$
declare t text;
begin
  if not public.is_owner(p_dept) then raise exception 'only the department owner can do this'; end if;
  t := public.gen_token();
  update public.departments set dispatch_token = t where id = p_dept;
  return t;
end $$;

create or replace function public.start_incident(p_dept uuid, p_name text, p_address text default null, p_call_type text default null, p_join boolean default true)
returns uuid language plpgsql security definer set search_path = public as $$
declare i uuid; m public.members;
begin
  if not public.can_command(p_dept) then
    if not public.is_officer(p_dept) then raise exception 'only officers can start an incident'; end if;
    raise exception 'subscription inactive';
  end if;
  insert into public.incidents(dept_id, name, address, call_type, started_by)
    values (p_dept, trim(p_name), nullif(trim(p_address), ''), nullif(trim(p_call_type), ''), auth.uid())
    returning id into i;
  select * into m from public.members where dept_id = p_dept and user_id = auth.uid() and active;
  insert into public.incident_events(incident_id, dept_id, actor, kind, message)
    values (i, p_dept, m.name, 'incident', 'Incident started by ' || m.name);
  if p_join then
    insert into public.incident_personnel(incident_id, dept_id, member_id, user_id, name, rank, crew, status)
      values (i, p_dept, m.id, auth.uid(), m.name, m.rank, coalesce(m.crew, 'Command'), 'Staged');
  end if;
  return i;
end $$;

create or replace function public.close_incident(p_incident uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d uuid; who text;
begin
  select dept_id into d from public.incidents where id = p_incident and status = 'active';
  if d is null then raise exception 'incident not found or already closed'; end if;
  if not public.is_officer(d) then raise exception 'only officers can close an incident'; end if;
  select name into who from public.members where dept_id = d and user_id = auth.uid();
  update public.incidents set status = 'closed', closed_at = now(), par_started_at = null where id = p_incident;
  delete from public.incident_locations where incident_id = p_incident;
  insert into public.incident_events(incident_id, dept_id, actor, kind, message)
    values (p_incident, d, who, 'incident', 'Incident closed by ' || coalesce(who, 'officer'));
end $$;

create or replace function public.join_incident(p_incident uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare d uuid; m public.members; pid uuid;
begin
  select dept_id into d from public.incidents where id = p_incident and status = 'active';
  if d is null then raise exception 'incident not active'; end if;
  if not public.can_write(d) then raise exception 'not allowed'; end if;
  select * into m from public.members where dept_id = d and user_id = auth.uid() and active;
  select id into pid from public.incident_personnel where incident_id = p_incident and member_id = m.id;
  if pid is not null then
    update public.incident_personnel set user_id = auth.uid() where id = pid;
    return pid;
  end if;
  insert into public.incident_personnel(incident_id, dept_id, member_id, user_id, name, rank, crew, status)
    values (p_incident, d, m.id, auth.uid(), m.name, m.rank, m.crew, 'Responding')
    returning id into pid;
  return pid;
end $$;

create or replace function public.add_personnel(p_incident uuid, p_member uuid, p_name text, p_rank text, p_crew text, p_status text default 'Responding', p_no_radio boolean default false, p_mutual_aid uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare d uuid; m public.members; pid uuid;
begin
  select dept_id into d from public.incidents where id = p_incident and status = 'active';
  if d is null then raise exception 'incident not active'; end if;
  if not public.can_command(d) then raise exception 'only officers can add personnel'; end if;
  if p_member is not null then
    select * into m from public.members where id = p_member and dept_id = d and active;
    if m.id is null then raise exception 'member not found'; end if;
    select id into pid from public.incident_personnel where incident_id = p_incident and member_id = m.id;
    if pid is not null then return pid; end if;
  end if;
  insert into public.incident_personnel(incident_id, dept_id, member_id, user_id, name, rank, crew, status, no_radio, mutual_aid_id)
    values (p_incident, d, m.id, m.user_id, coalesce(m.name, trim(p_name)), coalesce(nullif(trim(p_rank), ''), m.rank),
      coalesce(nullif(trim(p_crew), ''), m.crew), coalesce(p_status, 'Responding'), coalesce(p_no_radio, false), p_mutual_aid)
    returning id into pid;
  return pid;
end $$;

create or replace function public.start_par(p_incident uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d uuid; who text;
begin
  select dept_id into d from public.incidents where id = p_incident and status = 'active';
  if d is null then raise exception 'incident not active'; end if;
  if not public.can_command(d) then raise exception 'only officers can call PAR'; end if;
  select name into who from public.members where dept_id = d and user_id = auth.uid();
  update public.incident_personnel set par_ack_at = null where incident_id = p_incident;
  update public.incidents set par_started_at = now() where id = p_incident;
  insert into public.incident_events(incident_id, dept_id, actor, kind, message)
    values (p_incident, d, who, 'par', 'PAR check called');
end $$;

create or replace function public.end_par(p_incident uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d uuid; who text; acked int; total int;
begin
  select dept_id into d from public.incidents where id = p_incident;
  if not public.can_command(d) then raise exception 'only officers can end PAR'; end if;
  select name into who from public.members where dept_id = d and user_id = auth.uid();
  select count(*) filter (where par_ack_at is not null), count(*) into acked, total
    from public.incident_personnel where incident_id = p_incident and status not in ('OUT');
  update public.incidents set par_started_at = null where id = p_incident;
  insert into public.incident_events(incident_id, dept_id, actor, kind, message)
    values (p_incident, d, who, 'par', 'PAR closed: ' || acked || ' of ' || total || ' confirmed');
end $$;

-- Crew confirm their own PAR. Officers can confirm for anyone (radio PAR).
create or replace function public.ack_par(p_personnel uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d uuid; inc uuid; uid uuid;
begin
  select dept_id, incident_id, user_id into d, inc, uid from public.incident_personnel where id = p_personnel;
  if d is null then raise exception 'not found'; end if;
  if not (public.can_command(d) or (uid = auth.uid() and public.can_write(d))) then raise exception 'not allowed'; end if;
  if (select par_started_at from public.incidents where id = inc) is null then raise exception 'no PAR in progress'; end if;
  update public.incident_personnel set par_ack_at = now() where id = p_personnel and par_ack_at is null;
end $$;

create or replace function public.self_mark_attendance(p_session uuid)
returns void language plpgsql security definer set search_path = public as $$
declare d uuid; open_ boolean; mid uuid;
begin
  select dept_id, attendance_open into d, open_ from public.training_sessions where id = p_session;
  if d is null then raise exception 'session not found'; end if;
  if not open_ then raise exception 'attendance is closed for this session'; end if;
  if not public.can_write(d) then raise exception 'not allowed'; end if;
  mid := public.my_member_id(d);
  insert into public.training_attendance(session_id, member_id, dept_id, self_marked)
    values (p_session, mid, d, true) on conflict do nothing;
end $$;

-- Lock down function execution: helpers stay callable for policies,
-- but anon cannot call RPCs.
revoke execute on function public.create_department(text, text, text) from anon;
revoke execute on function public.join_department(text, text, text, text) from anon;
revoke execute on function public.leave_department(uuid) from anon;
revoke execute on function public.set_member_role(uuid, text) from anon;
revoke execute on function public.remove_member(uuid) from anon;
revoke execute on function public.regenerate_invite_code(uuid) from anon;
revoke execute on function public.get_dispatch_token(uuid) from anon;
revoke execute on function public.regenerate_dispatch_token(uuid) from anon;
revoke execute on function public.start_incident(uuid, text, text, text, boolean) from anon;
revoke execute on function public.close_incident(uuid) from anon;
revoke execute on function public.join_incident(uuid) from anon;
revoke execute on function public.add_personnel(uuid, uuid, text, text, text, text, boolean, uuid) from anon;
revoke execute on function public.start_par(uuid) from anon;
revoke execute on function public.end_par(uuid) from anon;
revoke execute on function public.ack_par(uuid) from anon;
revoke execute on function public.self_mark_attendance(uuid) from anon;
revoke execute on function public.gen_token() from anon, authenticated;

-- ------------------------------------------------------------
-- Realtime
-- ------------------------------------------------------------
-- departments is left out on purpose: it uses column level grants,
-- which Realtime does not support. The app refetches it instead.
alter publication supabase_realtime add table
  public.incidents, public.incident_personnel, public.incident_apparatus,
  public.incident_mutual_aid, public.incident_events, public.incident_messages, public.incident_locations,
  public.training_sessions, public.training_attendance;
