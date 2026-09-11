// Shared fixtures for page tests. Shapes copied from the real API responses
// (GET /api/meta/bounds mirrors PARAMETER_BOUNDS / ModelConfig defaults).
import type { BoundsResponse, ChipPresetsResponse, EnsembleResponse, ModelConfig, SimulationRun } from '../api/types'

export const MODEL_DEFAULTS: ModelConfig = {
  initial_length: 7500,
  initial_length_sd: 800,
  population_size: 100,
  carrying_capacity: 400,
  telomeres_per_cell: 32,
  shortening_rate: 55,
  stress_level: 0.4,
  stress_sensitivity: 100,
  maintenance_rate: 0.2,
  maintenance_max_gain: 120,
  repair_rate: 0.2,
  senescence_threshold: 3000,
  noise_sd: 30,
  senescent_death_rate: 0.03,
  cycles: 120,
  seed: 42,
  record_distribution_every: 0,
}

export const BOUNDS: BoundsResponse = {
  bounds: {
    initial_length: { min: 3000, max: 15000, unit: 'bp', label: 'Initial telomere length', description: 'Mean telomere length of the founding cells.' },
    initial_length_sd: { min: 0, max: 3000, unit: 'bp', label: 'Initial length spread (SD)', description: 'Standard deviation of telomere lengths at t=0.' },
    shortening_rate: { min: 10, max: 200, unit: 'bp/cycle', label: 'Replication shortening', description: 'End-replication loss per telomere per division.' },
    stress_level: { min: 0, max: 1, unit: 'a.u.', label: 'Stress level', description: 'Abstract culture/oxidative stress (0 = none, 1 = maximal).' },
    stress_sensitivity: { min: 0, max: 300, unit: 'bp/cycle', label: 'Stress sensitivity', description: 'Extra loss per division at stress_level = 1.' },
    maintenance_rate: { min: 0, max: 1, unit: 'a.u.', label: 'Maintenance (telomerase-like)', description: 'Fraction of the maximal length-restoring activity.' },
    maintenance_max_gain: { min: 0, max: 300, unit: 'bp/cycle', label: 'Max maintenance gain', description: 'Gain per division on the shortest telomere at maintenance_rate = 1.' },
    repair_rate: { min: 0, max: 1, unit: 'a.u.', label: 'Repair rate', description: 'Fraction of stress-induced damage that is repaired.' },
    senescence_threshold: { min: 500, max: 6000, unit: 'bp', label: 'Senescence threshold', description: 'A cell stops dividing once its *shortest* telomere drops below this.' },
    noise_sd: { min: 0, max: 200, unit: 'bp', label: 'Per-division noise SD', description: 'Gaussian variability in loss per telomere per division.' },
    senescent_death_rate: { min: 0, max: 0.5, unit: '1/cycle', label: 'Senescent death rate', description: 'Probability that a senescent cell is lost per cycle.' },
  },
  evolvable: ['initial_length', 'shortening_rate', 'stress_level', 'maintenance_rate', 'repair_rate', 'senescence_threshold'],
  defaults: MODEL_DEFAULTS,
  demo: { ...MODEL_DEFAULTS, stress_level: 0.6, maintenance_rate: 0.1, repair_rate: 0.15, record_distribution_every: 20 },
  fitness_weights_default: { w_survival: 0.4, w_reserve: 0.3, w_senescence: 0.2, w_instability: 0.1, w_cost: 0.3 },
  evolution_default: {
    population_size: 32,
    generations: 20,
    elite_fraction: 0.1,
    mutation_rate: 0.3,
    mutation_sigma: 0.15,
    crossover_rate: 0.7,
    crossover_kind: 'uniform',
    tournament_size: 3,
    seed: 7,
    eval_seeds: [1, 2, 3],
    free_genes: ['stress_level', 'maintenance_rate', 'repair_rate'],
    early_stopping_patience: 0,
    early_stopping_tol: 0.0001,
    checkpoint_every: 5,
    schedule_phases: 1,
    weights: { w_survival: 0.4, w_reserve: 0.3, w_senescence: 0.2, w_instability: 0.1, w_cost: 0.3 },
  },
  objectives: {
    survival: { direction: 'max', description: 'normalised proliferative-cell AUC' },
    reserve: { direction: 'max', description: 'normalised shortest-telomere reserve at the end' },
    senescence: { direction: 'min', description: 'final senescent fraction' },
    instability: { direction: 'min', description: 'final length CV, scaled' },
    cost: { direction: 'min', description: 'intervention cost ½(maintenance² + repair²)' },
  },
  schedulable: ['stress_level', 'maintenance_rate', 'repair_rate'],
  max_phases: 8,
  // configs/demo_fasting.yaml as GET /api/meta/bounds returns it (ModelConfig.to_dict()).
  presets: {
    demo_fasting: {
      ...MODEL_DEFAULTS,
      stress_level: 0.9,
      maintenance_rate: 0.1,
      repair_rate: 0.15,
      record_distribution_every: 20,
      schedule: { phases: 6, values: { stress_level: [0.9, 0.3, 0.9, 0.3, 0.9, 0.3] } },
    },
  },
  subclone_overridable: ['shortening_rate', 'maintenance_rate', 'repair_rate', 'stress_sensitivity'],
}

// GET /api/meta/chip-presets (ROADMAP.md candidate feature #3: multi-chip comparison).
export const CHIP_PRESETS: ChipPresetsResponse = {
  presets: {
    static_well: {
      conditions: { flow_rate: 0.0, oxygen_tension: 0.21, nutrient_state: 0.6, stress_exposure: 0.05, culture_days: 60 },
      label: 'Static well (control)',
      description: 'No perfusion, atmospheric oxygen, no deliberate exogenous stressor.',
      derived: { stress_level: 0.14, repair_rate: 0.28, cycles: 60 },
    },
    liver_chip_like: {
      conditions: { flow_rate: 0.15, oxygen_tension: 0.06, nutrient_state: 0.5, stress_exposure: 0.5, culture_days: 90 },
      label: 'Liver-chip-like (low flow, physioxia)',
      description: 'Illustrative low-perfusion, low-oxygen-tension, metabolically demanding profile.',
      derived: { stress_level: 0.55, repair_rate: 0.28, cycles: 90 },
    },
    lung_chip_like: {
      conditions: { flow_rate: 0.9, oxygen_tension: 0.21, nutrient_state: 0.9, stress_exposure: 0.15, culture_days: 45 },
      label: 'Lung-chip-like (high flow, high O2)',
      description: 'Illustrative high-perfusion, atmospheric-oxygen, nutrient-replete profile.',
      derived: { stress_level: 0.31, repair_rate: 0.55, cycles: 45 },
    },
  },
}

export function fakeRun(cycles = 4): SimulationRun {
  const t = Array.from({ length: cycles + 1 }, (_, i) => i)
  return {
    seed: 42,
    model_version: '0.1.0',
    config: { ...BOUNDS.demo, cycles },
    config_hash: 'abc123',
    valid: true,
    failure_reason: null,
    runtime_seconds: 0.01,
    terminal_metrics: {
      final_mean_length_bp: 6500,
      final_mean_shortest_bp: 4200,
      telomere_reserve_bp: 1200,
      normalized_telomere_reserve: 0.27,
      normalized_survival: 0.9,
      final_senescent_fraction: 0.12,
      final_population_size: 180,
      peak_population_size: 200,
      time_to_50pct_senescence: null,
      time_to_90pct_senescence: null,
      final_length_cv: 0.1,
      extinct: false,
    },
    timeseries: {
      cycle: t,
      mean_length_bp: t.map((i) => 7500 - 250 * i),
      median_length_bp: t.map((i) => 7500 - 250 * i),
      shortest_length_bp: t.map((i) => 6000 - 450 * i),
      p10_length_bp: t.map((i) => 6500 - 300 * i),
      mean_shortest_per_cell_bp: t.map((i) => 6500 - 300 * i),
      senescent_fraction: t.map((i) => 0.03 * i),
      population_size: t.map((i) => 100 + 20 * i),
      proliferative_count: t.map((i) => 100 + 15 * i),
      fraction_below_threshold: t.map((i) => 0.01 * i),
      length_cv: t.map(() => 0.1),
    },
    applied_schedule: {},
    clone_fraction: {},
    final_lengths_bp: [6000, 6500, 7000],
    biological_age: {
      score_over_time: t.map((i) => Math.min(100, 10 + 8 * i)),
      final_score: Math.min(100, 10 + 8 * cycles),
      scale_label: 'synthetic age index, 0 (youthful reference) - 100 (senescent reference)',
      formula_note: 'age_index = 100 * (1 - mean(normalized_survival, normalized_telomere_reserve, 1 - senescent_fraction))',
      valid: true,
    },
    run_id: 'TEL-20260909-001',
    fitness: { total: 0.512, survival: 0.9, reserve: 0.27, senescence: 0.12, instability: 0.2, cost: 0.02, valid: true, reason: null },
  }
}

export function fakeEnsemble(nSeeds = 3, cycles = 4): EnsembleResponse {
  const cycle = Array.from({ length: cycles + 1 }, (_, i) => i)
  const seeds = Array.from({ length: nSeeds }, (_, i) => 42 + i)
  return {
    run_id: 'TEL-20260911-001',
    n_seeds: nSeeds,
    base_seed: 42,
    seeds,
    config: { ...BOUNDS.demo, cycles },
    config_hash: 'ens123',
    bands: {
      cycle,
      p10: cycle.map((i) => 7000 - 200 * i),
      p50: cycle.map((i) => 7500 - 250 * i),
      p90: cycle.map((i) => 8000 - 300 * i),
      mean: cycle.map((i) => 7500 - 250 * i),
    },
    series: seeds.map((seed, si) => ({
      seed,
      valid: true,
      failure_reason: null,
      mean_length: cycle.map((i) => 7500 - (250 + si * 10) * i),
      shortest_length: cycle.map((i) => 6000 - 450 * i),
      population_size: cycle.map((i) => 100 + 20 * i),
      proliferative_count: cycle.map((i) => 100 + 15 * i),
      senescent_fraction: cycle.map((i) => 0.03 * i),
      terminal_metrics: {
        final_mean_length_bp: 6500 - si * 50,
        final_mean_shortest_bp: 4200,
        telomere_reserve_bp: 1200,
        normalized_telomere_reserve: 0.27,
        normalized_survival: 0.9,
        final_senescent_fraction: 0.12,
        final_population_size: 180,
        peak_population_size: 200,
        time_to_50pct_senescence: null,
        time_to_90pct_senescence: null,
        final_length_cv: 0.1,
        extinct: false,
      },
      biological_age_final: 25 + si * 3,
    })),
    applied_schedule: {},
  }
}
