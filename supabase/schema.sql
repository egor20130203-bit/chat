-- ============================================
-- Scalable Chat — схема базы
-- Выполнить целиком в Supabase: SQL Editor -> New query -> Run
-- ============================================

-- ---------- Профили ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text unique not null,
  display_name text not null,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (true);

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert to authenticated with check (auth.uid() = id);

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated using (auth.uid() = id);

-- Профиль создаётся сам при регистрации
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data->>'full_name',
      new.raw_user_meta_data->>'name',
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Контакты ----------
create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  contact_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending',
  created_at timestamptz default now(),
  unique (user_id, contact_id)
);

alter table public.contacts enable row level security;

drop policy if exists contacts_select on public.contacts;
create policy contacts_select on public.contacts
  for select to authenticated
  using (auth.uid() = user_id or auth.uid() = contact_id);

drop policy if exists contacts_insert on public.contacts;
create policy contacts_insert on public.contacts
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists contacts_update on public.contacts;
create policy contacts_update on public.contacts
  for update to authenticated
  using (auth.uid() = user_id or auth.uid() = contact_id);

drop policy if exists contacts_delete on public.contacts;
create policy contacts_delete on public.contacts
  for delete to authenticated
  using (auth.uid() = user_id or auth.uid() = contact_id);

-- ---------- Сообщения ----------
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  content text not null,
  created_at timestamptz default now()
);

alter table public.messages enable row level security;

drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages
  for select to authenticated
  using (auth.uid() = sender_id or auth.uid() = recipient_id);

drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages
  for insert to authenticated with check (auth.uid() = sender_id);

create index if not exists messages_pair_idx
  on public.messages (sender_id, recipient_id, created_at);

-- Доставка сообщений в реальном времени
do $$
begin
  alter publication supabase_realtime add table public.messages;
exception
  when duplicate_object then null;
end $$;
