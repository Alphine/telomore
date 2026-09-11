import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { THEME_STORAGE_KEY, useTheme } from './context'
import { ThemeProvider } from './ThemeProvider'

/** Stubs matchMedia for `(prefers-color-scheme: dark)`, returning `matches`
 * and letting the test fire a `change` event through the returned emitter. */
function stubMatchMedia(initialMatches: boolean) {
  let changeHandler: ((e: MediaQueryListEvent) => void) | null = null
  const mql = {
    matches: initialMatches,
    media: '(prefers-color-scheme: dark)',
    addEventListener: vi.fn((_event: string, handler: (e: MediaQueryListEvent) => void) => {
      changeHandler = handler
    }),
    removeEventListener: vi.fn(),
  }
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mql))
  return {
    fireChange: (matches: boolean) => {
      act(() => changeHandler?.({ matches } as MediaQueryListEvent))
    },
  }
}

function Probe() {
  const { preference, resolvedDark, setPreference } = useTheme()
  return (
    <div>
      <span data-testid="preference">{preference}</span>
      <span data-testid="resolved">{resolvedDark ? 'dark' : 'light'}</span>
      <button onClick={() => setPreference('light')}>set-light</button>
      <button onClick={() => setPreference('dark')}>set-dark</button>
      <button onClick={() => setPreference('system')}>set-system</button>
    </div>
  )
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    document.documentElement.classList.remove('dark')
  })

  it('defaults to system with no stored value, resolving against the OS preference', () => {
    stubMatchMedia(false)
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    expect(screen.getByTestId('preference')).toHaveTextContent('system')
    expect(screen.getByTestId('resolved')).toHaveTextContent('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('setting light persists to localStorage, resolves light, and removes the dark class', () => {
    stubMatchMedia(true) // OS is dark, to prove the override wins
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    act(() => screen.getByText('set-light').click())
    expect(screen.getByTestId('preference')).toHaveTextContent('light')
    expect(screen.getByTestId('resolved')).toHaveTextContent('light')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('setting dark persists to localStorage, resolves dark, and applies the dark class', () => {
    stubMatchMedia(false) // OS is light, to prove the override wins
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    act(() => screen.getByText('set-dark').click())
    expect(screen.getByTestId('preference')).toHaveTextContent('dark')
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark')
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('system preference tracks a mocked matchMedia change event', () => {
    const mq = stubMatchMedia(false)
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    expect(screen.getByTestId('resolved')).toHaveTextContent('light')
    mq.fireChange(true)
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    mq.fireChange(false)
    expect(screen.getByTestId('resolved')).toHaveTextContent('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('reads an existing stored preference instead of defaulting to system', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    stubMatchMedia(false)
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    expect(screen.getByTestId('preference')).toHaveTextContent('dark')
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark')
  })

  it('switching back to system re-follows the OS preference', () => {
    stubMatchMedia(true)
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    act(() => screen.getByText('set-light').click())
    expect(screen.getByTestId('resolved')).toHaveTextContent('light')
    act(() => screen.getByText('set-system').click())
    expect(screen.getByTestId('preference')).toHaveTextContent('system')
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark')
  })

  it('useTheme throws a clear error outside ThemeProvider', () => {
    function Bare() {
      useTheme()
      return null
    }
    expect(() => render(<Bare />)).toThrow(/useTheme must be used inside/)
  })
})
