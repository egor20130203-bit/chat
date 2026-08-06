-- Вложения в сообщениях + хранилище файлов
-- Выполнить в Supabase: SQL Editor -> New query -> Run

alter table public.messages add column if not exists attachment_url text;
alter table public.messages add column if not exists attachment_name text;
alter table public.messages add column if not exists attachment_size bigint;
alter table public.messages add column if not exists attachment_type text;

-- Сообщение может быть без текста, если это файл
alter table public.messages alter column content drop not null;

-- Хранилище
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', true)
on conflict (id) do nothing;

drop policy if exists "attachments_read" on storage.objects;
create policy "attachments_read" on storage.objects
  for select using (bucket_id = 'attachments');

drop policy if exists "attachments_upload" on storage.objects;
create policy "attachments_upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "attachments_delete" on storage.objects;
create policy "attachments_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);
