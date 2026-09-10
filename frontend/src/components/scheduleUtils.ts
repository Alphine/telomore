// Pure helpers for piecewise-constant intervention schedules (docs/MODEL.md
// §2.1). The phase arithmetic reproduces telomere_lab.schemas.phase_index
// exactly; the payload builders emit what ModelConfig.to_dict() emits, so a
// config edited here round-trips through ModelConfig.from_dict unchanged.
import type { InterventionSchedule, ModelConfig } from '../api/types'

/** evolution/genome.py::PHASE_SEPARATOR -- gene names are `<parameter>@<phase>` in a protocol search. */
export const PHASE_SEPARATOR = '@'

/**
 * schemas.phase_index: phase in force during step t -> t+1,
 * `min(K - 1, floor(t * K / cycles))`; t = cycles (one past the last step) is
 * clamped onto the final phase so a step line drawn on the cycles + 1 axis
 * ends flat.
 */
export function phaseIndex(t: number, cycles: number, phases: number): number {
  if (cycles < 1 || phases < 1) throw new Error('cycles and phases must be >= 1')
  return Math.min(phases - 1, Math.floor((Math.max(Math.trunc(t), 0) * phases) / cycles))
}

/** First and last step (inclusive) of every phase, e.g. cycles 120 / K 6 -> [[0,19], [20,39], ...]. */
export function phaseBounds(cycles: number, phases: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let k = 0; k < phases; k++) out.push([-1, -1])
  for (let t = 0; t < cycles; t++) {
    const k = phaseIndex(t, cycles, phases)
    if (out[k][0] === -1) out[k][0] = t
    out[k][1] = t
  }
  return out
}

/** InterventionSchedule.per_cycle: the value at every step 0 .. cycles (length cycles + 1). */
export function perCycleValues(values: number[], cycles: number): number[] {
  const phases = values.length
  return Array.from({ length: cycles + 1 }, (_, t) => values[phaseIndex(t, cycles, phases)])
}

/**
 * Time average over the `cycles` division steps of an `applied_schedule`
 * array (which is cycles + 1 long -- the trailing clamped entry is dropped),
 * i.e. ModelConfig.mean_value computed from what the simulator applied rather
 * than from a formula.
 */
export function meanApplied(applied: number[]): number | null {
  const steps = applied.slice(0, -1)
  if (!steps.length) return null
  return steps.reduce((a, b) => a + b, 0) / steps.length
}

/** `"maintenance_rate@3" -> {parameter: "maintenance_rate", phase: 3}`; `"stress_level" -> phase null`. */
export function splitGeneName(gene: string): { parameter: string; phase: number | null } {
  const i = gene.lastIndexOf(PHASE_SEPARATOR)
  if (i < 0) return { parameter: gene, phase: null }
  const phase = Number(gene.slice(i + 1))
  return Number.isInteger(phase) ? { parameter: gene.slice(0, i), phase } : { parameter: gene, phase: null }
}

/** Genes grouped by parameter, phases in order (constant genes are one-element groups). */
export function groupGenes(genes: string[]): Array<{ parameter: string; genes: string[]; scheduled: boolean }> {
  const groups: Array<{ parameter: string; genes: string[]; scheduled: boolean }> = []
  for (const g of genes) {
    const { parameter, phase } = splitGeneName(g)
    let grp = groups.find((x) => x.parameter === parameter)
    if (!grp) {
      grp = { parameter, genes: [], scheduled: phase !== null }
      groups.push(grp)
    }
    grp.genes.push(g)
  }
  for (const grp of groups) grp.genes.sort((a, b) => (splitGeneName(a).phase ?? 0) - (splitGeneName(b).phase ?? 0))
  return groups
}

/** True when the config carries a schedule with at least one scheduled parameter. */
export function isScheduled(config: Pick<ModelConfig, 'schedule'>): config is ModelConfig & { schedule: InterventionSchedule } {
  return Boolean(config.schedule && Object.keys(config.schedule.values).length > 0)
}

/** Parameters the config actually schedules (empty when unscheduled). */
export function scheduledParameters(config: Pick<ModelConfig, 'schedule'>): string[] {
  return isScheduled(config) ? Object.keys(config.schedule.values) : []
}

/** Resize a per-phase value list to `phases` entries (truncate, or pad by repeating the last value). */
export function resizePhases(values: number[], phases: number, fallback: number): number[] {
  const out = values.slice(0, phases)
  while (out.length < phases) out.push(out.length ? out[out.length - 1] : fallback)
  return out
}

/**
 * The schedule block exactly as ModelConfig.to_dict() emits it, or null when
 * no parameter is scheduled (so the caller can omit the key: `withSchedule`).
 */
export function buildSchedule(phases: number, values: Record<string, number[]>): InterventionSchedule | null {
  const names = Object.keys(values)
  if (!names.length) return null
  const out: Record<string, number[]> = {}
  for (const name of names) out[name] = values[name].map(Number)
  return { phases: Math.trunc(phases), values: out }
}

/**
 * Attach `schedule` to a config (keeping each scheduled parameter's scalar
 * field equal to its phase-0 value, the documented "fallback" meaning) or
 * drop the key entirely when the schedule is null / empty.
 */
export function withSchedule(config: ModelConfig, schedule: InterventionSchedule | null): ModelConfig {
  const { schedule: _old, ...rest } = config
  const next = rest as ModelConfig
  if (!schedule || !Object.keys(schedule.values).length) return next
  for (const [name, vals] of Object.entries(schedule.values)) {
    if (vals.length) (next as unknown as Record<string, unknown>)[name] = vals[0]
  }
  next.schedule = schedule
  return next
}

/** Request payload: the config without a `schedule` key when it is null (what the API also accepts). */
export function configPayload(config: ModelConfig): ModelConfig {
  return isScheduled(config) ? config : withSchedule(config, null)
}

/**
 * GenomeSpec.to_config(genome, seed) for the client: constant genes overwrite
 * scalar fields; `<parameter>@<phase>` genes are assembled into a schedule
 * whose phase count is the number of phases present for that parameter, with
 * the scalar field set to the phase-0 value. Locked scheduled parameters of
 * the base config pass through when they share the phase count; a base
 * schedule for a parameter that became a constant free gene is dropped.
 */
export function genomeToConfig(base: ModelConfig, genome: Record<string, number>, seed?: number): ModelConfig {
  const scalar: Record<string, number> = {}
  const phased: Record<string, Record<number, number>> = {}
  for (const [gene, v] of Object.entries(genome)) {
    const { parameter, phase } = splitGeneName(gene)
    if (phase === null) scalar[parameter] = v
    else (phased[parameter] ??= {})[phase] = v
  }
  let cfg: ModelConfig = { ...base, ...(scalar as Partial<ModelConfig>) }
  const phasedNames = Object.keys(phased)
  if (phasedNames.length) {
    const phases = Math.max(...phasedNames.map((p) => Object.keys(phased[p]).length))
    const values: Record<string, number[]> = {}
    if (base.schedule && base.schedule.phases === phases) Object.assign(values, base.schedule.values)
    for (const p of phasedNames) {
      values[p] = Array.from({ length: phases }, (_, k) => phased[p][k] ?? phased[p][0] ?? 0)
    }
    cfg = withSchedule(cfg, { phases, values })
  } else if (base.schedule) {
    const kept = Object.fromEntries(Object.entries(base.schedule.values).filter(([k]) => !(k in scalar)))
    cfg = withSchedule(cfg, Object.keys(kept).length ? { phases: base.schedule.phases, values: kept } : null)
  }
  if (seed !== undefined) cfg.seed = seed
  return cfg
}
