import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderApp } from '../test/helpers'
import { Showcase } from './Showcase'

describe('Showcase (pre-login) page', () => {
  it('renders the hero, a Register and Log in link, and no sidebar nav', () => {
    renderApp(<Showcase />)
    expect(screen.getByRole('heading', { level: 1, name: /Explore the evolution of/ })).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: /Register|Open Lab/ }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('link', { name: 'Log in' }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('navigation', { name: 'Lab pages' })).not.toBeInTheDocument()
  })

  it('renders the four pillar cards linking into the real feature routes', () => {
    renderApp(<Showcase />)
    expect(screen.getByText('Telomere Dynamics')).toBeInTheDocument()
    expect(screen.getByText('Evolutionary Search')).toBeInTheDocument()
    expect(screen.getByText('Pareto Analysis')).toBeInTheDocument()
    expect(screen.getByText('Data Driven')).toBeInTheDocument()
  })

  it('renders the live simulation preview with working parameter sliders and a population grid', () => {
    renderApp(<Showcase />)
    expect(screen.getByText('Live Simulation Preview')).toBeInTheDocument()
    expect(screen.getByText('Maintenance investment')).toBeInTheDocument()
    expect(screen.getByTitle('Individual 1')).toBeInTheDocument()
    expect(screen.getByTitle('Individual 60')).toBeInTheDocument()
  })

  it('cites a real docs/EXPERIMENT_PROTOCOL.md section for every results claim', () => {
    renderApp(<Showcase />)
    expect(screen.getByText(/EXPERIMENT_PROTOCOL.md §12/)).toBeInTheDocument()
    expect(screen.getByText(/EXPERIMENT_PROTOCOL.md §11/)).toBeInTheDocument()
    expect(screen.getByText(/EXPERIMENT_PROTOCOL.md §15(?!\.)/)).toBeInTheDocument()
    expect(screen.getByText(/EXPERIMENT_PROTOCOL.md §15\.1/)).toBeInTheDocument()
  })

  it('renders the scope disclaimer and a basyid.dev credit instead of social icons', () => {
    renderApp(<Showcase />)
    expect(screen.getByText(/computational research prototype/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'basyid.dev' })).toHaveAttribute('href', 'https://basyid.dev')
  })
})
