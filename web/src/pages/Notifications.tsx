import { useEffect, useState } from 'react';
import { Plus, Save, Send, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useAction, useApi } from '../hooks';
import { NOTIFICATION_EVENTS, SECRET_MASK, type NotificationLog, type NotificationSettings, type WebhookConfig } from '../types';
import { Alert, Card, Checkbox, ErrorState, FormField, Loading, PageHeader, Spinner, StatusBadge, Switch } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { MultiSelect } from '../components/MultiSelect';
import { toast } from '../components/Toasts';
import { fmtDateTimeSec, randomId } from '../format';

const EVENT_LABELS: Record<string, string> = {
  'user.onboarding': 'User invited',
  'user.password_reset': 'Password reset issued',
  'budget.warning': 'Spend cap threshold reached',
  'budget.reached': 'Spend cap exceeded',
  'key.created': 'API key created',
  'key.expiring': 'API key expiring soon',
  'key.revoked': 'API key revoked',
  'provider.failure': 'Provider failures',
  'security.alert': 'Security alerts (lockouts, etc.)',
};

function Webhooks({ list, onChange, disabled }: { list: WebhookConfig[]; onChange: (w: WebhookConfig[]) => void; disabled: boolean }) {
  const upd = (i: number, p: Partial<WebhookConfig>) => onChange(list.map((w, j) => (j === i ? { ...w, ...p } : w)));
  const eventOpts = [{ value: '*', label: 'All events (*)' }, ...NOTIFICATION_EVENTS.map((e) => ({ value: e, label: e, hint: EVENT_LABELS[e] }))];
  return (
    <div className="stack" style={{ gap: 10 }}>
      {list.length === 0 && <p className="muted small">No webhooks configured.</p>}
      {list.map((w, i) => (
        <div key={w.id} className="msg-editor">
          <div className="form-grid">
            <FormField label="Name">
              <input className="input" value={w.name} disabled={disabled} onChange={(e) => upd(i, { name: e.target.value })} />
            </FormField>
            <FormField label="Format">
              <select className="select" value={w.format} disabled={disabled} onChange={(e) => upd(i, { format: e.target.value as WebhookConfig['format'] })}>
                <option value="json">Generic JSON</option>
                <option value="slack">Slack incoming webhook</option>
                <option value="teams">Microsoft Teams</option>
              </select>
            </FormField>
            <FormField label="URL" className="span-2">
              <input className="input mono" value={w.url} disabled={disabled} onChange={(e) => upd(i, { url: e.target.value })} placeholder="https://hooks.example.com/…" />
            </FormField>
            <FormField label="Events">
              <MultiSelect options={eventOpts} value={w.events} disabled={disabled} onChange={(v) => upd(i, { events: v })} height={130} />
            </FormField>
            <div className="stack" style={{ gap: 8, justifyContent: 'flex-end' }}>
              <Switch checked={w.enabled} disabled={disabled} onChange={(v) => upd(i, { enabled: v })} label="Enabled" />
              <span className="hint mono">id: {w.id}</span>
              {!disabled && (
                <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => onChange(list.filter((_, j) => j !== i))}>
                  <Trash2 size={13} /> Remove webhook
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
      {!disabled && list.length < 20 && (
        <button type="button" className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => onChange([...list, { id: randomId(12), name: 'New webhook', url: '', events: ['*'], format: 'json', enabled: true }])}>
          <Plus size={13} /> Add webhook
        </button>
      )}
    </div>
  );
}

export default function Notifications() {
  const { canEdit, user } = useAuth();
  const { data, error, loading, reload } = useApi<NotificationSettings>('/api/admin/settings/notifications');
  const log = useApi<NotificationLog[]>('/api/admin/notifications/log');
  const [f, setF] = useState<NotificationSettings | null>(null);
  const [recipients, setRecipients] = useState('');
  const [testTo, setTestTo] = useState('');
  const { busy, run } = useAction();
  const test = useAction();
  useEffect(() => {
    if (data) {
      setF(structuredClone(data));
      setRecipients((data.adminRecipients ?? []).join(', '));
    }
  }, [data]);
  useEffect(() => {
    if (user?.email && !testTo) setTestTo(user.email);
  }, [user, testTo]);

  if (error) return <div className="card"><ErrorState error={error} onRetry={reload} /></div>;
  if (loading || !f) return <Loading />;
  const ro = !canEdit;
  const set = (p: Partial<NotificationSettings>) => setF({ ...f, ...p });

  const save = () =>
    run(async () => {
      const body = {
        enabled: f.enabled,
        channel: f.channel,
        fromAddress: f.fromAddress.trim(),
        fromName: f.fromName,
        adminRecipients: recipients.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean),
        events: f.events,
        smtp: { host: f.smtp.host, port: Number(f.smtp.port) || 587, secure: f.smtp.secure, username: f.smtp.username, password: f.smtp.password ?? SECRET_MASK },
        graph: { tenantId: f.graph.tenantId, clientId: f.graph.clientId, senderUpn: f.graph.senderUpn, clientSecret: f.graph.clientSecret ?? SECRET_MASK },
        webhooks: f.webhooks.map((w) => ({ ...w, name: w.name.trim() || 'Webhook', url: w.url.trim() })),
      };
      const saved = await api.put<NotificationSettings>('/api/admin/settings/notifications', body);
      setF(structuredClone(saved));
      setRecipients((saved.adminRecipients ?? []).join(', '));
    }, 'Notification settings saved');

  const logCols: Column<NotificationLog>[] = [
    { key: 'ts', header: 'Time', render: (r) => <span className="nowrap">{fmtDateTimeSec(r.ts)}</span> },
    { key: 'event', header: 'Event', render: (r) => <code>{r.event}</code> },
    { key: 'channel', header: 'Channel' },
    { key: 'recipients', header: 'Recipients', render: (r) => <span className="small truncate" title={Array.isArray(r.recipients) ? r.recipients.join(', ') : r.recipients}>{Array.isArray(r.recipients) ? r.recipients.join(', ') : r.recipients ?? '-'}</span> },
    { key: 'subject', header: 'Subject', hideSm: true, render: (r) => <span className="truncate" title={r.subject}>{r.subject}</span> },
    { key: 'status', header: 'Status', render: (r) => <span title={r.error}><StatusBadge status={r.status} /></span> },
    { key: 'error', header: 'Error', hideSm: true, render: (r) => (r.error ? <span className="danger-text small truncate" title={r.error}>{r.error}</span> : '') },
  ];

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle="Email (SMTP or Microsoft Graph) and webhooks for invitations, key lifecycle, spend caps and security alerts."
        actions={
          canEdit && (
            <button className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? <Spinner size={14} /> : <Save size={14} />} Save settings
            </button>
          )
        }
      />
      {ro && (
        <div className="mb-2">
          <Alert tone="info">You have read-only access. Secrets are always masked.</Alert>
        </div>
      )}
      <div className="grid grid-2">
        <Card title="Email delivery">
          <Switch checked={f.enabled} disabled={ro} onChange={(v) => set({ enabled: v })} label={<strong>Notifications enabled</strong>} />
          <div className="form-grid mt-2">
            <FormField label="Channel">
              <select className="select" value={f.channel} disabled={ro} onChange={(e) => set({ channel: e.target.value as NotificationSettings['channel'] })}>
                <option value="none">None (webhooks only)</option>
                <option value="smtp">SMTP</option>
                <option value="graph">Microsoft Graph (Microsoft 365)</option>
              </select>
            </FormField>
            <FormField label="From name">
              <input className="input" value={f.fromName} disabled={ro} onChange={(e) => set({ fromName: e.target.value })} />
            </FormField>
            <FormField label="From address" className="span-2">
              <input className="input" type="email" value={f.fromAddress} disabled={ro} onChange={(e) => set({ fromAddress: e.target.value })} placeholder="relay@example.com" />
            </FormField>
            <FormField label="Admin recipients" hint="Comma separated. Receive admin-level alerts." className="span-2">
              <input className="input" value={recipients} disabled={ro} onChange={(e) => setRecipients(e.target.value)} />
            </FormField>
          </div>

          {f.channel === 'smtp' && (
            <>
              <div className="section-title mt-3">SMTP</div>
              <div className="form-grid">
                <FormField label="Host">
                  <input className="input" value={f.smtp.host} disabled={ro} onChange={(e) => set({ smtp: { ...f.smtp, host: e.target.value } })} />
                </FormField>
                <FormField label="Port">
                  <input className="input" type="number" min={1} max={65535} value={f.smtp.port} disabled={ro} onChange={(e) => set({ smtp: { ...f.smtp, port: Number(e.target.value) } })} />
                </FormField>
                <FormField label="Username">
                  <input className="input" value={f.smtp.username} disabled={ro} autoComplete="off" onChange={(e) => set({ smtp: { ...f.smtp, username: e.target.value } })} />
                </FormField>
                <FormField label="Password" hint={f._secretsSet?.['smtp.password'] ? 'Stored. Leave the mask to keep it; clear to remove.' : 'Not set'}>
                  <input className="input" type="password" autoComplete="new-password" value={f.smtp.password ?? ''} disabled={ro} onFocus={(e) => e.target.value === SECRET_MASK && e.target.select()} onChange={(e) => set({ smtp: { ...f.smtp, password: e.target.value } })} />
                </FormField>
                <FormField className="span-2">
                  <Checkbox checked={f.smtp.secure} disabled={ro} onChange={(v) => set({ smtp: { ...f.smtp, secure: v } })} label="Use implicit TLS (port 465). Leave off for STARTTLS on 587." />
                </FormField>
              </div>
            </>
          )}
          {f.channel === 'graph' && (
            <>
              <div className="section-title mt-3">Microsoft Graph</div>
              <p className="hint">App registration with the <code>Mail.Send</code> application permission.</p>
              <div className="form-grid">
                <FormField label="Tenant ID">
                  <input className="input mono" value={f.graph.tenantId} disabled={ro} onChange={(e) => set({ graph: { ...f.graph, tenantId: e.target.value } })} />
                </FormField>
                <FormField label="Client ID">
                  <input className="input mono" value={f.graph.clientId} disabled={ro} onChange={(e) => set({ graph: { ...f.graph, clientId: e.target.value } })} />
                </FormField>
                <FormField label="Client secret" hint={f._secretsSet?.['graph.clientSecret'] ? 'Stored. Leave the mask to keep it; clear to remove.' : 'Not set'}>
                  <input className="input" type="password" autoComplete="new-password" value={f.graph.clientSecret ?? ''} disabled={ro} onFocus={(e) => e.target.value === SECRET_MASK && e.target.select()} onChange={(e) => set({ graph: { ...f.graph, clientSecret: e.target.value } })} />
                </FormField>
                <FormField label="Sender (UPN)">
                  <input className="input" value={f.graph.senderUpn} disabled={ro} onChange={(e) => set({ graph: { ...f.graph, senderUpn: e.target.value } })} placeholder="relay@contoso.com" />
                </FormField>
              </div>
            </>
          )}

          {canEdit && (
            <>
              <div className="section-title mt-3">Send test email</div>
              <p className="hint">Uses the saved settings - save first if you changed anything.</p>
              <div className="row">
                <input className="input" type="email" style={{ maxWidth: 280 }} value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" />
                <button
                  className="btn"
                  disabled={test.busy || !testTo.includes('@')}
                  onClick={() =>
                    test.run(async () => {
                      const r = await api.post<{ ok: boolean; error?: string }>('/api/admin/notifications/test', { to: testTo.trim() });
                      if (r.ok) toast.success(`Test email sent to ${testTo}`);
                      else toast.error(new Error(`Test failed: ${r.error ?? 'unknown error'}`));
                      log.reload();
                    })
                  }
                >
                  {test.busy ? <Spinner size={14} /> : <Send size={14} />} Send test
                </button>
              </div>
            </>
          )}
        </Card>

        <div className="stack">
          <Card title="Events">
            <p className="hint">Choose which events send email. Webhooks select events individually.</p>
            <div className="stack" style={{ gap: 8 }}>
              {NOTIFICATION_EVENTS.map((e) => (
                <div key={e} className="row between">
                  <span>
                    {EVENT_LABELS[e]} <code className="small">{e}</code>
                  </span>
                  <Switch checked={!!f.events?.[e]} disabled={ro} onChange={(v) => set({ events: { ...f.events, [e]: v } })} />
                </div>
              ))}
            </div>
            <p className="hint mt-2">Invitations and password resets are always delivered when requested, regardless of these toggles.</p>
          </Card>
          <Card title="Webhooks">
            <Webhooks list={f.webhooks ?? []} disabled={ro} onChange={(w) => set({ webhooks: w })} />
          </Card>
        </div>
      </div>

      <Card title="Delivery log" className="mt-2" flush actions={<button className="btn btn-sm" onClick={log.reload}>Refresh</button>}>
        {log.error ? <ErrorState error={log.error} onRetry={log.reload} /> : !log.data ? <Loading /> : <DataTable columns={logCols} rows={log.data} rowKey={(r) => r.id} emptyTitle="No notifications sent yet" compact />}
      </Card>
    </>
  );
}
