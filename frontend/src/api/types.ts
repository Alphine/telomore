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

// telomere_lab.schemas.SubcloneSpec.to_dict() (docs/MODEL.md §2.2, sub-clone
// competition). `overrides` keys must be one of `bounds.subclone_overridable`.
export interface SubcloneSpec {
  name: string
  initial_fraction: number
  overrides: Record<string, number>
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
  /** Genome stability (docs/MODEL.md §2.3): baseline mutation-burden rate per division; 0 = feature unused. */
  replication_error_rate: number
  /** Extra mutation-burden rate at stress_level = 1, offset by repair_rate; 0 = feature unused. */
  oxidative_mutation_sensitivity: number
  /** Apoptosis-checkpoint removal probability per cycle; 0 disables the checkpoint (the feature's off switch). */
  checkpoint_strength: number
  /** Mutation-burden level above which the checkpoint can trigger (only relevant when checkpoint_strength > 0). */
  mutation_threshold: number
  /** Per-division Gaussian step (SD) on each cell's own heritable repair_rate, clipped and inherited by daughters; 0 = feature unused. */
  repair_rate_mutation_sigma: number
  /** Bench-timeline assumption (docs/MODEL.md §2.6): hours per cycle; 0 = unused (no time axis). */
  hours_per_cycle: number
  /** Within-cell SD of initial telomere length (§2.7); 0 = unused (initial_length_sd applies within each cell). */
  initial_within_cell_sd: number
  /** CV of a heritable per-cell multiplier on division-driven shortening (§2.8); 0 = unused. */
  shortening_rate_cv: number
  /** Logistic width (bp) of a stochastic arrest around senescence_threshold (§2.9); 0 = hard threshold. */
  senescence_softness_bp: number
  /** Length-independent arrest probability per cycle for proliferating cells (§2.9); 0 = unused. */
  random_arrest_rate: number
  cycles: number
  seed: number
  record_distribution_every: number
  /** Optional time-varying protocol; when set, the scalar field of a scheduled parameter is its phase-0 value. */
  schedule?: InterventionSchedule | null
  /** Optional sub-clone competition (docs/MODEL.md §2.2); >= 2 clones, initial_fraction sums to ~1.0. */
  subclones?: SubcloneSpec[] | null
}

// telomere_lab.schemas.FitnessWeights
export interface FitnessWeights {
  w_survival: number
  w_reserve: number
  w_senescence: number
  w_instability: number
  w_cost: number
  /** Weight of the genome-instability term (docs/MODEL.md §2.3); 0.0 default keeps it inert. */
  w_genome_instability: number
  /** Weight of the canalization term (docs/MODEL.md §5); 0.0 default keeps it inert. Only meaningful with eval_seeds.length >= 2. */
  w_canalization: number
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

// telomere_lab.schemas.GenotypeSpec.to_dict() / EnvironmentSpec.to_dict() --
// symmetric "named parameter-override bundle" shapes for a G×E study
// (docs/ROADMAP.md 2026-09-13 follow-up). Genotype overrides must be one of
// `bounds.subclone_overridable`; environment overrides one of
// `bounds.environment_overridable`.
export interface GenotypeSpec {
  name: string
  overrides: Record<string, number>
}

export interface EnvironmentSpec {
  name: string
  overrides: Record<string, number>
}

// telomere_lab.schemas.GxEConfig.to_dict()
export interface GxEConfig {
  genotypes: GenotypeSpec[]
  environments: EnvironmentSpec[]
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
  /** SUBCLONE_OVERRIDABLE_PARAMETERS -- the only parameters a clone's `overrides` may set. */
  subclone_overridable: string[]
  /** ENVIRONMENT_OVERRIDABLE_PARAMETERS -- the only parameters a G×E EnvironmentSpec may set. */
  environment_overridable: string[]
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
  doubling_time_days: number
}

// chip_to_model_params return shape
export interface ChipParams {
  stress_level: number
  repair_rate: number
  cycles: number
}

// backend/schemas.py::ChipPresetInfo / ChipPresetsResponse (GET /api/meta/chip-presets,
// ROADMAP.md candidate feature #3: multi-chip comparison). Named, illustrative
// organ-chip condition profiles -- not calibrated to any organ's physiology
// (docs/SCIENTIFIC_SCOPE.md "organ-on-a-chip bridge").
export interface ChipPresetInfo {
  conditions: ChipConditions
  label: string
  description: string
  derived: ChipParams
}

export interface ChipPresetsResponse {
  presets: Record<string, ChipPresetInfo>
}

// --------------------------------------------------------------- simulate
export interface SimulateRequest {
  config: Partial<ModelConfig>
  /** Ledger provenance note (docs/ROADMAP.md LLM Layer 2 guardrail); omit for the default "via API". */
  provenance?: string
}

// evolution/fitness.py::FitnessBreakdown.to_dict()
export interface FitnessBreakdown {
  total: number
  survival: number
  reserve: number
  senescence: number
  instability: number
  cost: number
  /** Genome stability (docs/MODEL.md §2.3); inert (0) unless w_genome_instability is set. */
  genome_instability: number
  /** Consistency of survival across eval_seeds replicates (docs/MODEL.md §5); always 0 from a single simulation, only meaningful once averaged across replicates. */
  canalization: number
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
  /** Genome stability (docs/MODEL.md §2.3); absent on runs recorded before this feature existed. */
  final_mutation_burden?: number
  genomic_instability_index?: number
  /** Cumulative population doublings from division (docs/MODEL.md §2.5); absent on older runs. */
  total_pd?: number
  /** Only when hours_per_cycle > 0. */
  total_days?: number
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
  /** Genome stability (docs/MODEL.md §2.3): all-zero when the feature is unused. */
  mean_mutation_burden: Array<number | null>
  apoptotic_fraction: Array<number | null>
  /** Cumulative population doublings (docs/MODEL.md §2.5); absent on runs recorded before it existed. */
  population_doublings?: Array<number | null>
  /** Hours since start (hours_per_cycle x cycle); null when hours_per_cycle = 0. */
  time_hours?: Array<number | null>
}

// simulator/biomarker.py::BiologicalAgeScore.to_json_dict() (ROADMAP.md
// candidate feature #5). A synthetic, illustrative 0-100 "age index"
// composed purely of this result's own already-reported terminal metrics --
// `formula_note` is safe to surface verbatim as a UI caption/tooltip, and
// every place this score is shown MUST show a disclaimer alongside it
// (docs/SCIENTIFIC_SCOPE.md "Language policy"). `valid=false` (with
// `final_score: null` and an empty `score_over_time`) when the underlying
// simulation itself is invalid -- never NaN, never absent.
export interface BiologicalAgeScore {
  score_over_time: number[]
  final_score: number | null
  scale_label: string
  formula_note: string
  valid: boolean
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
  /**
   * Per-clone population-fraction-of-total array, each `cycles + 1` long on
   * the `timeseries.cycle` axis (docs/MODEL.md §2.2, sub-clone competition).
   * `{}` when the config has no `subclones`.
   */
  clone_fraction: Record<string, number[]>
  final_lengths_bp: number[]
  /** Synthetic "biological age" biomarker score (ROADMAP.md candidate feature #5). */
  biological_age: BiologicalAgeScore | null
  run_id: string
  fitness: FitnessBreakdown
}

export interface SimulateResponse {
  run: SimulationRun
}

// --------------------------------------------------------------- ensemble
// backend/schemas.py::Ensemble* (POST /api/simulate/ensemble, ROADMAP.md
// candidate feature #2). Runs the existing, unmodified simulator once per
// seed and returns the spread across seeds instead of one trajectory.
export const MIN_ENSEMBLE_SEEDS = 2
export const MAX_ENSEMBLE_SEEDS = 50

export interface EnsembleRequest {
  config: Partial<ModelConfig>
  n_seeds: number
  base_seed?: number
}

/**
 * Light-weight per-seed series -- NOT a full SimulationResult.to_json_dict()
 * (no final_lengths_bp / distribution_snapshots / per-seed config), just the
 * arrays the fan chart, terminal-metrics summary table and the multi-stream
 * particle visualization need, on the shared EnsembleBands.cycle axis.
 */
export interface EnsembleSeedResult {
  seed: number
  valid: boolean
  failure_reason: string | null
  mean_length: Array<number | null>
  shortest_length: Array<number | null>
  population_size: number[]
  proliferative_count: number[]
  senescent_fraction: Array<number | null>
  terminal_metrics: Partial<TerminalMetrics>
  /** Final synthetic "biological age" score for this seed (ROADMAP.md candidate feature #5); null when invalid. */
  biological_age_final: number | null
}

/**
 * p10 / p50 (median) / p90 + mean of mean_length across seeds, taken
 * independently at each cycle -- an honest, distribution-free description of
 * the spread across independent stochastic realizations of the same
 * configuration, NOT a confidence band around any single seed's trajectory.
 */
export interface EnsembleBands {
  cycle: number[]
  p10: Array<number | null>
  p50: Array<number | null>
  p90: Array<number | null>
  mean: Array<number | null>
}

export interface EnsembleResponse {
  run_id: string
  n_seeds: number
  base_seed: number
  seeds: number[]
  config: ModelConfig
  config_hash: string
  bands: EnsembleBands
  series: EnsembleSeedResult[]
  /** Shared by every seed (only the RNG differs); {} when the config has no schedule. */
  applied_schedule: Record<string, number[]>
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

// ------------------------------------------------------------------- gxe
// Genotype x Environment reaction-norm study (docs/ROADMAP.md 2026-09-13
// follow-up to Genome Stability). Each (genotype, environment) pair is run
// as an ISOLATED simulation, not as competing ModelConfig.subclones -- see
// docs/MODEL.md §2.2's cross-reference for why the sub-clone engine itself
// is not reused here.
export interface GxERequest {
  model: Partial<ModelConfig>
  gxe: Partial<GxEConfig>
  notes: string
}

// analysis/gxe.py::GxECell.to_dict() -- one per finished (genotype,
// environment) cell (the job's `progress`). Values are NaN (-> null) when
// the cell's simulation is invalid.
export interface GxECell {
  genotype: string
  environment: string
  fitness: number | null
  survival: number | null
  senescence: number | null
  /** Consistency of survival across this cell's eval_seeds replicates (docs/MODEL.md §5). */
  canalization: number | null
}

// backend/routers/gxe.py::_target return value.
export interface GxEResult {
  run_id: string | null
  items: GxECell[]
  /** Genotype-name pairs whose fitness ordering flips between at least two environments. */
  reranking_pairs: [string, string][]
  evaluations: number
  runtime_seconds: number
}

export type GxEJob = JobStatusResponse<GxECell, GxEResult>

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
// backend/schemas.py::CompareRequest / CompareScenario. A scenario is either
// a full `config` or organ-chip `chip` conditions (ROADMAP.md candidate
// feature #3: multi-chip comparison) -- never both, never neither; the
// server maps `chip` through chip_to_model_params and merges it onto
// CompareRequest.base_config.
export type CompareScenario =
  | { name: string; config: Partial<ModelConfig>; chip?: undefined }
  | { name: string; chip: ChipConditions; config?: undefined }

export interface CompareRequest {
  scenarios: CompareScenario[]
  /** Common random numbers: every scenario is re-seeded with this when set. */
  seed?: number
  /** Base config a `chip` scenario's derived params are merged onto; defaults to ModelConfig() defaults. */
  base_config?: Partial<ModelConfig>
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

// -------------------------------------------------------------------- llm
// LLM Layer 1, the read-only results interpreter (backend/llm.py,
// backend/schemas.py::LLM*). Bring-your-own-key: `api_key` is relayed to
// Anthropic for one request and never persisted server-side.
export type LLMProvider = 'anthropic'
export type LLMEffort = 'low' | 'medium' | 'high'

/** backend/schemas.py::LLMModelInfo (one row of backend.llm.MODELS). */
export interface LLMModelInfo {
  id: string
  label: string
  input_usd_per_mtok: number
  output_usd_per_mtok: number
}

/** GET /api/meta/llm */
export interface LLMMetaResponse {
  providers: LLMProvider[]
  models: LLMModelInfo[]
  default_model: string
  efforts: LLMEffort[]
  default_effort: LLMEffort
  rate_limit: { calls: number; window_seconds: number }
}

export interface LLMInterpretRequest {
  run_id: string
  api_key: string
  provider: LLMProvider
  model?: string
  effort?: LLMEffort
}

export interface LLMUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number | null
}

export interface LLMInterpretResponse {
  run_id: string
  model: string
  narrative_markdown: string
  usage: LLMUsage
  /** List-price estimate; the user's own invoice is the authority. */
  estimated_cost_usd: number | null
  warnings: string[]
}

export interface LLMValidateKeyRequest {
  api_key: string
  provider: LLMProvider
}

export interface LLMValidateKeyResponse {
  valid: boolean
  detail: string
}

/** The structured `detail` of every LLM error response (401/403/429/422/400/502). */
export interface LLMErrorDetail {
  code: 'llm_auth_failed' | 'llm_permission_denied' | 'llm_rate_limited' | 'llm_refusal' | 'llm_bad_request'
    | 'llm_upstream_error' | 'llm_proposal_invalid'
  message: string
  category?: string
}

// LLM Layer 2 -- protocol-designing agent (docs/ROADMAP.md "LLM agentic layer").
// Proposes a candidate stress_level/maintenance_rate/repair_rate protocol
// (optionally scheduled); NEVER runs a simulation itself. `config` in the
// response has already passed the same ModelConfig.validate() every other
// config passes -- the caller loads it into the Simulate form exactly like a
// named YAML preset and must press "Run simulation" themselves.
export interface LLMProposeRequest {
  goal: string
  base_config: ModelConfig
  api_key: string
  provider: LLMProvider
  model?: string
  effort?: LLMEffort
}

export interface LLMProposeResponse {
  rationale: string
  config: ModelConfig
  model: string
  usage: LLMUsage
  estimated_cost_usd: number | null
  warnings: string[]
}

// ------------------------------------------------ toy genome explorer
// backend/routers/sequence.py (GET /sequence/genome, POST /sequence/mutate, POST /sequence/lineage).
// Synthetic genes only (docs/MODEL.md §2.4).
export type MutationEffectClass = 'synonymous' | 'missense' | 'nonsense' | 'start_loss' | 'stop_loss'

export interface ToyGene {
  name: string
  role: string
  dna: string
  mrna: string
  protein: string
  profile: Record<string, number>
}

export interface ToyGenomeResponse {
  toy: true
  genes: ToyGene[]
}

export interface MutateResponse {
  toy: true
  gene: string
  position: number
  ref: string
  alt: string
  codon_index: number
  ref_codon: string
  alt_codon: string
  ref_aa: string
  alt_aa: string
  effect: MutationEffectClass
  mutated_dna: string
  mutated_mrna: string
  mutated_protein: string
}

export interface LineageRequest {
  cells?: number
  generations?: number
  mutation_rate?: number
  repair_penalty?: number
  missense_lof?: number
  burden_threshold?: number
  damaged_genes?: string[]
  seed?: number
}

export interface LineageSeries {
  generation: number[]
  alive_fraction: number[]
  mean_burden: Array<number | null>
  extinct: boolean
  [gene_functional: string]: unknown
}

export interface LineageResponse {
  toy: true
  normal: LineageSeries
  damaged: LineageSeries
  model_bridge: { normal: Record<string, number>; damaged: Record<string, number> }
}
