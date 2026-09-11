// Purely decorative animated DNA double-helix for the Landing hero (docs/
// ROADMAP.md "GPU strategy": client-side visualization only, no compute
// implications -- this draws nothing derived from any simulation data).
// Canvas2D is sufficient for two sine strands + rungs, so this intentionally
// skips the WebGL2 path that <PopulationCanvas /> uses for its particle
// field; the geometry math lives in ./dnaHelixGeometry.ts so this file only
// exports the component (see that file's header for why).
import { useEffect, useRef } from 'react'

import { usePrefersDark } from './charts/theme'
import { buildHelixFrame } from './dnaHelixGeometry'

// Same accent palette as PopulationCanvas / the rest of the app: teal-500
// for one backbone, rose-500 for the other, base-pair rungs in slate.
const STRAND_A = { light: '#0d9488', dark: '#2dd4bf' } // teal-600 / teal-400
const STRAND_B = { light: '#e11d48', dark: '#fb7185' } // rose-600 / rose-400
const RUNG = { light: 'rgba(100, 116, 139, 0.35)', dark: 'rgba(148, 163, 184, 0.35)' } // slate-500/400

const ROWS = 48
const RUNG_COUNT = 14
const TURNS = 2.5
const RADIANS_PER_SECOND = 0.6 // slow, ambient rotation

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export interface DnaHelixCanvasProps {
  className?: string
}

export function DnaHelixCanvas({ className }: DnaHelixCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dark = usePrefersDark()
  const darkRef = useRef(dark)

  // Mirror the latest dark-mode value into a ref (after render, following
  // <PopulationCanvas />'s convention) so the animation loop below can read
  // it without re-subscribing the effect on every theme change.
  useEffect(() => {
    darkRef.current = dark
  })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let ctx: CanvasRenderingContext2D | null = null
    try {
      ctx = canvas.getContext('2d')
    } catch {
      ctx = null
    }
    if (!ctx) return
    const c2d = ctx

    const reduceMotion = prefersReducedMotion()
    let dpr = Math.min(window.devicePixelRatio || 1, 2)
    let width = 0
    let height = 0

    const fit = () => {
      const parent = canvas.parentElement
      const w = parent?.clientWidth || canvas.clientWidth || 320
      const h = parent?.clientHeight || canvas.clientHeight || 320
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = Math.max(1, Math.round(w * dpr))
      height = Math.max(1, Math.round(h * dpr))
      canvas.width = width
      canvas.height = height
    }
    fit()
    window.addEventListener('resize', fit)

    const draw = (phase: number) => {
      const dark = darkRef.current
      c2d.clearRect(0, 0, width, height)
      const { strandA, strandB, rungs } = buildHelixFrame({ rows: ROWS, rungCount: RUNG_COUNT, turns: TURNS, phase })

      const toPx = (p: { x: number; y: number }) => ({ x: p.x * width, y: p.y * height })
      const depthAlpha = (depth: number) => 0.45 + 0.55 * ((depth + 1) / 2)
      const depthWidth = (depth: number) => (1.4 + 1.6 * ((depth + 1) / 2)) * dpr

      // Base-pair rungs first, so the strands draw on top of them.
      c2d.strokeStyle = RUNG[dark ? 'dark' : 'light']
      for (const [a, b] of rungs) {
        const pa = toPx(a)
        const pb = toPx(b)
        c2d.lineWidth = 1 * dpr
        c2d.beginPath()
        c2d.moveTo(pa.x, pa.y)
        c2d.lineTo(pb.x, pb.y)
        c2d.stroke()
      }

      const strokeStrand = (points: { x: number; y: number; depth: number }[], color: string) => {
        for (let i = 0; i < points.length - 1; i++) {
          const p0 = points[i]
          const p1 = points[i + 1]
          const depth = (p0.depth + p1.depth) / 2
          c2d.strokeStyle = withAlpha(color, depthAlpha(depth))
          c2d.lineWidth = depthWidth(depth)
          c2d.beginPath()
          c2d.moveTo(p0.x * width, p0.y * height)
          c2d.lineTo(p1.x * width, p1.y * height)
          c2d.stroke()
        }
      }
      strokeStrand(strandA, STRAND_A[dark ? 'dark' : 'light'])
      strokeStrand(strandB, STRAND_B[dark ? 'dark' : 'light'])
    }

    let raf = 0
    let start = performance.now()

    if (reduceMotion) {
      // Static single frame -- respect the OS preference instead of ignoring it.
      draw(0)
    } else {
      const loop = (now: number) => {
        const t = (now - start) / 1000
        draw(t * RADIANS_PER_SECOND)
        raf = requestAnimationFrame(loop)
      }
      const onVisibility = () => {
        if (document.visibilityState === 'hidden') {
          cancelAnimationFrame(raf)
          raf = 0
        } else if (raf === 0) {
          start = performance.now()
          raf = requestAnimationFrame(loop)
        }
      }
      document.addEventListener('visibilitychange', onVisibility)
      raf = requestAnimationFrame(loop)

      return () => {
        cancelAnimationFrame(raf)
        document.removeEventListener('visibilitychange', onVisibility)
        window.removeEventListener('resize', fit)
      }
    }

    return () => {
      window.removeEventListener('resize', fit)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={className}
      style={{ width: '100%', height: '100%', display: 'block' }}
    />
  )
}
