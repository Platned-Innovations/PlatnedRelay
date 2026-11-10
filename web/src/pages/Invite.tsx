import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { Alert, FormField, IssueList, Loading, Spinner } from '../components/ui';
import { AuthShell } from './Login';

export default function Invite() {
  const { token = '' } = useParams();
  const [info, setInfo] = useState<{ username: string; email: string; name: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api
      .get<{ username: string; email: string; name: string }>(`/api/admin/auth/invite/${encodeURIComponent(token)}`, { noAuthRedirect: true })
      .then(setInfo)
      .catch((e) => setLoadError((e as Error).message));
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError(new Error('Passwords do not match'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/admin/auth/invite/accept', { token, password }, { noAuthRedirect: true });
      setDone(true);
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <h1>Set your password</h1>
      {loadError ? (
        <div className="mt-2">
          <Alert tone="danger" title="Invitation unavailable">
            {loadError} Ask an administrator for a new link.
          </Alert>
          <p className="mt-2">
            <Link to="/login">Go to sign in</Link>
          </p>
        </div>
      ) : !info ? (
        <Loading />
      ) : done ? (
        <div className="mt-2">
          <Alert tone="success" title="Password set">
            Your account is ready. Sign in with username <strong>{info.username}</strong>.
          </Alert>
          <Link to="/login" className="btn btn-primary">
            Sign in
          </Link>
        </div>
      ) : (
        <>
          <p className="muted">
            Welcome, {info.name}. Choose a password for <strong>{info.username}</strong> ({info.email}).
          </p>
          {error && (
            <Alert tone="danger">
              {error.message}
              <IssueList issues={error instanceof ApiError ? error.issues : undefined} />
            </Alert>
          )}
          <form onSubmit={submit} className="mt-2">
            <input type="text" autoComplete="username" value={info.username} readOnly hidden />
            <FormField label="New password" hint="Use a long passphrase; the policy minimum length is enforced by the server.">
              <input type="password" className="input" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
            </FormField>
            <FormField label="Confirm password">
              <input type="password" className="input" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </FormField>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy && <Spinner size={14} />} Set password
            </button>
          </form>
        </>
      )}
    </AuthShell>
  );
}
