import { supabase } from './supabase';

// Supabase не принимает файл больше 50 МБ за раз — режем большие на куски.
// Для получателя файл склеивается обратно автоматически при скачивании.
export const DIRECT_LIMIT_MB = 50;
const CHUNK = 45 * 1024 * 1024;

// Возвращает поля для сообщения: { url, name, size, type }
// onProgress(pct) — 0..100
export async function uploadAttachment(userId, file, onProgress) {
  const safe = file.name.replace(/[^\w.\-]+/g, '_');
  const base = `${userId}/${Date.now()}_${safe}`;

  // Маленький файл — как раньше, одним куском
  if (file.size <= DIRECT_LIMIT_MB * 1024 * 1024) {
    const { error } = await supabase.storage
      .from('attachments')
      .upload(base, file, { cacheControl: '3600', upsert: false });
    if (error) throw error;
    const { data: pub } = supabase.storage.from('attachments').getPublicUrl(base);
    onProgress?.(100);
    return { url: pub.publicUrl, name: file.name, size: file.size, type: file.type };
  }

  // Большой — по кускам + manifest со списком кусков
  const parts = Math.ceil(file.size / CHUNK);
  const partPaths = [];
  for (let i = 0; i < parts; i++) {
    const blob = file.slice(i * CHUNK, (i + 1) * CHUNK);
    const p = `${base}.part${String(i).padStart(3, '0')}`;
    const { error } = await supabase.storage
      .from('attachments')
      .upload(p, blob, { cacheControl: '3600', upsert: false });
    if (error) throw error;
    partPaths.push(p);
    onProgress?.(Math.round(((i + 1) / (parts + 1)) * 100));
  }

  const manifest = { v: 1, name: file.name, size: file.size, type: file.type || 'application/octet-stream', parts: partPaths };
  const manifestPath = `${base}.scpart.json`;
  const { error: mErr } = await supabase.storage
    .from('attachments')
    .upload(manifestPath, new Blob([JSON.stringify(manifest)], { type: 'application/json' }), {
      cacheControl: '3600',
      upsert: false,
    });
  if (mErr) throw mErr;
  const { data: pub } = supabase.storage.from('attachments').getPublicUrl(manifestPath);
  onProgress?.(100);
  // Префикс chunked: — чтобы получатель понял, что файл надо склеить
  return { url: pub.publicUrl, name: file.name, size: file.size, type: 'chunked:' + manifest.type };
}

// Скачивает большой файл: тянет manifest, потом куски, склеивает и сохраняет
export async function downloadChunked(manifestUrl, onProgress) {
  const res = await fetch(manifestUrl);
  if (!res.ok) throw new Error('не скачалось описание файла');
  const manifest = await res.json();
  if (!manifest.parts?.length) throw new Error('битое описание файла');

  const blobs = [];
  for (let i = 0; i < manifest.parts.length; i++) {
    const { data: pub } = supabase.storage.from('attachments').getPublicUrl(manifest.parts[i]);
    const r = await fetch(pub.publicUrl);
    if (!r.ok) throw new Error(`кусок ${i + 1} не скачался`);
    blobs.push(await r.blob());
    onProgress?.(Math.round(((i + 1) / manifest.parts.length) * 100));
  }

  const blob = new Blob(blobs, { type: manifest.type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = manifest.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
