// Small typed fetch wrapper for the FastAPI backend (docs/API.md).
// Base path is `/api`: proxied to uvicorn by Vite in dev, same-origin in
// production where FastAPI serves the built frontend itself.

export const API_BASE = '/api'
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
    if (detail && typeof detail === 'object' && 'message' in detail) {
      const m = (detail as { message?: unknown }).message
      if (typeof m === 'string') return m
    }
    return `Request failed with status ${status}`
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  query?: Record<string, string | number | boolean | undefined>
  /** Explicit token override; defaults to the stored one. */
  token?: string | null
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
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
    throw new ApiError(res.status, detail)
  }
  return data as T
}
