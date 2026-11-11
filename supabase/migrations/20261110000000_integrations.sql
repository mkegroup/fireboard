-- ============================================================
-- Integrations
--  * Email to incident: every department gets a private address,
--    calls+<code>@mkegroup.ca. Pages forwarded there start an incident.
--  * Dispatch inbox: the last messages dispatch sent us, and what happened
--    to each one, so an officer can see why a page did or didn't start a call.
--  * Group chat: post new calls, PAR checks and Missing alerts to a
--    Slack, Microsoft Teams, Discord or Google Chat webhook.
--  * Training calendar: a private link that Google, Outlook or Apple
--    Calendar can subscribe to.
-- All secrets live in dept_integrations, which nobody can read directly.
-- The owner reads and changes them through the functions below.
-- ============================================================

create table if not exists public.dept_integrations (
  dept_id uuid primary key references public.departments(id) on delete cascade,
  inbox_code text not null unique default lower(public.gen_code(12)),
  calendar_token text not null unique default public.gen_token(),
  chat_webhook_url text check (chat_webhook_url is null or chat_webhook_url ~ '^https://'),
  chat_events text[] not null default array['incident','par','missing'],
  inbox_allow_from text check (inbox_allow_from is null or length(inbox_allow_from) <= 500),
  updated_at timestamptz not null default now()
);
alter table public.dept_integrations enable row level security;
revoke all on public.dept_integrations from anon, authenticated;

-- Every department has a row, now and from now on.
insert into public.dept_integrations(dept_id) select id from public.departments on conflict do nothing;
create or replace function public.dept_integrations_row()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.dept_integrations(dept_id) values (new.id) on conflict do nothing;
  return new;
end $$;
drop trigger if exists departments_integrations on public.departments;
create trigger departments_integrations after insert on public.departments
  for each row execute function public.dept_integrations_row();

-- What dispatch sent us. Officers can read their own department's.
create table if not exists public.dispatch_inbox (
  id bigint generated always as identity primary key,
  dept_id uuid not null references public.departments(id) on delete cascade,
  at timestamptz not null default now(),
  channel text not null check (channel in ('email', 'webhook')),
  sender text,
  subject text,
  excerpt text,
  outcome text not null check (outcome in ('created', 'duplicate', 'not_allowed_sender', 'confirmation', 'rate_limited', 'inactive', 'empty')),
  incident_id uuid references public.incidents(id) on delete set null,
  confirm_url text
);
create index if not exists dispatch_inbox_dept on public.dispatch_inbox(dept_id, at desc);
alter table public.dispatch_inbox enable row level security;
revoke all on public.dispatch_inbox from anon, authenticated;
grant select on public.dispatch_inbox to authenticated;
drop policy if exists dispatch_inbox_read on public.dispatch_inbox;
create policy dispatch_inbox_read on public.dispatch_inbox for select to authenticated
  using (public.is_officer(dept_id));

-- Owner only: every connection detail in one call.
create or replace function public.get_integrations(p_dept uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.dept_integrations;
begin
  if not public.is_owner(p_dept) then raise exception 'only the department owner can view this'; end if;
  insert into public.dept_integrations(dept_id) values (p_dept) on conflict do nothing;
  select * into r from public.dept_integrations where dept_id = p_dept;
  return jsonb_build_object(
    'dispatch_token', (select dispatch_token from public.departments where id = p_dept),
    'inbox_code', r.inbox_code,
    'calendar_token', r.calendar_token,
    'chat_webhook_url', r.chat_webhook_url,
    'chat_events', to_jsonb(r.chat_events),
    'inbox_allow_from', r.inbox_allow_from
  );
end $$;

create or replace function public.set_integrations(p_dept uuid, p_chat_webhook_url text, p_chat_events text[], p_inbox_allow_from text)
returns void language plpgsql security definer set search_path = public as $$
declare u text := nullif(trim(coalesce(p_chat_webhook_url, '')), '');
begin
  if not public.is_owner(p_dept) then raise exception 'only the department owner can do this'; end if;
  if u is not null and (u !~ '^https://[^\s/]+\.[^\s/]+/' or length(u) > 600) then raise exception 'chat link must start with https://'; end if;
  if p_chat_events is not null and not (p_chat_events <@ array['incident','par','missing','closed']) then raise exception 'unknown chat event'; end if;
  insert into public.dept_integrations(dept_id) values (p_dept) on conflict do nothing;
  update public.dept_integrations set
    chat_webhook_url = u,
    chat_events = coalesce(p_chat_events, chat_events),
    inbox_allow_from = nullif(left(trim(coalesce(p_inbox_allow_from, '')), 500), ''),
    updated_at = now()
  where dept_id = p_dept;
end $$;

create or replace function public.regenerate_integration(p_dept uuid, p_what text)
returns text language plpgsql security definer set search_path = public as $$
declare v text;
begin
  if not public.is_owner(p_dept) then raise exception 'only the department owner can do this'; end if;
  insert into public.dept_integrations(dept_id) values (p_dept) on conflict do nothing;
  if p_what = 'inbox' then
    loop
      v := lower(public.gen_code(12));
      exit when not exists(select 1 from public.dept_integrations where inbox_code = v);
    end loop;
    update public.dept_integrations set inbox_code = v, updated_at = now() where dept_id = p_dept;
  elsif p_what = 'calendar' then
    v := public.gen_token();
    update public.dept_integrations set calendar_token = v, updated_at = now() where dept_id = p_dept;
  else
    raise exception 'unknown setting';
  end if;
  return v;
end $$;

revoke execute on function public.get_integrations(uuid) from public, anon;
revoke execute on function public.set_integrations(uuid, text, text[], text) from public, anon;
revoke execute on function public.regenerate_integration(uuid, text) from public, anon;
revoke execute on function public.dept_integrations_row() from public, anon, authenticated;
grant execute on function public.get_integrations(uuid) to authenticated;
grant execute on function public.set_integrations(uuid, text, text[], text) to authenticated;
grant execute on function public.regenerate_integration(uuid, text) to authenticated;

-- Incidents from email are marked so the board can say where they came from.
alter table public.incidents drop constraint if exists incidents_source_check;
alter table public.incidents add constraint incidents_source_check check (source in ('app', 'dispatch', 'email'));

-- Language each person reads the app in. Used for push alerts too.
alter table public.members add column if not exists lang text check (lang in ('en', 'fr', 'es'));
grant update (lang) on public.members to authenticated;
grant select (lang) on public.members to authenticated;

-- Closing an incident can be posted to the group chat too (once).
alter table public.push_log drop constraint if exists push_log_kind_check;
alter table public.push_log add constraint push_log_kind_check check (kind in ('incident', 'par', 'missing', 'closed'));

-- Where the incident is, for the map pin and directions. Set from coordinates
-- in a dispatch page, or found from the address the first time the map opens.
alter table public.incidents add column if not exists lat double precision check (lat is null or lat between -90 and 90);
alter table public.incidents add column if not exists lng double precision check (lng is null or lng between -180 and 180);
grant update (lat, lng) on public.incidents to authenticated;
