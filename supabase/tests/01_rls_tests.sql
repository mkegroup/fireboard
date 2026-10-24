-- RLS + business rule tests. Run against a fresh DB with the stub + migration.
\set ON_ERROR_STOP 1
\set QUIET 1

create or replace function t_fail(sql text, pat text) returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    if sqlerrm !~* pat then raise exception 'expected error /%/ got: %', pat, sqlerrm; end if;
    return;
  end;
  raise exception 'expected failure /%/ but succeeded: %', pat, sql;
end $$;
create or replace function t_eq(got anyelement, want anyelement, label text) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'FAIL %: got % want %', label, got, want; end if;
end $$;
grant execute on function t_fail(text, text) to authenticated;

insert into auth.users values
  ('00000000-0000-0000-0000-00000000000a','alice@x'),
  ('00000000-0000-0000-0000-00000000000b','bob@x'),
  ('00000000-0000-0000-0000-00000000000c','carol@x');

create temp table ids(k text primary key, v text);
grant all on ids to authenticated;

-- ---------- Alice creates dept A ----------
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
set role authenticated;
insert into ids select 'deptA', public.create_department('Combermere FD','Alice Chief','Chief')::text;
-- ---------- Bob creates dept B ----------
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
set role authenticated;
insert into ids select 'deptB', public.create_department('Bobtown FD','Bob Boss','Chief')::text;
select t_eq((select count(*) from departments)::int, 1, 'bob sees only his dept');
reset role;
insert into ids select 'codeA', invite_code from departments where id = (select v::uuid from ids where k='deptA');

-- ---------- Carol joins A ----------
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000c',false);
set role authenticated;
select t_eq(public.join_department('NOPE99','Carol','Firefighter') is null, true, 'wrong invite code returns nothing');
select public.join_department((select v from ids where k='codeA'),'Carol Crew','Firefighter','Alpha');
select t_eq((select count(*) from members)::int, 2, 'carol sees 2 members in A');
select t_eq((select seat_count from departments)::int, 2, 'seat count 2');
select t_fail($$select dispatch_token from departments$$, 'permission denied');
select t_fail($$update departments set subscription_status='active'$$, 'permission denied');
select t_fail($$update departments set trial_ends_at = now() + interval '9 years'$$, 'permission denied');
-- member (not officer) cannot rename dept: update silently affects 0 rows under RLS
update departments set name = 'Hacked';
reset role;
select t_eq((select name from departments where id=(select v::uuid from ids where k='deptA')), 'Combermere FD', 'carol cannot rename');
set role authenticated;
select t_fail($$select public.start_incident((select v::uuid from ids where k='deptA'),'Fire','1 Main')$$, 'only officers');
select t_fail($$select public.get_dispatch_token((select v::uuid from ids where k='deptA'))$$, 'only the department owner');
select t_fail($$update members set role='owner' where user_id = auth.uid()$$, 'permission denied');

-- ---------- Alice starts an incident ----------
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
set role authenticated;
insert into ids select 'inc', public.start_incident((select v::uuid from ids where k='deptA'),'Structure Fire','12 Mill St','Structure')::text;
select t_eq((select count(*) from incident_personnel)::int, 1, 'alice auto-joined board');
select t_eq((select status from incident_personnel limit 1), 'Staged', 'alice staged');
insert into ids select 'tok', public.get_dispatch_token((select v::uuid from ids where k='deptA'));
select t_eq(length((select v from ids where k='tok')), 64, 'owner reads dispatch token');
with x as (insert into incident_apparatus(incident_id, dept_id, name)
  values ((select v::uuid from ids where k='inc'), (select v::uuid from ids where k='deptB'), 'Tanker 1') returning id)
insert into ids select 'truck', id::text from x;
reset role;
select t_eq((select dept_id::text from incident_apparatus limit 1), (select v from ids where k='deptA'), 'dept_id forced from incident');

-- ---------- Carol joins incident and changes her own status ----------
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000c',false);
set role authenticated;
insert into ids select 'carolp', public.join_incident((select v::uuid from ids where k='inc'))::text;
update incident_personnel set status = 'IN' where id = (select v::uuid from ids where k='carolp');
update incident_personnel set status = 'MISSING' where user_id = '00000000-0000-0000-0000-00000000000a';
reset role;
select t_eq((select status from incident_personnel where user_id='00000000-0000-0000-0000-00000000000c'), 'IN', 'carol set own status');
select t_eq((select status from incident_personnel where user_id='00000000-0000-0000-0000-00000000000a'), 'Staged', 'carol cannot change alice');
select t_eq((select count(*) from incident_events where message like 'Carol Crew: Responding to IN')::int, 1, 'status change logged');
select t_eq((select actor from incident_events where message like 'Carol Crew: Responding to IN'), 'Carol Crew', 'actor stamped');
set role authenticated;
-- chat sender spoofing
insert into incident_messages(incident_id, body, sender, user_id) values ((select v::uuid from ids where k='inc'), 'on scene', 'Alice Chief', '00000000-0000-0000-0000-00000000000a');
select t_eq((select sender from incident_messages limit 1), 'Carol Crew', 'sender stamped from member');
select t_fail($$delete from incident_messages$$, 'permission denied');
select t_fail($$insert into incident_events(incident_id, message, kind) values ((select v::uuid from ids where k='inc'), 'x', 'par')$$, 'row-level security');
-- PAR: carol cannot call it
select t_fail($$select public.start_par((select v::uuid from ids where k='inc'))$$, 'only officers');

-- ---------- Bob cannot touch dept A ----------
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
set role authenticated;
select t_eq((select count(*) from incidents)::int, 0, 'bob sees no A incidents');
select t_eq((select count(*) from incident_personnel)::int, 0, 'bob sees no A personnel');
select t_fail($$insert into incident_messages(incident_id, body) values ((select v::uuid from ids where k='inc'), 'hi')$$, 'row-level security');
select t_fail($$select public.join_incident((select v::uuid from ids where k='inc'))$$, 'not allowed');
select t_eq(public.join_department('XXXXXX','Bob','x') is null, true, 'wrong code for bob');
update incident_personnel set status='OUT';
reset role;
select t_eq((select count(*) from incident_personnel where status='OUT')::int, 0, 'bob cannot update A rows');

-- ---------- PAR flow ----------
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
set role authenticated;
select public.start_par((select v::uuid from ids where k='inc'));
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000c',false);
set role authenticated;
select public.ack_par((select v::uuid from ids where k='carolp'));
select t_fail($$select public.ack_par((select id from incident_personnel where user_id='00000000-0000-0000-0000-00000000000a'))$$, 'not allowed');
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
set role authenticated;
select public.end_par((select v::uuid from ids where k='inc'));
select t_eq((select count(*) from incident_events where message = 'PAR closed: 1 of 2 confirmed')::int, 1, 'par summary');

-- ---------- Medical privacy ----------
insert into member_medical(member_id, dept_id, allergies)
  select id, dept_id, 'Penicillin' from members where user_id='00000000-0000-0000-0000-00000000000a';
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000c',false);
set role authenticated;
select t_eq((select count(*) from member_medical)::int, 0, 'carol cannot read alice medical');
insert into member_medical(member_id, dept_id, allergies)
  select id, dept_id, 'Bees' from members where user_id='00000000-0000-0000-0000-00000000000c';
select t_eq((select count(*) from member_medical)::int, 1, 'carol sees her own medical');
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
set role authenticated;
select t_eq((select count(*) from member_medical)::int, 2, 'officer sees all medical');

-- ---------- Roles ----------
select public.set_member_role((select id from members where user_id='00000000-0000-0000-0000-00000000000c'), 'officer');
select t_fail($$select public.set_member_role((select id from members where user_id='00000000-0000-0000-0000-00000000000a'), 'member')$$, 'at least one owner');
select t_fail($$select public.remove_member((select id from members where user_id='00000000-0000-0000-0000-00000000000a'))$$, 'owners cannot be removed');

-- ---------- Training ----------
insert into training_sessions(dept_id, title, hours, attendance_open)
  values ((select v::uuid from ids where k='deptA'), 'Pump Ops', 3, true);
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000c',false);
set role authenticated;
select public.self_mark_attendance((select id from training_sessions limit 1));
select t_eq((select count(*) from training_attendance)::int, 1, 'self attendance');

-- ---------- Trial expiry locks writes, keeps reads ----------
reset role;
update departments set trial_ends_at = now() - interval '1 day' where id = (select v::uuid from ids where k='deptA');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
set role authenticated;
select t_fail($$select public.start_incident((select v::uuid from ids where k='deptA'),'Fire 2','x')$$, 'subscription inactive');
select t_fail($$insert into incident_messages(incident_id, body) values ((select v::uuid from ids where k='inc'), 'hi')$$, 'row-level security');
update incident_personnel set status = 'OUT';
select t_eq((select count(*) from incident_personnel where status='OUT')::int, 0, 'locked dept cannot write');
select t_eq((select count(*) from incidents)::int, 1, 'locked dept can still read history');
select public.close_incident((select v::uuid from ids where k='inc'));
select t_eq((select status from incidents limit 1), 'closed', 'can always close an incident');
reset role;
update departments set subscription_status = 'active' where id = (select v::uuid from ids where k='deptA');
set role authenticated;
select public.start_incident((select v::uuid from ids where k='deptA'),'Fire 2','x');
select t_eq((select count(*) from incidents where status='active')::int, 1, 'paid dept can start again');

-- ---------- Pricing rules ----------
reset role;
select t_eq((select round(extract(epoch from trial_ends_at - now()) / 86400)::int from departments where id=(select v::uuid from ids where k='deptB')), 7, 'trial is 7 days');
set role authenticated;
select t_fail($$update departments set past_due_since = null$$, 'permission denied');
-- Roster import: officers only, skips names already on the roster
select t_eq(public.import_roster((select v::uuid from ids where k='deptA'),
  '[{"name":"Roster One"},{"name":"Roster Two","rank":"Captain","crew":"Bravo"},{"name":"alice chief"},{"name":"  "}]'::jsonb), 2, 'import adds new names only');
select t_eq(public.import_roster((select v::uuid from ids where k='deptA'), '[{"name":"Roster One"}]'::jsonb), 0, 'import skips duplicates');
select t_eq((select rank from members where name='Roster Two'), 'Captain', 'import keeps rank');
select t_eq((select count(*) from members where name like 'Roster%' and user_id is null and role='member')::int, 2, 'imported people are free roster entries');
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
set role authenticated;
select t_fail($$select public.import_roster((select v::uuid from ids where k='deptA'), '[{"name":"Spy"}]'::jsonb)$$, 'not allowed');
-- Grace period counts from when the payment went past due, not the yearly period end
reset role;
update departments set subscription_status='past_due', current_period_end = now() + interval '11 months',
  past_due_since = now() - interval '3 days' where id=(select v::uuid from ids where k='deptA');
select t_eq(public.dept_has_access((select v::uuid from ids where k='deptA')), true, 'past due 3 days still works');
update departments set past_due_since = now() - interval '20 days' where id=(select v::uuid from ids where k='deptA');
select t_eq(public.dept_has_access((select v::uuid from ids where k='deptA')), false, 'past due 20 days locks even with a far period end');
update departments set subscription_status='active', past_due_since=null where id=(select v::uuid from ids where k='deptA');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
set role authenticated;

-- ---------- Removed people stay out; invite codes can't be brute forced ----------
reset role;
insert into auth.users values ('00000000-0000-0000-0000-00000000000d','dave@x');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000d',false);
set role authenticated;
select t_eq(public.invite_preview((select v from ids where k='codeA')), 'Combermere FD', 'preview shows dept name');
select public.join_department((select v from ids where k='codeA'),'Dave Diver','Firefighter');
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
set role authenticated;
select public.remove_member((select id from members where user_id='00000000-0000-0000-0000-00000000000d'));
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000d',false);
set role authenticated;
select t_fail($$select public.join_department((select v from ids where k='codeA'),'Dave Again','Firefighter')$$, 'removed from this department');
select t_eq((select count(*) from incidents)::int, 0, 'removed member sees nothing');
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
set role authenticated;
select t_fail($$select public.allow_member_back((select id from public.members where name='Dave Diver' limit 1))$$, 'not allowed');
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
set role authenticated;
select public.allow_member_back((select id from members where name='Dave Diver'));
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000d',false);
set role authenticated;
select t_eq(public.join_department((select v from ids where k='codeA'),'Dave Diver','Firefighter') is not null, true, 'allowed back can rejoin');
select public.join_department('WRONG' || g, 'Dave', 'Firefighter') from generate_series(1, 10) g;
select t_fail($$select public.join_department((select v from ids where k='codeA'),'Dave','Firefighter')$$, 'too many invite attempts');
select t_fail($$select public.invite_preview('ABCDEF')$$, 'too many invite attempts');
select t_fail($$select * from invite_attempts$$, 'permission denied');
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
set role authenticated;

-- ---------- Leaving ----------
select t_fail($$select public.leave_department((select v::uuid from ids where k='deptA'))$$, 'transfer ownership');
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000c',false);
set role authenticated;
select public.leave_department((select v::uuid from ids where k='deptA'));
select t_eq((select count(*) from incidents)::int, 0, 'left member loses access');
reset role;
select t_eq((select seat_count from departments where id=(select v::uuid from ids where k='deptA')), 2, 'seat count drops (alice + dave)');

\echo ALL_TESTS_PASSED
