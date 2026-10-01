// Dev-only mock of the Railway API + the static demo cache, so the UI can be
// exercised in a browser without the Python backend. NOT part of the build
// (lives outside src/ and public/, so it never reaches dist/).
//
//   DEMO_CACHE_DIR=/path/to/demo-cache PORT=5190 node dev-mocks/server.mjs
//   MOCK_API_PORT=5190 npx vite --port 5181        (vite proxies /api and /demo-cache)
//
// Log in as free / pro / admin / expired (any password), or set localStorage
// tel_token to free-token | pro-token | admin-token | expired-token.
// `expired` looks like a pro user whose plan lapsed server-side: compute
// endpoints answer 403 pro_required, which the UI must turn into demo mode.
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 5190)
const CACHE_DIR = path.resolve(process.env.DEMO_CACHE_DIR ?? path.join(here, '..', 'public', 'demo-cache'))
const bounds = readFileSync(path.join(here, 'bounds.json'), 'utf8')
const chipPresets = readFileSync(path.join(here, 'chip-presets.json'), 'utf8')

let handleAdmin = () => null
try {
  ;({ handleAdmin } = await import('./admin-fixtures.mjs'))
} catch (err) {
  console.warn('admin fixtures not available:', err.message)
}

const USERS = {
  free: { id: 11, username: 'free', email: 'free@example.org', is_verified: true, plan: 'free', is_admin: false, plan_expires_at: null },
  pro: { id: 12, username: 'pro', email: 'pro@example.org', is_verified: true, plan: 'pro', is_admin: false, plan_expires_at: '2027-03-01T00:00:00Z' },
  admin: { id: 1, username: 'admin', email: 'admin@example.org', is_verified: true, plan: 'pro', is_admin: true, plan_expires_at: null },
  expired: { id: 13, username: 'expired', email: 'expired@example.org', is_verified: true, plan: 'pro', is_admin: false, plan_expires_at: '2027-03-01T00:00:00Z' },
}
const requestsByUser = new Map()

const send = (res, status, body, headers = {}) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(text)
}

function userFrom(req) {
  const m = /^Bearer (\w+)-token$/.exec(req.headers.authorization ?? '')
  return m ? USERS[m[1]] : undefined
}

function readCached(feature, pick = 0) {
  try {
    const idx = JSON.parse(readFileSync(path.join(CACHE_DIR, 'index.json'), 'utf8'))
    const meta = idx.features[feature][pick]
    return JSON.parse(readFileSync(path.join(CACHE_DIR, meta.file), 'utf8'))
  } catch {
    return null
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const p = url.pathname
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  let body = null
  try {
    body = raw ? JSON.parse(raw) : null
  } catch {
    /* not json */
  }
  const user = userFrom(req)

  if (p.startsWith('/demo-cache/')) {
    const file = path.join(CACHE_DIR, p.slice('/demo-cache/'.length))
    if (!file.startsWith(CACHE_DIR) || !existsSync(file)) return send(res, 404, { detail: 'no such demo file' })
    return send(res, 200, readFileSync(file, 'utf8'), { 'Cache-Control': 'no-store' })
  }
  if (p === '/api/meta/bounds') return send(res, 200, bounds)
  if (p === '/api/meta/chip-presets') return send(res, 200, chipPresets)
  if (p === '/api/health') return send(res, 200, { status: 'ok' })

  if (p === '/api/auth/login' && req.method === 'POST') {
    const name = String(body?.username ?? '')
    const u = USERS[name]
    if (!u) return send(res, 401, { detail: 'Incorrect username or password' })
    return send(res, 200, { access_token: `${name}-token`, token_type: 'bearer', plan: u.plan, is_admin: u.is_admin })
  }
  if (p === '/api/auth/me') {
    if (!user) return send(res, 401, { detail: 'Could not validate credentials' })
    const pending = (requestsByUser.get(user.id) ?? []).some((r) => r.status === 'pending')
    return send(res, 200, { ...user, pending_request: pending })
  }
  if (p === '/api/access-requests' && req.method === 'POST') {
    if (!user) return send(res, 401, { detail: 'Could not validate credentials' })
    const list = requestsByUser.get(user.id) ?? []
    if (list.some((r) => r.status === 'pending'))
      return send(res, 409, { detail: { code: 'request_pending', message: 'You already have a pending request.' } })
    const r = { id: Date.now() % 100000, status: 'pending', message: String(body?.message ?? ''), created_at: new Date().toISOString(), decided_at: null, decision_note: null }
    requestsByUser.set(user.id, [r, ...list])
    return send(res, 201, r)
  }
  if (p === '/api/access-requests/mine') {
    if (!user) return send(res, 401, { detail: 'Could not validate credentials' })
    return send(res, 200, requestsByUser.get(user.id) ?? [])
  }

  if (p.startsWith('/api/admin/')) {
    if (!user) return send(res, 401, { detail: 'Could not validate credentials' })
    if (!user.is_admin) return send(res, 403, { detail: { code: 'admin_required', message: 'Admin only.' } })
    const out = handleAdmin(req.method ?? 'GET', p.replace(/^\/api/, '/api'), url.searchParams, body)
    if (!out) return send(res, 404, { detail: { code: 'not_found', message: 'Unknown admin route.' } })
    if (out.text !== undefined) return send(res, out.status, out.text, out.headers ?? { 'Content-Type': 'text/csv' })
    return send(res, out.status, out.body)
  }

  // ---- live compute (pro / admin only) ----
  const compute = /^\/api\/(simulate|evolve|pareto|sensitivity|gxe|active-learning|compare|benchmark|llm)/.test(p)
  if (compute) {
    if (!user) return send(res, 401, { detail: 'Not authenticated' })
    if (user.plan !== 'pro' || user.username === 'expired')
      return send(res, 403, { detail: { code: 'pro_required', message: 'Live compute needs a Pro plan.' } })
    if (p === '/api/simulate') {
      const sc = readCached('simulate', 0)
      return sc ? send(res, 200, sc.response) : send(res, 500, { detail: 'no cached simulate scenario to echo' })
    }
    return send(res, 501, { detail: 'not implemented in the mock' })
  }
  if (p === '/api/jobs') return send(res, 200, [])
  if (p === '/api/experiments') return send(res, 200, readCached('experiments', 0)?.response ?? [])

  send(res, 404, { detail: 'Not Found' })
}).listen(PORT, () => console.log(`mock API on http://127.0.0.1:${PORT}  (demo cache: ${CACHE_DIR})`))
