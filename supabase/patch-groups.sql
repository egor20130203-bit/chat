-- ============================================
-- Scalable Chat — групповые чаты и групповые звонки
-- Выполнить целиком в Supabase: SQL Editor -> New query -> Run
-- ============================================

-- ---------- Группы ----------
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz default now()
);

create table if not exists public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz default now(),
  primary key (room_id, user_id)
);

create table if not exists public.room_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  content text not null default '',
  attachment_url text,
  attachment_name text,
  attachment_size bigint,
  attachment_type text,
  created_at timestamptz default now(),
  edited_at timestamptz
);

alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.room_messages enable row level security;

-- Функции-помощники с security definer: проверяют членство/владение,
-- не запуская RLS повторно (иначе политики зацикливаются сами на себя)
create or replace function public.is_room_member(p_room uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists(
    select 1 from public.room_members
    where room_id = p_room and user_id = auth.uid()
  );
$$;

create or replace function public.is_room_owner(p_room uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists(
    select 1 from public.rooms
    where id = p_room and owner_id = auth.uid()
  );
$$;

-- Группы видят владелец и участники
drop policy if exists rooms_select on public.rooms;
create policy rooms_select on public.rooms
  for select to authenticated
  using (owner_id = auth.uid() or public.is_room_member(id));

-- Создать группу может любой (он же владелец)
drop policy if exists rooms_insert on public.rooms;
create policy rooms_insert on public.rooms
  for insert to authenticated with check (auth.uid() = owner_id);

-- Название меняет владелец, удаляет тоже
drop policy if exists rooms_update on public.rooms;
create policy rooms_update on public.rooms
  for update to authenticated using (auth.uid() = owner_id);

drop policy if exists rooms_delete on public.rooms;
create policy rooms_delete on public.rooms
  for delete to authenticated using (auth.uid() = owner_id);

-- Участников видят участники той же группы
drop policy if exists room_members_select on public.room_members;
create policy room_members_select on public.room_members
  for select to authenticated
  using (public.is_room_member(room_id) or public.is_room_owner(room_id));

-- Добавлять может владелец; вступить может сам пользователь
drop policy if exists room_members_insert on public.room_members;
create policy room_members_insert on public.room_members
  for insert to authenticated
  with check (auth.uid() = user_id or public.is_room_owner(room_id));

-- Выйти может сам участник или его может убрать владелец
drop policy if exists room_members_delete on public.room_members;
create policy room_members_delete on public.room_members
  for delete to authenticated
  using (auth.uid() = user_id or public.is_room_owner(room_id));

-- Сообщения: читают и пишут участники
drop policy if exists room_messages_select on public.room_messages;
create policy room_messages_select on public.room_messages
  for select to authenticated
  using (public.is_room_member(room_id));

drop policy if exists room_messages_insert on public.room_messages;
create policy room_messages_insert on public.room_messages
  for insert to authenticated
  with check (auth.uid() = sender_id and public.is_room_member(room_id));

drop policy if exists room_messages_update on public.room_messages;
create policy room_messages_update on public.room_messages
  for update to authenticated using (auth.uid() = sender_id);

drop policy if exists room_messages_delete on public.room_messages;
create policy room_messages_delete on public.room_messages
  for delete to authenticated using (auth.uid() = sender_id);

alter table public.room_messages replica identity full;

create index if not exists room_messages_room_idx
  on public.room_messages (room_id, created_at);

-- Реалтайм для групповых сообщений
do $$
begin
  alter publication supabase_realtime add table public.room_messages;
exception
  when duplicate_object then null;
end $$;
