// In-memory fake of /api/admin/* (docs/ADMIN.md) for exercising the admin UI in a
// browser without the backend. Plain ESM, no dependencies.
//
//   import { handleAdmin } from './admin-fixtures.mjs'
//   const r = handleAdmin(method, url.pathname, url.searchParams, parsedJsonBody)
//   if (r) { send r.status with r.body (JSON) -- or r.text + r.headers for the CSV }
//
// Returns null for any path that is not under /api/admin/. State lives in module
// memory: PATCH / create / approve / reject mutate it and write audit entries.

const DAY = 86_400_000
const NOW = Date.now()
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10)

// Small seeded PRNG so reloads of the dev server show the same data.
let seed = 20260930
function rnd() {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}
const pick = (xs) => xs[Math.floor(rnd() * xs.length)]

const ADMIN = { id: 1, username: 'root' }
const err = (status, code, message) => ({ status, body: { detail: { code, message } } })

// ---- users -----------------------------------------------------------------
const NAMES = [
  'root', 'alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy', 'ken', 'laura', 'mallory',
  'nina', 'oscar', 'peggy', 'quentin', 'rita', 'sam', 'tina', 'uma', 'victor', 'wendy', 'xavier',
]
const users = NAMES.map((username, i) => {
  const id = i + 1
  const created = NOW - Math.floor(rnd() * 80 + 2) * DAY - Math.floor(rnd() * DAY)
  const isAdmin = id === 1
  const isPro = isAdmin || [2, 3, 5, 9, 12, 15, 20].includes(id)
  const expiring = isPro && !isAdmin && id % 2 === 0
  const expired = id === 15
  return {
    id,
    username,
    email: `${username}@example.org`,
    is_verified: ![8, 17, 24].includes(id),
    is_admin: isAdmin,
    plan: isPro ? 'pro' : 'free',
    plan_expires_at: expired ? iso(NOW - 6 * DAY) : expiring ? iso(NOW + (id * 9) * DAY) : null,
    is_disabled: [7, 19].includes(id),
    note: id === 3 ? 'Postdoc, telomere lab. Approved by email.' : id === 7 ? 'Disabled after abuse report.' : null,
    created_at: iso(created),
    last_login_at: id % 5 === 0 ? null : iso(NOW - Math.floor(rnd() * 20) * DAY - Math.floor(rnd() * DAY)),
    last_seen_at: id % 5 === 0 ? null : iso(NOW - Math.floor(rnd() * 10) * DAY - Math.floor(rnd() * DAY)),
  }
})
let nextUserId = users.length + 1

function effectivePlan(u) {
  if (u.is_admin) return 'pro'
  if (u.plan === 'pro' && (!u.plan_expires_at || Date.parse(u.plan_expires_at) > Date.now())) return 'pro'
  return 'free'
}
function userItem(u) {
  const pending = requests.some((r) => r.user_id === u.id && r.status === 'pending')
  return { ...u, plan_effective: effectivePlan(u), pending_request: pending }
}

// ---- access requests ---------------------------------------------------------
const MESSAGES = [
  'Hi, I am running telomere attrition models for my thesis and need live simulations.',
  'Would like to benchmark our lab protocol against the ensemble tools.',
  'Student project on aging clocks. Thank you!',
  'Need the Pareto optimiser for a grant figure.',
  '',
  'Researching senescence in fibroblasts, could I get Pro access please?',
  'Evaluating the tool for our core facility.',
  'Teaching a course on cellular aging; want to demo live runs.',
]
const requests = [
  { id: 1, user_id: 3, status: 'approved', age: 40, by: 1, note: 'Welcome aboard.' },
  { id: 2, user_id: 5, status: 'approved', age: 25, by: 1, note: null },
  { id: 3, user_id: 7, status: 'rejected', age: 18, by: 1, note: 'Could not verify affiliation.' },
  { id: 4, user_id: 4, status: 'pending', age: 6 },
  { id: 5, user_id: 6, status: 'pending', age: 3 },
  { id: 6, user_id: 10, status: 'pending', age: 1 },
  { id: 7, user_id: 11, status: 'rejected', age: 9, by: 1, note: 'Please add details about your use case.' },
  { id: 8, user_id: 13, status: 'pending', age: 0.2 },
].map((r, i) => {
  const u = users.find((x) => x.id === r.user_id)
  const created = NOW - r.age * DAY
  return {
    id: r.id,
    user_id: u.id,
    username: u.username,
    email: u.email,
    message: MESSAGES[i % MESSAGES.length],
    status: r.status,
    created_at: iso(created),
    decided_by: r.by ?? null,
    decided_by_username: r.by ? 'root' : null,
    decided_at: r.by ? iso(created + 3_600_000 * 5) : null,
    decision_note: r.note ?? null,
  }
})

// ---- usage events ---------------------------------------------------------------
const ENDPOINTS = [
  { m: 'POST', e: '/api/simulate', k: 'compute', base: 900 },
  { m: 'POST', e: '/api/simulate/ensemble', k: 'compute', base: 2600 },
  { m: 'POST', e: '/api/evolve', k: 'compute', base: 5200 },
  { m: 'POST', e: '/api/llm/interpret', k: 'llm', base: 3400 },
  { m: 'GET', e: '/api/jobs/{job_id}', k: 'job', base: 25 },
  { m: 'POST', e: '/api/auth/login', k: 'auth', base: 180 },
  { m: 'POST', e: '/api/access-requests', k: 'access', base: 40 },
  { m: 'GET', e: '/api/foci/screen', k: 'foci', base: 110 },
  { m: 'GET', e: '/api/meta/chips', k: 'other', base: 12 },
]
const usage = []
for (let i = 0; i < 200; i++) {
  const ep = pick(ENDPOINTS)
  const u = rnd() < 0.12 ? null : users[Math.floor(rnd() * users.length)]
  const r = rnd()
  const status = r < 0.04 ? 500 : r < 0.07 ? 502 : r < 0.18 ? 403 : r < 0.22 ? 422 : 200
  // Skew toward recent days so the 30-day charts look alive.
  const ageMs = Math.pow(rnd(), 1.6) * 30 * DAY
  usage.push({
    ts: NOW - ageMs,
    user_id: u ? u.id : null,
    endpoint: ep.e,
    method: ep.m,
    status_code: status,
    duration_ms: Math.round(ep.base * (0.3 + rnd() * 1.6) * 10) / 10,
    ip_hash: u ? (u.id * 2654435761).toString(16).padStart(16, '0').slice(-16) : Math.floor(rnd() * 1e15).toString(16).padStart(16, '0'),
    req_bytes: ep.m === 'POST' ? Math.floor(200 + rnd() * 2000) : 0,
    kind: ep.k,
  })
}
usage.sort((a, b) => b.ts - a.ts)
usage.forEach((e, i) => {
  e.id = usage.length - i
})
const usageItem = (e) => ({
  id: e.id,
  ts: iso(e.ts),
  user_id: e.user_id,
  username: e.user_id ? users.find((u) => u.id === e.user_id)?.username ?? null : null,
  endpoint: e.endpoint,
  method: e.method,
  status_code: e.status_code,
  duration_ms: e.duration_ms,
  ip_hash: e.ip_hash,
  req_bytes: e.req_bytes,
  kind: e.kind,
})

// ---- audit -----------------------------------------------------------------------
const audit = []
let nextAuditId = 1
function logAudit(action, targetUserId, detail, ts = Date.now()) {
  const t = targetUserId ? users.find((u) => u.id === targetUserId) : null
  audit.unshift({
    id: nextAuditId++,
    ts: iso(ts),
    admin_id: ADMIN.id,
    admin_username: ADMIN.username,
    action,
    target_user_id: t ? t.id : null,
    target_username: t ? t.username : null,
    detail,
  })
}
logAudit('user_update', 7, { is_disabled: true }, NOW - 12 * DAY)
logAudit('request_reject', 7, { note: 'Could not verify affiliation.' }, NOW - 18 * DAY + 5 * 3_600_000)
logAudit('request_approve', 5, { plan_days: null, note: null }, NOW - 25 * DAY + 5 * 3_600_000)
logAudit('request_approve', 3, { plan_days: 90, note: 'Welcome aboard.' }, NOW - 40 * DAY + 5 * 3_600_000)
logAudit('user_update', 3, { note: 'Postdoc, telomere lab. Approved by email.' }, NOW - 39 * DAY)
logAudit('usage_export', null, { from: '2026-09-01', rows: 412 }, NOW - 4 * DAY)
logAudit('user_create', 19, { plan: 'free', plan_days: null }, NOW - 30 * DAY)
audit.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
audit.forEach((a, i) => {
  a.id = audit.length - i
})
nextAuditId = audit.length + 1

// ---- helpers -----------------------------------------------------------------------
function paginate(all, sp) {
  const page_size = Math.min(100, Math.max(1, parseInt(sp.get('page_size') ?? '25', 10) || 25))
  const total = all.length
  const pages = Math.max(1, Math.ceil(total / page_size))
  const page = Math.min(pages, Math.max(1, parseInt(sp.get('page') ?? '1', 10) || 1))
  return { items: all.slice((page - 1) * page_size, page * page_size), total, page, page_size, pages }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

function series(days, pred) {
  const out = []
  for (let i = days - 1; i >= 0; i--) out.push({ date: dayKey(NOW - i * DAY), count: 0 })
  const idx = new Map(out.map((d, i) => [d.date, i]))
  return { out, bump: (ms) => { const i = idx.get(dayKey(ms)); if (i !== undefined) out[i].count++ }, pred }
}

function filterUsage(sp) {
  const from = sp.get('from')
  const to = sp.get('to')
  const userId = sp.get('user_id')
  const endpoint = sp.get('endpoint')
  const status = sp.get('status')
  const fromMs = from ? Date.parse(from.length === 10 ? `${from}T00:00:00Z` : from) : null
  const toMs = to ? (to.length === 10 ? Date.parse(`${to}T23:59:59.999Z`) : Date.parse(to)) : null
  return usage.filter((e) => {
    if (fromMs !== null && e.ts < fromMs) return false
    if (toMs !== null && e.ts > toMs) return false
    if (userId && String(e.user_id) !== userId) return false
    if (endpoint && e.endpoint !== endpoint) return false
    if (status) {
      if (/^\dxx$/i.test(status)) {
        if (Math.floor(e.status_code / 100) !== Number(status[0])) return false
      } else if (String(e.status_code) !== status) return false
    }
    return true
  })
}

// ---- endpoints -----------------------------------------------------------------------
function stats() {
  const signups = series(30)
  users.forEach((u) => signups.bump(Date.parse(u.created_at)))
  const compute = series(30)
  usage.filter((e) => e.kind === 'compute' || e.kind === 'llm').forEach((e) => compute.bump(e.ts))

  const week = usage.filter((e) => e.ts >= NOW - 7 * DAY)
  const byEp = new Map()
  for (const e of week) {
    if (!byEp.has(e.endpoint)) byEp.set(e.endpoint, [])
    byEp.get(e.endpoint).push(e.duration_ms)
  }
  const latency = [...byEp.entries()].map(([endpoint, ds]) => {
    const s = [...ds].sort((a, b) => a - b)
    return { endpoint, count: s.length, p50_ms: percentile(s, 50), p95_ms: percentile(s, 95) }
  })
  const errors = week.filter((e) => e.status_code >= 500).length
  const counts = new Map()
  usage
    .filter((e) => e.user_id && (e.kind === 'compute' || e.kind === 'llm'))
    .forEach((e) => counts.set(e.user_id, (counts.get(e.user_id) ?? 0) + 1))
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([user_id, count]) => ({ user_id, username: users.find((u) => u.id === user_id).username, count }))

  return {
    generated_at: iso(Date.now()),
    users: {
      total: users.length,
      verified: users.filter((u) => u.is_verified).length,
      free: users.filter((u) => effectivePlan(u) === 'free').length,
      pro: users.filter((u) => effectivePlan(u) === 'pro').length,
      disabled: users.filter((u) => u.is_disabled).length,
    },
    signups_per_day: signups.out,
    requests: {
      pending: requests.filter((r) => r.status === 'pending').length,
      last_24h: requests.filter((r) => Date.parse(r.created_at) >= Date.now() - DAY).length,
      last_7d: requests.filter((r) => Date.parse(r.created_at) >= Date.now() - 7 * DAY).length,
    },
    compute_events_per_day: compute.out,
    latency_by_endpoint: latency,
    error_rate: { window_days: 7, total: week.length, errors, rate: week.length ? errors / week.length : 0 },
    top_users: top,
    jobs: { running: 1, queued: 2 },
  }
}

const USER_SORTS = ['created_at', 'last_seen_at', 'last_login_at', 'username', 'email']

function listUsers(sp) {
  const q = (sp.get('query') ?? '').trim().toLowerCase()
  const plan = sp.get('plan') ?? 'all'
  const status = sp.get('status') ?? 'all'
  let rows = users.map(userItem)
  if (q) rows = rows.filter((u) => u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
  if (plan !== 'all') rows = rows.filter((u) => u.plan_effective === plan)
  if (status !== 'all') {
    const test = {
      active: (u) => !u.is_disabled,
      disabled: (u) => u.is_disabled,
      verified: (u) => u.is_verified,
      unverified: (u) => !u.is_verified,
      admin: (u) => u.is_admin,
    }[status]
    if (test) rows = rows.filter(test)
  }
  const sort = sp.get('sort') ?? '-created_at'
  const desc = sort.startsWith('-')
  const key = sort.replace(/^-/, '')
  if (!USER_SORTS.includes(key)) return err(422, 'validation', `Unsupported sort: ${sort}`)
  rows.sort((a, b) => {
    const av = a[key]
    const bv = b[key]
    if (av === bv) return a.id - b.id
    if (av === null) return 1 // nulls last in both directions
    if (bv === null) return -1
    return (av < bv ? -1 : 1) * (desc ? -1 : 1)
  })
  return { status: 200, body: paginate(rows, sp) }
}

function patchUser(id, body) {
  const u = users.find((x) => x.id === id)
  if (!u) return err(404, 'not_found', 'User not found')
  const allowed = ['plan', 'plan_expires_at', 'is_disabled', 'note']
  const bad = Object.keys(body ?? {}).filter((k) => !allowed.includes(k))
  if (bad.length) return { status: 422, body: { detail: [{ loc: ['body', bad[0]], msg: 'Extra inputs are not permitted', type: 'extra_forbidden' }] } }
  if (u.is_admin && (body.is_disabled === true || body.plan === 'free')) return err(409, 'admin_protected', 'Admin accounts cannot be disabled or set to free.')
  if (body.note && body.note.length > 500) return { status: 422, body: { detail: [{ loc: ['body', 'note'], msg: 'String too long', type: 'string_too_long' }] } }
  if ('plan' in body) {
    u.plan = body.plan
    if (body.plan === 'free') u.plan_expires_at = null
  }
  if ('plan_expires_at' in body && body.plan !== 'free') u.plan_expires_at = body.plan_expires_at
  if ('is_disabled' in body) u.is_disabled = !!body.is_disabled
  if ('note' in body) u.note = body.note || null
  logAudit('user_update', u.id, body)
  return { status: 200, body: userItem(u) }
}

function createUser(body) {
  const username = String(body?.username ?? '').trim()
  const email = String(body?.email ?? '').trim()
  if (!username || !email) return { status: 422, body: { detail: [{ loc: ['body', 'username'], msg: 'Field required', type: 'missing' }] } }
  if (users.some((u) => u.username.toLowerCase() === username.toLowerCase() || u.email.toLowerCase() === email.toLowerCase())) {
    return err(409, 'duplicate', 'Username or email already taken')
  }
  const pro = body.plan === 'pro'
  const u = {
    id: nextUserId++,
    username,
    email,
    is_verified: true,
    is_admin: false,
    plan: pro ? 'pro' : 'free',
    plan_expires_at: pro && body.plan_days ? iso(Date.now() + body.plan_days * DAY) : null,
    is_disabled: false,
    note: null,
    created_at: iso(Date.now()),
    last_login_at: null,
    last_seen_at: null,
  }
  users.push(u)
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const generated = Array.from({ length: 16 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')
  logAudit('user_create', u.id, { plan: u.plan, plan_days: body.plan_days ?? null })
  return { status: 201, body: { user: userItem(u), temporary_password: body.password || generated } }
}

function decide(id, kind, body) {
  const r = requests.find((x) => x.id === id)
  if (!r) return err(404, 'not_found', 'Request not found')
  if (r.status !== 'pending') return err(409, 'request_not_pending', 'Request is not pending')
  if (kind === 'approve') {
    const days = body?.plan_days ?? null
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) {
      return { status: 422, body: { detail: [{ loc: ['body', 'plan_days'], msg: 'Must be between 1 and 3650', type: 'value_error' }] } }
    }
    const u = users.find((x) => x.id === r.user_id)
    u.plan = 'pro'
    u.plan_expires_at = days ? iso(Date.now() + days * DAY) : null
    r.status = 'approved'
    r.decision_note = body?.note ?? null
    logAudit('request_approve', u.id, { plan_days: days, note: r.decision_note })
  } else {
    r.status = 'rejected'
    r.decision_note = body?.note ?? null
    logAudit('request_reject', r.user_id, { note: r.decision_note })
  }
  r.decided_by = ADMIN.id
  r.decided_by_username = ADMIN.username
  r.decided_at = iso(Date.now())
  return { status: 200, body: { ...r } }
}

function listRequests(sp) {
  const status = sp.get('status') ?? 'pending'
  let rows = status === 'all' ? [...requests] : requests.filter((r) => r.status === status)
  rows.sort((a, b) => (status === 'pending' ? Date.parse(a.created_at) - Date.parse(b.created_at) : Date.parse(b.created_at) - Date.parse(a.created_at)))
  return { status: 200, body: paginate(rows, sp) }
}

function usageSummary(sp) {
  const days = Math.min(90, Math.max(1, parseInt(sp.get('days') ?? '7', 10) || 7))
  const from = NOW - days * DAY
  const rows = usage.filter((e) => e.ts >= from)
  const total = rows.length
  const errors = rows.filter((e) => e.status_code >= 500).length
  const byDay = new Map()
  for (let i = days - 1; i >= 0; i--) byDay.set(dayKey(NOW - i * DAY), { date: dayKey(NOW - i * DAY), count: 0, errors: 0 })
  const byEp = new Map()
  const byKind = new Map()
  for (const e of rows) {
    const d = byDay.get(dayKey(e.ts))
    if (d) {
      d.count++
      if (e.status_code >= 500) d.errors++
    }
    if (!byEp.has(e.endpoint)) byEp.set(e.endpoint, { ds: [], errors: 0 })
    const b = byEp.get(e.endpoint)
    b.ds.push(e.duration_ms)
    if (e.status_code >= 500) b.errors++
    byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1)
  }
  return {
    status: 200,
    body: {
      from: iso(from),
      to: iso(NOW),
      total,
      errors,
      error_rate: total ? errors / total : 0,
      unique_users: new Set(rows.map((e) => e.user_id).filter(Boolean)).size,
      unique_ips: new Set(rows.map((e) => e.ip_hash)).size,
      by_day: [...byDay.values()],
      by_endpoint: [...byEp.entries()].map(([endpoint, v]) => {
        const s = [...v.ds].sort((a, b) => a - b)
        return { endpoint, count: s.length, errors: v.errors, p50_ms: percentile(s, 50), p95_ms: percentile(s, 95) }
      }),
      by_kind: [...byKind.entries()].map(([kind, count]) => ({ kind, count })),
    },
  }
}

function exportCsv(sp) {
  const rows = filterUsage(sp).slice(0, 100000)
  const cols = ['id', 'ts', 'user_id', 'endpoint', 'method', 'status_code', 'duration_ms', 'ip_hash', 'req_bytes', 'kind']
  const lines = [cols.join(',')]
  for (const e of rows) {
    const it = usageItem(e)
    lines.push(cols.map((c) => (it[c] === null || it[c] === undefined ? '' : String(it[c]))).join(','))
  }
  logAudit('usage_export', null, { rows: rows.length })
  return {
    status: 200,
    text: lines.join('\n') + '\n',
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="usage.csv"', 'Cache-Control': 'no-store' },
  }
}

/**
 * @param {string} method HTTP method
 * @param {string} pathname e.g. "/api/admin/users/3"
 * @param {URLSearchParams} searchParams
 * @param {any} body parsed JSON body or undefined
 * @returns {null | {status: number, body?: any, text?: string, headers?: Record<string,string>}}
 */
export function handleAdmin(method, pathname, searchParams, body) {
  const m = String(method).toUpperCase()
  const path = pathname.replace(/\/+$/, '')
  if (!path.startsWith('/api/admin/') && path !== '/api/admin') return null
  const sp = searchParams ?? new URLSearchParams()
  const rest = path.slice('/api/admin'.length)

  if (m === 'GET' && rest === '/stats') return { status: 200, body: stats() }
  if (m === 'GET' && rest === '/users') return listUsers(sp)
  if (m === 'POST' && rest === '/users') return createUser(body)
  let g = rest.match(/^\/users\/(\d+)$/)
  if (g) {
    const id = Number(g[1])
    if (m === 'GET') {
      const u = users.find((x) => x.id === id)
      if (!u) return err(404, 'not_found', 'User not found')
      return {
        status: 200,
        body: {
          ...userItem(u),
          runs_count: (id * 3) % 11,
          recent_usage: usage.filter((e) => e.user_id === id).slice(0, 50).map(usageItem),
          requests: requests.filter((r) => r.user_id === id).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)),
        },
      }
    }
    if (m === 'PATCH') return patchUser(id, body ?? {})
  }
  if (m === 'GET' && rest === '/requests') return listRequests(sp)
  g = rest.match(/^\/requests\/(\d+)\/(approve|reject)$/)
  if (g && m === 'POST') return decide(Number(g[1]), g[2], body)
  if (m === 'GET' && rest === '/usage') {
    return { status: 200, body: paginate(filterUsage(sp).map(usageItem), sp) }
  }
  if (m === 'GET' && rest === '/usage/summary') return usageSummary(sp)
  if (m === 'GET' && rest === '/usage/export.csv') return exportCsv(sp)
  if (m === 'GET' && rest === '/audit') {
    const action = sp.get('action')
    const adminId = sp.get('admin_id')
    const rows = audit.filter((a) => (!action || a.action === action) && (!adminId || String(a.admin_id) === adminId))
    return { status: 200, body: paginate(rows, sp) }
  }
  return err(404, 'not_found', `No admin route for ${m} ${path}`)
}
