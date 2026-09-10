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
// telomere_lab.schemas.InterventionSchedule.to_dict() (docs/MODEL.md §2.1):
// `values[name]` holds exactly `phases` entries for a SCHEDULABLE_PARAMETERS
// name (bounds.schedulable); parameters absent from `values` stay constant.
export interface InterventionSchedule {
  phases: number
  values: Record<string, number[]>
}

// telomere_lab.schemas.ModelConfig (to_dict() emits `schedule: null` when
// unscheduled; requests may omit the key entirely -- backend/schemas.py::ModelConfigBody).
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
  /** Optional time-varying protocol; when set, the scalar field of a scheduled parameter is its phase-0 value. */
  schedule?: InterventionSchedule | null
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
  /** >1 expands every free SCHEDULABLE gene into one `<gene>@<phase>` gene per phase (protocol search). */
  schedule_phases: number
  weights: FitnessWeights
}

// telomere_lab.schemas.MultiObjectiveConfig.to_dict()
export interface MultiObjectiveConfig {
  population_size: number
  generations: number
  mutation_rate: number
  mutation_sigma: number
  crossover_rate: number
  crossover_kind: 'uniform' | 'arithmetic'
  seed: number
  eval_seeds: number[]
  free_genes: string[]
  objectives: string[]
  checkpoint_every: number
  schedule_phases: number
  weights: FitnessWeights
}

// telomere_lab.schemas.SensitivityConfig.to_dict()
export interface SensitivityConfig {
  parameters: string[]
  perturbation_fraction: number
  eval_seeds: number[]
  weights: FitnessWeights
}

// telomere_lab.schemas.ActiveLearningConfig.to_dict()
export interface ActiveLearningConfig {
  n_initial: number
  n_iterations: number
  eval_seeds: number[]
  free_genes: string[]
  seed: number
  xi: number
  candidate_pool_size: number
  schedule_phases: number
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

/** One telomere_lab.schemas.OBJECTIVES entry (backend/schemas.py::ObjectiveInfo). */
export interface ObjectiveInfo {
  direction: 'max' | 'min'
  description: string
}

export interface BoundsResponse {
  bounds: Record<string, ParameterBound>
  evolvable: string[]
  defaults: ModelConfig
  demo: ModelConfig
  fitness_weights_default: FitnessWeights
  evolution_default: EvolutionConfig
  objectives: Record<string, ObjectiveInfo>
  /** SCHEDULABLE_PARAMETERS -- the only parameters a schedule may vary. */
  schedulable: string[]
  /** MAX_PHASES -- upper bound for schedule.phases / schedule_phases. */
  max_phases: number
  /** Named example protocols as full ModelConfigs (configs/demo_fasting.yaml -> "demo_fasting"). */
  presets: Record<string, ModelConfig>
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
  /**
   * Per-cycle value actually applied for every *scheduled* parameter, each
   * `cycles + 1` long on the `timeseries.cycle` axis (entry t = value in force
   * during step t -> t+1; the last entry repeats the final phase). `{}` when
   * the config has no schedule.
   */
  applied_schedule: Record<string, number[]>
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

// ----------------------------------------------------------------- pareto
export interface ParetoRequest {
  model: Partial<ModelConfig>
  multiobjective: Partial<MultiObjectiveConfig>
  notes: string
}

// evolution/multiobjective.py::MOGenerationRecord.to_dict() -- the per-generation
// `progress` payload of a pareto job. Means/bests are NaN (-> null) when every
// candidate in a generation is invalid.
export interface MOGenerationRecord {
  generation: number
  front_size: number
  hypervolume: number
  n_invalid: number
  objective_means: Record<string, number | null>
  objective_best: Record<string, number | null>
  evaluations_so_far: number
  elapsed_seconds: number
}

// evolution/multiobjective.py::MOCandidate.to_dict()
export interface MOCandidate {
  genome: Record<string, number>
  objectives: Record<string, number>
  vector: number[]
  scalar_fitness: number
  valid: boolean
  rank: number
  crowding: number | null
  breakdown: FitnessBreakdown | null
  terminal_metrics: Partial<TerminalMetrics>
}

// backend/routers/pareto.py::_target return value. NOTE: no final_population --
// the dominated-candidate cloud of the Streamlit scatter is not available.
export interface ParetoResult {
  run_id: string | null
  front: MOCandidate[]
  baseline: MOCandidate
  history: MOGenerationRecord[]
  reference_point: number[]
  evaluations: number
  runtime_seconds: number
  stopped_early: boolean
}

export type ParetoJob = JobStatusResponse<MOGenerationRecord, ParetoResult>

// ------------------------------------------------------------ sensitivity
export interface SensitivityRequest {
  model: Partial<ModelConfig>
  sensitivity: Partial<SensitivityConfig>
  notes: string
}

// analysis/sensitivity.py::ParameterSensitivity.to_dict() -- one per parameter
// finished (the job's `progress`). Fitness values are NaN (-> null) when the
// perturbed run is invalid.
export interface ParameterSensitivity {
  parameter: string
  baseline_value: number
  low_value: number
  high_value: number
  fitness_low: number | null
  fitness_baseline: number | null
  fitness_high: number | null
  swing: number | null
}

// backend/routers/sensitivity.py::_target return value.
export interface SensitivityResult {
  run_id: string | null
  baseline_fitness: number | null
  items: ParameterSensitivity[]
  evaluations: number
  runtime_seconds: number
}

export type SensitivityJob = JobStatusResponse<ParameterSensitivity, SensitivityResult>

// -------------------------------------------------------- active learning
export interface ActiveLearningRequest {
  model: Partial<ModelConfig>
  active_learning: Partial<ActiveLearningConfig>
  notes: string
}

// evolution/surrogate.py::ActiveLearningRecord.to_dict() -- one per real
// evaluation (the job's `progress`). predicted_* / acquisition_value are null
// during the random initial design (no surrogate yet).
export interface ActiveLearningRecord {
  iteration: number
  phase: 'initial' | 'active'
  genome: Record<string, number>
  real_fitness: number
  predicted_mean: number | null
  predicted_std: number | null
  acquisition_value: number | null
  best_so_far: number
  n_real_evaluations: number
}

// backend/routers/active_learning.py::_target return value. NOTE: the Streamlit
// page also ran a random-search baseline of the same budget; the API result
// does not include one.
export interface ActiveLearningResult {
  run_id: string | null
  best_genome: Record<string, number>
  best_fitness: number
  records: ActiveLearningRecord[]
  evaluations: number
  runtime_seconds: number
}

export type ActiveLearningJob = JobStatusResponse<ActiveLearningRecord, ActiveLearningResult>

// ---------------------------------------------------------------- compare
// backend/schemas.py::CompareRequest / CompareResponse
export interface CompareScenario {
  name: string
  config: Partial<ModelConfig>
}

export interface CompareRequest {
  scenarios: CompareScenario[]
  /** Common random numbers: every scenario is re-seeded with this when set. */
  seed?: number
}

// runner.deltas keys; fitness_pct is null when the baseline fitness is 0 / invalid.
export interface ScenarioDeltas {
  fitness_abs: number | null
  fitness_pct: number | null
  senescence_pp: number | null
  reserve_kb: number | null
  mean_length_kb: number | null
  survival_abs: number | null
}

/** SimulationResult.to_json_dict() (no run_id / fitness -- compare records nothing). */
export type ScenarioRun = Omit<SimulationRun, 'run_id' | 'fitness'>

export interface CompareScenarioResult {
  name: string
  result: ScenarioRun
  fitness: number | null
  breakdown: FitnessBreakdown
  deltas: ScenarioDeltas | null
}

export interface CompareResponse {
  baseline: string
  scenarios: CompareScenarioResult[]
}

// ------------------------------------------------------------ experiments
// backend/schemas.py::ExperimentSummary (registry._index_row columns)
export interface ExperimentSummary {
  run_id: string
  kind: string | null
  created_at: string | null
  fitness: number | null
  runtime_seconds: number | null
  notes: string | null
  mine: boolean
  seed: number | null
  configuration_hash: string | null
  git_commit: string | null
  model_version: string | null
}

// The ledger record written by ExperimentRegistry.register (+ per-kind `extra`).
export interface ExperimentRecord {
  run_id: string
  kind: string
  created_at: string
  seed: number
  configuration: Record<string, Record<string, unknown>>
  configuration_hash: string
  fitness: number | null
  runtime_seconds: number | null
  artifacts: Record<string, string>
  notes: string
  environment: Record<string, unknown>
  model_version: string
  optimizer_version: string
  git_commit: string | null
  [extra: string]: unknown
}

export interface ExperimentDetail {
  record: ExperimentRecord
  artifacts: Record<string, string>
}

// backend/schemas.py::ArtifactInfo
export interface ArtifactInfo {
  name: string
  key: string | null
  size_bytes: number
  media_type: string
}
