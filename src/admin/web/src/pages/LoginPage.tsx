import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { loginSchema } from '@shared/schemas';
import { LogoLockup, LogoMark } from '@/components/Logo';
import { useLogin } from '@/hooks/use-auth';
import { ApiError } from '@/lib/api';

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Неверный логин или пароль.',
  totp_invalid: 'Код аутентификации не подошёл.',
  disabled: 'Учётная запись отключена.',
  invalid_input: 'Проверьте поля и попробуйте снова.',
};

export function LoginPage() {
  const navigate = useNavigate();
  const login = useLogin();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [totpRequired, setTotpRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = loginSchema.safeParse({ username, password, totp: totp || undefined });
    if (!parsed.success) {
      setError('Логин — от 3 символов, пароль — от 8.');
      return;
    }
    try {
      await login.mutateAsync(parsed.data);
      navigate('/');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'totp_required') {
        setTotpRequired(true);
        setError('Введите код из приложения-аутентификатора.');
        return;
      }
      setError(err instanceof ApiError ? (MESSAGES[err.code] ?? err.code) : 'Не удалось войти.');
    }
  }

  return (
    <div className="login">
      <div className="login-form-side">
        <div className="login-form">
          <div className="row" style={{ gap: 10, marginBottom: 28 }}>
            <LogoLockup />
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em' }}>Вход в консоль</h1>
          <p className="muted" style={{ marginTop: 6, marginBottom: 24 }}>Управление общей памятью ваших агентов.</p>

          <form onSubmit={onSubmit}>
            <div className="field">
              <label htmlFor="username">Логин</label>
              <input
                id="username"
                className="input"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="password">Пароль</label>
              <input
                id="password"
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {totpRequired && (
              <div className="field">
                <label htmlFor="totp">Код аутентификации</label>
                <input
                  id="totp"
                  className="input mono"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={totp}
                  onChange={(e) => setTotp(e.target.value)}
                />
              </div>
            )}
            {error && <p style={{ color: 'var(--danger-fg)', fontSize: 13, marginBottom: 14 }}>{error}</p>}
            <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={login.isPending}>
              {login.isPending ? 'Входим…' : 'Войти'}
            </button>
          </form>
        </div>
      </div>
      <div className="login-art">
        <div style={{ position: 'relative', zIndex: 1, textAlign: 'center' }}>
          <LogoMark palette="onDark" width={120} />
          <div
            style={{
              fontFamily: 'var(--font-head)',
              color: '#EDEFF2',
              fontSize: 22,
              fontWeight: 700,
              marginTop: 24,
              letterSpacing: '-0.02em',
            }}
          >
            Единая память для ваших ИИ-агентов
          </div>
          <p style={{ color: '#9AA2AE', marginTop: 10, maxWidth: 320 }}>
            Контекст, который не теряется между сессиями. В вашем контуре.
          </p>
        </div>
      </div>
    </div>
  );
}
