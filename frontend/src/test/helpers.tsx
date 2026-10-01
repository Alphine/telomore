import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'

import { AccessProvider } from '../access/AccessProvider'
import { AuthProvider } from '../auth/AuthContext'
import { ToastProvider } from '../components/ui/Toast'
import { ThemeProvider } from '../theme/ThemeProvider'

/** Render inside a MemoryRouter + ThemeProvider + AuthProvider (no localStorage token unless given). */
export function renderApp(ui: ReactNode, opts: { route?: string; token?: string | null } = {}) {
  return render(
    <MemoryRouter initialEntries={[opts.route ?? '/']}>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider initialToken={opts.token ?? null}>
            <AccessProvider>{ui}</AccessProvider>
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </MemoryRouter>,
  )
}

export interface FakeResponse {
  status: number
  body: unknown
}

/**
 * Install a fetch mock. `routes` maps `"METHOD /api/path"` (query string
 * stripped) to a response; anything else 404s. Returns the mock so tests can
 * assert on calls.
 */
export function mockFetch(routes: Record<string, FakeResponse | ((url: URL, init?: RequestInit) => FakeResponse)>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost')
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}`
    const hit = routes[key]
    const resp: FakeResponse = hit
      ? typeof hit === 'function'
        ? hit(url, init)
        : hit
      : { status: 404, body: { detail: 'Not Found' } }
    return new Response(JSON.stringify(resp.body), {
      status: resp.status,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}
