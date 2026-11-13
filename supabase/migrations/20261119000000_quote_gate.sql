-- ============================================================
-- Departments with 60+ people signed in get a custom plan (quote).
-- When a department crosses 60, the owner's console gets a "Needs a quote"
-- alert (kind 'quote', so it uses the existing Quote alerts setting and shows
-- under Needs attention). Self-serve checkout is closed for them in the
-- billing function. The board itself keeps working.
-- ============================================================

create or replace function public.ev_big_department()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(old.seat_count, 0) < 60 and new.seat_count >= 60 and not coalesce(new.plan_custom, false) then
    perform public.log_platform_event('quote', 'Needs a quote: ' || new.name,
      new.seat_count || ' people signed in. Self-serve checkout is closed for them, so reach out with a custom plan.',
      new.id, null, null, jsonb_build_object('auto', true), true);
  end if;
  return new;
exception when others then return new;
end $$;

drop trigger if exists platform_department_big on public.departments;
create trigger platform_department_big after update of seat_count on public.departments
  for each row execute function public.ev_big_department();
