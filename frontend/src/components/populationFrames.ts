// Pure data -> frame mapping for <PopulationCanvas />. No WebGL here so it is
// unit-testable. Everything is derived ONLY from series that
// SimulationResult.to_json_dict() actually returns (timeseries.population_size,
// senescent_fraction, proliferative_count, mean_length_bp, shortest_length_bp)
// plus config.initial_length -- the API has no per-cell trajectories, so the
// particles are an aggregate, illustrative rendering, not tracked cells.
import type { SimulationRun } from '../api/types'

export type FrameSource = Pick<SimulationRun, 'timeseries' | 'config'>

export interface PopulationFrame {
  /** Cell cycle shown (timeseries.cycle[index]). */
  cycle: number
  /** Living cells (proliferative + senescent) at that cycle. */
  living: number
  proliferative: number
  /** Senescent share of the living population, 0..1 (1 once extinct). */
  senescentFraction: number
  /** Particles actually drawn: min(living, cap). */
  drawn: number
  /** How many of the drawn particles are coloured senescent. */
  drawnSenescent: number
  /** mean_length[t] / initial_length, clamped to [0, 1.5]; 0 once extinct. */
  lengthRatio: number
  /** shortest_length[t] / initial_length, same clamping. */
  shortestRatio: number
  extinct: boolean
}

export const DEFAULT_PARTICLE_CAP = 1500

export function frameCount(run: FrameSource): number {
  return run.timeseries.cycle.length
}

function ratio(value: number | null | undefined, initial: number): number {
  if (value === null || value === undefined || !Number.isFinite(value) || initial <= 0) return 0
  return Math.min(1.5, Math.max(0, value / initial))
}

export function frameAt(run: FrameSource, index: number, cap: number = DEFAULT_PARTICLE_CAP): PopulationFrame {
  const ts = run.timeseries
  const n = ts.cycle.length
  if (n === 0) {
    return {
      cycle: 0, living: 0, proliferative: 0, senescentFraction: 1, drawn: 0, drawnSenescent: 0,
      lengthRatio: 0, shortestRatio: 0, extinct: true,
    }
  }
  const i = Math.min(n - 1, Math.max(0, Math.floor(index)))
  const living = Math.max(0, Math.round(ts.population_size[i] ?? 0))
  const proliferative = Math.max(0, Math.round(ts.proliferative_count[i] ?? 0))
  const extinct = living === 0
  const rawSen = ts.senescent_fraction[i]
  const senescentFraction = extinct
    ? 1
    : rawSen === null || rawSen === undefined || !Number.isFinite(rawSen)
      ? 0
      : Math.min(1, Math.max(0, rawSen))
  const drawn = Math.min(living, Math.max(0, Math.floor(cap)))
  const drawnSenescent = Math.round(drawn * senescentFraction)
  return {
    cycle: ts.cycle[i],
    living,
    proliferative,
    senescentFraction,
    drawn,
    drawnSenescent,
    lengthRatio: ratio(ts.mean_length_bp[i], run.config.initial_length),
    shortestRatio: ratio(ts.shortest_length_bp[i], run.config.initial_length),
    extinct,
  }
}

// ------------------------------------------------------------- particles
/** Deterministic 32-bit PRNG so the dish looks the same on every render. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Particle state: [x, y, vx, vy] per particle, positions inside the unit disk. */
export const PARTICLE_STRIDE = 4

export function makeParticles(n: number, seed = 42): Float32Array {
  const rnd = mulberry32(seed)
  const out = new Float32Array(n * PARTICLE_STRIDE)
  for (let i = 0; i < n; i++) {
    // Uniform in the disk: r = sqrt(u) keeps density even.
    const r = Math.sqrt(rnd())
    const theta = rnd() * Math.PI * 2
    const speed = 0.01 + rnd() * 0.02
    const dir = rnd() * Math.PI * 2
    out[i * PARTICLE_STRIDE] = r * Math.cos(theta)
    out[i * PARTICLE_STRIDE + 1] = r * Math.sin(theta)
    out[i * PARTICLE_STRIDE + 2] = speed * Math.cos(dir)
    out[i * PARTICLE_STRIDE + 3] = speed * Math.sin(dir)
  }
  return out
}

/** Drift every particle by `dt` seconds, reflecting softly at the dish wall (radius 1). */
export function stepParticles(p: Float32Array, dt: number): void {
  const n = p.length / PARTICLE_STRIDE
  for (let i = 0; i < n; i++) {
    const o = i * PARTICLE_STRIDE
    let x = p[o] + p[o + 2] * dt
    let y = p[o + 1] + p[o + 3] * dt
    const r2 = x * x + y * y
    if (r2 > 1) {
      const r = Math.sqrt(r2)
      // Reflect the velocity about the wall normal and pull back inside.
      const nx = x / r
      const ny = y / r
      const dot = p[o + 2] * nx + p[o + 3] * ny
      p[o + 2] -= 2 * dot * nx
      p[o + 3] -= 2 * dot * ny
      x = nx * 0.999
      y = ny * 0.999
    }
    p[o] = x
    p[o + 1] = y
  }
}
