import { useState } from 'react';
import { supabase } from '../lib/supabase';

export default function Auth() {
  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const submit = async () => {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { full_name: name || email.split('@')[0] } },
        });
        if (error) throw error;
        setNotice('Аккаунт создан. Если Supabase требует подтверждение почты — проверьте письмо.');
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const google = async () => {
    setError('');
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
    if (error) setError(error.message);
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo">SC</div>
        <h1>С возвращением</h1>
        <p className="muted">Войдите, чтобы писать и звонить контактам</p>

        <button className="btn google" onClick={google}>
          Продолжить с Google
        </button>

        <div className="divider">или по email</div>

        <div className="tabs">
          <button className={mode === 'signin' ? 'tab active' : 'tab'} onClick={() => setMode('signin')}>
            Вход
          </button>
          <button className={mode === 'signup' ? 'tab active' : 'tab'} onClick={() => setMode('signup')}>
            Регистрация
          </button>
        </div>

        {mode === 'signup' && (
          <label>
            Имя
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Как вас видят другие" />
          </label>
        )}

        <label>
          Email
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@mail.ru" />
        </label>

        <label>
          Пароль
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Минимум 6 символов"
          />
        </label>

        {error && <div className="error">{error}</div>}
        {notice && <div className="notice">{notice}</div>}

        <button className="btn primary" onClick={submit} disabled={busy || !email || !password}>
          {busy ? 'Секунду…' : mode === 'signup' ? 'Создать аккаунт' : 'Войти'}
        </button>
      </div>
    </div>
  );
}
