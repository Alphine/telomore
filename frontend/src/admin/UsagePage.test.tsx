import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { setToken } from '../api/client'
import { mockFetch, renderApp } from '../test/helpers'
import UsagePage from './UsagePage'
import { chooseOption, installDomStubs, makeEvent, pageOf } from './testSupport'

beforeAll(installDomStubs)

const summary = {
  from: '2026-09-23T00:00:00Z',
  to: '2026-09-30T00:00:00Z',
  total: 100,
  errors: 3,
  error_rate: 0.03,
  unique_users: 5,
  unique_ips: 7,
  by_day: [{ date: '2026-09-30', count: 10, errors: 1 }],
  by_endpoint: [],
  by_kind: [],
}

describe('UsagePage', () => {
  it('shows events with status badges and the summary strip', async () => {
    mockFetch({
      'GET /api/admin/usage': {
        status: 200,
        body: pageOf([makeEvent({ id: 1 }), makeEvent({ id: 2, status_code: 404 }), makeEvent({ id: 3, status_code: 503 })]),
      },
      'GET /api/admin/usage/summary': { status: 200, body: summary },
    })
    renderApp(<UsagePage />, { token: 'tok' })
    expect(await screen.findByText('503')).toBeInTheDocument()
    expect(screen.getByText('404')).toBeInTheDocument()
    expect(screen.getByTestId('usage-summary')).toHaveTextContent('100')
    expect(screen.getByTestId('usage-summary')).toHaveTextContent('3 (3.0%)')
  })

  it('exports CSV with the active filters and the bearer token', async () => {
    setToken('tok')
    const created = vi.fn(() => 'blob:fake')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const fn = mockFetch({
      'GET /api/admin/usage': { status: 200, body: pageOf([makeEvent()]) },
      'GET /api/admin/usage/summary': { status: 200, body: summary },
      'GET /api/admin/usage/export.csv': { status: 200, body: 'id,ts\n' },
    })
    renderApp(<UsagePage />, { token: 'tok' })
    await screen.findByText('/api/simulate')

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } })
    chooseOption('Status filter', '5xx server error')
    await waitFor(() => {
      const last = fn.mock.calls.filter(([u]) => String(u).includes('/admin/usage?')).at(-1)
      expect(String(last?.[0])).toContain('status=5xx')
    })

    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }))
    await waitFor(() => expect(click).toHaveBeenCalled())
    const call = fn.mock.calls.find(([u]) => String(u).includes('export.csv'))
    const url = new URL(String(call?.[0]), 'http://localhost')
    expect(url.pathname).toBe('/api/admin/usage/export.csv')
    expect(url.searchParams.get('from')).toBe('2026-09-01')
    expect(url.searchParams.get('status')).toBe('5xx')
    expect(url.searchParams.has('page')).toBe(false)
    const headers = (call?.[1]?.headers ?? {}) as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok')
    expect(created).toHaveBeenCalled()
    expect(await screen.findByText('CSV exported')).toBeInTheDocument()
  })

  it('toasts when the export fails', async () => {
    mockFetch({
      'GET /api/admin/usage': { status: 200, body: pageOf([makeEvent()]) },
      'GET /api/admin/usage/summary': { status: 200, body: summary },
      'GET /api/admin/usage/export.csv': { status: 500, body: { detail: 'down' } },
    })
    renderApp(<UsagePage />, { token: 'tok' })
    await screen.findByText('/api/simulate')
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }))
    expect(await screen.findByText('Export failed')).toBeInTheDocument()
  })
})
