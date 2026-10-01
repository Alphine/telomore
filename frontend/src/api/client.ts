// Small typed fetch wrapper for the FastAPI backend (docs/API.md).
// Base path is `/api`: proxied to uvicorn by Vite in dev, same-origin in
// production where FastAPI serves the built frontend itself. A static copy
// hosted elsewhere (studylab.id, see foci/deploy_hostinger.bat) is built with
// VITE_API_BASE=https://telomore-production.up.railway.app/api and talks to
// the Railway backend cross-origin (CORS allows that origin; auth is a bearer
// token, not a cookie).

export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') || '/api'
export const TOKEN_KEY = 'tel_token'

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token)
    else window.localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* storage unavailable (private mode etc.) -- login just won't persist */
  }
}

// FastAPI error bodies are `{"detail": ...}` where detail is a string for
// HTTPException(...) and a list of {loc, msg, type} for validation errors.
type ValidationItem = { loc?: unknown[]; msg?: string; type?: string }

export class ApiError extends Error {
  status: number
  detail: unknown

  constructor(status: number, detail: unknown) {
    super(ApiError.describe(status, detail))
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }

  static describe(status: number, detail: unknown): string {
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail)) {
      const msgs = (detail as ValidationItem[])
        .map((d) => {
          const where = Array.isArray(d.loc) ? d.loc.slice(1).join('.') : ''
          return where ? `${where}: ${d.msg ?? ''}` : (d.msg ?? '')
        })
        .filter(Boolean)
      if (msgs.length) return msgs.join('; ')
    }
    if (detail && typeof detail === 'object' && (detail as { code?: unknown }).code === 'pro_required') {
      return 'This feature needs a Pro account. Request Pro access from your account page.'
    }
    if (detail && typeof detail === 'object' && 'message' in detail) {
      const m = (detail as { message?: unknown }).message
      if (typeof m === 'string') return m
    }
    return `Request failed with status ${status}`
  }
}

/** True for a 403 whose body is {detail:{code:'pro_required'}} (docs/ADMIN.md). */
export function isProRequired(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 403) return false
  const d = err.detail
  return !!d && typeof d === 'object' && (d as { code?: unknown }).code === 'pro_required'
}

export const PRO_REQUIRED_EVENT = 'tel:pro-required'

// ---- demo-mode hooks (see src/demo/replay.ts) -------------------------------
// In demo mode no compute call may reach the live API. `demoHooks.replay`
// serves the cached scenario for the few GETs a page makes on its own
// (job polling, ledger, genome); anything else on a compute path is refused
// locally with a 403 `demo_mode` error before any network traffic.
export const demoHooks: {
  active: boolean
  replay: ((method: string, path: string) => { hit: true; value: unknown } | { hit: false }) | null
} = { active: false, replay: null }

const COMPUTE_PREFIXES = [
  '/simulate',
  '/evolve',
  '/pareto',
  '/sensitivity',
  '/gxe',
  '/active-learning',
  '/compare',
  '/jobs',
  '/experiments',
  '/sequence',
  '/llm',
  '/benchmark',
  '/meta/chip-to-params',
]

function isComputePath(path: string): boolean {
  return COMPUTE_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`))
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  query?: Record<string, string | number | boolean | undefined>
  /** Explicit token override; defaults to the stored one. */
  token?: string | null
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  if (demoHooks.active && isComputePath(path)) {
    const hit = demoHooks.replay?.(opts.method ?? 'GET', path)
    if (hit?.hit) return hit.value as T
    throw new ApiError(403, {
      code: 'demo_mode',
      message: 'Demo mode shows precomputed examples only. Request Pro access to run live compute.',
    })
  }
  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = opts.token === undefined ? getToken() : opts.token
  if (token) headers.Authorization = `Bearer ${token}`
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

  let url = `${API_BASE}${path}`
  if (opts.query) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) qs.set(k, String(v))
    }
    const s = qs.toString()
    if (s) url += `?${s}`
  }

  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })

  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  if (!res.ok) {
    const detail =
      data && typeof data === 'object' && 'detail' in data
        ? (data as { detail: unknown }).detail
        : data
    const err = new ApiError(res.status, detail)
    if (isProRequired(err) && typeof window !== 'undefined') window.dispatchEvent(new Event(PRO_REQUIRED_EVENT))
    throw err
  }
  return data as T
}

/**
 * GET a binary/text file from a protected route as a Blob (artifact
 * downloads). A plain `<a href>` cannot carry the bearer token, so the
 * Experiments page fetches through this and saves the Blob client-side.
 */
export async function requestBlob(path: string): Promise<Blob> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (demoHooks.active) throw new ApiError(403, { code: 'demo_mode', message: 'Downloads are unavailable in demo mode.' })
  const res = await fetch(`${API_BASE}${path}`, { headers })
  if (!res.ok) {
    let detail: unknown = null
    try {
      detail = (JSON.parse(await res.text()) as { detail?: unknown }).detail ?? null
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, detail)
  }
  return res.blob()
}
