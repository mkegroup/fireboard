-- ============================================================
-- Owner's console (for MKE Group, not for departments)
--  * platform_admins: who can open Admin in the app. Add yourself once:
--      insert into public.platform_admins(user_id)
--      select id from auth.users where email = 'you@example.com';
--  * platform_events: everything worth knowing about the business, newest first:
--    sign-ups, new departments, people joining, plans chosen, payments,
--    failed payments, cancellations, quote requests, trials ending, errors.
--    Events marked notify are pushed to admins' iPhones by the edge functions.
--  * admin_* functions: the numbers and lists behind the Admin screens.
-- Nothing here is readable by departments.
-- ============================================================

create table if not exists public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  alerts text[] not null default array['signup','department','plan','payment','past_due','canceled','cancel_scheduled','quote','trial_ending','trial_ended','error','test'],
  created_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;
revoke all on public.platform_admins from anon, authenticated;

create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.platform_admins where user_id = auth.uid())
$$;

create table if not exists public.platform_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  kind text not null check (length(kind) between 1 and 40),
  dept_id uuid references public.departments(id) on delete set null,
  user_id uuid,
  title text not null check (length(title) <= 300),
  detail text check (detail is null or length(detail) <= 2000),
  amount numeric(12, 2),
  meta jsonb not null default '{}'::jsonb,
  notify boolean not null default false,
  pushed_at timestamptz
);
create index if not exists platform_events_at on public.platform_events(at desc);
create index if not exists platform_events_kind on public.platform_events(kind, at desc);
create index if not exists platform_events_pending on public.platform_events(id) where notify and pushed_at is null;
alter table public.platform_events enable row level security;
revoke all on public.platform_events from anon, authenticated;

create or replace function public.log_platform_event(p_kind text, p_title text, p_detail text default null, p_dept uuid default null,
  p_user uuid default null, p_amount numeric default null, p_meta jsonb default '{}'::jsonb, p_notify boolean default false)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.platform_events(kind, title, detail, dept_id, user_id, amount, meta, notify)
  values (p_kind, left(p_title, 300), left(p_detail, 2000), p_dept, p_user, p_amount, coalesce(p_meta, '{}'::jsonb), p_notify);
end $$;
revoke execute on function public.log_platform_event(text, text, text, uuid, uuid, numeric, jsonb, boolean) from public, anon, authenticated;

-- ---------- events recorded by the database itself ----------
create or replace function public.ev_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.log_platform_event('signup', 'New sign-up', new.email, null, new.id, null, '{}'::jsonb, true);
  return new;
exception when others then return new; -- never block a sign-up
end $$;
drop trigger if exists platform_new_user on auth.users;
create trigger platform_new_user after insert on auth.users for each row execute function public.ev_new_user();

create or replace function public.ev_department()
returns trigger language plpgsql security definer set search_path = public as $$
declare who text; amt text;
begin
  if tg_op = 'INSERT' then
    select email into who from auth.users where id = new.created_by;
    perform public.log_platform_event('department', 'New department: ' || new.name,
      coalesce(who, 'unknown owner') || '. Free trial ends ' || to_char(new.trial_ends_at, 'Mon DD') || '.', new.id, new.created_by, null, '{}'::jsonb, true);
    return new;
  end if;
  amt := case when new.plan_amount is null then '' else ' $' || to_char(new.plan_amount, 'FM999G990D00') || case new.plan_interval when 'year' then ' a year' when 'month' then ' a month' else '' end end;
  if new.subscription_status is distinct from old.subscription_status then
    if new.subscription_status = 'trialing' then
      perform public.log_platform_event('plan', 'Plan chosen: ' || new.name, 'Billing starts when the trial ends' || coalesce(', ' || to_char(new.trial_ends_at, 'Mon DD'), '') || '.' || amt, new.id, null, new.plan_amount, '{}'::jsonb, true);
    elsif new.subscription_status = 'active' then
      perform public.log_platform_event('plan', 'Paying customer: ' || new.name, case when old.subscription_status = 'past_due' then 'Back in good standing.' else 'Plan is active.' end || amt, new.id, null, new.plan_amount, '{}'::jsonb, true);
    elsif new.subscription_status = 'past_due' then
      perform public.log_platform_event('past_due', 'Payment overdue: ' || new.name, 'The last payment did not go through. The board keeps working for 14 days.', new.id, null, new.plan_amount, '{}'::jsonb, true);
    elsif new.subscription_status in ('canceled', 'unpaid', 'incomplete_expired') then
      perform public.log_platform_event('canceled', 'Plan ended: ' || new.name, 'Status is now ' || new.subscription_status || '.', new.id, null, new.plan_amount, '{}'::jsonb, true);
    end if;
  end if;
  if new.plan_cancel_at is not null and old.plan_cancel_at is null and new.subscription_status <> 'canceled' then
    perform public.log_platform_event('cancel_scheduled', 'Cancelling: ' || new.name, 'Their plan ends ' || to_char(new.plan_cancel_at, 'Mon DD, YYYY') || '.', new.id, null, new.plan_amount, '{}'::jsonb, true);
  end if;
  return new;
exception when others then return new;
end $$;
drop trigger if exists platform_department_new on public.departments;
create trigger platform_department_new after insert on public.departments for each row execute function public.ev_department();
drop trigger if exists platform_department_plan on public.departments;
create trigger platform_department_plan after update of subscription_status, plan_cancel_at on public.departments for each row execute function public.ev_department();

create or replace function public.ev_member()
returns trigger language plpgsql security definer set search_path = public as $$
declare d text;
begin
  select name into d from public.departments where id = new.dept_id;
  if new.user_id is not null and new.active and (tg_op = 'INSERT' or old.user_id is null or not old.active) then
    perform public.log_platform_event('member_joined', new.name || ' joined ' || coalesce(d, 'a department'), null, new.dept_id, new.user_id);
  elsif tg_op = 'UPDATE' and old.active and not new.active and old.user_id is not null then
    perform public.log_platform_event('member_left', old.name || ' left ' || coalesce(d, 'a department'), null, new.dept_id, old.user_id);
  end if;
  return new;
exception when others then return new;
end $$;
drop trigger if exists platform_member on public.members;
create trigger platform_member after insert or update of user_id, active on public.members for each row execute function public.ev_member();

-- A department asks for a quote from the Plan page.
create or replace function public.request_quote(p_dept uuid, p_details text)
returns void language plpgsql security definer set search_path = public as $$
declare d text; who text;
begin
  if not public.is_member(p_dept) then raise exception 'not a member'; end if;
  if (select count(*) from public.platform_events where kind = 'quote' and dept_id = p_dept and at > now() - interval '1 hour') >= 3 then
    raise exception 'quote already sent';
  end if;
  select name into d from public.departments where id = p_dept;
  select email into who from auth.users where id = auth.uid();
  perform public.log_platform_event('quote', 'Quote request: ' || coalesce(d, ''), left(coalesce(p_details, ''), 1800), p_dept, auth.uid(), null, jsonb_build_object('email', who), true);
end $$;
revoke execute on function public.request_quote(uuid, text) from public, anon;
grant execute on function public.request_quote(uuid, text) to authenticated;

-- ---------- what the Admin screens read ----------
create or replace function public.admin_check()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'admins only'; end if;
end $$;

-- What a department pays each month, before tax. Uses what Stripe told us, or an estimate.
create or replace function public.dept_mrr(d public.departments)
returns numeric language sql immutable as $$
  select case
    when d.plan_amount is not null then round(case when d.plan_interval = 'year' then d.plan_amount / 12 else d.plan_amount end, 2)
    when d.plan_interval = 'year' then round(least(greatest(d.seat_count, 1), 20) * 99.99 / 12, 2)
    else round(least(greatest(d.seat_count, 1), 20) * 9.99, 2)
  end
$$;

create or replace function public.dept_stage(d public.departments)
returns text language sql stable as $$
  select case
    when d.subscription_status = 'active' then 'paying'
    when d.subscription_status = 'past_due' then 'overdue'
    when d.subscription_status = 'trialing' then 'plan_set'
    when now() < d.trial_ends_at then 'trial'
    when d.subscription_status in ('canceled', 'unpaid', 'incomplete_expired') then 'ended'
    else 'expired'
  end
$$;

create or replace function public.admin_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  perform public.admin_check();
  select jsonb_build_object(
    'mrr', coalesce((select sum(public.dept_mrr(d)) from public.departments d where d.subscription_status in ('active', 'past_due')), 0),
    'mrr_pending', coalesce((select sum(public.dept_mrr(d)) from public.departments d where d.subscription_status = 'trialing'), 0),
    'collected_30d', coalesce((select sum(amount) from public.platform_events where kind = 'payment' and at > now() - interval '30 days'), 0),
    'collected_all', coalesce((select sum(amount) from public.platform_events where kind = 'payment'), 0),
    'stages', coalesce((select jsonb_object_agg(s, n) from (select public.dept_stage(d) s, count(*) n from public.departments d group by 1) x), '{}'::jsonb),
    'departments', (select count(*) from public.departments),
    'users', (select count(*) from auth.users),
    'users_new_7d', (select count(*) from auth.users where created_at > now() - interval '7 days'),
    'users_active_7d', (select count(*) from auth.users where last_sign_in_at > now() - interval '7 days'),
    'seats', (select count(*) from public.members where active and user_id is not null),
    'incidents_7d', (select count(*) from public.incidents where started_at > now() - interval '7 days'),
    'incidents_30d', (select count(*) from public.incidents where started_at > now() - interval '30 days'),
    'incidents_active', (select count(*) from public.incidents where status = 'active'),
    'incidents_from_dispatch_30d', (select count(*) from public.incidents where source in ('dispatch', 'email') and started_at > now() - interval '30 days'),
    'messages_7d', (select count(*) from public.incident_messages where created_at > now() - interval '7 days'),
    'phones', (select count(*) from public.push_devices),
    'weeks', (
      select jsonb_agg(jsonb_build_object(
        'week', to_char(w, 'YYYY-MM-DD'),
        'users', (select count(*) from auth.users where created_at >= w and created_at < w + interval '7 days'),
        'departments', (select count(*) from public.departments where created_at >= w and created_at < w + interval '7 days'),
        'incidents', (select count(*) from public.incidents where started_at >= w and started_at < w + interval '7 days')
      ) order by w)
      from generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week') w
    ),
    'months', (
      select jsonb_agg(jsonb_build_object(
        'month', to_char(m, 'YYYY-MM'),
        'collected', coalesce((select sum(amount) from public.platform_events where kind = 'payment' and at >= m and at < m + interval '1 month'), 0)
      ) order by m)
      from generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') m
    ),
    'attention', coalesce((
      select jsonb_agg(x order by x->>'sort') from (
        select jsonb_build_object('dept_id', d.id, 'name', d.name, 'why', 'overdue', 'sort', '1' || coalesce(d.past_due_since::text, ''), 'at', d.past_due_since) x
          from public.departments d where d.subscription_status = 'past_due'
        union all
        select jsonb_build_object('dept_id', d.id, 'name', d.name, 'why', 'trial_ending', 'sort', '2' || d.trial_ends_at::text, 'at', d.trial_ends_at)
          from public.departments d where public.dept_stage(d) = 'trial' and d.trial_ends_at < now() + interval '3 days'
        union all
        select jsonb_build_object('dept_id', d.id, 'name', d.name, 'why', 'trial_ended', 'sort', '3' || d.trial_ends_at::text, 'at', d.trial_ends_at)
          from public.departments d where public.dept_stage(d) = 'expired' and d.trial_ends_at > now() - interval '21 days'
        union all
        select jsonb_build_object('dept_id', e.dept_id, 'name', e.title, 'why', 'quote', 'sort', '0' || e.at::text, 'at', e.at)
          from public.platform_events e where e.kind = 'quote' and e.at > now() - interval '14 days'
        union all
        select jsonb_build_object('dept_id', e.dept_id, 'name', e.title, 'why', 'error', 'sort', '4' || e.at::text, 'at', e.at)
          from public.platform_events e where e.kind = 'error' and e.at > now() - interval '2 days'
      ) q
    ), '[]'::jsonb)
  ) into r;
  return r;
end $$;

create or replace function public.admin_departments(p_search text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.admin_check();
  return coalesce((
    select jsonb_agg(row_to_json(x)::jsonb order by x.created_at desc) from (
      select d.id, d.name, d.created_at, d.trial_ends_at, d.subscription_status, public.dept_stage(d) as stage,
        d.plan_interval, d.plan_amount, d.plan_invoice, d.plan_custom, d.plan_cancel_at, d.seat_count, public.dept_mrr(d) as mrr,
        d.stripe_customer_id, d.stripe_subscription_id,
        (select count(*) from public.members m where m.dept_id = d.id and m.active) as roster,
        (select u.email from public.members m join auth.users u on u.id = m.user_id where m.dept_id = d.id and m.role = 'owner' and m.active order by m.created_at limit 1) as owner_email,
        (select max(i.started_at) from public.incidents i where i.dept_id = d.id) as last_incident,
        (select count(*) from public.incidents i where i.dept_id = d.id and i.started_at > now() - interval '30 days') as incidents_30d,
        (select max(u.last_sign_in_at) from public.members m join auth.users u on u.id = m.user_id where m.dept_id = d.id and m.active) as last_seen
      from public.departments d
      where p_search is null or p_search = '' or d.name ilike '%' || p_search || '%'
        or exists(select 1 from public.members m join auth.users u on u.id = m.user_id where m.dept_id = d.id and u.email ilike '%' || p_search || '%')
      order by d.created_at desc
      limit 500
    ) x
  ), '[]'::jsonb);
end $$;

create or replace function public.admin_department(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  perform public.admin_check();
  select jsonb_build_object(
    'dept', (select row_to_json(x)::jsonb from (select d.id, d.name, d.created_at, d.trial_ends_at, d.subscription_status, public.dept_stage(d) as stage,
        d.plan_interval, d.plan_amount, d.plan_invoice, d.plan_custom, d.plan_cancel_at, d.current_period_end, d.past_due_since, d.seat_count,
        public.dept_mrr(d) as mrr, d.stripe_customer_id, d.stripe_subscription_id, d.invite_code from public.departments d where d.id = p_id) x),
    'members', coalesce((select jsonb_agg(jsonb_build_object('name', m.name, 'rank', m.rank, 'role', m.role, 'email', u.email,
        'phone', m.phone, 'joined', m.created_at, 'last_seen', u.last_sign_in_at) order by (m.role = 'owner') desc, m.name)
      from public.members m left join auth.users u on u.id = m.user_id where m.dept_id = p_id and m.active), '[]'::jsonb),
    'incidents', coalesce((select jsonb_agg(jsonb_build_object('name', i.name, 'address', i.address, 'status', i.status, 'source', i.source,
        'started_at', i.started_at, 'closed_at', i.closed_at) order by i.started_at desc)
      from (select * from public.incidents where dept_id = p_id order by started_at desc limit 15) i), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'kind', e.kind, 'title', e.title, 'detail', e.detail, 'amount', e.amount) order by e.at desc)
      from (select * from public.platform_events where dept_id = p_id order by at desc limit 40) e), '[]'::jsonb),
    'usage', jsonb_build_object(
      'incidents_total', (select count(*) from public.incidents where dept_id = p_id),
      'messages_30d', (select count(*) from public.incident_messages where dept_id = p_id and created_at > now() - interval '30 days'),
      'training_sessions', (select count(*) from public.training_sessions where dept_id = p_id),
      'equipment', (select count(*) from public.equipment where dept_id = p_id),
      'phones', (select count(*) from public.push_devices p join public.members m on m.user_id = p.user_id where m.dept_id = p_id and m.active),
      'group_chat', (select chat_webhook_url is not null from public.dept_integrations where dept_id = p_id),
      'dispatch_30d', (select count(*) from public.dispatch_inbox where dept_id = p_id and at > now() - interval '30 days')
    )
  ) into r;
  if r->'dept' is null or r->'dept' = 'null'::jsonb then raise exception 'department not found'; end if;
  return r;
end $$;

create or replace function public.admin_events(p_before bigint default null, p_kind text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.admin_check();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'kind', e.kind, 'title', e.title, 'detail', e.detail, 'amount', e.amount,
      'dept_id', e.dept_id, 'meta', e.meta) order by e.id desc)
    from (select * from public.platform_events
      where (p_before is null or id < p_before) and (p_kind is null or p_kind = '' or kind = p_kind)
      order by id desc limit 100) e
  ), '[]'::jsonb);
end $$;

create or replace function public.admin_users(p_search text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.admin_check();
  return coalesce((
    select jsonb_agg(row_to_json(x)::jsonb order by x.created_at desc) from (
      select u.id, u.email, u.created_at, u.last_sign_in_at,
        coalesce((select jsonb_agg(jsonb_build_object('dept_id', d.id, 'name', d.name, 'role', m.role, 'member', m.name))
          from public.members m join public.departments d on d.id = m.dept_id where m.user_id = u.id and m.active), '[]'::jsonb) as departments,
        exists(select 1 from public.push_devices p where p.user_id = u.id) as has_iphone
      from auth.users u
      where p_search is null or p_search = '' or u.email ilike '%' || p_search || '%'
        or exists(select 1 from public.members m where m.user_id = u.id and m.name ilike '%' || p_search || '%')
      order by u.created_at desc
      limit 500
    ) x
  ), '[]'::jsonb);
end $$;

create or replace function public.admin_extend_trial(p_dept uuid, p_days int)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare t timestamptz; n text;
begin
  perform public.admin_check();
  if p_days not between 1 and 365 then raise exception 'pick 1 to 365 days'; end if;
  update public.departments set trial_ends_at = greatest(trial_ends_at, now()) + make_interval(days => p_days)
    where id = p_dept returning trial_ends_at, name into t, n;
  if t is null then raise exception 'department not found'; end if;
  perform public.log_platform_event('admin', 'Trial extended: ' || n, 'Now ends ' || to_char(t, 'Mon DD, YYYY') || '.', p_dept, auth.uid());
  return t;
end $$;

create or replace function public.admin_settings()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.admin_check();
  return jsonb_build_object('alerts', (select to_jsonb(alerts) from public.platform_admins where user_id = auth.uid()),
    'phones', (select count(*) from public.push_devices where user_id = auth.uid()));
end $$;

create or replace function public.admin_set_alerts(p_alerts text[])
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_check();
  update public.platform_admins set alerts = coalesce(p_alerts, '{}') where user_id = auth.uid();
end $$;

create or replace function public.admin_test_alert()
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.admin_check();
  perform public.log_platform_event('test', 'Test alert', 'Admin alerts are working.', null, auth.uid(), null, '{}'::jsonb, true);
end $$;

do $$
declare f text;
begin
  foreach f in array array['is_platform_admin()', 'admin_overview()', 'admin_departments(text)', 'admin_department(uuid)', 'admin_events(bigint, text)',
    'admin_users(text)', 'admin_extend_trial(uuid, integer)', 'admin_settings()', 'admin_set_alerts(text[])', 'admin_test_alert()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['admin_check()', 'ev_new_user()', 'ev_department()', 'ev_member()'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;
