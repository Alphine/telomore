// jsdom has no real canvas implementation (no `canvas` npm package
// installed in this repo -- see PopulationCanvas.tsx's own try/catch
// pattern around getContext), so this mocks a minimal 2D context and the
// animation-frame globals to exercise the mount/animate/unmount lifecycle
// deterministically.
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DnaHelixCanvas } from './DnaHelixCanvas'

function stubContext2D() {
  return {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
  } as unknown as CanvasRenderingContext2D
}

// jsdom has no IntersectionObserver implementation. This stub immediately
// reports "intersecting" (matching a freshly mounted, on-screen hero) and
// exposes `trigger` so tests can simulate scrolling the canvas in/out of view.
class StubIntersectionObserver {
  static instances: StubIntersectionObserver[] = []
  callback: (entries: { isIntersecting: boolean }[]) => void
  constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
    this.callback = callback
    StubIntersectionObserver.instances.push(this)
  }
  observe = vi.fn(() => this.callback([{ isIntersecting: true }]))
  disconnect = vi.fn()
  trigger(isIntersecting: boolean) {
    this.callback([{ isIntersecting }])
  }
}

describe('DnaHelixCanvas', () => {
  let rafCallbacks: FrameRequestCallback[]
  let rafId: number
  let cancelSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    rafCallbacks = []
    rafId = 0
    cancelSpy = vi.fn()
    StubIntersectionObserver.instances = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(stubContext2D())
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb)
      rafId += 1
      return rafId
    })
    vi.stubGlobal('cancelAnimationFrame', cancelSpy)
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('mounts without throwing and schedules an animation frame', () => {
    expect(() => render(<DnaHelixCanvas />)).not.toThrow()
    expect(rafCallbacks.length).toBeGreaterThan(0)
  })

  it('renders a hidden decorative canvas', () => {
    const { container } = render(<DnaHelixCanvas />)
    const canvas = container.querySelector('canvas')
    expect(canvas).not.toBeNull()
    expect(canvas).toHaveAttribute('aria-hidden')
  })

  it('runs at least one draw frame using the 2D context', () => {
    render(<DnaHelixCanvas />)
    // Fire the first scheduled frame to exercise the draw path.
    expect(rafCallbacks.length).toBeGreaterThan(0)
    expect(() => rafCallbacks[0](16)).not.toThrow()
  })

  it('cancels the animation frame on unmount, leaving no leaked loop', () => {
    const { unmount } = render(<DnaHelixCanvas />)
    expect(rafCallbacks.length).toBeGreaterThan(0)
    unmount()
    expect(cancelSpy).toHaveBeenCalled()
  })

  it('renders a single static frame and skips the rAF loop under prefers-reduced-motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    const { unmount } = render(<DnaHelixCanvas />)
    expect(rafCallbacks).toHaveLength(0)
    expect(() => unmount()).not.toThrow()
  })

  it('stops scheduling frames once scrolled out of view, and resumes when back in view', () => {
    render(<DnaHelixCanvas />)
    const observer = StubIntersectionObserver.instances[0]
    expect(rafCallbacks.length).toBeGreaterThan(0)
    const scheduledBeforePause = rafCallbacks.length

    observer.trigger(false)
    expect(cancelSpy).toHaveBeenCalled()

    const scheduledAtPause = rafCallbacks.length
    observer.trigger(false) // redundant pause: must not schedule/cancel again
    expect(rafCallbacks.length).toBe(scheduledAtPause)

    observer.trigger(true)
    expect(rafCallbacks.length).toBeGreaterThan(scheduledBeforePause)
  })
})
