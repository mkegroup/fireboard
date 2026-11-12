-- ============================================================
-- Seats the owner chooses
--  * seats_paid: how many people the owner chose to pay for at checkout or
--    with Change seats. It's a floor: if more people sign in, billing grows
--    on its own (up to the cap) and the owner gets an alert.
--  * seats_billed: the quantity Stripe is billing right now. Written only by
--    the server (billing function, webhook, nightly check).
-- ============================================================

alter table public.departments add column if not exists seats_paid int check (seats_paid is null or seats_paid between 1 and 10000);
alter table public.departments add column if not exists seats_billed int check (seats_billed is null or seats_billed between 0 and 10000);

grant select (seats_paid, seats_billed) on public.departments to authenticated;

-- Monthly revenue estimate for the admin console now prefers what's actually billed.
create or replace function public.dept_mrr(d public.departments)
returns numeric language sql immutable as $$
  select case
    when d.plan_amount is not null then round(case when d.plan_interval = 'year' then d.plan_amount / 12 else d.plan_amount end, 2)
    when d.plan_interval = 'year' then round(coalesce(d.seats_billed, least(greatest(d.seat_count, 1), 20)) * 99.99 / 12, 2)
    else round(coalesce(d.seats_billed, least(greatest(d.seat_count, 1), 20)) * 9.99, 2)
  end
$$;
