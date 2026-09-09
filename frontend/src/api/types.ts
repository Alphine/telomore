// Wire types -- field names copied verbatim from backend/schemas.py (the
// Pydantic models) and, for the free-form config/result dicts those models
// pass through, from src/telomere_lab/schemas.py (ModelConfig, FitnessWeights,
// EvolutionConfig, SimulationResult.to_json_dict), evolution/engine.py
// (GenerationRecord), evolution/population.py (Candidate), evolution/fitness.py
// (FitnessBreakdown) and simulator/metrics.py (terminal_metrics). Do not add
// fields that are not in those files.

export interface RegisterRequest {
  username: string
  email: string
  password: string
}

export interface RegisterResponse {
  message: string
  dev_verification_link?: string | null
}

export interface VerifyResponse {
  message: string
  verified: boolean
}

export interface LoginRequest {
  username: string
  password: string
}

export interface TokenResponse {
  access_token: string
  token_type: string
}

export interface ForgotPasswordRequest {
  email: string
}

export interface ForgotPasswordResponse {
  message: string
  dev_reset_link?: string | null
}

export interface ResetPasswordRequest {
  token: string
  new_password: string
}

export interface MessageResponse {
  message: string
}

export interface UserResponse {
  id: number
  username: string
  email: string
  is_verified: boolean
}

export interface HealthResponse {
  status: string
}

// ---------------------------------------------------------------- configs
// telomere_lab.schemas.ModelConfig
export interface ModelConfig {
  initial_length: number
  initial_length_sd: number
  population_size: number
  carrying_capacity: number
  telomeres_per_cell: number
  shortening_rate: number
  stress_level: number
  stress_sensitivity: number
  maintenance_rate: number
  maintenance_max_gain: number
  repair_rate: number
  senescence_threshold: number
  noise_sd: number
  senescent_death_rate: number
  cycles: number
  seed: number
  record_distribution_every: number
}

// telomere_lab.schemas.FitnessWeights
export interface FitnessWeights {
  w_survival: number
  w_reserve: number
  w_senescence: number
  w_instability: number
  w_cost: number
}

// telomere_lab.schemas.EvolutionConfig.to_dict()
export interface EvolutionConfig {
  population_size: number
  generations: number
  elite_fraction: number
  mutation_rate: number
  mutation_sigma: number
  crossover_rate: number
  crossover_kind: 'uniform' | 'arithmetic'
  tournament_size: number
  seed: number
  eval_seeds: number[]
  free_genes: string[]
  early_stopping_patience: number
  early_stopping_tol: number
  checkpoint_every: number
  weights: FitnessWeights
}

// ------------------------------------------------------------------- meta
/** One PARAMETER_BOUNDS entry (backend/schemas.py::ParameterBound). */
export interface ParameterBound {
  min: number
  max: number
  unit: string
  label: string
  description: string
}

export interface BoundsResponse {
  bounds: Record<string, ParameterBound>
  evolvable: string[]
  defaults: ModelConfig
  demo: ModelConfig
  fitness_weights_default: FitnessWeights
  evolution_default: EvolutionConfig
}

export interface VersionResponse {
  package: string
  model: string
  optimizer: string
  python: string
  numpy: string
  git_commit: string | null
}

// telomere_lab.adapters.chip.ChipConditions
export interface ChipConditions {
  flow_rate: number
  oxygen_tension: number
  nutrient_state: number
  stress_exposure: number
  culture_days: number
}

// chip_to_model_params return shape
export interface ChipParams {
  stress_level: number
  repair_rate: number
  cycles: number
}

// --------------------------------------------------------------- simulate
export interface SimulateRequest {
  config: Partial<ModelConfig>
}

// evolution/fitness.py::FitnessBreakdown.to_dict()
export interface FitnessBreakdown {
  total: number
  survival: number
  reserve: number
  senescence: number
  instability: number
  cost: number
  valid: boolean
  reason: string | null
}

// simulator/metrics.py::terminal_metrics. `inf` (target never reached) is
// serialised as null by the API (pydantic ser_json_inf_nan='null').
export interface TerminalMetrics {
  final_mean_length_bp: number
  final_mean_shortest_bp: number
  telomere_reserve_bp: number
  normalized_telomere_reserve: number
  normalized_survival: number
  final_senescent_fraction: number
  final_population_size: number
  peak_population_size: number
  time_to_50pct_senescence: number | null
  time_to_90pct_senescence: number | null
  final_length_cv: number
  extinct: boolean
}

// SimulationResult.timeseries_frame() columns. Length statistics are NaN
// (-> null) once the population is extinct.
export interface SimulationTimeseries {
  cycle: number[]
  mean_length_bp: Array<number | null>
  median_length_bp: Array<number | null>
  shortest_length_bp: Array<number | null>
  p10_length_bp: Array<number | null>
  mean_shortest_per_cell_bp: Array<number | null>
  senescent_fraction: Array<number | null>
  population_size: number[]
  proliferative_count: number[]
  fraction_below_threshold: Array<number | null>
  length_cv: Array<number | null>
}

/** SimulationResult.to_json_dict() + the run_id / fitness added by POST /api/simulate. */
export interface SimulationRun {
  seed: number
  model_version: string
  config: ModelConfig
  config_hash: string
  valid: boolean
  failure_reason: string | null
  runtime_seconds: number
  terminal_metrics: Partial<TerminalMetrics>
  timeseries: SimulationTimeseries
  final_lengths_bp: number[]
  run_id: string
  fitness: FitnessBreakdown
}

export interface SimulateResponse {
  run: SimulationRun
}

// ------------------------------------------------------------------- jobs
export interface EvolveRequest {
  model: Partial<ModelConfig>
  evolution: Partial<EvolutionConfig>
  notes: string
}

export interface JobStartResponse {
  job_id: string
}

export type JobStatusValue = 'pending' | 'running' | 'completed' | 'failed' | 'stopped'

export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatusValue> = new Set(['completed', 'failed', 'stopped'])

export interface JobStatusResponse<P = Record<string, unknown>, R = Record<string, unknown>> {
  job_id: string
  kind: string
  status: JobStatusValue
  progress: P | null
  result: R | null
  error: string | null
  created_at: string
  updated_at: string
}

// evolution/engine.py::GenerationRecord.to_dict() -- the per-generation
// `progress` payload of an evolve job. mean/median are NaN (-> null) when
// every candidate in a generation is invalid.
export interface GenerationRecord {
  generation: number
  best_fitness: number
  mean_fitness: number | null
  median_fitness: number | null
  diversity: number
  best_genome: Record<string, number>
  best_breakdown: Partial<FitnessBreakdown>
  n_invalid: number
  evaluations_so_far: number
  elapsed_seconds: number
}

// evolution/population.py::Candidate.to_dict()
export interface Candidate {
  genome: Record<string, number>
  fitness: number
  breakdown: FitnessBreakdown | null
  terminal_metrics: Partial<TerminalMetrics>
}

// backend/routers/evolve.py::_target return value (the job's `result`).
// NOTE: no per-cycle simulation payload of the best candidate is included --
// re-run it on the Simulate page ("Set best as baseline").
export interface EvolveResult {
  run_id: string | null
  best: Candidate
  baseline: Candidate
  history: GenerationRecord[]
  evaluations: number
  runtime_seconds: number
  stopped_early: boolean
  stop_reason: string
}

export type EvolveJob = JobStatusResponse<GenerationRecord, EvolveResult>
