import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { me } from '../test/demoHelpers'
import { mockFetch, renderApp } from '../test/helpers'
import { Layout } from './Layout'

function Tree() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<div>HOME PAGE</div>} />
        <Route path="/evolve" element={<div>EVOLVE PAGE</div>} />
        <Route path="/admin" element={<div>ADMIN PAGE</div>} />
      </Route>
    </Routes>
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('command palette', () => {
  it('opens with Ctrl-K, filters and navigates with the keyboard', async () => {
    mockFetch({})
    renderApp(<Tree />)
    await screen.findByText('HOME PAGE')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const input = await screen.findByRole('combobox', { name: /search pages/i })
    fireEvent.change(input, { target: { value: 'evol' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByText('EVOLVE PAGE')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('combobox')).not.toBeInTheDocument())
  })

  it('offers admin shortcuts only to admins', async () => {
    mockFetch({ 'GET /api/auth/me': { status: 200, body: me({ is_admin: true, plan: 'pro' }) }, 'GET /api/jobs': { status: 200, body: [] } })
    renderApp(<Tree />, { token: 'jwt' })
    await waitFor(() => expect(screen.getAllByRole('link', { name: /Admin/ }).length).toBeGreaterThan(0))
    fireEvent.keyDown(window, { key: 'K', metaKey: true })
    const input = await screen.findByRole('combobox')
    fireEvent.change(input, { target: { value: 'admin' } })
    expect(screen.getAllByRole('option').length).toBeGreaterThan(1)
  })

  it('does not list admin entries for ordinary users', async () => {
    mockFetch({ 'GET /api/auth/me': { status: 200, body: me() }, 'GET /api/jobs': { status: 200, body: [] } })
    renderApp(<Tree />, { token: 'jwt' })
    await screen.findByText('HOME PAGE')
    await waitFor(() => expect(screen.getAllByText('Account').length).toBeGreaterThan(0))
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const input = await screen.findByRole('combobox')
    fireEvent.change(input, { target: { value: 'admin' } })
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })
})
