# Admin API reference

All endpoints are under `/api/admin`, require a session cookie, and for `POST/PUT/PATCH/DELETE` the `x-csrf-token` header (value of the `relay_csrf` cookie). Default role: `viewer` for `GET`, `admin` for mutations, unless noted. Validation errors return `400 {message, issues:[{path,message}]}`. Request schemas are the zod schemas in each controller file.

The admin API is meant for the bundled UI. Applications must use the public `/v1` API with Relay keys.

## Auth (`/auth`)
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/login` | `{username, password}` → `{mfaRequired}`; public |
| POST | `/auth/mfa` | `{code}` (TOTP or recovery code) completes MFA sign-in; public |
| POST | `/auth/logout` | |
| GET | `/auth/me` | Current user |
| POST | `/auth/change-password` | `{currentPassword, newPassword}`; revokes other sessions |
| POST | `/auth/mfa/setup` · `/auth/mfa/enable` · `/auth/mfa/disable` | Enrolment returns QR + secret; enable returns recovery codes once |
| GET / DELETE | `/auth/sessions` · `/auth/sessions/:id` | Own sessions |
| GET / POST | `/auth/invite/:token` · `/auth/invite/accept` | Public, invitation / reset links |

## Users (`/users`)
`GET /users`, `POST /users` (invite), `PATCH /users/:id`, `POST /users/:id/disable|enable|reset-access|unlock`, `POST /users/:id/reset-mfa` (owner). Only owners manage owner accounts.

## Providers & models
`GET /providers/presets`, `GET|POST /providers`, `PATCH /providers/:id`, `POST /providers/:id/test`, `GET /providers/:id/discover`, `POST /providers/:id/import-preset-models`.
`GET|POST /models`, `PATCH /models/:id`, `GET /models/:id/pricing-history`.

## Apps & entities
`GET|POST /apps`, `PATCH /apps/:id`, `GET|POST /entities` (`?q=`), `PATCH /entities/:id`.

## Keys (`/keys`)
`GET /keys?appId&entityId&status&q`, `GET /keys/:id` (with events), `POST /keys` → `{key, secret}` (secret only here), `PATCH /keys/:id` (name/access/limits/ipAllowlist/metadata), `POST /keys/:id/deactivate|reactivate|revoke` `{reason?}`, `POST /keys/:id/regenerate` → `{key, secret}`.

## Policies
`GET|POST /routes`, `PATCH /routes/:id` · `GET|POST /guardrails`, `PATCH /guardrails/:id`, `POST /guardrails/:id/test {text}`, `GET /guardrails-meta` · `GET|POST /budgets` (with current spend), `PATCH /budgets/:id`, `POST /budgets/:id/reset`.

## Prompts (`/prompts`)
`GET|POST /prompts`, `GET|PATCH /prompts/:id`, `POST /prompts/:id/versions`, `POST /prompts/:id/labels {label, version|null}`, `POST /prompts/:id/render {version?, label?, variables}`.

## Analytics (`/analytics`)
Common filters: `from`, `to` (ISO), `appId`, `entityId`, `keyId`, `providerId`, `modelId`, `status`, `endpoint` (comma-separated for several).
`GET /analytics/overview`, `GET /analytics/report?groupBy=appId,modelId&bucket=day`, `GET /analytics/report.csv`, `GET /analytics/logs?page&pageSize&q`, `GET /analytics/logs.csv`, `GET /analytics/logs/:id/body` (admin).

## Audit (`/audit`)
`GET /audit?from&to&action&actor&resourceType&resourceId&outcome&page&pageSize`, `GET /audit/verify` (admin), `GET /audit/export.json` (admin).

## Settings & system
`GET|PUT /settings/:key` with key `security` (PUT owner only), `gateway`, `routing`, `notifications` · `POST /notifications/test {to}` · `GET /notifications/log` · `GET /system/info` · `POST /system/reencrypt` (owner) · `POST /system/cache/purge {appId?}`.
