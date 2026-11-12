-- ============================================================
-- Free trial is 30 days (was 7). Volunteer departments need a few
-- weeks to see real calls on the board and get spending approved.
-- Departments still in a trial today get the longer trial too.
-- ============================================================

alter table public.departments
  alter column trial_ends_at set default (now() + interval '30 days');

update public.departments
   set trial_ends_at = created_at + interval '30 days'
 where coalesce(subscription_status, 'none') in ('none', 'incomplete')
   and stripe_subscription_id is null
   and trial_ends_at < created_at + interval '30 days'
   and created_at + interval '30 days' > now();
