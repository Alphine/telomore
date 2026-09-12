// Particle visualization of a simulated culture (docs/ROADMAP.md "GPU
// strategy": rendering only -- every number comes from the server-side
// SimulationResult, nothing is simulated here). Raw WebGL2 point sprites with
// a Canvas 2D fallback; the data -> frame mapping lives in
// ./populationFrames.ts so it can be unit-tested without a GL context.
import { useCallback, useEffect, useRef, useState } from 'react'

import type { SimulationRun } from '../api/types'
import {
  DEFAULT_PARTICLE_CAP,
  PARTICLE_STRIDE,
  ageBandColor,
  frameAt,
  frameCount,
  makeParticles,
  stepParticles,
} from './populationFrames'
import type { PopulationFrame } from './populationFrames'

const LIVE_RGB: [number, number, number] = [0.08, 0.72, 0.65] // teal-500
const SEN_RGB: [number, number, number] = [0.96, 0.25, 0.37] // rose-500
const SPEEDS = [5, 10, 20, 40] // cycles per second

interface Renderer {
  kind: 'webgl2' | 'canvas2d'
  draw(particles: Float32Array, frame: PopulationFrame, dark: boolean): void
  resize(width: number, height: number, dpr: number): void
  dispose(): void
}

const VERT = `#version 300 es
in vec2 a_pos;
in float a_sen;
uniform float u_size;
out float v_sen;
void main() {
  gl_Position = vec4(a_pos * 0.94, 0.0, 1.0);
  gl_PointSize = u_size;
  v_sen = a_sen;
}`

const FRAG = `#version 300 es
precision mediump float;
in float v_sen;
uniform vec3 u_live;
uniform vec3 u_sen;
uniform float u_bright;
out vec4 o_color;
void main() {
  vec2 c = gl_PointCoord - vec2(0.5);
  float d = length(c);
  if (d > 0.5) discard;
  float alpha = smoothstep(0.5, 0.3, d) * 0.9;
  vec3 col = mix(u_live, u_sen, v_sen) * u_bright;
  o_color = vec4(col, alpha);
}`

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh)
    return null
  }
  return sh
}

function createWebGLRenderer(canvas: HTMLCanvasElement, cap: number): Renderer | null {
  let gl: WebGL2RenderingContext | null = null
  try {
    gl = canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: false })
  } catch {
    gl = null
  }
  if (!gl) return null
  const vs = compile(gl, gl.VERTEX_SHADER, VERT)
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
  const prog = gl.createProgram()
  if (!vs || !fs || !prog) return null
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null
  gl.useProgram(prog)

  const aPos = gl.getAttribLocation(prog, 'a_pos')
  const aSen = gl.getAttribLocation(prog, 'a_sen')
  const uSize = gl.getUniformLocation(prog, 'u_size')
  const uLive = gl.getUniformLocation(prog, 'u_live')
  const uSen = gl.getUniformLocation(prog, 'u_sen')
  const uBright = gl.getUniformLocation(prog, 'u_bright')

  const posBuf = gl.createBuffer()
  const senBuf = gl.createBuffer()
  const positions = new Float32Array(cap * 2)
  const flags = new Float32Array(cap)
  let dpr = 1

  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  gl.uniform3f(uLive, ...LIVE_RGB)
  gl.uniform3f(uSen, ...SEN_RGB)

  const ctx = gl
  return {
    kind: 'webgl2',
    resize(width, height, ratio) {
      dpr = ratio
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      ctx.viewport(0, 0, canvas.width, canvas.height)
    },
    draw(particles, frame, dark) {
      const n = Math.min(frame.drawn, cap)
      for (let i = 0; i < n; i++) {
        positions[i * 2] = particles[i * PARTICLE_STRIDE]
        positions[i * 2 + 1] = particles[i * PARTICLE_STRIDE + 1]
        flags[i] = i < frame.drawnSenescent ? 1 : 0
      }
      ctx.clearColor(0, 0, 0, 0)
      ctx.clear(ctx.COLOR_BUFFER_BIT)
      if (n === 0) return
      const size = (3 + 5 * Math.min(1, frame.lengthRatio)) * dpr
      ctx.uniform1f(uSize, size)
      ctx.uniform1f(uBright, (dark ? 0.6 : 0.5) + 0.5 * Math.min(1, frame.lengthRatio))
      ctx.bindBuffer(ctx.ARRAY_BUFFER, posBuf)
      ctx.bufferData(ctx.ARRAY_BUFFER, positions.subarray(0, n * 2), ctx.DYNAMIC_DRAW)
      ctx.enableVertexAttribArray(aPos)
      ctx.vertexAttribPointer(aPos, 2, ctx.FLOAT, false, 0, 0)
      ctx.bindBuffer(ctx.ARRAY_BUFFER, senBuf)
      ctx.bufferData(ctx.ARRAY_BUFFER, flags.subarray(0, n), ctx.DYNAMIC_DRAW)
      ctx.enableVertexAttribArray(aSen)
      ctx.vertexAttribPointer(aSen, 1, ctx.FLOAT, false, 0, 0)
      ctx.drawArrays(ctx.POINTS, 0, n)
    },
    dispose() {
      ctx.deleteBuffer(posBuf)
      ctx.deleteBuffer(senBuf)
      ctx.deleteProgram(prog)
      ctx.deleteShader(vs)
      ctx.deleteShader(fs)
      ctx.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}

function rgb([r, g, b]: [number, number, number], bright: number, alpha: number): string {
  const c = (v: number) => Math.round(Math.min(1, v * bright) * 255)
  return `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${alpha})`
}

//: The dish's border colour: the synthetic age index (docs/MODEL.md §4.1)
//: on the emerald->amber->rose gradient (ROADMAP.md "possible future ideas":
//: surfacing score_over_time on the canvas itself, not only a line chart).
//: Falls back to a neutral border (no age claim) for a run recorded before
//: this field existed, or one whose result was invalid.
const NEUTRAL_BORDER = 'rgb(203 213 225)' // slate-300; visible on both themes
function ageRingColor(ageIndex: number | null): string {
  if (ageIndex === null) return NEUTRAL_BORDER
  return rgb(ageBandColor(ageIndex), 1, 1)
}

function createCanvas2DRenderer(canvas: HTMLCanvasElement, cap: number): Renderer | null {
  let ctx: CanvasRenderingContext2D | null = null
  try {
    ctx = canvas.getContext('2d')
  } catch {
    ctx = null
  }
  if (!ctx) return null
  const c2d = ctx
  let dpr = 1
  return {
    kind: 'canvas2d',
    resize(width, height, ratio) {
      dpr = ratio
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
    },
    draw(particles, frame, dark) {
      const w = canvas.width
      const h = canvas.height
      c2d.clearRect(0, 0, w, h)
      const n = Math.min(frame.drawn, cap)
      const radius = (1.5 + 2.5 * Math.min(1, frame.lengthRatio)) * dpr
      const bright = (dark ? 0.6 : 0.5) + 0.5 * Math.min(1, frame.lengthRatio)
      const live = rgb(LIVE_RGB, bright, 0.9)
      const sen = rgb(SEN_RGB, bright, 0.9)
      for (let i = 0; i < n; i++) {
        const x = (particles[i * PARTICLE_STRIDE] * 0.94 * 0.5 + 0.5) * w
        const y = (0.5 - particles[i * PARTICLE_STRIDE + 1] * 0.94 * 0.5) * h
        c2d.fillStyle = i < frame.drawnSenescent ? sen : live
        c2d.beginPath()
        c2d.arc(x, y, radius, 0, Math.PI * 2)
        c2d.fill()
      }
    },
    dispose() {
      /* nothing to release */
    },
  }
}

export interface PopulationCanvasProps {
  run: SimulationRun
  /** Called whenever the displayed cycle changes (used to draw the chart cursor). */
  onCycleChange?: (cycle: number) => void
  dark?: boolean
  cap?: number
}

export function PopulationCanvas({ run, onCycleChange, dark = false, cap = DEFAULT_PARTICLE_CAP }: PopulationCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rendererRef = useRef<Renderer | null>(null)
  const particlesRef = useRef<Float32Array>(makeParticles(cap, run.seed))
  const tRef = useRef(0) // fractional frame index
  const playingRef = useRef(true)
  const speedRef = useRef(SPEEDS[1])
  const darkRef = useRef(dark)
  const onCycleRef = useRef(onCycleChange)

  const total = frameCount(run)
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(SPEEDS[1])
  const [rendererKind, setRendererKind] = useState<Renderer['kind'] | 'unavailable' | null>(null)
  const [shownRun, setShownRun] = useState(run)

  // New run: restart the timeline (React's "adjust state on prop change"
  // pattern -- the particles/tRef reset happens in the renderer effect below).
  if (run !== shownRun) {
    setShownRun(run)
    setIndex(0)
    setPlaying(true)
  }

  // Mirror the latest props/state into refs for the animation loop (after
  // render, so refs are never touched during render).
  useEffect(() => {
    darkRef.current = dark
    onCycleRef.current = onCycleChange
    speedRef.current = speed
    playingRef.current = playing
  })

  // Renderer lifecycle + animation loop.
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    particlesRef.current = makeParticles(cap, run.seed)
    tRef.current = 0
    const renderer = createWebGLRenderer(canvas, cap) ?? createCanvas2DRenderer(canvas, cap)
    rendererRef.current = renderer
    setRendererKind(renderer ? renderer.kind : 'unavailable')
    if (!renderer) return

    const fit = () => {
      const size = Math.max(120, Math.min(wrap.clientWidth || 320, 360))
      canvas.style.width = `${size}px`
      canvas.style.height = `${size}px`
      renderer.resize(size, size, Math.min(window.devicePixelRatio || 1, 2))
    }
    fit()
    window.addEventListener('resize', fit)

    let raf = 0
    let last = performance.now()
    let lastInt = -1
    let lastEmit = -Infinity
    const loop = (now: number) => {
      // Clamp so a background tab / long GC pause does not jump the timeline.
      const dt = Math.min(0.25, (now - last) / 1000)
      last = now
      const frames = frameCount(run)
      if (playingRef.current && frames > 1) {
        tRef.current += dt * speedRef.current
        if (tRef.current >= frames - 1) {
          tRef.current = frames - 1
          playingRef.current = false
          setPlaying(false)
        }
      }
      const i = Math.floor(tRef.current)
      const frame = frameAt(run, i, cap)
      if (i !== lastInt) {
        lastInt = i
        setIndex(i)
        // The chart cursor re-renders every Plotly figure, so emit it at
        // most ~7x/s (and always on the final frame) rather than per cycle.
        if (now - lastEmit > 150 || !playingRef.current) {
          lastEmit = now
          onCycleRef.current?.(frame.cycle)
        }
      }
      stepParticles(particlesRef.current, dt)
      renderer.draw(particlesRef.current, frame, darkRef.current)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', fit)
      renderer.dispose()
      rendererRef.current = null
    }
  }, [run, cap])

  const seek = useCallback((i: number) => {
    tRef.current = i
    setIndex(i)
  }, [])

  const frame = frameAt(run, index, cap)
  const meanKb = run.timeseries.mean_length_bp[Math.min(index, total - 1)]
  const atEnd = total <= 1 || index >= total - 1

  return (
    <section className="card p-4 sm:p-5" aria-label="Population visualization">
      <div className="flex flex-col gap-4 sm:flex-row">
        <div ref={wrapRef} className="flex shrink-0 items-start justify-center sm:w-[360px]">
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={`Cell population at cycle ${frame.cycle}: ${frame.living} living cells, ${Math.round(
              frame.senescentFraction * 100,
            )}% senescent${frame.ageIndex === null ? '' : `, synthetic age index ${Math.round(frame.ageIndex)} of 100`}`}
            className="rounded-full border-4 bg-slate-50 transition-colors dark:bg-slate-950"
            style={{ borderColor: ageRingColor(frame.ageIndex) }}
          />
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-base font-semibold">Culture over time</h3>
            <span className="prose-muted text-xs">
              renderer:{' '}
              {rendererKind === 'webgl2'
                ? 'WebGL2'
                : rendererKind === 'canvas2d'
                  ? 'Canvas 2D (WebGL2 unavailable)'
                  : rendererKind === 'unavailable'
                    ? 'unavailable in this browser'
                    : '…'}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
            <div>
              <dt className="prose-muted text-xs">cycle</dt>
              <dd className="font-mono" data-testid="viz-cycle">
                {frame.cycle} / {total ? run.timeseries.cycle[total - 1] : 0}
              </dd>
            </div>
            <div>
              <dt className="prose-muted text-xs">living cells</dt>
              <dd className="font-mono">{frame.living}</dd>
            </div>
            <div>
              <dt className="prose-muted text-xs">senescent</dt>
              <dd className="font-mono text-rose-600 dark:text-rose-400">{(frame.senescentFraction * 100).toFixed(0)} %</dd>
            </div>
            <div>
              <dt className="prose-muted text-xs">mean length</dt>
              <dd className="font-mono">{meanKb === null || meanKb === undefined ? '—' : `${(meanKb / 1000).toFixed(2)} kb`}</dd>
            </div>
            <div>
              <dt className="prose-muted text-xs">age index</dt>
              <dd className="font-mono" data-testid="viz-age-index" style={{ color: ageRingColor(frame.ageIndex) }}>
                {frame.ageIndex === null ? '—' : frame.ageIndex.toFixed(0)}
              </dd>
            </div>
          </dl>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-ghost !px-3 !py-1.5"
              onClick={() => {
                if (atEnd && !playing) seek(0)
                setPlaying((p) => !p)
              }}
              aria-label={playing ? 'Pause' : 'Play'}
            >
              {playing ? '⏸ Pause' : atEnd ? '↺ Replay' : '▶ Play'}
            </button>
            <label className="prose-muted flex items-center gap-1.5 text-xs">
              speed
              <select
                className="input !w-auto !py-1 !text-xs"
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
                aria-label="Playback speed (cycles per second)"
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
            aria-label="Timeline (cell cycle)"
          />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full bg-teal-500" /> proliferative / living
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full bg-rose-500" /> senescent share
            </span>
            <span className="prose-muted">particle size and brightness follow mean length relative to the initial length</span>
            {frame.ageIndex !== null && (
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: ageRingColor(frame.ageIndex) }} />
                dish ring = synthetic age index (emerald → amber → rose)
              </span>
            )}
          </div>
          <p className="prose-muted text-xs">
            Aggregate visualization of the simulated population: particle count = living cells (capped at {cap}),
            coloured share = senescent fraction, size = mean telomere length, ring colour = the synthetic age index
            (docs/MODEL.md §4.1, when available) on the same 0-100 scale shown in the timeline chart. Particles are
            illustrative, not tracked individual cells -- the simulation itself ran server-side in Python.
          </p>
        </div>
      </div>
    </section>
  )
}
