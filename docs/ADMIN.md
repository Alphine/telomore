# Pro access, admin panel and usage logging

Compute on the Railway API is limited to **PRO** accounts granted by an admin. Free and anonymous visitors only see the
cached demo (frontend). All endpoints below are under `/api`, JSON, `Authorization: Bearer <jwt>` unless noted.
The frontend is a static site on `https://studylab.id/telomore/` calling this API cross-origin (CORS allows studylab.id
and the `Authorization` header).

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `TELOMERE_ADMIN_USERS` | empty | Comma-separated usernames **or emails** (case-insensitive). Matching **email-verified** accounts get `is_admin=true`, `plan=pro` at server startup and on every login (an unverified account that merely squats a listed username is never promoted; prefer listing emails). This is the **only** way to create an admin. Env-listed admins can never be demoted or disabled through the API. |
| `TELOMERE_REQUIRE_PRO` | `1` | `0` turns the plan check off (tests, cache generator). The disabled-account check stays on. |
| `TELOMERE_USAGE_RETENTION_DAYS` | `90` | Usage events older than this are deleted at startup. `0` = keep forever. |
| `TELOMERE_USAGE_LOG` | `on` | `off` disables usage logging entirely. |
| `TELOMERE_IP_SALT` | derived from `SECRET_KEY` | Salt for the IP hash. |
| `TELOMERE_TRUSTED_HOPS` | `0` | Number of trusted proxies that append to `X-Forwarded-For`. `0` reads the first (client-controlled) entry; `1` reads the right-most entry, which a caller cannot forge. Affects rate limits and `ip_hash`. |

## Privacy statement

Usage logging stores, per `/api/*` request: timestamp, user id (if a valid token was sent), the **route template** (for
example `/api/jobs/{job_id}`, never the concrete URL), HTTP method, status code, duration, request size in bytes
(from `Content-Length`), a short salted SHA-256 hash of the client IP (truncated to 16 hex chars; the raw IP is never
stored) and a coarse kind. It never stores request or response bodies, query strings, tokens, passwords or raw IPs.
Admin endpoints and `/api/health` are not logged. Writes happen off the request path and failures never break a request.
Events are pruned after `TELOMERE_USAGE_RETENTION_DAYS`. Every mutating admin action is written to an audit log.

## Plans and enforcement

* `plan` is `free` or `pro`. `plan_expires_at` (nullable, UTC) ends a pro plan; after it passes the effective plan is `free`.
* Admins are always allowed.
* PRO required (all return 403 for free users): `POST /simulate`, `/simulate/ensemble`, `/evolve`, `/pareto`,
  `/sensitivity`, `/gxe`, `/active-learning`, `/benchmark`, `/compare`, `/llm/interpret`, `/llm/propose-protocol`.
  Everything else that needs login (jobs, experiments, sequence genome/mutate/lineage, meta, `/llm/validate-key`) stays free.
* Error body: HTTP 403 `{"detail": {"code": "pro_required", "message": "..."}}`.
  Disabled account: HTTP 403 `{"detail": {"code": "account_disabled", "message": "..."}}` on login and on every request.
  Admin endpoint without admin: 403 `{"detail": {"code": "admin_required", "message": "..."}}`.
  Unverified email stays `403 {"detail": "Email not verified..."}` (string, unchanged).
  Other admin-specific errors use the same `{code, message}` object: `admin_protected` (409), `request_pending` (409),
  `already_pro` (409), `request_not_pending` (409), `too_many_requests` (429), `not_found` (404), `duplicate` (409).

All datetimes are ISO 8601 UTC strings ending in `Z` (or `null`).

## User-facing endpoints

### `POST /api/auth/login`
Unchanged request. Response: `{"access_token": "...", "token_type": "bearer", "plan": "free"|"pro", "is_admin": bool}`
(`plan` is the effective plan).

### `GET /api/auth/me`
```json
{"id": 1, "username": "alice", "email": "a@x.org", "is_verified": true,
 "plan": "free", "is_admin": false, "plan_expires_at": null, "pending_request": false}
```
`plan` is the effective plan (an expired pro shows `free`; `plan_expires_at` still shows when it ended).

### `POST /api/access-requests`
Body `{"message": "<= 500 chars, may be empty"}`. Verified users only; one pending at a time; max 3 per rolling 24 h.
201:
```json
{"id": 5, "status": "pending", "message": "...", "created_at": "...", "decided_at": null, "decision_note": null}
```
Errors: 409 `request_pending`, 409 `already_pro`, 429 `too_many_requests`.

### `GET /api/access-requests/mine`
Array of the same objects, newest first.

## Admin endpoints (`/api/admin/*`, admin only, `Cache-Control: no-store`)

Paginated lists return `{"items": [...], "total": int, "page": int, "page_size": int, "pages": int}`
(`page` from 1, `page_size` default 25, max 100; the CSV export and `/stats` are not paginated).

### `GET /api/admin/stats`
```json
{
 "generated_at": "...",
 "users": {"total": 10, "verified": 8, "free": 7, "pro": 3, "disabled": 1},
 "signups_per_day": [{"date": "2026-09-30", "count": 2}],
 "requests": {"pending": 2, "last_24h": 1, "last_7d": 4},
 "compute_events_per_day": [{"date": "2026-09-30", "count": 12}],
 "latency_by_endpoint": [{"endpoint": "/api/simulate", "count": 40, "p50_ms": 120.0, "p95_ms": 900.0}],
 "error_rate": {"window_days": 7, "total": 100, "errors": 3, "rate": 0.03},
 "top_users": [{"user_id": 3, "username": "bob", "count": 55}],
 "jobs": {"running": 1, "queued": 0}
}
```
`signups_per_day` and `compute_events_per_day` cover the last 30 days, zero-filled, oldest first (compute = kind `compute`
or `llm`). `latency_by_endpoint` and `error_rate` use the last 7 days (errors = status >= 500). `top_users` = most
compute+llm events in the last 30 days, top 10. `users.free`/`pro` use the effective plan; `users.pro` includes admins.
On an empty DB all counts are 0 and lists are empty (the two day series still have 30 entries).

### `GET /api/admin/users`
Query: `query` (substring of username/email), `plan` (`free`|`pro`|`all`, effective plan), `status`
(`all`|`active`|`disabled`|`verified`|`unverified`|`admin`), `sort` (`created_at`, `last_seen_at`, `last_login_at`,
`username`, `email`; prefix `-` for descending; default `-created_at`), `page`, `page_size`.
Item:
```json
{"id": 1, "username": "alice", "email": "a@x.org", "is_verified": true, "is_admin": false,
 "plan": "pro", "plan_effective": "pro", "plan_expires_at": null, "is_disabled": false,
 "note": null, "created_at": "...", "last_login_at": null, "last_seen_at": null, "pending_request": false}
```
Never includes password hashes or tokens.

### `GET /api/admin/users/{id}`
The item above plus:
```json
{"runs_count": 4,
 "recent_usage": ["<usage event>, up to 50, newest first"],
 "requests": ["<request item>"]}
```

### `PATCH /api/admin/users/{id}`
Body (all optional; unknown fields such as `is_admin` are rejected with 422):
`{"plan": "free"|"pro", "plan_expires_at": "ISO datetime"|null, "is_disabled": bool, "note": "<=500 chars"|null}`.
Returns the user item. Setting `plan` to `free` also clears `plan_expires_at`. Admin accounts cannot be disabled or set to
free: 409 `admin_protected`. Audit action: `user_update`.

### `POST /api/admin/users`
Body `{"username": "...", "email": "...", "password": "optional", "plan": "free"|"pro", "plan_days": int|null}`.
Creates a pre-verified user. If `password` is omitted one is generated. 201:
`{"user": <user item>, "temporary_password": "..."}` -- the password is shown **once** and is never retrievable later.
409 `duplicate` for a taken username/email. Audit: `user_create`.

### `GET /api/admin/requests`
Query `status` (`pending`|`approved`|`rejected`|`all`, default `pending`), `page`, `page_size`. Item:
```json
{"id": 5, "user_id": 3, "username": "bob", "email": "b@x.org", "message": "...", "status": "pending",
 "created_at": "...", "decided_by": null, "decided_by_username": null, "decided_at": null, "decision_note": null}
```
Oldest first for `pending`, newest first otherwise.

### `POST /api/admin/requests/{id}/approve`
Body `{"plan_days": int|null (1..3650, null = no expiry), "note": "<=500 chars"|null}`. Sets the user's plan to pro,
returns the request item. 409 `request_not_pending`. Audit: `request_approve`.

### `POST /api/admin/requests/{id}/reject`
Body `{"note": "..."}`; returns the request item. Audit: `request_reject`.

### `GET /api/admin/usage`
Query: `from`, `to` (ISO date or datetime, UTC), `user_id`, `endpoint` (exact template), `status` (`200`, or a class like `5xx`),
`page`, `page_size`. Newest first. Item:
```json
{"id": 9, "ts": "...", "user_id": 3, "username": "bob", "endpoint": "/api/simulate", "method": "POST",
 "status_code": 200, "duration_ms": 123.4, "ip_hash": "9f2c1ab04d77e310", "req_bytes": 512, "kind": "compute"}
```
`kind` is one of `compute`, `llm`, `job`, `auth`, `access`, `foci`, `other`.

### `GET /api/admin/usage/summary`
Query `days` (default 7, 1..90). Response:
```json
{"from": "...", "to": "...", "total": 100, "errors": 3, "error_rate": 0.03, "unique_users": 5, "unique_ips": 7,
 "by_day": [{"date": "2026-09-30", "count": 10, "errors": 0}],
 "by_endpoint": [{"endpoint": "/api/simulate", "count": 40, "errors": 1, "p50_ms": 1.0, "p95_ms": 2.0}],
 "by_kind": [{"kind": "compute", "count": 40}]}
```

### `GET /api/admin/usage/export.csv`
Same filters as `/usage` (no paging, at most 100000 rows). `text/csv`, `Content-Disposition: attachment`. Columns:
`id,ts,user_id,endpoint,method,status_code,duration_ms,ip_hash,req_bytes,kind`. It needs the bearer header, so fetch it
with `fetch` + blob download rather than a plain link.

### `GET /api/admin/audit`
Query `action`, `admin_id`, `page`, `page_size`. Newest first. Item:
```json
{"id": 1, "ts": "...", "admin_id": 1, "admin_username": "root", "action": "request_approve",
 "target_user_id": 3, "target_username": "bob", "detail": {"plan_days": 30, "note": "ok"}}
```
Actions: `user_update`, `user_create`, `request_approve`, `request_reject`, `usage_export`.
