// Types for the /api/admin/* contract (docs/ADMIN.md).

export type Plan = 'free' | 'pro'
export type RequestStatus = 'pending' | 'approved' | 'rejected'
export type UsageKind = 'compute' | 'llm' | 'job' | 'auth' | 'access' | 'foci' | 'other'
export type AuditAction = 'user_update' | 'user_create' | 'request_approve' | 'request_reject' | 'usage_export'

export const AUDIT_ACTIONS: AuditAction[] = ['user_update', 'user_create', 'request_approve', 'request_reject', 'usage_export']

export interface Page<T> {
  items: T[]
  total: number
  page: number
  page_size: number
  pages: number
}

export interface DayCount {
  date: string
  count: number
}

export interface EndpointLatency {
  endpoint: string
  count: number
  p50_ms: number
  p95_ms: number
}

export interface AdminStats {
  generated_at: string
  users: { total: number; verified: number; free: number; pro: number; disabled: number }
  signups_per_day: DayCount[]
  requests: { pending: number; last_24h: number; last_7d: number }
  compute_events_per_day: DayCount[]
  latency_by_endpoint: EndpointLatency[]
  error_rate: { window_days: number; total: number; errors: number; rate: number }
  top_users: Array<{ user_id: number; username: string; count: number }>
  jobs: { running: number; queued: number }
}

export interface AdminUser {
  id: number
  username: string
  email: string
  is_verified: boolean
  is_admin: boolean
  plan: Plan
  plan_effective: Plan
  plan_expires_at: string | null
  is_disabled: boolean
  note: string | null
  created_at: string
  last_login_at: string | null
  last_seen_at: string | null
  pending_request: boolean
}

export interface UsageEvent {
  id: number
  ts: string
  user_id: number | null
  username: string | null
  endpoint: string
  method: string
  status_code: number
  duration_ms: number
  ip_hash: string | null
  req_bytes: number | null
  kind: UsageKind
}

export interface AccessRequestItem {
  id: number
  user_id: number
  username: string
  email: string
  message: string
  status: RequestStatus
  created_at: string
  decided_by: number | null
  decided_by_username: string | null
  decided_at: string | null
  decision_note: string | null
}

export interface AdminUserDetail extends AdminUser {
  runs_count: number
  recent_usage: UsageEvent[]
  requests: AccessRequestItem[]
}

export interface UserPatch {
  plan?: Plan
  plan_expires_at?: string | null
  is_disabled?: boolean
  note?: string | null
}

export interface CreateUserBody {
  username: string
  email: string
  password?: string
  plan: Plan
  plan_days: number | null
}

export interface CreateUserResult {
  user: AdminUser
  temporary_password: string
}

export interface UsageSummary {
  from: string
  to: string
  total: number
  errors: number
  error_rate: number
  unique_users: number
  unique_ips: number
  by_day: Array<{ date: string; count: number; errors: number }>
  by_endpoint: Array<{ endpoint: string; count: number; errors: number; p50_ms: number; p95_ms: number }>
  by_kind: Array<{ kind: string; count: number }>
}

export interface AuditEntry {
  id: number
  ts: string
  admin_id: number
  admin_username: string
  action: AuditAction
  target_user_id: number | null
  target_username: string | null
  detail: Record<string, unknown> | null
}

export interface UserListParams {
  query?: string
  plan?: string
  status?: string
  sort?: string
  page?: number
  page_size?: number
}

export interface UsageFilters {
  from?: string
  to?: string
  user_id?: string
  endpoint?: string
  status?: string
}
