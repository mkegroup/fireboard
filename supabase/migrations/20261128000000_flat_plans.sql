-- ============================================================
-- Nov 28, 2026: flat price per department (up to 25, 50 or 100 people).
-- Only departments over 100 people signed in need a quote now (was 60).
-- ============================================================

create or replace function public.ev_big_department()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(old.seat_count, 0) <= 100 and new.seat_count > 100 and not coalesce(new.plan_custom, false) then
    perform public.log_platform_event('quote', 'Needs a quote: ' || new.name,
      new.seat_count || ' people signed in, over the 100 the Large plan covers. Self-serve checkout is closed for them, so reach out with a custom plan.',
      new.id, null, null, jsonb_build_object('auto', true), true);
  end if;
  return new;
exception when others then return new;
end $$;
