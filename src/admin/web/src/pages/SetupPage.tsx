import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { setupSchema } from '@shared/schemas';
import { LogoLockup } from '@/components/Logo';
import { useSetup } from '@/hooks/use-auth';
import { ApiError } from '@/lib/api';

export function SetupPage() {
  const navigate = useNavigate();
  const setup = useSetup();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = setupSchema.safeParse({ username, password, setup_token: setupToken });
    if (!parsed.success || !setupToken) {
      setError('Укажите setup-токен, логин (3+ символа) и пароль (8+).');
      return;
    }
    try {
      await setup.mutateAsync({ username, password, setup_token: setupToken });
      navigate('/');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'setup_closed') {
        setError('Настройка уже завершена. Войдите.');
        return;
      }
      if (err instanceof ApiError && err.code === 'invalid_setup_token') {
        setError('Неверный setup-токен. Скопируйте его из логов сервера.');
        return;
      }
      setError('Не удалось создать первого оператора.');
    }
  }

  return (
    <div className="login-form-side" style={{ minHeight: '100vh' }}>
      <div className="login-form">
        <div className="row" style={{ gap: 10, marginBottom: 28 }}>
          <LogoLockup />
        </div>
        <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em' }}>Первый запуск</h1>
        <p className="muted" style={{ marginTop: 6, marginBottom: 24 }}>
          Создайте первого оператора. Setup-токен напечатан в логах сервера.
        </p>
        <form onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="setup-token">Setup-токен</label>
            <input id="setup-token" className="input mono" autoComplete="off" value={setupToken} onChange={(e) => setSetupToken(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="username">Логин</label>
            <input id="username" className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="password">Пароль</label>
            <input id="password" className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && <p style={{ color: 'var(--danger-fg)', fontSize: 13, marginBottom: 14 }}>{error}</p>}
          <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={setup.isPending}>
            {setup.isPending ? 'Создаём…' : 'Создать оператора'}
          </button>
        </form>
      </div>
    </div>
  );
}
