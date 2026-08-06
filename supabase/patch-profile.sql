-- Дополнение к схеме: ник и строка активности
-- Выполнить в Supabase: SQL Editor -> New query -> Run

alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists activity text;

-- Ник по умолчанию — из email
update public.profiles
set username = split_part(email, '@', 1)
where username is null;
