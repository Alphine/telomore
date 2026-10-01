import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { request } from '../api/client'
import { me } from '../test/demoHelpers'
import { mockFetch, renderApp } from '../test/helpers'
import { derivePlan, useAccess } from './context'

const NOW = Date.parse('2026-10-01T00:00:00Z')

describe('derivePlan', () => {
  it('maps users to plans', () => {
    expect(derivePlan(null, NOW)).toEqual({ plan: 'anonymous', canLive: false })
    expect(derivePlan(me(), NOW)).toEqual({ plan: 'free', canLive: false })
    expect(derivePlan(me({ plan: 'pro' }), NOW)).toEqual({ plan: 'pro', canLive: true })
    expect(derivePlan(me({ plan: 'pro', is_admin: true }), NOW)).toEqual({ plan: 'admin', canLive: true })
  })

  it('treats a pro plan past its expiry as free, and a legacy user without a plan as free', () => {
    expect(derivePlan(me({ plan: 'pro', plan_expires_at: '2026-09-01T00:00:00Z' }), NOW).canLive).toBe(false)
    expect(derivePlan(me({ plan: 'pro', plan_expires_at: '2027-01-01T00:00:00Z' }), NOW).canLive).toBe(true)
    const legacy = { id: 1, username: 'x', email: 'x@x.io', is_verified: true }
    expect(derivePlan(legacy, NOW).plan).toBe('free')
  })
})

function Probe() {
  const a = useAccess()
  return (
    <div>
      <span data-testid="state">
        {a.status}|{a.plan}|{a.mode}|{String(a.canLive)}
      </span>
      <button onClick={() => a.setPreferredMode(a.mode === 'live' ? 'demo' : 'live')}>toggle</button>
      <button
        onClick={() => {
          void request('/simulate', { method: 'POST', body: {} }).catch(() => undefined)
        }}
      >
        compute
      </button>
    </div>
  )
}

const state = () => screen.getByTestId('state').textContent

beforeEach(() => window.localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe('useAccess mode switching', () => {
  it('anonymous visitors are in demo mode', async () => {
    mockFetch({})
    renderApp(<Probe />)
    expect(state()).toBe('anonymous|anonymous|demo|false')
  })

  it('free users are in demo mode and cannot opt into live', async () => {
    mockFetch({ 'GET /api/auth/me': { status: 200, body: me() } })
    renderApp(<Probe />, { token: 'jwt' })
    await waitFor(() => expect(state()).toBe('authenticated|free|demo|false'))
    fireEvent.click(screen.getByText('toggle'))
    expect(state()).toBe('authenticated|free|demo|false')
  })

  it('pro users start live and can flip to demo and back (choice is remembered)', async () => {
    mockFetch({ 'GET /api/auth/me': { status: 200, body: me({ plan: 'pro' }) } })
    renderApp(<Probe />, { token: 'jwt' })
    await waitFor(() => expect(state()).toBe('authenticated|pro|live|true'))
    fireEvent.click(screen.getByText('toggle'))
    expect(state()).toBe('authenticated|pro|demo|true')
    expect(window.localStorage.getItem('tel_mode')).toBe('demo')
    fireEvent.click(screen.getByText('toggle'))
    expect(state()).toBe('authenticated|pro|live|true')
  })

  it('admins count as live-capable', async () => {
    mockFetch({ 'GET /api/auth/me': { status: 200, body: me({ plan: 'pro', is_admin: true }) } })
    renderApp(<Probe />, { token: 'jwt' })
    await waitFor(() => expect(state()).toBe('authenticated|admin|live|true'))
  })

  it('a 403 pro_required from the API forces demo mode instead of crashing', async () => {
    const fetchMock = mockFetch({
      'GET /api/auth/me': { status: 200, body: me({ plan: 'pro' }) },
      'POST /api/simulate': { status: 403, body: { detail: { code: 'pro_required', message: 'Pro only' } } },
    })
    renderApp(<Probe />, { token: 'jwt' })
    await waitFor(() => expect(state()).toBe('authenticated|pro|live|true'))
    fireEvent.click(screen.getByText('compute'))
    await waitFor(() => expect(state()).toBe('authenticated|pro|demo|true'))
    // and the account is re-read so a real plan change can lift the lock
    await waitFor(() => expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/auth/me')).length).toBeGreaterThan(1))
  })
})
