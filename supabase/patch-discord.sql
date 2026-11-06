-- ============================================
-- Scalable Chat — новые функции (редактирование/удаление сообщений, аватарки)
-- Выполнить целиком в Supabase: SQL Editor -> New query -> Run
-- ============================================

-- Колонка «сообщение изменено»
alter table public.messages add column if not exists edited_at timestamptz;

-- Редактировать и удалять можно только свои сообщения
drop policy if exists messages_update on public.messages;
create policy messages_update on public.messages
  for update to authenticated using (auth.uid() = sender_id);

drop policy if exists messages_delete on public.messages;
create policy messages_delete on public.messages
  for delete to authenticated using (auth.uid() = sender_id);

-- Чтобы собеседник видел правки и удаления вживую
alter table public.messages replica identity full;

-- Колонка с аватаркой
alter table public.profiles add column if not exists avatar_url text;

-- Хранилище аватарок (публичное чтение, загрузка — только в свою папку)
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists avatars_read on storage.objects;
create policy avatars_read on storage.objects
  for select to authenticated using (bucket_id = 'avatars');

drop policy if exists avatars_upload on storage.objects;
create policy avatars_upload on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists avatars_update on storage.objects;
create policy avatars_update on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);
