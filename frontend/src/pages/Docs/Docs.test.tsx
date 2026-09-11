import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderApp } from '../../test/helpers'
import { Docs } from './index'

// Rendered through the same unauthenticated harness Landing.test.tsx uses
// (renderApp with no `token`) -- Docs is public, same tier as Landing, so it
// must render with no auth state at all, not just "logged out but gated".
describe('Docs page', () => {
  it('defaults to the Overview tab showing a distinctive README string', () => {
    renderApp(<Docs />)
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
    // Unique to README.md -- the Kaggle framing line does not appear in
    // MODEL.md or SCIENTIFIC_SCOPE.md.
    expect(screen.getByText(/AI4S Open Innovation/)).toBeInTheDocument()
  })

  it('switches to the Model tab and shows a distinctive MODEL.md string, hiding the README one', () => {
    renderApp(<Docs />)
    fireEvent.click(screen.getByRole('tab', { name: 'Model & Methods' }))
    expect(screen.getByRole('tab', { name: 'Model & Methods' })).toHaveAttribute('aria-selected', 'true')
    // Matches both the rendered <h1> and its TOC jump link -- either way it
    // proves MODEL.md's real content is showing.
    expect(screen.getAllByText(/Telomere dynamics model/).length).toBeGreaterThan(0)
    expect(screen.getByTestId('docs-source-caption')).toHaveTextContent('docs/MODEL.md')
    expect(screen.queryByText(/AI4S Open Innovation/)).not.toBeInTheDocument()
  })

  it('switches to the Scientific Scope tab and shows a distinctive SCIENTIFIC_SCOPE.md string', () => {
    renderApp(<Docs />)
    fireEvent.click(screen.getByRole('tab', { name: 'Scientific Scope' }))
    expect(screen.getByRole('tab', { name: 'Scientific Scope' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(/Not a predictor of human lifespan/)).toBeInTheDocument()
  })

  it('renders an in-page table of contents with jump links while the long Model doc is shown', () => {
    renderApp(<Docs />)
    fireEvent.click(screen.getByRole('tab', { name: 'Model & Methods' }))
    const toc = screen.getByRole('navigation', { name: 'On this page' })
    expect(toc).toBeInTheDocument()
    // MODEL.md has many `#`/`##` headings; assert a real, known one shows up
    // as a jump link rather than asserting an exact (edit-fragile) count.
    expect(screen.getByRole('link', { name: /Parameters/ })).toBeInTheDocument()
  })

  it('shows a "back to top" link', () => {
    renderApp(<Docs />)
    expect(screen.getByRole('link', { name: /Back to top/ })).toHaveAttribute('href', '#doc-top')
  })
})
