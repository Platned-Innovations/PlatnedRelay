import { useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Zap } from 'lucide-react';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Alert, FormField, IssueList, Spinner } from '../components/ui';

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="brand-line">
          <span className="brand-mark">
            <Zap size={15} />
          </span>
          Relay LLM Gateway
        </div>
        {children}
      </div>
    </div>
  );
}

function safeNext(next: string | null) {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login') ? next : '/';
}

export default function Login() {
  const { status, user, refresh } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get('next'));
  const [step, setStep] = useState<'password' | 'mfa'>('password');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  if (status === 'ready' && user && step === 'password' && !busy) return <Navigate to={next} replace />;

  const finish = async () => {
    const me = await refresh();
    if (me?.mustChangePassword) navigate('/change-password', { replace: true });
    else if (me?.mfaEnrollmentRequired) navigate('/profile', { replace: true });
    else navigate(next, { replace: true });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (step === 'password') {
        const r = await api.post<{ mfaRequired: boolean }>('/api/admin/auth/login', { username: username.trim(), password }, { noAuthRedirect: true });
        if (r.mfaRequired) {
          setStep('mfa');
          setBusy(false);
          return;
        }
      } else {
        await api.post('/api/admin/auth/mfa', { code: code.replace(/\s+/g, '') }, { noAuthRedirect: true });
      }
      await finish();
    } catch (err) {
      setError(err as Error);
      if (step === 'mfa' && err instanceof ApiError && err.status === 401) {
        setStep('password');
        setCode('');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <h1>{step === 'password' ? 'Sign in' : 'Two-factor authentication'}</h1>
      <p className="muted">{step === 'password' ? 'Use your Relay admin account.' : 'Enter the 6-digit code from your authenticator app, or a recovery code.'}</p>
      {error && (
        <div className="mt-2">
          <Alert tone="danger">
            {error.message}
            <IssueList issues={error instanceof ApiError ? error.issues : undefined} />
          </Alert>
        </div>
      )}
      <form onSubmit={submit} className="mt-2">
        {step === 'password' ? (
          <>
            <FormField label="Username or email" htmlFor="u">
              <input id="u" className="input" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} required />
            </FormField>
            <FormField label="Password" htmlFor="p">
              <input id="p" type="password" className="input" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </FormField>
          </>
        ) : (
          <FormField label="Authentication code" htmlFor="c">
            <input id="c" className="input mono" inputMode="text" autoComplete="one-time-code" autoFocus value={code} onChange={(e) => setCode(e.target.value)} required minLength={6} maxLength={20} />
          </FormField>
        )}
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy && <Spinner size={14} />} {step === 'password' ? 'Sign in' : 'Verify'}
        </button>
        {step === 'mfa' && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setStep('password');
              setCode('');
              setError(null);
            }}
          >
            Back
          </button>
        )}
      </form>
    </AuthShell>
  );
}
