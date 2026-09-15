import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { FEATURES } from '../features'
import { renderApp } from '../test/helpers'
import { Showcase } from './Showcase'

describe('Showcase (pre-login) page', () => {
  it('renders the hero, a Register and Log in link, and no sidebar nav', () => {
    renderApp(<Showcase />)
    expect(screen.getByRole('heading', { level: 1, name: /Evolve smarter biology/ })).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: /Register/ }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('link', { name: 'Log in' }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('navigation', { name: 'Lab pages' })).not.toBeInTheDocument()
  })

  it('renders one feature card per FEATURES entry', () => {
    renderApp(<Showcase />)
    for (const f of FEATURES) {
      expect(screen.getByText(f.title)).toBeInTheDocument()
      expect(screen.getByText(f.description)).toBeInTheDocument()
    }
  })

  it('cites a real docs/EXPERIMENT_PROTOCOL.md section for every results claim', () => {
    renderApp(<Showcase />)
    expect(screen.getByText(/EXPERIMENT_PROTOCOL.md §12/)).toBeInTheDocument()
    expect(screen.getByText(/EXPERIMENT_PROTOCOL.md §11/)).toBeInTheDocument()
    expect(screen.getByText(/EXPERIMENT_PROTOCOL.md §15/)).toBeInTheDocument()
  })

  it('renders the scope disclaimer', () => {
    renderApp(<Showcase />)
    expect(screen.getByText(/computational research prototype/)).toBeInTheDocument()
  })
})
