import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError, demoHooks, request } from '../api/client'
import { DemoForm } from '../components/DemoForm'
import { PageHeader } from '../components/PageHeader'
import { FEATURES } from '../features'
import { DEMO_INDEX, demoCacheRoutes, me } from '../test/demoHelpers'
import { mockFetch, renderApp } from '../test/helpers'
import { resetDemoCache } from './cache'
import { useDemoScenario } from './context'
import { FeatureGate } from './FeatureGate'

const FEATURE = FEATURES.find((f) => f.path === '/simulate')!

function Page() {
  const sc = useDemoScenario<{ config: { seed: number } }, { marker: string }>()
  return (
    <div>
      <PageHeader feature={FEATURE} />
      <span data-testid="seeded">{sc ? `${sc.response.marker}:${sc.request.config.seed}` : 'none'}</span>
      <DemoForm aria-label="params">
        <input aria-label="stress" defaultValue="0.5" />
        <button type="submit">Run simulation</button>
      </DemoForm>
    </div>
  )
}

function Tree() {
  return (
    <FeatureGate feature="simulate">
      <Page />
    </FeatureGate>
  )
}

beforeEach(() => resetDemoCache())
afterEach(() => vi.unstubAllGlobals())

describe('FeatureGate / demo mode', () => {
  it('anonymous visitors see the banner, the scenario picker, the first scenario and a locked form', async () => {
    mockFetch({ ...demoCacheRoutes() })
    renderApp(<Tree />)

    expect(await screen.findByText('Precomputed example – not live compute')).toBeInTheDocument()
    const cards = await screen.findAllByRole('radio', { name: /run/i })
    expect(cards.map((c) => c.textContent)).toEqual([expect.stringContaining('Alpha run'), expect.stringContaining('Beta run')])
    expect(cards[0]).toHaveAttribute('aria-checked', 'true')
    await waitFor(() => expect(screen.getByTestId('seeded')).toHaveTextContent('alpha:1'))

    expect(screen.getByLabelText('stress')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Run simulation' })).toBeDisabled()
    // anonymous -> "Log in"; the locked-form note repeats the CTA
    expect(screen.getAllByRole('link', { name: 'Log in' }).length).toBeGreaterThan(0)

    fireEvent.click(cards[1])
    await waitFor(() => expect(screen.getByTestId('seeded')).toHaveTextContent('beta:2'))
    expect(cards[1]).toHaveAttribute('aria-checked', 'true')
  })

  it('free users get the Request Pro access CTA pointing at the account page', async () => {
    mockFetch({ ...demoCacheRoutes(), 'GET /api/auth/me': { status: 200, body: me() } })
    renderApp(<Tree />, { token: 'jwt' })
    const cta = (await screen.findAllByRole('link', { name: 'Request Pro access' }))[0]
    expect(cta).toHaveAttribute('href', '/account#access')
  })

  it('a pending request changes the CTA label', async () => {
    mockFetch({ ...demoCacheRoutes(), 'GET /api/auth/me': { status: 200, body: me({ pending_request: true }) } })
    renderApp(<Tree />, { token: 'jwt' })
    expect((await screen.findAllByRole('link', { name: 'View access request' })).length).toBeGreaterThan(0)
  })

  it('pro users get the live page (no demo panel, no scenario fetch) with a switch to demo', async () => {
    const fetchMock = mockFetch({ ...demoCacheRoutes(), 'GET /api/auth/me': { status: 200, body: me({ plan: 'pro' }) } })
    renderApp(<Tree />, { token: 'jwt' })
    expect(await screen.findByTestId('live-bar')).toBeInTheDocument()
    expect(screen.getByLabelText('stress')).toBeEnabled()
    expect(screen.queryByTestId('demo-panel')).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('demo-cache'))).toBe(false)

    fireEvent.click(screen.getByRole('switch', { name: /precomputed examples/i }))
    expect(await screen.findByTestId('demo-panel')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('stress')).toBeDisabled())
    // pro users can switch back
    fireEvent.click(await screen.findByRole('button', { name: /switch to live/i }))
    await waitFor(() => expect(screen.getByLabelText('stress')).toBeEnabled())
  })

  it('shows a retryable error when the demo cache cannot be fetched', async () => {
    mockFetch({})
    renderApp(<Tree />)
    expect(await screen.findByText(/Could not load the precomputed examples/)).toBeInTheDocument()

    mockFetch({ ...demoCacheRoutes() })
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(await screen.findAllByRole('radio', { name: /run/i })).toHaveLength(2)
  })

  it('says so when a feature has no published scenarios', async () => {
    mockFetch({ 'GET /demo-cache/index.json': { status: 200, body: { ...DEMO_INDEX, features: { simulate: [] } } } })
    renderApp(<Tree />)
    expect(await screen.findByText(/No precomputed examples are published/)).toBeInTheDocument()
  })

  it('survives a malformed index', async () => {
    mockFetch({ 'GET /demo-cache/index.json': { status: 200, body: { nope: true } } })
    renderApp(<Tree />)
    expect(await screen.findByText(/malformed/)).toBeInTheDocument()
  })

  it('blocks compute calls while the demo is shown: no request reaches the API', async () => {
    const fetchMock = mockFetch({ ...demoCacheRoutes() })
    renderApp(<Tree />)
    await screen.findByTestId('demo-panel')
    expect(demoHooks.active).toBe(true)
    const before = fetchMock.mock.calls.length
    const err = await request('/evolve', { method: 'POST', body: {} }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(403)
    expect(fetchMock.mock.calls.length).toBe(before)
    // public metadata still flows
    await request('/meta/bounds', { token: null }).catch(() => undefined)
    expect(fetchMock.mock.calls.length).toBe(before + 1)
  })
})

describe('demo replay', () => {
  it('answers the scenario endpoint locally (cached response) and polls a synthetic completed job', async () => {
    const fetchMock = mockFetch({ ...demoCacheRoutes() })
    renderApp(<Tree />)
    await waitFor(() => expect(screen.getByTestId('seeded')).toHaveTextContent('alpha:1'))
    const before = fetchMock.mock.calls.length
    await expect(request('/simulate', { method: 'POST', body: {} })).resolves.toEqual({ marker: 'alpha' })
    const job = await request<{ status: string; result: unknown }>('/jobs/demo:alpha')
    expect(job.status).toBe('completed')
    expect(job.result).toEqual({ marker: 'alpha' })
    await expect(request('/jobs')).resolves.toEqual([])
    expect(fetchMock.mock.calls.length).toBe(before)
  })
})
