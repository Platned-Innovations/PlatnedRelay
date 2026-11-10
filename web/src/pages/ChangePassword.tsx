import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Alert, FormField, IssueList, Spinner } from '../components/ui';
import { toast } from '../components/Toasts';
import { AuthShell } from './Login';

export function ChangePasswordForm({ onDone }: { onDone: () => void }) {
  const { user } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) {
      setError(new Error('New passwords do not match'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/admin/auth/change-password', { currentPassword: current, newPassword: next });
      toast.success('Password changed');
      setCurrent('');
      setNext('');
      setConfirm('');
      onDone();
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      {error && (
        <div className="mb-2">
          <Alert tone="danger">
            {error.message}
            <IssueList issues={error instanceof ApiError ? error.issues : undefined} />
          </Alert>
        </div>
      )}
      <input type="text" autoComplete="username" value={user?.username ?? ''} readOnly hidden />
      <FormField label="Current password">
        <input type="password" className="input" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </FormField>
      <FormField label="New password" hint="Must satisfy the password policy (minimum length, not containing your username).">
        <input type="password" className="input" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
      </FormField>
      <FormField label="Confirm new password">
        <input type="password" className="input" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </FormField>
      <button className="btn btn-primary mt-2" type="submit" disabled={busy}>
        {busy && <Spinner size={14} />} Change password
      </button>
    </form>
  );
}

export default function ChangePassword() {
  const { refresh, user, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <AuthShell>
      <h1>Change your password</h1>
      <p className="muted">{user?.mustChangePassword ? 'You must set a new password before continuing.' : 'Update the password for your account.'}</p>
      <ChangePasswordForm
        onDone={async () => {
          const me = await refresh();
          navigate(me?.mfaEnrollmentRequired ? '/profile' : '/', { replace: true });
        }}
      />
      <button
        className="btn btn-ghost"
        type="button"
        onClick={async () => {
          await logout();
          navigate('/login', { replace: true });
        }}
      >
        Sign out
      </button>
    </AuthShell>
  );
}
