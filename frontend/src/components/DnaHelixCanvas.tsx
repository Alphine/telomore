// Purely decorative animated DNA double-helix for the Landing hero (docs/
// ROADMAP.md "GPU strategy": client-side visualization only, no compute
// implications -- this draws nothing derived from any simulation data).
// Canvas2D is sufficient for two sine strands + rungs, so this intentionally
// skips the WebGL2 path that <PopulationCanvas /> uses for its particle
// field; the geometry math lives in ./dnaHelixGeometry.ts so this file only
// exports the component (see that file's header for why).
import { useEffect, useRef } from 'react'

import { usePrefersDark } from './charts/theme'
import { buildBokehField, buildHelixFrame, depthToLitFactor, lerpHexColor } from './dnaHelixGeometry'

// Premium-glow palette (2026-09-11 polish pass): blue -> violet gradient per
// strand, matching the reference mockup's blue/purple/cyan glow direction,
// while keeping the two backbones visually distinct (cyan-blue vs.
// violet-purple) so the double helix still reads as two strands rather than
// one blended ribbon. Each strand fades from its "top" hue to its "bottom"
// hue along its length via `lerpHexColor` (see the draw loop).
const STRAND_A = {
  light: { top: '#0284c7', bottom: '#0369a1' }, // sky-600 / sky-700
  dark: { top: '#38bdf8', bottom: '#0ea5e9' }, // sky-400 / sky-500
}
const STRAND_B = {
  light: { top: '#7c3aed', bottom: '#a21caf' }, // violet-600 / purple-700
  dark: { top: '#a78bfa', bottom: '#e879f9' }, // violet-400 / fuchsia-400
}
const RUNG_GLOW = { light: '#0ea5e9', dark: '#38bdf8' } // sky-500 / sky-400
const BOKEH_COLOR = { light: 'rgba(56, 189, 248, 0.5)', dark: 'rgba(167, 139, 250, 0.55)' }

const ROWS = 48
const RUNG_COUNT = 14
const TURNS = 2.5
const RADIANS_PER_SECOND = 0.6 // slow, ambient rotation
const BOKEH_COUNT = 20
const BOKEH_SEED = 7

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

    // Deterministic, built once -- the bokeh field's layout never changes,
    // only its opacity pulses over time (see `bokehPulse` in `draw`).
    const bokeh = buildBokehField(BOKEH_COUNT, BOKEH_SEED)

    const draw = (phase: number) => {
      const dark = darkRef.current
      c2d.clearRect(0, 0, width, height)
      const { strandA, strandB, rungs } = buildHelixFrame({ rows: ROWS, rungCount: RUNG_COUNT, turns: TURNS, phase })

      const toPx = (p: { x: number; y: number }) => ({ x: p.x * width, y: p.y * height })
      const depthWidth = (depth: number) => (1.6 + 1.8 * ((depth + 1) / 2)) * dpr

      // Ambient background bokeh dots, drawn first so everything else sits
      // on top. Cheap: fixed count, no physics, opacity gently pulses per
      // dot using its own phase offset so they don't blink in lockstep.
      const bokehColor = BOKEH_COLOR[dark ? 'dark' : 'light']
      for (const dot of bokeh) {
        const pulse = 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(phase * 0.8 + dot.phase))
        c2d.save()
        c2d.globalAlpha = pulse
        c2d.shadowColor = bokehColor
        c2d.shadowBlur = 6 * dpr
        c2d.fillStyle = bokehColor
        c2d.beginPath()
        c2d.arc(dot.x * width, dot.y * height, dot.r * Math.min(width, height), 0, Math.PI * 2)
        c2d.fill()
        c2d.restore()
      }

      // Base-pair rungs as small glowing nodes (shadowBlur'd circles) rather
      // than plain connecting lines, sized/brightened by depth.
      const rungColor = RUNG_GLOW[dark ? 'dark' : 'light']
      for (const [a, b] of rungs) {
        for (const p of [a, b]) {
          const lit = depthToLitFactor(p.depth)
          const px = toPx(p)
          const radius = (2 + 1.6 * lit) * dpr
          c2d.save()
          c2d.globalAlpha = 0.55 + 0.35 * lit
          c2d.shadowColor = rungColor
          c2d.shadowBlur = 8 * dpr * lit
          c2d.fillStyle = rungColor
          c2d.beginPath()
          c2d.arc(px.x, px.y, radius, 0, Math.PI * 2)
          c2d.fill()
          c2d.restore()
        }
      }

      // Strands: a gradient from each strand's "top" hue to its "bottom"
      // hue along its length (lerpHexColor), further lit/shadowed per
      // segment by the pseudo-3D depth (depthToLitFactor) so the near phase
      // of the rotation reads brighter than the far phase. A soft glow
      // (shadowBlur) sits under a sharper core stroke for the "luminous
      // strand" look without a blurry mess.
      const strokeStrand = (points: { x: number; y: number; depth: number }[], hues: { top: string; bottom: string }) => {
        for (let i = 0; i < points.length - 1; i++) {
          const p0 = points[i]
          const p1 = points[i + 1]
          const depth = (p0.depth + p1.depth) / 2
          const lit = depthToLitFactor(depth)
          const t = (p0.y + p1.y) / 2
          const baseColor = lerpHexColor(hues.top, hues.bottom, t)
          const alpha = 0.4 + 0.5 * lit
          const width_ = depthWidth(depth)

          c2d.save()
          c2d.shadowColor = withAlpha(baseColor, Math.min(1, alpha + 0.2))
          c2d.shadowBlur = 5 * dpr * lit
          c2d.strokeStyle = withAlpha(baseColor, alpha)
          c2d.lineWidth = width_
          c2d.lineCap = 'round'
          c2d.beginPath()
          c2d.moveTo(p0.x * width, p0.y * height)
          c2d.lineTo(p1.x * width, p1.y * height)
          c2d.stroke()
          c2d.restore()
        }
      }
      strokeStrand(strandA, STRAND_A[dark ? 'dark' : 'light'])
      strokeStrand(strandB, STRAND_B[dark ? 'dark' : 'light'])
    }

    let raf = 0
    let start = performance.now()
    let elapsedAtPause = 0

    if (reduceMotion) {
      // Static single frame -- respect the OS preference instead of ignoring it.
      draw(0)
    } else {
      // Each frame costs ~140 shadowBlur'd fills/strokes (bokeh + rungs +
      // strand segments) -- one of the most expensive Canvas2D operations.
      // Throttled to ~30fps (imperceptible for this slow ambient rotation,
      // RADIANS_PER_SECOND=0.6) so it costs half as much main-thread time
      // per second as a naive 60fps loop.
      const FRAME_INTERVAL_MS = 1000 / 30
      let lastFrame = 0

      const loop = (now: number) => {
        raf = requestAnimationFrame(loop)
        if (now - lastFrame < FRAME_INTERVAL_MS) return
        lastFrame = now
        const t = (now - start) / 1000
        draw(t * RADIANS_PER_SECOND)
      }

      const stop = () => {
        if (raf) {
          elapsedAtPause = performance.now() - start
          cancelAnimationFrame(raf)
          raf = 0
        }
      }
      const resume = () => {
        if (raf === 0) {
          start = performance.now() - elapsedAtPause
          lastFrame = 0
          raf = requestAnimationFrame(loop)
        }
      }

      const onVisibility = () => {
        if (document.visibilityState === 'hidden') stop()
        else resume()
      }
      document.addEventListener('visibilitychange', onVisibility)

      // Purely decorative and only shown in the Landing hero -- no reason to
      // keep spending frame budget once the user has scrolled past it, which
      // is the main source of felt scroll jank (the loop used to run
      // forever regardless of scroll position). Feature-detected, like the
      // matchMedia check above: fall back to always-on if unsupported.
      let io: IntersectionObserver | null = null
      if (typeof IntersectionObserver === 'function') {
        io = new IntersectionObserver(([entry]) => {
          if (entry.isIntersecting) resume()
          else stop()
        })
        io.observe(canvas)
      } else {
        resume()
      }

      return () => {
        cancelAnimationFrame(raf)
        document.removeEventListener('visibilitychange', onVisibility)
        io?.disconnect()
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
