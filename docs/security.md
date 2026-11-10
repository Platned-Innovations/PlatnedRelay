# Security

Relay holds the organisation's LLM provider credentials and sees every prompt, so it is designed as a high-value system.

## Threat model (summary)

| Threat | Controls |
|---|---|
| Database dump / backup leak | Provider keys, SMTP/Graph secrets, MFA seeds and stored request bodies are AES-256-GCM encrypted with keys derived from a master key that is **not** in the database. Relay keys, session tokens, invite tokens and recovery codes are stored only as HMAC-SHA256 digests. |
| Ciphertext swapping in the DB | Every ciphertext is bound to its record and field through GCM additional authenticated data (e.g. `provider:<id>:secrets`); moving it to another record fails decryption. |
| Leaked Relay key | Keys can be restricted (models/providers/routes, IP allowlist, rate/token/concurrency limits, spend caps), expire, and can be deactivated, regenerated or revoked instantly; usage is attributable per key. |
| Brute force | Per-IP sign-in throttling, account lockout with alert, invalid-key throttling on `/v1`, 256-bit random keys. |
| Session theft / CSRF | Opaque random session tokens in `HttpOnly; Secure; SameSite=Strict` cookies, server-side sessions (revocable, idle + absolute timeouts), double-submit CSRF token bound to the session for every mutating request. |
| Insider tampering with history | Hash-chained, HMAC-signed audit log; usage history immutable from the UI; keys/users are never deleted. |
| Provider credential exfiltration through the UI/API | Secrets are write-only: API returns only "set" flags and last 4 characters. |
| XSS / clickjacking | Strict CSP (`script-src 'self'`, no inline scripts, `frame-ancestors 'none'`), HSTS, `no-referrer`, `X-Content-Type-Options`; React escaping. |
| Data leakage to model providers | PII redaction / reversible masking / blocking, secret detection, prompt-injection detection, per-app guardrails. |
| Cross-app data leakage via cache | Cache entries are keyed per app and encrypted at rest. |

## Cryptography

- **Master key** (`RELAY_MASTER_KEY`, 32 bytes) → HKDF-SHA256 derives independent keys for encryption, HMAC lookup digests and audit signing.
- **Encryption**: AES-256-GCM, random 96-bit IV per value, AAD context binding, versioned format `v1.<keyId>.<iv>.<tag>.<ciphertext>`.
- **Passwords**: Argon2id (19 MiB memory, 2 iterations — OWASP baseline), constant-time behaviour for unknown users.
- **Relay keys**: `rly_` + 256-bit random; stored as HMAC digest; displayed once; prefix and last 4 characters kept for identification.
- **MFA**: TOTP (RFC 6238, SHA-1, 6 digits, ±30 s), replay-protected; 10 single-use recovery codes (HMAC-stored).

## Authentication and authorisation (admin console)

- Server-side sessions; the cookie holds a random token whose HMAC is looked up in the DB. Sign-out and role changes revoke sessions. Users can view and revoke their own sessions.
- Two-step login when MFA is enabled (short-lived pre-MFA session that grants nothing).
- Forced password change for the generated initial owner; optional mandatory MFA for everyone.
- Roles: `viewer` (read), `admin` (write), `owner` (security settings, owner accounts, MFA resets, re-encryption). Owners cannot be demoted/disabled if they are the last owner.
- Optional admin IP allowlist (applies to sign-in too). Combine with network restrictions (see below).

## Audit trail

Recorded: sign-in success/failure/lockout, MFA changes, password changes, invitations, every create/update/state change of users, apps, entities, keys, providers, models/pricing, routes, prompts, guardrails, budgets, settings; cache purges; re-encryption; system initialisation. Each entry has actor, IP, user agent, outcome and redacted details.

Integrity: entry *n* stores `prevHash = hash(n-1)` and `hash = HMAC(auditKey, canonical(entry))`. A unique `seq` index keeps the chain linear across instances. **Audit → Verify integrity** recomputes the chain and reports the first broken entry. Retention purges remove the oldest entries; verification restarts from the first remaining one.

## Master key rotation

1. Generate a new key. Deploy with `RELAY_MASTER_KEY=<new>` and `RELAY_MASTER_KEY_PREVIOUS=<old>`.
2. As an owner: **Settings → System → Re-encrypt secrets**. Provider secrets, settings secrets and MFA seeds are re-encrypted; the response cache is purged.
3. Relay keys keep working and their digests migrate to the new key automatically on first use. Regenerate keys that are not used during the rotation window.
4. Users sign in again (sessions are bound to the old key). Re-issue pending invitations.
5. **Verify** and **export** the audit log (entries signed with the old key verify only while it is loaded); archive the export with the old key.
6. Remove `RELAY_MASTER_KEY_PREVIOUS`.

If the master key is lost, encrypted secrets cannot be recovered: re-enter provider keys and notification secrets, regenerate Relay keys and reset MFA.

## Hardening checklist

- [ ] Master key in Azure Key Vault (Key Vault reference) or Docker secret; offline backup in a safe.
- [ ] TLS everywhere: HTTPS only at the edge, `sslmode=require` to PostgreSQL / TLS to MongoDB.
- [ ] `TRUST_PROXY` set correctly so IP-based controls see real client IPs.
- [ ] Require MFA (Settings → Security) and set the admin IP allowlist to corporate ranges/VPN.
- [ ] Ideally keep the admin console private: expose only `/v1` publicly (e.g. Azure Front Door/App Gateway rule or App Service access restrictions for `/api/admin` and the UI), or run a second internal-only instance for administration.
- [ ] Private networking between Relay and the database (VNet integration + private endpoint).
- [ ] Least-privilege DB user (owner of the Relay schema only).
- [ ] Restrict keys: per-environment keys, model allowlists, IP allowlists, expiry dates, spend caps.
- [ ] Keep request-body logging off unless needed, with short retention.
- [ ] Enable the *Baseline protection* guardrail (default) and attach PII policies to apps handling personal data.
- [ ] Configure notifications (security alerts, provider failures, spend caps) and forward audit exports to the SIEM.
- [ ] Back up the database (see [operations.md](operations.md)) and test restores.
- [ ] Use Microsoft Graph with an application access policy limiting the sending mailbox.

## Reporting a vulnerability

Report privately to the platform team. Do not open public issues for security problems.
