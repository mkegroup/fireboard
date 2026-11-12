-- ============================================================
-- Bulk import from spreadsheets
--  * import_roster takes more columns: call sign, radio, years, and
--    certifications. People already on the roster (same name) get their
--    blank fields filled in instead of being skipped. Returns how many are new.
--  * import_training adds many training sessions at once, with attendance
--    matched to roster names.
--  * import_equipment adds many equipment items at once.
-- Officers only, up to 500 rows a call.
-- ============================================================

create or replace function public.import_roster(p_dept uuid, p_people jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int := 0; p jsonb; nm text; m public.members; certs jsonb; yrs int;
begin
  if not public.can_command(p_dept) then raise exception 'not allowed'; end if;
  if jsonb_typeof(p_people) <> 'array' or jsonb_array_length(p_people) > 500 then
    raise exception 'send up to 500 people at a time';
  end if;
  for p in select * from jsonb_array_elements(p_people) loop
    nm := left(trim(coalesce(p->>'name', '')), 80);
    continue when nm = '';
    certs := case when jsonb_typeof(p->'certifications') = 'array' then p->'certifications' else '[]'::jsonb end;
    yrs := case when coalesce(p->>'years', '') ~ '^\d{1,2}$' then (p->>'years')::int end;
    select * into m from public.members where dept_id = p_dept and active and lower(name) = lower(nm) limit 1;
    if m.id is not null then
      -- Already on the roster: fill in what's missing, add new certifications.
      update public.members set
        rank = case when rank = 'Firefighter' and nullif(trim(p->>'rank'), '') is not null then left(trim(p->>'rank'), 40) else rank end,
        crew = coalesce(crew, nullif(left(trim(p->>'crew'), 40), '')),
        phone = coalesce(phone, nullif(left(trim(p->>'phone'), 30), '')),
        call_sign = coalesce(call_sign, nullif(left(trim(p->>'call_sign'), 20), '')),
        radio = coalesce(radio, nullif(left(trim(p->>'radio'), 20), '')),
        years = coalesce(years, yrs),
        certifications = coalesce(certifications, '[]'::jsonb) || coalesce((
          select jsonb_agg(c) from jsonb_array_elements(certs) c
          where not exists (select 1 from jsonb_array_elements(coalesce(m.certifications, '[]'::jsonb)) o
            where lower(o->>'name') = lower(c->>'name'))), '[]'::jsonb)
      where id = m.id;
      continue; -- counts only new people

    end if;
    insert into public.members(dept_id, user_id, role, name, rank, crew, phone, call_sign, radio, years, certifications)
      values (p_dept, null, 'member', nm,
        coalesce(nullif(left(trim(p->>'rank'), 40), ''), 'Firefighter'),
        nullif(left(trim(p->>'crew'), 40), ''),
        nullif(left(trim(p->>'phone'), 30), ''),
        nullif(left(trim(p->>'call_sign'), 20), ''),
        nullif(left(trim(p->>'radio'), 20), ''),
        yrs, certs);
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.import_training(p_dept uuid, p_sessions jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s jsonb; sid uuid; n int := 0; att int := 0; unmatched text[] := '{}'; who text; mid uuid; d date; h numeric;
begin
  if not public.can_command(p_dept) then raise exception 'not allowed'; end if;
  if jsonb_typeof(p_sessions) <> 'array' or jsonb_array_length(p_sessions) > 500 then
    raise exception 'send up to 500 sessions at a time';
  end if;
  for s in select * from jsonb_array_elements(p_sessions) loop
    continue when coalesce(trim(s->>'title'), '') = '';
    d := case when coalesce(s->>'session_date', '') ~ '^\d{4}-\d{2}-\d{2}$' then (s->>'session_date')::date else current_date end;
    h := case when coalesce(s->>'hours', '') ~ '^\d{1,3}(\.\d{1,2})?$' then least((s->>'hours')::numeric, 500) end;
    insert into public.training_sessions(dept_id, title, session_date, kind, hours, location, instructor, notes)
      values (p_dept, left(trim(s->>'title'), 120), d, nullif(left(trim(s->>'kind'), 60), ''), h,
        nullif(left(trim(s->>'location'), 120), ''), nullif(left(trim(s->>'instructor'), 80), ''), nullif(left(trim(s->>'notes'), 2000), ''))
      returning id into sid;
    n := n + 1;
    if jsonb_typeof(s->'attendees') = 'array' then
      for who in select trim(x) from jsonb_array_elements_text(s->'attendees') x loop
        continue when who = '';
        select id into mid from public.members where dept_id = p_dept and active and lower(name) = lower(who) limit 1;
        if mid is null then
          if not who = any(unmatched) and cardinality(unmatched) < 50 then unmatched := unmatched || who; end if;
          continue;
        end if;
        insert into public.training_attendance(session_id, member_id, dept_id) values (sid, mid, p_dept) on conflict do nothing;
        att := att + 1;
      end loop;
    end if;
  end loop;
  return jsonb_build_object('sessions', n, 'attendance', att, 'unmatched', to_jsonb(unmatched));
end $$;

create or replace function public.import_equipment(p_dept uuid, p_items jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare e jsonb; n int := 0; st text; q int;
begin
  if not public.can_command(p_dept) then raise exception 'not allowed'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 500 then
    raise exception 'send up to 500 items at a time';
  end if;
  for e in select * from jsonb_array_elements(p_items) loop
    continue when coalesce(trim(e->>'name'), '') = '';
    st := case when e->>'status' in ('Available','Deployed','In Service','Out of Service','Missing') then e->>'status' else 'Available' end;
    q := case when coalesce(e->>'qty', '') ~ '^\d{1,5}$' then greatest(1, least((e->>'qty')::int, 10000)) else 1 end;
    insert into public.equipment(dept_id, name, category, status, serial, qty, location, condition, last_inspected, next_service, notes)
      values (p_dept, left(trim(e->>'name'), 120), nullif(left(trim(e->>'category'), 60), ''), st,
        nullif(left(trim(e->>'serial'), 80), ''), q, nullif(left(trim(e->>'location'), 80), ''), nullif(left(trim(e->>'condition'), 40), ''),
        case when coalesce(e->>'last_inspected', '') ~ '^\d{4}-\d{2}-\d{2}$' then (e->>'last_inspected')::date end,
        case when coalesce(e->>'next_service', '') ~ '^\d{4}-\d{2}-\d{2}$' then (e->>'next_service')::date end,
        nullif(left(trim(e->>'notes'), 2000), ''));
    n := n + 1;
  end loop;
  return n;
end $$;

revoke execute on function public.import_training(uuid, jsonb) from public, anon;
revoke execute on function public.import_equipment(uuid, jsonb) from public, anon;
grant execute on function public.import_training(uuid, jsonb) to authenticated;
grant execute on function public.import_equipment(uuid, jsonb) to authenticated;
