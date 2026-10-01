// Typed client for /api/admin/* (docs/ADMIN.md). Built on the shared request().
import { API_BASE, ApiError, getToken, request } from '../api/client'
import type {
  AccessRequestItem,
  AdminStats,
  AdminUser,
  AdminUserDetail,
  AuditEntry,
  CreateUserBody,
  CreateUserResult,
  Page,
  RequestStatus,
  UsageEvent,
  UsageFilters,
  UsageSummary,
  UserListParams,
  UserPatch,
} from './types'

type QueryIn = Record<string, string | number | boolean | null | undefined>

/** Drops undefined / null / empty-string params so they never reach the URL. */
export function buildQuery(params: QueryIn): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    if (typeof v === 'string' && v.trim() === '') continue
    out[k] = typeof v === 'string' ? v.trim() : v
  }
  return out
}

/** UI filter value "all" means "no filter". */
export function unlessAll(v: string): string | undefined {
  return v === 'all' ? undefined : v
}

export function getStats(): Promise<AdminStats> {
  return request<AdminStats>('/admin/stats')
}

export function listUsers(p: UserListParams): Promise<Page<AdminUser>> {
  return request<Page<AdminUser>>('/admin/users', { query: buildQuery({ ...p }) })
}

export function getUser(id: number): Promise<AdminUserDetail> {
  return request<AdminUserDetail>(`/admin/users/${id}`)
}

export function patchUser(id: number, body: UserPatch): Promise<AdminUser> {
  // request()'s method union has no PATCH yet; it forwards the string to fetch unchanged.
  return request<AdminUser>(`/admin/users/${id}`, { method: 'PATCH', body })
}

export function createUser(body: CreateUserBody): Promise<CreateUserResult> {
  return request<CreateUserResult>('/admin/users', { method: 'POST', body })
}

export function listRequests(p: { status?: RequestStatus | 'all'; page?: number; page_size?: number }): Promise<Page<AccessRequestItem>> {
  return request<Page<AccessRequestItem>>('/admin/requests', { query: buildQuery({ ...p }) })
}

export function approveRequest(id: number, body: { plan_days: number | null; note: string | null }): Promise<AccessRequestItem> {
  return request<AccessRequestItem>(`/admin/requests/${id}/approve`, { method: 'POST', body })
}

export function rejectRequest(id: number, body: { note: string }): Promise<AccessRequestItem> {
  return request<AccessRequestItem>(`/admin/requests/${id}/reject`, { method: 'POST', body })
}

function usageQuery(f: UsageFilters): Record<string, string | number | boolean> {
  return buildQuery({ ...f })
}

export function listUsage(f: UsageFilters & { page?: number; page_size?: number }): Promise<Page<UsageEvent>> {
  return request<Page<UsageEvent>>('/admin/usage', { query: usageQuery(f) })
}

export function getUsageSummary(days: number): Promise<UsageSummary> {
  return request<UsageSummary>('/admin/usage/summary', { query: { days } })
}

/** Fetches the CSV with the bearer token (a plain link cannot send it). */
export async function exportUsageCsv(f: UsageFilters): Promise<Blob> {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(usageQuery(f))) qs.set(k, String(v))
  const s = qs.toString()
  const headers: Record<string, string> = { Accept: 'text/csv' }
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${API_BASE}/admin/usage/export.csv${s ? `?${s}` : ''}`, { headers })
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

export function listAudit(p: { action?: string; admin_id?: number; page?: number; page_size?: number }): Promise<Page<AuditEntry>> {
  return request<Page<AuditEntry>>('/admin/audit', { query: buildQuery({ ...p }) })
}
