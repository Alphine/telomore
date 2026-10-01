// Shared helpers for the admin tests (not shipped: only imported from *.test.tsx).
import { fireEvent, screen } from '@testing-library/react'
import { vi } from 'vitest'

import type { AccessRequestItem, AdminStats, AdminUser, Page, UsageEvent } from './types'

/** jsdom lacks a few APIs Radix Select / Popper call. */
export function installDomStubs(): void {
  const proto = Element.prototype as unknown as Record<string, unknown>
  proto.hasPointerCapture ??= () => false
  proto.setPointerCapture ??= () => undefined
  proto.releasePointerCapture ??= () => undefined
  proto.scrollIntoView ??= () => undefined
  if (!('ResizeObserver' in globalThis)) {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
  }
}

/** Open a ui/Select by its aria-label and pick an option by its visible label. */
export function chooseOption(selectLabel: string, optionLabel: string): void {
  const trigger = screen.getByRole('combobox', { name: selectLabel })
  fireEvent.keyDown(trigger, { key: 'Enter' })
  const opt = screen.getByRole('option', { name: optionLabel })
  fireEvent.keyDown(opt, { key: 'Enter' })
}

export function makeUser(over: Partial<AdminUser> = {}): AdminUser {
  return {
    id: 1,
    username: 'alice',
    email: 'alice@example.org',
    is_verified: true,
    is_admin: false,
    plan: 'free',
    plan_effective: 'free',
    plan_expires_at: null,
    is_disabled: false,
    note: null,
    created_at: '2026-09-01T10:00:00Z',
    last_login_at: null,
    last_seen_at: null,
    pending_request: false,
    ...over,
  }
}

export function pageOf<T>(items: T[], over: Partial<Page<T>> = {}): Page<T> {
  return { items, total: items.length, page: 1, page_size: 25, pages: 1, ...over }
}

export function makeRequest(over: Partial<AccessRequestItem> = {}): AccessRequestItem {
  return {
    id: 5,
    user_id: 3,
    username: 'bob',
    email: 'bob@example.org',
    message: 'Please let me run simulations',
    status: 'pending',
    created_at: '2026-09-30T08:00:00Z',
    decided_by: null,
    decided_by_username: null,
    decided_at: null,
    decision_note: null,
    ...over,
  }
}

export function makeEvent(over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: 9,
    ts: '2026-09-30T12:00:00Z',
    user_id: 3,
    username: 'bob',
    endpoint: '/api/simulate',
    method: 'POST',
    status_code: 200,
    duration_ms: 123.4,
    ip_hash: '9f2c1ab04d77e310',
    req_bytes: 512,
    kind: 'compute',
    ...over,
  }
}

export function makeStats(over: Partial<AdminStats> = {}): AdminStats {
  const days = (n: number) =>
    Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, count: i === 29 ? n : 0 }))
  return {
    generated_at: '2026-09-30T12:00:00Z',
    users: { total: 10, verified: 8, free: 7, pro: 3, disabled: 1 },
    signups_per_day: days(2),
    requests: { pending: 2, last_24h: 1, last_7d: 4 },
    compute_events_per_day: days(12),
    latency_by_endpoint: [
      { endpoint: '/api/simulate', count: 40, p50_ms: 120, p95_ms: 900 },
      { endpoint: '/api/evolve', count: 5, p50_ms: 2000, p95_ms: 5200 },
    ],
    error_rate: { window_days: 7, total: 100, errors: 3, rate: 0.03 },
    top_users: [{ user_id: 3, username: 'bob', count: 55 }],
    jobs: { running: 1, queued: 0 },
    ...over,
  }
}

export const EMPTY_STATS: AdminStats = makeStats({
  users: { total: 0, verified: 0, free: 0, pro: 0, disabled: 0 },
  signups_per_day: makeStats().signups_per_day.map((d) => ({ ...d, count: 0 })),
  compute_events_per_day: makeStats().compute_events_per_day.map((d) => ({ ...d, count: 0 })),
  requests: { pending: 0, last_24h: 0, last_7d: 0 },
  latency_by_endpoint: [],
  error_rate: { window_days: 7, total: 0, errors: 0, rate: 0 },
  top_users: [],
  jobs: { running: 0, queued: 0 },
})
