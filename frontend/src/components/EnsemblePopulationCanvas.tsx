// Multi-stream sibling of <PopulationCanvas /> for the ensemble / uncertainty
// visualization (ROADMAP.md candidate feature #2: "many trajectories = many
// particle streams"). Rendering only -- every number comes from the
// server-side POST /api/simulate/ensemble response (backend/routers/simulate.py),
// nothing is simulated here (docs/ROADMAP.md "GPU strategy").
//
// SCOPE REDUCTION (documented per the build brief): the single-run
// <PopulationCanvas /> has a WebGL2 renderer with a Canvas 2D fallback for one
// particle stream. Building a second WebGL2 program that draws N independently
// seeded, independently timed streams (each with its own senescent-colouring
// and brightness) would roughly multiply that renderer's complexity by the
// stream cap for a feature that is explicitly allowed a lighter-touch
// treatment. This component instead uses Canvas 2D only, for up to
// `MAX_STREAMS` seeds, each drawn with reduced opacity so overlapping streams
// visually accumulate into a denser cloud where seeds agree and a hazier one
// where they diverge -- a reasonable proxy for "the spread on the canvas",
// not a from-scratch multi-stream WebGL rewrite.
import { useEffect, useMemo, useRef, useState } from 'react'

import type { EnsembleBands, EnsembleSeedResult } from '../api/types'
import { ensembleSeedFrameAt } from './ensembleFrames'
import { PARTICLE_STRIDE, makeParticles, stepParticles } from './populationFrames'

export const MAX_STREAMS = 5
const STREAM_CAP = 260 // particles per stream (single-run default is 1500; N streams overlaid needs less each)
const SPEEDS = [5, 10, 20, 40]

// Same palette as PopulationCanvas, one hue per stream via HSL rotation so
// streams are distinguishable while staying in the living/senescent family.
function streamColor(streamIndex: number, senescent: boolean, bright: number, alpha: number): string {
  const hueLive = 174 // teal-500
  const hueSen = 350 // rose-500
  const hue = (senescent ? hueSen : hueLive) + streamIndex * 6
  const lightness = Math.round((senescent ? 55 : 45) * Math.min(1, bright + 0.3))
  return `hsla(${hue}, 70%, ${lightness}%, ${alpha})`
}

export interface EnsemblePopulationCanvasProps {
  series: EnsembleSeedResult[]
  bands: EnsembleBands
  initialLength: number
  dark?: boolean
}

export function EnsemblePopulationCanvas({ series, bands, initialLength, dark = false }: EnsemblePopulationCanvasProps) {
  const streams = useMemo(() => series.filter((s) => s.valid).slice(0, MAX_STREAMS), [series])
  const total = bands.cycle.length

  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const particlesRef = useRef<Float32Array[]>([])
  const tRef = useRef(0)
  const playingRef = useRef(true)
  const speedRef = useRef(SPEEDS[1])
  const darkRef = useRef(dark)

  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(SPEEDS[1])

  useEffect(() => {
    darkRef.current = dark
    speedRef.current = speed
    playingRef.current = playing
  })

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap || streams.length === 0) return
    particlesRef.current = streams.map((s, i) => makeParticles(STREAM_CAP, s.seed + i * 7919))
    tRef.current = 0

    let ctx: CanvasRenderingContext2D | null = null
    try {
      ctx = canvas.getContext('2d')
    } catch {
      ctx = null
    }
    if (!ctx) return
    const c2d = ctx
    let dpr = Math.min(window.devicePixelRatio || 1, 2)

    const fit = () => {
      const size = Math.max(120, Math.min(wrap.clientWidth || 320, 360))
      canvas.style.width = `${size}px`
      canvas.style.height = `${size}px`
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.max(1, Math.round(size * dpr))
      canvas.height = Math.max(1, Math.round(size * dpr))
    }
    fit()
    window.addEventListener('resize', fit)

    let raf = 0
    let last = performance.now()
    let lastInt = -1
    const frameCount = Math.max(1, total)
    const loop = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000)
      last = now
      if (playingRef.current && frameCount > 1) {
        tRef.current += dt * speedRef.current
        if (tRef.current >= frameCount - 1) {
          tRef.current = frameCount - 1
          playingRef.current = false
          setPlaying(false)
        }
      }
      const i = Math.floor(tRef.current)
      if (i !== lastInt) {
        lastInt = i
        setIndex(i)
      }

      const w = canvas.width
      const h = canvas.height
      c2d.clearRect(0, 0, w, h)
      streams.forEach((s, si) => {
        const particles = particlesRef.current[si]
        if (!particles) return
        stepParticles(particles, dt)
        const frame = ensembleSeedFrameAt(s, bands.cycle, initialLength, i, STREAM_CAP)
        const n = Math.min(frame.drawn, STREAM_CAP)
        const radius = (1.1 + 1.8 * Math.min(1, frame.lengthRatio)) * dpr
        const bright = (darkRef.current ? 0.6 : 0.5) + 0.5 * Math.min(1, frame.lengthRatio)
        // Reduced per-stream opacity so overlapping streams accumulate visually.
        const alpha = streams.length > 1 ? 0.85 / Math.sqrt(streams.length) : 0.9
        for (let p = 0; p < n; p++) {
          const x = (particles[p * PARTICLE_STRIDE] * 0.94 * 0.5 + 0.5) * w
          const y = (0.5 - particles[p * PARTICLE_STRIDE + 1] * 0.94 * 0.5) * h
          const senescent = p < frame.drawnSenescent
          c2d.fillStyle = streamColor(si, senescent, bright, alpha)
          c2d.beginPath()
          c2d.arc(x, y, radius, 0, Math.PI * 2)
          c2d.fill()
        }
      })
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', fit)
    }
    // `streams` is derived from `series`/`bands` each render via useMemo; re-run the
    // effect whenever the underlying ensemble result (or theme) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streams, bands, initialLength, total])

  const seek = (i: number) => {
    tRef.current = i
    setIndex(i)
  }

  if (streams.length === 0) {
    return (
      <section className="card p-4 text-sm" aria-label="Ensemble population visualization">
        No valid seed to visualize.
      </section>
    )
  }

  const atEnd = total <= 1 || index >= total - 1

  return (
    <section className="card p-4 sm:p-5" aria-label="Ensemble population visualization">
      <div className="flex flex-col gap-4 sm:flex-row">
        <div ref={wrapRef} className="flex shrink-0 items-start justify-center sm:w-[360px]">
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={`Ensemble population cloud at cycle ${bands.cycle[Math.min(index, total - 1)] ?? 0}, ${streams.length} seed streams overlaid`}
            className="rounded-full border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-950"
          />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-base font-semibold">Culture over time -- {streams.length} seed streams overlaid</h3>
            <span className="prose-muted text-xs">Canvas 2D, up to {MAX_STREAMS} streams</span>
          </div>
          <p className="prose-muted text-xs" data-testid="ensemble-canvas-cycle">
            cycle {bands.cycle[Math.min(index, total - 1)] ?? 0} / {total ? bands.cycle[total - 1] : 0}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-ghost !px-3 !py-1.5"
              onClick={() => {
                if (atEnd && !playing) seek(0)
                setPlaying((p) => !p)
              }}
              aria-label={playing ? 'Pause ensemble visualization' : 'Play ensemble visualization'}
            >
              {playing ? '⏸ Pause' : atEnd ? '↺ Replay' : '▶ Play'}
            </button>
            <label className="prose-muted flex items-center gap-1.5 text-xs">
              speed
              <select
                className="input !w-auto !py-1 !text-xs"
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
                aria-label="Ensemble playback speed (cycles per second)"
              >
                {SPEEDS.map((s) => (
                  <option key={s} value={s}>
                    {s} cycles/s
                  </option>
                ))}
              </select>
            </label>
          </div>
          <input
            type="range"
            className="w-full accent-teal-600"
            min={0}
            max={Math.max(0, total - 1)}
            step={1}
            value={index}
            onChange={(e) => {
              setPlaying(false)
              seek(Number(e.target.value))
            }}
            aria-label="Ensemble timeline (cell cycle)"
          />
          <p className="prose-muted text-xs">
            Each stream is one independent stochastic realization of the same configuration (a different simulator
            seed), not a tracked biological sub-population. Overlapping, dimmed particle clouds where streams agree
            -- and a hazier spread where they diverge -- is an illustrative rendering of the same seed-to-seed spread
            shown numerically in the chart and table above.
          </p>
        </div>
      </div>
    </section>
  )
}
