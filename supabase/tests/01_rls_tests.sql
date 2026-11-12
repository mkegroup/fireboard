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
select t_eq((select round(extract(epoch from trial_ends_at - now()) / 86400)::int from departments where id=(select v::uuid from ids where k='deptB')), 30, 'trial is 30 days');
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

-- ---------- iPhone alert tokens ----------
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
set role authenticated;
select public.register_push_device(repeat('ab', 32));
select public.register_push_device(upper(repeat('cd', 32)));
select t_fail($$select * from push_devices$$, 'permission denied');
select t_fail($$insert into push_devices(token, user_id) values (repeat('ef',32), auth.uid())$$, 'permission denied');
select t_fail($$select public.register_push_device('not a token')$$, 'bad device token');
reset role;
select t_eq((select count(*) from push_devices where user_id='00000000-0000-0000-0000-00000000000a')::int, 2, 'alice has 2 phones (token lowercased)');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
set role authenticated;
select public.unregister_push_device(repeat('ab', 32));
reset role;
select t_eq((select count(*) from push_devices)::int, 2, 'bob cannot remove alice''s phone');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
set role authenticated;
select public.register_push_device(repeat('ab', 32));
reset role;
select t_eq((select user_id::text from push_devices where token=repeat('ab',32)), '00000000-0000-0000-0000-00000000000b', 'phone moves to whoever signs in on it');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
set role authenticated;
select public.unregister_push_device(repeat('cd', 32));
reset role;
select t_eq((select count(*) from push_devices where user_id='00000000-0000-0000-0000-00000000000a')::int, 0, 'sign out removes the phone');
set role anon;
select t_fail($$select public.register_push_device(repeat('ab', 32))$$, 'permission denied');
reset role;

-- ---------- Connections ----------
select t_eq((select count(*) from dept_integrations where dept_id=(select v::uuid from ids where k='deptA'))::int, 1, 'new department gets a connections row');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
set role authenticated;
select t_eq((public.get_integrations((select v::uuid from ids where k='deptA'))->>'inbox_code') ~ '^[a-z0-9]{12}$', true, 'owner sees dispatch email code');
select public.set_integrations((select v::uuid from ids where k='deptA'), 'https://hooks.slack.com/services/x', array['incident','closed'], 'county.on.ca');
select t_eq(public.get_integrations((select v::uuid from ids where k='deptA'))->>'chat_webhook_url', 'https://hooks.slack.com/services/x', 'owner saves chat link');
select t_fail($$select public.set_integrations((select v::uuid from ids where k='deptA'), 'http://evil', null, null)$$, 'https');
select t_fail($$select public.set_integrations((select v::uuid from ids where k='deptA'), null, array['bogus'], null)$$, 'unknown chat event');
select t_fail($$select * from dept_integrations$$, 'permission denied');
select t_eq(public.regenerate_integration((select v::uuid from ids where k='deptA'), 'inbox') ~ '^[a-z0-9]{12}$', true, 'owner makes a new email address');
reset role;
insert into dispatch_inbox(dept_id, channel, outcome) values ((select v::uuid from ids where k='deptA'), 'email', 'created');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
set role authenticated;
select t_fail($$select public.get_integrations((select v::uuid from ids where k='deptA'))$$, 'only the department owner');
select t_fail($$select public.set_integrations((select v::uuid from ids where k='deptA'), null, null, null)$$, 'only the department owner');
select t_eq((select count(*) from dispatch_inbox)::int, 0, 'other department cannot see dispatch messages');
select t_fail($$insert into dispatch_inbox(dept_id, channel, outcome) values ((select v::uuid from ids where k='deptB'), 'email', 'created')$$, 'permission denied');
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
set role authenticated;
select t_eq((select count(*) from dispatch_inbox)::int, 1, 'owner sees dispatch messages');
select t_fail($$update members set lang = 'xx' where user_id = auth.uid()$$, 'check');
update members set lang = 'fr' where user_id = auth.uid();
reset role;
select t_eq((select lang from members where user_id='00000000-0000-0000-0000-00000000000a' limit 1), 'fr', 'language saved');

-- ---------- Incident map pin ----------
reset role;
insert into ids select 'incPin', id::text from incidents where dept_id=(select v::uuid from ids where k='deptA') limit 1;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
set role authenticated;
update incidents set lat = 45.36, lng = -77.62 where id = (select v::uuid from ids where k='incPin');
select t_fail($$update incidents set lat = 95 where id = (select v::uuid from ids where k='incPin')$$, 'check');
reset role;
select t_eq((select lat from incidents where id=(select v::uuid from ids where k='incPin'))::numeric, 45.36::numeric, 'officer saves the map pin');

-- ---------- Chat: station chat, media, replies, reactions, edits, pins, reads ----------
reset role;
insert into auth.users values ('00000000-0000-0000-0000-00000000000e','erin@x');
delete from ids where k='codeA';
insert into ids select 'codeA', invite_code from departments where id = (select v::uuid from ids where k='deptA');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000e',false);
set role authenticated;
select public.join_department((select v from ids where k='codeA'),'Erin Crew','Firefighter');
with x as (insert into incident_messages(dept_id, body) values ((select v::uuid from ids where k='deptA'), 'truck check at 7') returning id)
insert into ids select 'smsg', id::text from x;
select t_eq((select sender from incident_messages where id=(select v::uuid from ids where k='smsg')), 'Erin Crew', 'station chat sender stamped');
select t_fail($$insert into incident_messages(dept_id, body) values ((select v::uuid from ids where k='deptB'), 'sneaky')$$, 'row-level security');
select t_fail($$insert into incident_messages(dept_id, body) values ((select v::uuid from ids where k='deptA'), '   ')$$, 'incident_messages_shape');
select t_fail($$insert into incident_messages(dept_id, kind) values ((select v::uuid from ids where k='deptA'), 'photo')$$, 'incident_messages_shape');
select t_fail($$insert into incident_messages(dept_id, kind, media_path) values ((select v::uuid from ids where k='deptA'), 'photo', (select v from ids where k='deptA') || '/00000000-0000-0000-0000-00000000000a/x.jpg')$$, 'row-level security');
insert into incident_messages(dept_id, kind, media_path, media_w, media_h) values ((select v::uuid from ids where k='deptA'), 'photo', (select v from ids where k='deptA') || '/00000000-0000-0000-0000-00000000000e/p1.jpg', 800, 600);
insert into incident_messages(dept_id, kind, media_path, media_seconds) values ((select v::uuid from ids where k='deptA'), 'voice', (select v from ids where k='deptA') || '/00000000-0000-0000-0000-00000000000e/v1.m4a', 7.5);
insert into incident_messages(dept_id, kind, lat, lng) values ((select v::uuid from ids where k='deptA'), 'location', 45.49, -77.68);
insert into incident_messages(dept_id, body, reply_to) values ((select v::uuid from ids where k='deptA'), 'see you there', (select v::uuid from ids where k='smsg'));
select t_fail($$insert into incident_messages(incident_id, body, reply_to) values ((select v::uuid from ids where k='inc'), 'x', (select v::uuid from ids where k='smsg'))$$, 'reply is not in this chat');
select public.edit_chat_message((select v::uuid from ids where k='smsg'), 'truck check at 7:30');
select t_eq((select edited_at is not null from incident_messages where id=(select v::uuid from ids where k='smsg')), true, 'own message edited');
select t_fail($$update incident_messages set body = 'x'$$, 'permission denied');
select t_fail($$select public.pin_chat_message((select v::uuid from ids where k='smsg'), true)$$, 'only officers');
insert into chat_reactions(message_id, emoji, user_id) values ((select v::uuid from ids where k='smsg'), '👍', '00000000-0000-0000-0000-00000000000a');
select t_eq((select user_id::text from chat_reactions limit 1), '00000000-0000-0000-0000-00000000000e', 'reaction belongs to whoever made it');
select public.mark_chat_read((select v::uuid from ids where k='deptA'), 'station');
select t_eq((select name from chat_reads limit 1), 'Erin Crew', 'read receipt saved');
insert into storage.objects(bucket_id, name) values ('chat', (select v from ids where k='deptA') || '/00000000-0000-0000-0000-00000000000e/p1.jpg');
select t_fail($$insert into storage.objects(bucket_id, name) values ('chat', (select v from ids where k='deptA') || '/00000000-0000-0000-0000-00000000000a/p2.jpg')$$, 'row-level security');
select t_fail($$insert into storage.objects(bucket_id, name) values ('chat', (select v from ids where k='deptB') || '/00000000-0000-0000-0000-00000000000e/p2.jpg')$$, 'row-level security');
update members set chat_alerts = false where user_id = auth.uid();

reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
set role authenticated;
select t_eq((select count(*) from incident_messages where incident_id is null)::int, 5, 'alice reads station chat');
select t_eq((select count(*) from storage.objects)::int, 1, 'alice can open the photo');
select t_fail($$select public.edit_chat_message((select v::uuid from ids where k='smsg'), 'nope')$$, 'only change your own');
select public.pin_chat_message((select v::uuid from ids where k='smsg'), true);
select t_eq((select pinned_by from incident_messages where id=(select v::uuid from ids where k='smsg')), 'Alice Chief', 'officer pins');
delete from chat_reactions;
select t_eq((select count(*) from chat_reactions)::int, 1, 'cannot remove someone else''s reaction');
select t_eq(public.delete_chat_message((select v::uuid from ids where k='smsg')), null, 'officer removes a message');
select t_eq((select body || coalesce(pinned_by, '') from incident_messages where id=(select v::uuid from ids where k='smsg')), '', 'removed message is blanked and unpinned');
select t_eq((select count(*) from chat_reactions)::int, 0, 'reactions go with it');

reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
set role authenticated;
select t_eq((select count(*) from incident_messages)::int, 0, 'other department cannot read the chat');
select t_eq((select count(*) from storage.objects)::int, 0, 'other department cannot open the photo');
select t_eq((select count(*) from chat_reads)::int, 0, 'other department cannot see who read');
select t_fail($$select public.mark_chat_read((select v::uuid from ids where k='deptA'), 'station')$$, 'not a member');
select t_fail($$select public.delete_chat_message((select v::uuid from ids where k='smsg'))$$, 'not found');
reset role;
select t_eq((select chat_alerts from members where user_id='00000000-0000-0000-0000-00000000000e'), false, 'chat alerts turned off');

-- ---------- Owner's console ----------
reset role;
select t_eq((select count(*) from platform_events where kind = 'signup')::int >= 3, true, 'sign-ups recorded');
select t_eq((select count(*) from platform_events where kind = 'department' and notify)::int, 2, 'new departments recorded for alerts');
select t_eq((select count(*) from platform_events where kind = 'member_joined')::int >= 2, true, 'joins recorded');
select t_eq((select count(*) from platform_events where kind = 'plan' and title like 'Paying customer%')::int >= 1, true, 'plan going active recorded');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
set role authenticated;
select t_eq(public.is_platform_admin(), false, 'department owner is not a platform admin');
select t_fail($$select public.admin_overview()$$, 'admins only');
select t_fail($$select public.admin_departments(null)$$, 'admins only');
select t_fail($$select public.admin_users(null)$$, 'admins only');
select t_fail($$select public.admin_extend_trial((select v::uuid from ids where k='deptA'), 30)$$, 'admins only');
select t_fail($$select * from platform_events$$, 'permission denied');
select t_fail($$select * from platform_admins$$, 'permission denied');
select t_fail($$select public.log_platform_event('payment', 'fake', null, null, null, 999, '{}'::jsonb, true)$$, 'permission denied');
select public.request_quote((select v::uuid from ids where k='deptA'), 'Stations: 6, people: 120');
reset role;
select t_eq((select count(*) from platform_events where kind = 'quote' and notify)::int, 1, 'quote request recorded for alerts');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
set role authenticated;
select t_fail($$select public.request_quote((select v::uuid from ids where k='deptA'), 'x')$$, 'not a member');
reset role;
insert into platform_admins(user_id) values ('00000000-0000-0000-0000-00000000000b');
insert into platform_events(kind, title, amount, dept_id) values ('payment', 'Payment received', 99.99, (select v::uuid from ids where k='deptA'));
set role authenticated;
select t_eq(public.is_platform_admin(), true, 'admin recognized');
select t_eq((public.admin_overview()->>'departments')::int, 2, 'admin sees every department');
select t_eq((public.admin_overview()->>'collected_30d')::numeric, 99.99, 'payments add up');
select t_eq(jsonb_array_length(public.admin_overview()->'weeks'), 12, '12 weeks of history');
select t_eq(jsonb_array_length(public.admin_departments('combermere')), 1, 'department search');
select t_eq(public.admin_department((select v::uuid from ids where k='deptA'))->'dept'->>'name', 'Combermere FD', 'department detail');
select t_eq(jsonb_array_length(public.admin_users('alice')), 1, 'user search');
select t_eq(public.admin_events(null, 'quote')->0->>'kind', 'quote', 'activity filter');
select t_eq(public.admin_extend_trial((select v::uuid from ids where k='deptB'), 30) > now() + interval '29 days', true, 'admin extends a trial');
select public.admin_set_alerts(array['payment','quote']);
select t_eq(jsonb_array_length(public.admin_settings()->'alerts'), 2, 'alert choices saved');
reset role;

-- ---------- Bulk import ----------
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000a',false);
set role authenticated;
select t_eq(public.import_roster((select v::uuid from ids where k='deptA'), '[{"name":"Imp One","rank":"Captain","call_sign":"C9","years":"7","certifications":[{"name":"NFPA 1001","date":"2024-01-02","expiry":""}]},{"name":"Imp Two"},{"name":""}]'::jsonb), 2, 'roster import adds people');
select t_eq((select call_sign || years::text from members where name='Imp One'), 'C97', 'extra roster columns saved');
select t_eq(public.import_roster((select v::uuid from ids where k='deptA'), '[{"name":"imp two","phone":"613-555-0100","certifications":[{"name":"First Aid"}]}]'::jsonb), 0, 'existing person not added twice');
select t_eq((select phone || jsonb_array_length(certifications)::text from members where name='Imp Two'), '613-555-01001', 'blank fields filled, certification added');
select t_eq((public.import_training((select v::uuid from ids where k='deptA'), '[{"title":"Pump ops","session_date":"2026-10-01","hours":"3","attendees":["Imp One","Nobody Here"]},{"title":""}]'::jsonb)->>'sessions')::int, 1, 'training import');
select t_eq((select count(*) from training_attendance a join training_sessions s on s.id=a.session_id where s.title='Pump ops')::int, 1, 'attendance matched by name');
select t_eq(public.import_equipment((select v::uuid from ids where k='deptA'), '[{"name":"SCBA bottle","qty":"12","status":"Bogus","next_service":"2027-01-01"},{"name":"Hose 1.75"}]'::jsonb), 2, 'equipment import');
select t_eq((select status || qty::text from equipment where name='SCBA bottle'), 'Available12', 'bad status falls back');
reset role;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000000b',false);
set role authenticated;
select t_fail($$select public.import_equipment((select v::uuid from ids where k='deptA'), '[{"name":"x"}]'::jsonb)$$, 'not allowed');
select t_fail($$select public.import_training((select v::uuid from ids where k='deptA'), '[{"title":"x"}]'::jsonb)$$, 'not allowed');
reset role;

\echo ALL_TESTS_PASSED
