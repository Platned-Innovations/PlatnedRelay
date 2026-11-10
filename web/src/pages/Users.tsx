import { useEffect, useState } from 'react';
import { KeyRound, Lock, Pencil, Power, ShieldOff, UserPlus } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useAction, useApi } from '../hooks';
import type { AdminUser, Role } from '../types';
import { Alert, Badge, Checkbox, CopyButton, ErrorState, FormField, Loading, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { ConfirmDialog, Modal } from '../components/Modal';
import { fmtDate, fmtRelative } from '../format';

function LinkModal({ link, onClose }: { link: { url: string; expiresAt: string; title: string; emailed: boolean } | null; onClose: () => void }) {
  if (!link) return null;
  return (
    <Modal open title={link.title} onClose={onClose} footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
      <Alert tone={link.emailed ? 'info' : 'warning'}>
        {link.emailed ? 'An email with this link was sent (if notifications are configured). You can also share it directly.' : 'No email was sent. Share this link with the user through a trusted channel.'} It expires {fmtDate(link.expiresAt)}.
      </Alert>
      <div className="secret-box mt-2">
        <span>{link.url.startsWith('http') ? link.url : `${window.location.origin}${link.url}`}</span>
        <CopyButton text={link.url.startsWith('http') ? link.url : `${window.location.origin}${link.url}`} label="Copy" />
      </div>
      {!link.url.startsWith('http') && <p className="hint mt-1">Tip: set Settings › Gateway › Public base URL so emailed links are absolute.</p>}
    </Modal>
  );
}

function InviteModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (url: string, expiresAt: string, emailed: boolean) => void }) {
  const { isOwner } = useAuth();
  const [f, setF] = useState({ username: '', email: '', name: '', role: 'viewer' as Role, sendEmail: true });
  const { busy, run } = useAction();
  useEffect(() => {
    if (open) setF({ username: '', email: '', name: '', role: 'viewer', sendEmail: true });
  }, [open]);
  const usernameOk = /^[a-zA-Z0-9._-]{3,60}$/.test(f.username);
  const save = () =>
    run(async () => {
      const r = await api.post<{ inviteUrl: string; expiresAt: string }>('/api/admin/users', { ...f, username: f.username.trim(), email: f.email.trim(), name: f.name.trim() });
      onClose();
      onDone(r.inviteUrl, r.expiresAt, f.sendEmail);
    }, 'User invited');
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Invite user"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !usernameOk || !f.email.includes('@') || !f.name.trim()} onClick={save}>
            {busy && <Spinner size={14} />} Send invite
          </button>
        </>
      }
    >
      <div className="form-grid">
        <FormField label="Username" required hint="3-60 chars: letters, digits, . _ -" error={f.username && !usernameOk ? 'Invalid username' : undefined}>
          <input className="input" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoFocus />
        </FormField>
        <FormField label="Full name" required>
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </FormField>
        <FormField label="Email" required>
          <input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </FormField>
        <FormField label="Role">
          <select className="select" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>
            <option value="viewer">Viewer - read only</option>
            <option value="admin">Admin - manage configuration</option>
            {isOwner && <option value="owner">Owner - full control incl. security</option>}
          </select>
        </FormField>
        <FormField className="span-2">
          <Checkbox checked={f.sendEmail} onChange={(v) => setF({ ...f, sendEmail: v })} label="Email the invitation link" />
        </FormField>
      </div>
    </Modal>
  );
}

function EditUserModal({ user, onClose, onSaved }: { user: AdminUser | null; onClose: () => void; onSaved: () => void }) {
  const { isOwner, user: me } = useAuth();
  const [f, setF] = useState({ name: '', email: '', role: 'viewer' as Role });
  const { busy, run } = useAction();
  useEffect(() => {
    if (user) setF({ name: user.name, email: user.email, role: user.role });
  }, [user]);
  if (!user) return null;
  const self = me?.id === user.id;
  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${user.username}`}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !f.name.trim()}
            onClick={() =>
              run(async () => {
                const body: Record<string, unknown> = { name: f.name.trim(), email: f.email.trim() };
                if (f.role !== user.role) body.role = f.role;
                await api.patch(`/api/admin/users/${user.id}`, body);
                onSaved();
                onClose();
              }, 'User updated')
            }
          >
            Save
          </button>
        </>
      }
    >
      <FormField label="Full name">
        <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </FormField>
      <FormField label="Email">
        <input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
      </FormField>
      <FormField label="Role" hint={self ? 'You cannot change your own role.' : 'Changing the role signs the user out of all sessions.'}>
        <select className="select" value={f.role} disabled={self || (user.role === 'owner' && !isOwner)} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>
          <option value="viewer">Viewer</option>
          <option value="admin">Admin</option>
          {(isOwner || user.role === 'owner') && <option value="owner">Owner</option>}
        </select>
      </FormField>
    </Modal>
  );
}

type UAction = 'disable' | 'enable' | 'reset-access' | 'unlock' | 'reset-mfa';

function RowActions({ u, onAction, onEdit }: { u: AdminUser; onAction: (a: UAction) => void; onEdit: () => void }) {
  const { isOwner, user: me } = useAuth();
  const self = me?.id === u.id;
  if (u.role === 'owner' && !isOwner) return <span className="muted small">owner only</span>;
  return (
    <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap', gap: 4 }}>
      <button className="btn btn-sm btn-icon" title="Edit" aria-label="Edit" onClick={onEdit}>
        <Pencil size={13} />
      </button>
      <button className="btn btn-sm" title={u.status === 'invited' ? 'Resend invitation link' : 'Issue a password reset link'} onClick={() => onAction('reset-access')}>
        <KeyRound size={13} /> {u.status === 'invited' ? 'Resend' : 'Reset access'}
      </button>
      {u.lockedUntil && (
        <button className="btn btn-sm" title="Unlock" onClick={() => onAction('unlock')}>
          <Lock size={13} /> Unlock
        </button>
      )}
      {isOwner && u.mfaEnabled && (
        <button className="btn btn-sm btn-icon" title="Reset MFA" aria-label="Reset MFA" onClick={() => onAction('reset-mfa')}>
          <ShieldOff size={13} />
        </button>
      )}
      {!self && u.status !== 'invited' && (
        <button className="btn btn-sm btn-icon" title={u.status === 'active' ? 'Disable' : 'Enable'} aria-label={u.status === 'active' ? 'Disable' : 'Enable'} onClick={() => onAction(u.status === 'active' ? 'disable' : 'enable')}>
          <Power size={13} />
        </button>
      )}
    </div>
  );
}

export default function Users() {
  const { canEdit, user: me } = useAuth();
  const { data, error, loading, reload } = useApi<AdminUser[]>('/api/admin/users');
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [link, setLink] = useState<{ url: string; expiresAt: string; title: string; emailed: boolean } | null>(null);
  const [pending, setPending] = useState<{ u: AdminUser; a: UAction } | null>(null);
  const [sendEmail, setSendEmail] = useState(true);

  const ACTION_TEXT: Record<UAction, { title: string; msg: string; label: string; danger?: boolean }> = {
    disable: { title: 'Disable user?', msg: 'The user is signed out everywhere and cannot sign in until re-enabled.', label: 'Disable', danger: true },
    enable: { title: 'Enable user?', msg: 'The user can sign in again.', label: 'Enable' },
    'reset-access': { title: 'Issue access link?', msg: 'Creates a one-time link the user can use to set a new password. Any previous link stops working.', label: 'Create link' },
    unlock: { title: 'Unlock account?', msg: 'Clears failed login attempts and the lockout.', label: 'Unlock' },
    'reset-mfa': { title: 'Reset MFA?', msg: 'Removes the user’s authenticator and recovery codes and signs them out. They must enrol again if MFA is required.', label: 'Reset MFA', danger: true },
  };

  const doAction = async () => {
    if (!pending) return;
    const { u, a } = pending;
    if (a === 'reset-access') {
      const r = await api.post<{ inviteUrl: string; expiresAt: string }>(`/api/admin/users/${u.id}/reset-access`, { sendEmail });
      setLink({ url: r.inviteUrl, expiresAt: r.expiresAt, title: u.status === 'invited' ? `Invitation link for ${u.username}` : `Password reset link for ${u.username}`, emailed: sendEmail });
    } else await api.post(`/api/admin/users/${u.id}/${a}`);
    reload();
  };

  const columns: Column<AdminUser>[] = [
    { key: 'username', header: 'User', render: (u) => <div><div className="cell-title">{u.name} {me?.id === u.id && <Badge>you</Badge>}</div><div className="cell-sub">{u.username} · {u.email}</div></div> },
    { key: 'role', header: 'Role', render: (u) => <Badge tone={u.role === 'owner' ? 'info' : u.role === 'admin' ? 'success' : 'neutral'}>{u.role}</Badge> },
    {
      key: 'status',
      header: 'Status',
      render: (u) => (
        <div className="row" style={{ gap: 4 }}>
          <StatusBadge status={u.status} />
          {u.lockedUntil && <Badge tone="danger" title={`until ${fmtDate(u.lockedUntil)}`}>locked</Badge>}
          {u.mustChangePassword && <Badge tone="warning">must change password</Badge>}
          {u.status === 'invited' && u.inviteExpiresAt && <span className="cell-sub">invite {new Date(u.inviteExpiresAt) < new Date() ? 'expired' : `expires ${fmtRelative(u.inviteExpiresAt)}`}</span>}
        </div>
      ),
    },
    { key: 'mfaEnabled', header: 'MFA', render: (u) => (u.mfaEnabled ? <Badge tone="success">enabled</Badge> : <span className="muted">off</span>) },
    { key: 'lastLoginAt', header: 'Last login', render: (u) => <span title={fmtDate(u.lastLoginAt)}>{fmtRelative(u.lastLoginAt)}</span>, sortValue: (u) => (u.lastLoginAt ? new Date(u.lastLoginAt).getTime() : 0) },
    { key: 'createdAt', header: 'Created', hideSm: true, render: (u) => fmtDate(u.createdAt) },
    { key: 'actions', header: '', sortable: false, className: 'actions', render: (u) => canEdit && <RowActions u={u} onEdit={() => setEditing(u)} onAction={(a) => { setSendEmail(true); setPending({ u, a }); }} /> },
  ];

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="People who can sign in to this console. Viewers are read-only, admins manage configuration, owners also control security settings."
        actions={
          canEdit && (
            <button className="btn btn-primary" onClick={() => setInviting(true)}>
              <UserPlus size={15} /> Invite user
            </button>
          )
        }
      />
      <div className="card">{error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <Loading /> : <DataTable columns={columns} rows={data ?? []} rowKey={(u) => u.id} emptyTitle="No users" />}</div>
      <InviteModal open={inviting} onClose={() => setInviting(false)} onDone={(url, expiresAt, emailed) => { setLink({ url, expiresAt, title: 'Invitation created', emailed }); reload(); }} />
      <EditUserModal user={editing} onClose={() => setEditing(null)} onSaved={reload} />
      <LinkModal link={link} onClose={() => setLink(null)} />
      <ConfirmDialog
        open={!!pending}
        title={pending ? ACTION_TEXT[pending.a].title : ''}
        message={
          pending && (
            <>
              <p>
                <strong>{pending.u.name}</strong> ({pending.u.username})
              </p>
              <p>{ACTION_TEXT[pending.a].msg}</p>
              {pending.a === 'reset-access' && <Checkbox checked={sendEmail} onChange={setSendEmail} label="Also email the link to the user" />}
            </>
          )
        }
        confirmLabel={pending ? ACTION_TEXT[pending.a].label : 'Confirm'}
        danger={pending ? ACTION_TEXT[pending.a].danger : false}
        onConfirm={doAction}
        onClose={() => setPending(null)}
      />
    </>
  );
}
