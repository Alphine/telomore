import { screen } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FEATURES } from '../features'
import { mockFetch, renderApp } from '../test/helpers'
import { Landing } from './Landing'

afterEach(() => vi.unstubAllGlobals())

describe('Landing page', () => {
  it('renders a feature card per FEATURES entry with correct hrefs', async () => {
    mockFetch({ 'GET /api/health': { status: 200, body: { status: 'ok' } } })
    renderApp(<Landing />)
    const cards = screen.getAllByTestId('feature-card')
    expect(cards).toHaveLength(FEATURES.length)
    const hrefs = cards.map((c) => c.getAttribute('href'))
    expect(hrefs).toEqual(FEATURES.map((f) => f.path))
    expect(hrefs).toEqual(
      expect.arrayContaining([
        '/simulate',
        '/evolve',
        '/pareto',
        '/sensitivity',
        '/gxe',
        '/active-learning',
        '/compare',
        '/experiments',
      ]),
    )
    for (const f of FEATURES) {
      expect(screen.getByText(`Open ${f.title} →`)).toBeInTheDocument()
    }
    expect(await screen.findByTestId('api-status')).toHaveTextContent('ok')
  })

  it('renders the disclaimer and scope caption verbatim', () => {
    mockFetch({})
    renderApp(<Landing />)
    expect(screen.getByText(/computational research prototype/)).toBeInTheDocument()
    expect(screen.getByText(/Fitness ≠ biological truth/)).toBeInTheDocument()
    expect(screen.getByText('Simulate. Evolve. Compare. Learn.')).toBeInTheDocument()
  })

  it('loads the recorded demo run asynchronously and shows the population canvas', async () => {
    mockFetch({})
    renderApp(<Landing />)
    expect(screen.getByText(/loading recorded run/)).toBeInTheDocument()
    expect(await screen.findByRole('img', { name: /cell population/i })).toBeInTheDocument()
    expect(screen.queryByText(/loading recorded run/)).not.toBeInTheDocument()
  })

  it('redirects backend-style /?token= and /?reset_token= links onto their routes', async () => {
    mockFetch({})
    const tree = (
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/verify" element={<div>VERIFY ROUTE</div>} />
        <Route path="/reset-password" element={<div>RESET ROUTE</div>} />
      </Routes>
    )
    const first = renderApp(tree, { route: '/?token=abc' })
    expect(await screen.findByText('VERIFY ROUTE')).toBeInTheDocument()
    first.unmount()
    renderApp(tree, { route: '/?reset_token=xyz' })
    expect(await screen.findByText('RESET ROUTE')).toBeInTheDocument()
  })
})
