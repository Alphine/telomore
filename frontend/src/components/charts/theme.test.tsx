import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider } from '../../theme/ThemeProvider'
import { usePrefersDark } from './theme'

function stubMatchMedia(matches: boolean) {
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

function Probe() {
  const dark = usePrefersDark()
  return <span data-testid="dark">{String(dark)}</span>
}

describe('usePrefersDark', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reflects the ThemeProvider resolved theme when mounted inside one', () => {
    stubMatchMedia(false)
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    expect(screen.getByTestId('dark')).toHaveTextContent('false')
  })

  it('falls back to a raw prefers-color-scheme read when no ThemeProvider is mounted', () => {
    stubMatchMedia(true)
    render(<Probe />)
    expect(screen.getByTestId('dark')).toHaveTextContent('true')
  })
})
