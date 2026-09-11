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
