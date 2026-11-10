import { useEffect, useState, type ReactNode } from 'react';
import { Database, KeyRound, Save, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useAction, useApi, useApps } from '../hooks';
import type { GatewaySettings, RoutingSettings, SecuritySettings, SystemInfo } from '../types';
import { Alert, Card, Checkbox, ErrorState, FormField, KV, Loading, PageHeader, Spinner, Tabs } from '../components/ui';
import { ConfirmDialog } from '../components/Modal';
import { toast } from '../components/Toasts';
import { fmtDate, fmtDuration, fmtNum, splitList } from '../format';

type Tab = 'security' | 'gateway' | 'routing' | 'system';

/** Loads a settings section and provides a typed draft + save. */
function useSection<T extends object>(key: string) {
  const { data, error, loading, reload } = useApi<T>(`/api/admin/settings/${key}`);
  const [draft, setDraft] = useState<T | null>(null);
  const { busy, run } = useAction();
  useEffect(() => {
    if (data) setDraft(structuredClone(data));
  }, [data]);
  const save = (body: Partial<T>) =>
    run(async () => {
      const saved = await api.put<T>(`/api/admin/settings/${key}`, body);
      setDraft(structuredClone(saved));
    }, 'Settings saved');
  return { draft, setDraft, error, loading, reload, busy, save };
}

function NumField({ label, hint, value, onChange, min, max, disabled }: { label: string; hint?: ReactNode; value: number; onChange: (n: number) => void; min?: number; max?: number; disabled?: boolean }) {
  return (
    <FormField label={label} hint={hint}>
      <input className="input" type="number" min={min} max={max} value={Number.isFinite(value) ? value : ''} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} />
    </FormField>
  );
}

function SaveBar({ busy, onSave, disabled }: { busy: boolean; onSave: () => void; disabled?: boolean }) {
  if (disabled) return null;
  return (
    <div className="row mt-3" style={{ justifyContent: 'flex-end' }}>
      <button className="btn btn-primary" disabled={busy} onClick={onSave}>
        {busy ? <Spinner size={14} /> : <Save size={14} />} Save
      </button>
    </div>
  );
}

function SecurityTab() {
  const { isOwner } = useAuth();
  const s = useSection<SecuritySettings>('security');
  const [ips, setIps] = useState('');
  useEffect(() => {
    if (s.draft) setIps(s.draft.adminIpAllowlist.join('\n'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.draft?.adminIpAllowlist]);
  if (s.error) return <ErrorState error={s.error} onRetry={s.reload} />;
  if (!s.draft) return <Loading />;
  const d = s.draft;
  const set = (p: Partial<SecuritySettings>) => s.setDraft({ ...d, ...p });
  const ro = !isOwner;
  return (
    <Card title="Security">
      {ro && (
        <div className="mb-2">
          <Alert tone="info">Only owners can change security settings.</Alert>
        </div>
      )}
      <div className="form-grid form-grid-3">
        <NumField label="Session idle timeout (minutes)" min={5} max={1440} value={d.sessionIdleMinutes} onChange={(n) => set({ sessionIdleMinutes: n })} disabled={ro} />
        <NumField label="Session absolute lifetime (hours)" min={1} max={720} value={d.sessionAbsoluteHours} onChange={(n) => set({ sessionAbsoluteHours: n })} disabled={ro} />
        <NumField label="Invite / reset link validity (hours)" min={1} max={336} value={d.inviteExpiryHours} onChange={(n) => set({ inviteExpiryHours: n })} disabled={ro} />
        <NumField label="Max failed logins before lockout" min={3} max={50} value={d.maxFailedLogins} onChange={(n) => set({ maxFailedLogins: n })} disabled={ro} />
        <NumField label="Lockout duration (minutes)" min={1} max={1440} value={d.lockoutMinutes} onChange={(n) => set({ lockoutMinutes: n })} disabled={ro} />
        <NumField label="Minimum password length" min={10} max={128} value={d.passwordMinLength} onChange={(n) => set({ passwordMinLength: n })} disabled={ro} />
      </div>
      <div className="mt-2">
        <Checkbox checked={d.requireMfa} disabled={ro} onChange={(v) => set({ requireMfa: v })} label={<strong>Require MFA for all users</strong>} />
        <div className="hint">Users without MFA are forced to enrol at their next sign-in before they can use the console.</div>
      </div>
      <FormField label="Admin IP allowlist" hint="One IP or CIDR per line. Empty = any network. Make sure your own address is included or you will lock yourself out." className="mt-2">
        <textarea className="textarea mono" rows={4} value={ips} disabled={ro} onChange={(e) => setIps(e.target.value)} />
      </FormField>
      <SaveBar disabled={ro} busy={s.busy} onSave={() => s.save({ ...d, adminIpAllowlist: splitList(ips) })} />
    </Card>
  );
}

function GatewayTab() {
  const { canEdit } = useAuth();
  const s = useSection<GatewaySettings>('gateway');
  const [warn, setWarn] = useState('');
  useEffect(() => {
    if (s.draft) setWarn(s.draft.keyExpiryWarningDays.join(', '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.draft?.keyExpiryWarningDays]);
  if (s.error) return <ErrorState error={s.error} onRetry={s.reload} />;
  if (!s.draft) return <Loading />;
  const d = s.draft;
  const set = (p: Partial<GatewaySettings>) => s.setDraft({ ...d, ...p });
  const ro = !canEdit;
  return (
    <Card title="Gateway">
      <div className="form-grid form-grid-3">
        <FormField label="Public base URL" hint="Used in emailed links, e.g. https://relay.example.com" className="span-2">
          <input className="input mono" value={d.publicBaseUrl} disabled={ro} onChange={(e) => set({ publicBaseUrl: e.target.value })} placeholder={window.location.origin} />
        </FormField>
        <NumField label="Request timeout (ms)" min={5000} max={900000} value={d.requestTimeoutMs} onChange={(n) => set({ requestTimeoutMs: n })} disabled={ro} />
        <NumField label="Default max retries" min={0} max={5} value={d.defaultMaxRetries} onChange={(n) => set({ defaultMaxRetries: n })} disabled={ro} />
        <NumField label="Default cache TTL (seconds)" min={1} value={d.defaultCacheTtlSeconds} onChange={(n) => set({ defaultCacheTtlSeconds: n })} disabled={ro} />
        <NumField label="Default key rate limit (rpm)" hint="0 = unlimited" min={0} value={d.defaultKeyRpm} onChange={(n) => set({ defaultKeyRpm: n })} disabled={ro} />
        <NumField label="Request body retention (days)" min={1} max={3650} value={d.requestLogRetentionDays} onChange={(n) => set({ requestLogRetentionDays: n })} disabled={ro} />
        <NumField label="Usage retention (days)" hint="0 = keep forever" min={0} value={d.usageRetentionDays} onChange={(n) => set({ usageRetentionDays: n })} disabled={ro} />
        <NumField label="Audit retention (days)" hint="0 = keep forever" min={0} value={d.auditRetentionDays} onChange={(n) => set({ auditRetentionDays: n })} disabled={ro} />
        <FormField label="Key expiry warnings (days before)" hint="Comma separated, up to 5">
          <input className="input" value={warn} disabled={ro} onChange={(e) => setWarn(e.target.value)} />
        </FormField>
      </div>
      <div className="stack mt-2" style={{ gap: 6 }}>
        <Checkbox checked={d.storeRequestBodies} disabled={ro} onChange={(v) => set({ storeRequestBodies: v })} label="Store request/response bodies by default (apps can override)" />
        <Checkbox checked={d.exposeCostHeaders} disabled={ro} onChange={(v) => set({ exposeCostHeaders: v })} label="Expose x-relay-cost-usd response header to clients" />
      </div>
      <SaveBar
        disabled={ro}
        busy={s.busy}
        onSave={() =>
          s.save({
            ...d,
            keyExpiryWarningDays: splitList(warn)
              .map(Number)
              .filter((n) => Number.isFinite(n) && n > 0),
          })
        }
      />
    </Card>
  );
}

function RoutingTab() {
  const { canEdit } = useAuth();
  const s = useSection<RoutingSettings>('routing');
  const [kw, setKw] = useState('');
  useEffect(() => {
    if (s.draft) setKw(s.draft.autoStrongKeywords.join(', '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.draft?.autoStrongKeywords]);
  if (s.error) return <ErrorState error={s.error} onRetry={s.reload} />;
  if (!s.draft) return <Loading />;
  const d = s.draft;
  const ro = !canEdit;
  return (
    <Card title="Auto routing defaults">
      <p className="hint">Defaults for routes using the “auto” strategy that don’t set their own threshold or keywords. Requests whose input exceeds the threshold, or that contain a strong keyword, go to the route’s strong models.</p>
      <div className="form-grid">
        <NumField label="Threshold (input tokens)" min={1} value={d.autoThresholdTokens} onChange={(n) => s.setDraft({ ...d, autoThresholdTokens: n })} disabled={ro} />
        <FormField label="Strong keywords" hint="Comma separated, case-insensitive" className="span-2">
          <textarea className="textarea" rows={3} value={kw} disabled={ro} onChange={(e) => setKw(e.target.value)} />
        </FormField>
      </div>
      <SaveBar disabled={ro} busy={s.busy} onSave={() => s.save({ autoThresholdTokens: d.autoThresholdTokens, autoStrongKeywords: splitList(kw) })} />
    </Card>
  );
}

function SystemTab() {
  const { canEdit, isOwner } = useAuth();
  const { data, error, loading, reload } = useApi<SystemInfo>('/api/admin/system/info');
  const apps = useApps();
  const [purgeApp, setPurgeApp] = useState('');
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [confirmRe, setConfirmRe] = useState(false);
  const [reResult, setReResult] = useState<{ providers: number; users: number; settings: number; cachePurged: number; note: string } | null>(null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !data) return <Loading />;
  return (
    <div className="stack">
      <Card title="System information">
        <KV
          items={[
            ['Version', data.version],
            ['Node.js', data.node],
            ['Database', data.database],
            ['Master key ID', <code key="k">{data.masterKeyId}</code>],
            ['Previous master key loaded', data.rotationKeyLoaded ? 'Yes (rotation in progress)' : 'No'],
            ['Installed', fmtDate(data.installedAt)],
            ['Uptime', fmtDuration(data.uptimeSeconds)],
            ['Process ID', data.pid],
            ['Counts', `${fmtNum(data.counts.users)} users · ${fmtNum(data.counts.apps)} apps · ${fmtNum(data.counts.keys)} keys · ${fmtNum(data.counts.providers)} providers · ${fmtNum(data.counts.models)} models`],
          ]}
        />
      </Card>
      {canEdit && (
        <Card title="Response cache">
          <p className="small text-2">Purge cached responses for all apps or a single app (e.g. after changing a prompt or model behaviour).</p>
          <div className="row">
            <select className="select" style={{ maxWidth: 260 }} value={purgeApp} onChange={(e) => setPurgeApp(e.target.value)}>
              <option value="">All apps</option>
              {(apps.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <button className="btn" onClick={() => setConfirmPurge(true)}>
              <Trash2 size={14} /> Purge cache
            </button>
          </div>
        </Card>
      )}
      {isOwner && (
        <Card title="Master key rotation">
          <p className="small text-2">
            Relay encrypts provider credentials, MFA secrets and notification secrets with <code>RELAY_MASTER_KEY</code>. To rotate: set the new key as <code>RELAY_MASTER_KEY</code>, keep the old one as <code>RELAY_MASTER_KEY_PREVIOUS</code>, restart, then run re-encryption below. After that, regenerate API keys (their hashes use the old key) before removing the previous key.
          </p>
          {!data.rotationKeyLoaded && (
            <div className="mb-2">
              <Alert tone="info">No previous master key is loaded, so there is probably nothing to re-encrypt.</Alert>
            </div>
          )}
          <button className="btn" onClick={() => setConfirmRe(true)}>
            <KeyRound size={14} /> Re-encrypt secrets
          </button>
          {reResult && (
            <div className="mt-2">
              <Alert tone="success" title="Re-encryption complete">
                {reResult.providers} providers, {reResult.users} MFA secrets, {reResult.settings} settings sections re-encrypted; {reResult.cachePurged} cache entries purged.
                <div className="mt-1">{reResult.note}</div>
              </Alert>
            </div>
          )}
        </Card>
      )}
      <ConfirmDialog
        open={confirmPurge}
        title="Purge response cache?"
        message={purgeApp ? 'Cached responses for the selected app will be removed.' : 'All cached responses for all apps will be removed.'}
        confirmLabel="Purge"
        onConfirm={async () => {
          const r = await api.post<{ purged: number }>('/api/admin/system/cache/purge', purgeApp ? { appId: purgeApp } : {});
          toast.success(`Purged ${r.purged} cache entries`);
        }}
        onClose={() => setConfirmPurge(false)}
      />
      <ConfirmDialog
        open={confirmRe}
        title="Re-encrypt all secrets?"
        message="Every stored secret encrypted with an older master key is decrypted and re-encrypted with the current key. The response cache is purged. This is safe to run more than once."
        confirmLabel="Re-encrypt"
        onConfirm={async () => {
          setReResult(await api.post('/api/admin/system/reencrypt'));
          reload();
        }}
        onClose={() => setConfirmRe(false)}
      />
    </div>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('security');
  return (
    <>
      <PageHeader title="Settings" subtitle="Gateway-wide configuration. Changes are audited." />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'security', label: 'Security' },
          { id: 'gateway', label: 'Gateway' },
          { id: 'routing', label: 'Routing' },
          { id: 'system', label: <><Database size={13} /> System</> },
        ]}
      />
      {tab === 'security' && <SecurityTab />}
      {tab === 'gateway' && <GatewayTab />}
      {tab === 'routing' && <RoutingTab />}
      {tab === 'system' && <SystemTab />}
    </>
  );
}
