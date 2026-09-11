import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider } from '../theme/ThemeProvider'
import { ThemeToggle } from './ThemeToggle'

function stubMatchMedia(matches = false) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches,
      media: '(prefers-color-scheme: dark)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  )
}

describe('ThemeToggle', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    document.documentElement.classList.remove('dark')
  })

  it('renders exactly three theme options as a radiogroup, System active by default', () => {
    stubMatchMedia(false)
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    )
    const group = screen.getByRole('radiogroup', { name: 'Theme' })
    const options = group.querySelectorAll('[role="radio"]')
    expect(options).toHaveLength(3)
    expect(screen.getByRole('radio', { name: 'System theme' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Light theme' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('radio', { name: 'Dark theme' })).toHaveAttribute('aria-checked', 'false')
  })

  it('clicking Dark selects it and applies the dark class', () => {
    stubMatchMedia(false)
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Dark theme' }))
    expect(screen.getByRole('radio', { name: 'Dark theme' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'System theme' })).toHaveAttribute('aria-checked', 'false')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('clicking Light selects it and removes the dark class even if the OS prefers dark', () => {
    stubMatchMedia(true)
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Light theme' }))
    expect(screen.getByRole('radio', { name: 'Light theme' })).toHaveAttribute('aria-checked', 'true')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})
