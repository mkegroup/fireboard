-- ============================================================
-- Chat, done properly
--  * Station chat for the whole department, plus the chat on each incident.
--    Both live in incident_messages: incident_id is empty for station chat.
--  * Photos, voice notes and shared locations. Files go in the private
--    "chat" storage bucket under <dept id>/<user id>/<file>.
--  * Replies, reactions, edits, unsend, pinned messages, mentions, read receipts.
--  * Chat alerts on the iPhone, which each person can turn off.
-- Plans
--  * What the department actually pays per month or year, and whether it is
--    a custom deal set up by hand in Stripe.
-- ============================================================

-- ---------- messages ----------
alter table public.incident_messages alter column incident_id drop not null;
alter table public.incident_messages drop constraint if exists incident_messages_body_check;
alter table public.incident_messages alter column body set default '';
alter table public.incident_messages
  add column if not exists kind text not null default 'text' check (kind in ('text', 'photo', 'voice', 'location')),
  add column if not exists media_path text check (media_path is null or length(media_path) <= 200),
  add column if not exists media_seconds numeric(6, 1) check (media_seconds is null or media_seconds between 0 and 600),
  add column if not exists media_w int check (media_w is null or media_w between 1 and 10000),
  add column if not exists media_h int check (media_h is null or media_h between 1 and 10000),
  add column if not exists lat double precision check (lat is null or lat between -90 and 90),
  add column if not exists lng double precision check (lng is null or lng between -180 and 180),
  add column if not exists reply_to uuid references public.incident_messages(id) on delete set null,
  add column if not exists mentions uuid[] not null default '{}' check (cardinality(mentions) <= 20),
  add column if not exists edited_at timestamptz,
  add column if not exists deleted_at timestamptz,
  add column if not exists pinned_at timestamptz,
  add column if not exists pinned_by text,
  add column if not exists pushed_at timestamptz;
alter table public.incident_messages drop constraint if exists incident_messages_shape;
alter table public.incident_messages add constraint incident_messages_shape check (
  length(body) <= 2000 and (
    deleted_at is not null
    or (kind = 'text' and length(trim(body)) >= 1)
    or (kind in ('photo', 'voice') and media_path is not null)
    or (kind = 'location' and lat is not null and lng is not null)
  )
);
create index if not exists station_messages_idx on public.incident_messages(dept_id, created_at) where incident_id is null;

-- Department comes from the incident, or for station chat from the row itself.
-- A reply has to be to a message in the same chat.
create or replace function public.chat_message_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.incident_id is not null then
    select dept_id into new.dept_id from public.incidents where id = new.incident_id;
    if new.dept_id is null then raise exception 'incident not found'; end if;
  elsif new.dept_id is null then
    raise exception 'department required';
  end if;
  if new.reply_to is not null and not exists(
      select 1 from public.incident_messages r where r.id = new.reply_to and r.dept_id = new.dept_id
        and r.incident_id is not distinct from new.incident_id) then
    raise exception 'reply is not in this chat';
  end if;
  new.edited_at := null; new.deleted_at := null; new.pinned_at := null; new.pinned_by := null; new.pushed_at := null;
  new.created_at := now();
  return new;
end $$;
drop trigger if exists incident_messages_dept on public.incident_messages;
create trigger incident_messages_dept before insert on public.incident_messages
  for each row execute function public.chat_message_before_insert();
revoke execute on function public.chat_message_before_insert() from public, anon, authenticated;

drop policy if exists msg_insert on public.incident_messages;
create policy msg_insert on public.incident_messages for insert to authenticated
  with check (
    public.can_write(dept_id) and user_id = auth.uid()
    and (media_path is null or media_path like dept_id::text || '/' || auth.uid()::text || '/%')
  );

-- Change your own message, unsend it (officers can remove anyone's), pin it.
create or replace function public.edit_chat_message(p_id uuid, p_body text)
returns void language plpgsql security definer set search_path = public as $$
declare m public.incident_messages; b text := trim(coalesce(p_body, ''));
begin
  select * into m from public.incident_messages where id = p_id;
  if m.id is null or m.user_id is distinct from auth.uid() or not public.can_write(m.dept_id) then raise exception 'you can only change your own messages'; end if;
  if m.deleted_at is not null then raise exception 'message was removed'; end if;
  if m.kind = 'text' and b = '' then raise exception 'message is empty'; end if;
  if length(b) > 2000 then raise exception 'message is too long'; end if;
  update public.incident_messages set body = b, edited_at = now() where id = p_id;
end $$;

create or replace function public.delete_chat_message(p_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare m public.incident_messages;
begin
  select * into m from public.incident_messages where id = p_id;
  if m.id is null or not public.is_member(m.dept_id) then raise exception 'message not found'; end if;
  if m.user_id is distinct from auth.uid() and not public.is_officer(m.dept_id) then raise exception 'you can only remove your own messages'; end if;
  update public.incident_messages
    set body = '', media_path = null, lat = null, lng = null, deleted_at = now(), pinned_at = null, pinned_by = null
    where id = p_id;
  delete from public.chat_reactions where message_id = p_id;
  return m.media_path; -- the app removes the file from storage
end $$;

create or replace function public.pin_chat_message(p_id uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
declare m public.incident_messages; n text;
begin
  select * into m from public.incident_messages where id = p_id;
  if m.id is null or not public.can_command(m.dept_id) then raise exception 'only officers can pin messages'; end if;
  if m.deleted_at is not null then raise exception 'message was removed'; end if;
  select name into n from public.members where dept_id = m.dept_id and user_id = auth.uid() and active;
  update public.incident_messages
    set pinned_at = case when p_on then now() end, pinned_by = case when p_on then n end
    where id = p_id;
end $$;

-- ---------- reactions ----------
create table if not exists public.chat_reactions (
  message_id uuid not null references public.incident_messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  dept_id uuid not null references public.departments(id) on delete cascade,
  emoji text not null check (length(emoji) between 1 and 16),
  name text,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
create index if not exists chat_reactions_dept on public.chat_reactions(dept_id);
create or replace function public.chat_reaction_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  select dept_id into new.dept_id from public.incident_messages where id = new.message_id and deleted_at is null;
  if new.dept_id is null then raise exception 'message not found'; end if;
  new.user_id := auth.uid();
  select name into new.name from public.members where dept_id = new.dept_id and user_id = auth.uid() and active;
  return new;
end $$;
drop trigger if exists chat_reactions_before on public.chat_reactions;
create trigger chat_reactions_before before insert on public.chat_reactions
  for each row execute function public.chat_reaction_before_insert();
revoke execute on function public.chat_reaction_before_insert() from public, anon, authenticated;
alter table public.chat_reactions enable row level security;
revoke all on public.chat_reactions from anon, authenticated;
grant select, insert, delete on public.chat_reactions to authenticated;
drop policy if exists react_select on public.chat_reactions;
create policy react_select on public.chat_reactions for select to authenticated using (public.is_member(dept_id));
drop policy if exists react_insert on public.chat_reactions;
create policy react_insert on public.chat_reactions for insert to authenticated
  with check (public.can_write(dept_id) and user_id = auth.uid());
drop policy if exists react_delete on public.chat_reactions;
create policy react_delete on public.chat_reactions for delete to authenticated using (user_id = auth.uid());

-- ---------- read receipts ----------
-- thread is the incident id, or 'station' for station chat.
create table if not exists public.chat_reads (
  dept_id uuid not null references public.departments(id) on delete cascade,
  thread text not null check (thread = 'station' or thread ~ '^[0-9a-f-]{36}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text,
  read_at timestamptz not null default now(),
  primary key (dept_id, thread, user_id)
);
alter table public.chat_reads enable row level security;
revoke all on public.chat_reads from anon, authenticated;
grant select on public.chat_reads to authenticated;
drop policy if exists reads_select on public.chat_reads;
create policy reads_select on public.chat_reads for select to authenticated using (public.is_member(dept_id));

create or replace function public.mark_chat_read(p_dept uuid, p_thread text)
returns void language plpgsql security definer set search_path = public as $$
declare n text;
begin
  select name into n from public.members where dept_id = p_dept and user_id = auth.uid() and active;
  if n is null then raise exception 'not a member'; end if;
  if p_thread <> 'station' and not exists(select 1 from public.incidents where id::text = p_thread and dept_id = p_dept) then
    raise exception 'incident not found';
  end if;
  insert into public.chat_reads(dept_id, thread, user_id, name, read_at) values (p_dept, p_thread, auth.uid(), n, now())
    on conflict (dept_id, thread, user_id) do update set read_at = now(), name = excluded.name;
end $$;

-- ---------- chat alerts setting ----------
alter table public.members add column if not exists chat_alerts boolean not null default true;
grant select (chat_alerts) on public.members to authenticated;
grant update (chat_alerts) on public.members to authenticated;

revoke execute on function public.edit_chat_message(uuid, text) from public, anon;
revoke execute on function public.delete_chat_message(uuid) from public, anon;
revoke execute on function public.pin_chat_message(uuid, boolean) from public, anon;
revoke execute on function public.mark_chat_read(uuid, text) from public, anon;
grant execute on function public.edit_chat_message(uuid, text) to authenticated;
grant execute on function public.delete_chat_message(uuid) to authenticated;
grant execute on function public.pin_chat_message(uuid, boolean) to authenticated;
grant execute on function public.mark_chat_read(uuid, text) to authenticated;

alter publication supabase_realtime add table public.chat_reactions, public.chat_reads;

-- ---------- photo and voice files ----------
create or replace function public.try_uuid(t text)
returns uuid language plpgsql immutable as $$
begin
  return t::uuid;
exception when others then
  return null;
end $$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat', 'chat', false, 12582912,
  array['image/jpeg', 'image/png', 'image/webp', 'audio/mp4', 'audio/aac', 'audio/x-m4a', 'audio/webm', 'audio/ogg', 'audio/mpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "chat files: members read" on storage.objects;
create policy "chat files: members read" on storage.objects for select to authenticated
  using (bucket_id = 'chat' and public.is_member(public.try_uuid((storage.foldername(name))[1])));
drop policy if exists "chat files: members add their own" on storage.objects;
create policy "chat files: members add their own" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'chat'
    and public.can_write(public.try_uuid((storage.foldername(name))[1]))
    and (storage.foldername(name))[2] = auth.uid()::text
  );
drop policy if exists "chat files: remove your own" on storage.objects;
create policy "chat files: remove your own" on storage.objects for delete to authenticated
  using (bucket_id = 'chat' and (storage.foldername(name))[2] = auth.uid()::text);

-- ---------- plans ----------
alter table public.departments
  add column if not exists plan_amount numeric(10, 2) check (plan_amount is null or plan_amount >= 0),
  add column if not exists plan_custom boolean not null default false;
grant select (plan_amount, plan_custom) on public.departments to authenticated;
