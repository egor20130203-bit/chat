import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('Нет ключей Supabase. Создайте файл .env по образцу .env.example');
}

export const supabase = createClient(url ?? '', key ?? '', {
  auth: { persistSession: true, autoRefreshToken: true },
});
