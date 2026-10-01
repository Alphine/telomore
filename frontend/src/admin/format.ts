import { ApiError } from '../api/client'
import type { AdminUser } from './types'

export function accessPlanOf(u: AdminUser): 'admin' | 'pro' | 'free' {
  return u.is_admin ? 'admin' : u.plan_effective
}

/** "2026-09-30T14:05:12Z" -> "2026-09-30 14:05" (UTC, deterministic). */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  return iso.slice(0, 16).replace('T', ' ')
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '-'
  return iso.slice(0, 10)
}

/** "3 d ago", "5 h ago", "just now". */
export function ageLabel(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '-'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '-'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.floor(h / 24)} d ago`
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '-'
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s`
  return `${ms >= 100 ? Math.round(ms) : ms.toFixed(1)} ms`
}

export function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(rate > 0 && rate < 0.001 ? 2 : 1)}%`
}

export function fmtInt(n: number): string {
  return n.toLocaleString('en-US')
}

/** Detail object -> compact "plan_days=30 note=ok" text. */
export function formatDetail(detail: Record<string, unknown> | null | undefined): string {
  if (!detail) return ''
  return Object.entries(detail)
    .map(([k, v]) => {
      const val = v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)
      return `${k}=${/\s/.test(val) ? JSON.stringify(val) : val}`
    })
    .join(' ')
}

export function errorCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null
  const d = err.detail
  if (d && typeof d === 'object' && typeof (d as { code?: unknown }).code === 'string') return (d as { code: string }).code
  return null
}

const FRIENDLY: Record<string, string> = {
  admin_protected: 'Admin accounts cannot be disabled or moved to the free plan.',
  duplicate: 'That username or email is already in use.',
  request_not_pending: 'This request has already been decided. Refresh to see its current state.',
  not_found: 'That record no longer exists.',
  admin_required: 'Your account is not an admin.',
  account_disabled: 'This account is disabled.',
  already_pro: 'This user already has Pro.',
}

/** Human message for any thrown value (maps documented admin error codes). */
export function errorMessage(err: unknown): string {
  const code = errorCode(err)
  if (code && FRIENDLY[code]) return FRIENDLY[code]
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong.'
}

/** Date input value (yyyy-mm-dd) -> ISO end of that UTC day. */
export function endOfDayIso(date: string): string {
  return `${date}T23:59:59Z`
}

export function addDaysIso(days: number, from: number = Date.now()): string {
  return new Date(from + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function statusTone(code: number): 'green' | 'amber' | 'red' | 'neutral' {
  if (code >= 500) return 'red'
  if (code >= 400) return 'amber'
  if (code >= 200 && code < 300) return 'green'
  return 'neutral'
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}
