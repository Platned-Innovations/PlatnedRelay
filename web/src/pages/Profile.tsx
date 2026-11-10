import { useState } from 'react';
import { LogOut, ShieldCheck, ShieldOff } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useAction, useApi } from '../hooks';
import type { SessionInfo } from '../types';
import { Alert, Badge, Card, CopyButton, ErrorState, FormField, KV, Loading, PageHeader, Spinner } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { ConfirmDialog, Modal } from '../components/Modal';
import { fmtDate, fmtRelative } from '../format';
import { ChangePasswordForm } from './ChangePassword';

function MfaSetup({ onDone }: { onDone: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const { busy, run } = useAction();
  if (codes)
    return (
      <Modal open dismissible={false} title="Save your recovery codes" onClose={() => { setCodes(null); onDone(); }} footer={<button className="btn btn-primary" onClick={() => { setCodes(null); onDone(); }}>I have saved them</button>}>
        <Alert tone="warning" title="These codes are shown only once">
          Each code can be used once to sign in if you lose your authenticator. Store them in a password manager.
        </Alert>
        <div className="kbd-list mt-2">
          {codes.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
        <div className="mt-2">
          <CopyButton text={codes.join('\n')} label="Copy all codes" />
        </div>
      </Modal>
    );
  if (!setup)
    return (
      <button className="btn btn-primary" disabled={busy} onClick={() => run(async () => setSetup(await api.post('/api/admin/auth/mfa/setup')))}>
        {busy ? <Spinner size={14} /> : <ShieldCheck size={14} />} Set up authenticator app
      </button>
    );
  return (
    <div className="row top" style={{ gap: 20 }}>
      <img className="qr" src={setup.qrDataUrl} alt="QR code for authenticator app" />
      <div className="grow" style={{ minWidth: 240 }}>
        <ol className="small text-2" style={{ paddingLeft: 18, marginTop: 0 }}>
          <li>Scan the QR code with an authenticator app (Microsoft Authenticator, 1Password, Google Authenticator…).</li>
          <li>Or enter this secret manually:</li>
        </ol>
        <div className="secret-box">
          <span>{setup.secret}</span>
          <CopyButton text={setup.secret} small />
        </div>
        <FormField label="6-digit code from the app" className="mt-2">
          <input className="input mono" style={{ maxWidth: 180 }} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\s/g, ''))} />
        </FormField>
        <button
          className="btn btn-primary mt-2"
          disabled={busy || code.length < 6}
          onClick={() =>
            run(async () => {
              const r = await api.post<{ recoveryCodes: string[] }>('/api/admin/auth/mfa/enable', { code });
              setCodes(r.recoveryCodes);
            }, 'MFA enabled')
          }
        >
          {busy && <Spinner size={14} />} Verify & enable
        </button>
      </div>
    </div>
  );
}

function DisableMfa({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const { busy, run } = useAction();
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>
        <ShieldOff size={14} /> Disable MFA
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="sm"
        title="Disable MFA"
        footer={
          <>
            <button className="btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              disabled={busy || !password || code.length < 6}
              onClick={() =>
                run(async () => {
                  await api.post('/api/admin/auth/mfa/disable', { password, code });
                  setOpen(false);
                  setPassword('');
                  setCode('');
                  onDone();
                }, 'MFA disabled')
              }
            >
              Disable
            </button>
          </>
        }
      >
        <p className="small text-2">Confirm with your password and a current authenticator (or recovery) code.</p>
        <FormField label="Password">
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </FormField>
        <FormField label="Code">
          <input className="input mono" value={code} autoComplete="one-time-code" onChange={(e) => setCode(e.target.value.trim())} />
        </FormField>
      </Modal>
    </>
  );
}

export default function Profile() {
  const { user, refresh } = useAuth();
  const partial = !!user?.mfaEnrollmentRequired;
  const sessions = useApi<SessionInfo[]>(partial ? null : '/api/admin/auth/sessions');
  const [revoke, setRevoke] = useState<SessionInfo | null>(null);
  if (!user) return <Loading />;

  const cols: Column<SessionInfo>[] = [
    { key: 'userAgent', header: 'Device', render: (s) => <div><div className="truncate small" title={s.userAgent} style={{ maxWidth: 360 }}>{s.userAgent ?? 'Unknown'}</div>{s.current && <Badge tone="success">this session</Badge>}</div> },
    { key: 'ip', header: 'IP', render: (s) => <span className="mono small">{s.ip ?? '-'}</span> },
    { key: 'createdAt', header: 'Signed in', render: (s) => fmtDate(s.createdAt) },
    { key: 'lastSeenAt', header: 'Last active', render: (s) => fmtRelative(s.lastSeenAt) },
    { key: 'expiresAt', header: 'Expires', hideSm: true, render: (s) => fmtDate(s.expiresAt) },
    {
      key: 'actions',
      header: '',
      sortable: false,
      className: 'actions',
      render: (s) =>
        !s.current && (
          <button className="btn btn-sm" onClick={() => setRevoke(s)}>
            <LogOut size={13} /> Revoke
          </button>
        ),
    },
  ];

  return (
    <>
      <PageHeader title="Profile & security" subtitle="Your account, password, two-factor authentication and active sessions." />
      {partial && (
        <div className="mb-2">
          <Alert tone="warning" title="Two-factor authentication is required">
            Your organisation requires MFA. Set up an authenticator app below to continue using the console.
          </Alert>
        </div>
      )}
      <div className="grid grid-2">
        <Card title="Account">
          <KV
            items={[
              ['Name', user.name],
              ['Username', user.username],
              ['Email', user.email],
              ['Role', <Badge key="r" tone={user.role === 'owner' ? 'info' : user.role === 'admin' ? 'success' : 'neutral'}>{user.role}</Badge>],
              ['MFA', user.mfaEnabled ? <Badge tone="success">enabled</Badge> : <Badge tone="warning">not enabled</Badge>],
            ]}
          />
          <p className="hint mt-2">Ask an administrator to change your name, email or role.</p>
        </Card>
        <Card title="Two-factor authentication">
          {user.mfaEnabled ? (
            <div className="stack" style={{ gap: 10 }}>
              <Alert tone="success">MFA is enabled. You will be asked for a code at each sign-in.</Alert>
              <div>
                <DisableMfa onDone={() => void refresh()} />
              </div>
            </div>
          ) : (
            <>
              <p className="small text-2">Protect your account with a time-based one-time code (TOTP) from an authenticator app.</p>
              <MfaSetup onDone={() => void refresh()} />
            </>
          )}
        </Card>
      </div>
      {!partial && (
        <>
          <Card title="Change password" className="mt-2">
            <div style={{ maxWidth: 420 }}>
              <ChangePasswordForm onDone={() => { void refresh(); sessions.reload(); }} />
            </div>
          </Card>
          <Card title="Active sessions" flush className="mt-2">
            {sessions.error ? <ErrorState error={sessions.error} onRetry={sessions.reload} /> : !sessions.data ? <Loading /> : <DataTable columns={cols} rows={sessions.data} rowKey={(s) => s.id} emptyTitle="No active sessions" compact />}
          </Card>
        </>
      )}
      <ConfirmDialog
        open={!!revoke}
        title="Revoke session?"
        message="That device will be signed out immediately."
        confirmLabel="Revoke"
        danger
        onConfirm={async () => {
          await api.del(`/api/admin/auth/sessions/${revoke!.id}`);
          sessions.reload();
        }}
        onClose={() => setRevoke(null)}
      />
    </>
  );
}
