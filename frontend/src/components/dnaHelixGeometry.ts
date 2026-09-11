// Pure geometry for <DnaHelixCanvas /> -- kept separate from the component
// module so it stays a plain, tree-shakeable set of functions (no JSX) and
// so the oxlint `react/only-export-components` rule never flags this file
// (it has already fired twice in this project's history when a component
// file exported a helper alongside the component).
//
// The helix is a decorative pseudo-3D projection, not a scientific model: two
// phase-shifted sine strands (the two DNA backbones) plus periodic rungs
// (base pairs) connecting them. Depth comes from a simple rotation around the
// vertical axis -- `depth = cos(angle)` scales radius/opacity/size so the
// "far" strand reads as behind the "near" one without a real 3D pipeline.

export interface HelixPoint {
  /** Horizontal position, 0..1 across the canvas. */
  x: number
  /** Vertical position, 0..1 down the canvas. */
  y: number
  /** Pseudo-depth in [-1, 1]; +1 is nearest the viewer. */
  depth: number
}

export interface HelixGeometry {
  strandA: HelixPoint[]
  strandB: HelixPoint[]
  /** Rung endpoints (one per sampled row): [pointOnA, pointOnB]. */
  rungs: [HelixPoint, HelixPoint][]
}

export interface HelixParams {
  /** Points sampled down the strand (resolution of the sine curve). */
  rows: number
  /** How many rungs to draw across the sampled rows. */
  rungCount: number
  /** Number of full turns visible top-to-bottom. */
  turns: number
  /** Current animation phase in radians (advances over time or with rotation). */
  phase: number
}

/**
 * Build one frame of the double-helix geometry in normalised [0,1] x/y
 * space, ready to be scaled to a canvas's actual pixel size by the caller.
 */
export function buildHelixFrame({ rows, rungCount, turns, phase }: HelixParams): HelixGeometry {
  const strandA: HelixPoint[] = []
  const strandB: HelixPoint[] = []
  for (let i = 0; i < rows; i++) {
    const y = rows <= 1 ? 0 : i / (rows - 1)
    const angle = y * Math.PI * 2 * turns + phase
    strandA.push({ x: 0.5 + 0.5 * Math.sin(angle), y, depth: Math.cos(angle) })
    strandB.push({ x: 0.5 + 0.5 * Math.sin(angle + Math.PI), y, depth: Math.cos(angle + Math.PI) })
  }

  const rungs: [HelixPoint, HelixPoint][] = []
  const step = rungCount <= 1 ? rows - 1 : (rows - 1) / (rungCount - 1)
  for (let r = 0; r < rungCount; r++) {
    const i = Math.min(rows - 1, Math.round(r * step))
    rungs.push([strandA[i], strandB[i]])
  }

  return { strandA, strandB, rungs }
}

// ---------------------------------------------------------------------------
// Premium-glow upgrade helpers (still pure/testable, still decorative-only).

export interface BokehDot {
  /** 0..1 across the canvas. */
  x: number
  /** 0..1 down the canvas. */
  y: number
  /** Base radius in normalised units (scaled by the caller to pixels). */
  r: number
  /** Per-dot phase offset (radians) so the pulsing isn't in lockstep. */
  phase: number
}

/**
 * Deterministic (seeded) scatter of small background "bokeh" dots, used to
 * match the ambient-particle feel of the reference images. A tiny
 * mulberry32-style PRNG keeps this pure/reproducible across renders and unit
 * tests, rather than pulling in `Math.random()` (which would make the frame
 * layout re-randomise on every mount and be untestable).
 */
export function buildBokehField(count: number, seed = 1): BokehDot[] {
  let s = seed >>> 0
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const dots: BokehDot[] = []
  for (let i = 0; i < count; i++) {
    dots.push({
      x: next(),
      y: next(),
      r: 0.006 + next() * 0.014,
      phase: next() * Math.PI * 2,
    })
  }
  return dots
}

/** Clamp a number into [0, 1]. */
function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

/**
 * Linear-interpolate two `#rrggbb` hex colors at `t` in [0, 1], returning an
 * `#rrggbb` hex string. Used to give each strand a gradient along its length
 * (e.g. blue near the top shifting to violet near the bottom) instead of a
 * single flat color.
 */
export function lerpHexColor(hexA: string, hexB: string, t: number): string {
  const tt = clamp01(t)
  const a = parseInt(hexA.slice(1), 16)
  const b = parseInt(hexB.slice(1), 16)
  const ar = (a >> 16) & 255
  const ag = (a >> 8) & 255
  const ab = a & 255
  const br = (b >> 16) & 255
  const bg = (b >> 8) & 255
  const bb = b & 255
  const r = Math.round(ar + (br - ar) * tt)
  const g = Math.round(ag + (bg - ag) * tt)
  const bch = Math.round(ab + (bb - ab) * tt)
  const hex = (n: number) => n.toString(16).padStart(2, '0')
  return `#${hex(r)}${hex(g)}${hex(bch)}`
}

/**
 * Depth (in [-1, 1], +1 nearest the viewer) -> a 0..1 "lit" factor used to
 * brighten the near/front phase of the helix's rotation and dim the far/back
 * phase, for the lit-vs-shadowed 3D feel in reference image 2.
 */
export function depthToLitFactor(depth: number): number {
  return clamp01(0.35 + 0.65 * ((depth + 1) / 2))
}
