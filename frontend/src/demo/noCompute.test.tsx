// Demo mode must never reach the live compute API. Every feature route is opened as an
// anonymous visitor, a free account and a Pro account that switched to demo; the test
// fails if any request goes to a compute endpoint or if any /api call is not a plain GET.
import { act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MODE_STORAGE_KEY } from '../access/context'
import { request, requestBlob } from '../api/client'
import { resetBoundsCache } from '../api/useBounds'
import App from '../App'
import { FEATURES } from '../features'
import { BOUNDS } from '../test/fixtures'
import { me } from '../test/demoHelpers'
import { mockFetch, renderApp } from '../test/helpers'
import { resetDemoCache } from './cache'

vi.mock('../components/charts/Plot', () => ({ Plot: () => <div data-testid="plot" /> }))

const COMPUTE = ['/simulate', '/evolve', '/pareto', '/sensitivity', '/gxe', '/active-learning', '/compare', '/jobs',
  '/sequence', '/llm', '/benchmark', '/meta/chip-to-params']

const PERSONAS = {
  anonymous: { token: null, user: null, demoPref: false },
  free: { token: 'tok', user: me({ plan: 'free' }), demoPref: false },
  'pro in demo mode': { token: 'tok', user: me({ plan: 'pro' }), demoPref: true },
} as const

beforeEach(() => {
  resetBoundsCache()
  resetDemoCache()
  window.localStorage.clear()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe.each(Object.entries(PERSONAS))('demo mode as %s', (_name, persona) => {
  it.each(FEATURES.map((f) => f.path))('%s makes no live compute call', async (path) => {
    if (persona.demoPref) window.localStorage.setItem(MODE_STORAGE_KEY, 'demo')
    const fetchMock = mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      'GET /api/auth/me': persona.user ? { status: 200, body: persona.user } : { status: 401, body: { detail: 'no' } },
      'GET /demo-cache/index.json': { status: 200, body: { version: 1, features: {} } },
    })
    renderApp(<App />, { route: path, token: persona.token })
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('demo-cache/index.json'))).toBe(true))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60))
    })
    const calls = fetchMock.mock.calls.map((c) => ({
      path: new URL(String(c[0]), 'http://localhost').pathname.replace(/^\/api/, ''),
      isApi: new URL(String(c[0]), 'http://localhost').pathname.startsWith('/api/'),
      method: ((c[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase(),
    }))
    const bad = calls.filter(
      (c) => c.isApi && (c.method !== 'GET' || COMPUTE.some((p) => c.path === p || c.path.startsWith(`${p}/`))),
    )
    expect(bad).toEqual([])
  })
})

describe('demo guard in the API client', () => {
  it('refuses every compute path locally while a demo page is mounted', async () => {
    const fetchMock = mockFetch({
      'GET /api/meta/bounds': { status: 200, body: BOUNDS },
      'GET /demo-cache/index.json': { status: 200, body: { version: 1, features: {} } },
    })
    renderApp(<App />, { route: '/simulate' })
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('demo-cache/index.json'))).toBe(true))
    const before = fetchMock.mock.calls.length
    for (const p of COMPUTE) {
      // a call is either refused (403 demo_mode) or answered from the cached scenario; never sent
      await request(p, { method: 'POST', body: {} }).catch((e: unknown) => expect(e).toMatchObject({ status: 403 }))
    }
    await expect(requestBlob('/experiments/R1/artifacts/a.csv')).rejects.toMatchObject({ status: 403 })
    expect(fetchMock.mock.calls.length).toBe(before)
  })
})
