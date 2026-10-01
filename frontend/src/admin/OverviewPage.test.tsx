import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { mockFetch, renderApp } from '../test/helpers'
import AdminApp from './AdminApp'
import OverviewPage from './OverviewPage'
import { EMPTY_STATS, makeStats } from './testSupport'

describe('OverviewPage', () => {
  it('renders KPIs, charts, latency and top users from the stats fixture', async () => {
    mockFetch({ 'GET /api/admin/stats': { status: 200, body: makeStats() } })
    renderApp(<OverviewPage />, { token: 'tok' })

    const pending = await screen.findByTestId('kpi-requests-pending')
    expect(pending).toHaveTextContent('2')
    expect(pending).toHaveAttribute('href', '/requests')
    expect(within(screen.getByTestId('kpi-users-total')).getByText('10')).toBeInTheDocument()
    expect(screen.getByTestId('kpi-users-total')).toHaveTextContent('8 verified')
    expect(screen.getByTestId('kpi-users-pro')).toHaveTextContent('3')
    expect(screen.getByTestId('kpi-users-disabled')).toHaveTextContent('1')
    expect(screen.getByTestId('kpi-requests-24h')).toHaveTextContent('1')
    expect(screen.getByTestId('kpi-requests-7d')).toHaveTextContent('4')
    expect(screen.getByTestId('kpi-jobs-running')).toHaveTextContent('1')
    expect(screen.getByTestId('kpi-error-rate')).toHaveTextContent('3.0%')
    expect(screen.getByRole('img', { name: /Signups per day/ })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /Compute events per day/ })).toBeInTheDocument()
    // slowest endpoint first
    const rows = screen.getAllByRole('listitem').filter((li) => li.textContent?.includes('/api/'))
    expect(rows[0]).toHaveTextContent('/api/evolve')
    expect(screen.getByText('bob')).toBeInTheDocument()
  })

  it('handles an empty database', async () => {
    mockFetch({ 'GET /api/admin/stats': { status: 200, body: EMPTY_STATS } })
    renderApp(<OverviewPage />, { token: 'tok' })
    expect(await screen.findByTestId('kpi-users-total')).toHaveTextContent('0')
    expect(screen.getByTestId('kpi-error-rate')).toHaveTextContent('0.0%')
    expect(screen.getByText('No traffic yet')).toBeInTheDocument()
    expect(screen.getByText('No activity yet')).toBeInTheDocument()
  })

  it('shows an error card with Retry', async () => {
    let calls = 0
    mockFetch({
      'GET /api/admin/stats': () => (++calls === 1 ? { status: 500, body: { detail: 'down' } } : { status: 200, body: makeStats() }),
    })
    renderApp(<OverviewPage />, { token: 'tok' })
    const retry = await screen.findByRole('button', { name: 'Retry' })
    retry.click()
    expect(await screen.findByTestId('kpi-users-total')).toBeInTheDocument()
  })
})

describe('AdminApp', () => {
  it('links back to Overview from an unknown sub-path', async () => {
    mockFetch({ 'GET /api/admin/stats': { status: 200, body: makeStats() } })
    renderApp(<AdminApp />, { route: '/nope' })
    expect(await screen.findByText('That admin page does not exist.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Admin' })).toBeInTheDocument()
  })
})
