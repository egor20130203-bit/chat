-- Ники: заполняем пустые и делаем уникальными
-- Выполнить в Supabase: SQL Editor -> New query -> Run

update public.profiles
set username = split_part(email, '@', 1)
where username is null or trim(username) = '';

-- Если ники совпали — добавляем номер
with d as (
  select id, username,
         row_number() over (partition by lower(username) order by created_at) as rn
  from public.profiles
)
update public.profiles p
set username = p.username || d.rn::text
from d
where p.id = d.id and d.rn > 1;

create unique index if not exists profiles_username_lower_idx
  on public.profiles (lower(username));
