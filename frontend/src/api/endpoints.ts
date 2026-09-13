// One function per endpoint in docs/API.md. Shapes are the Pydantic models in
// backend/schemas.py, mirrored in ./types.ts.
import { API_BASE, request, requestBlob } from './client'
import type {
  ActiveLearningRequest,
  ArtifactInfo,
  BoundsResponse,
  ChipConditions,
  ChipParams,
  ChipPresetsResponse,
  CompareRequest,
  CompareResponse,
  EnsembleRequest,
  EnsembleResponse,
  EvolveRequest,
  ExperimentDetail,
  ExperimentSummary,
  ForgotPasswordRequest,
  ForgotPasswordResponse,
  GxERequest,
  HealthResponse,
  JobStartResponse,
  JobStatusResponse,
  LoginRequest,
  MessageResponse,
  ParetoRequest,
  RegisterRequest,
  RegisterResponse,
  ResetPasswordRequest,
  SensitivityRequest,
  SimulateRequest,
  SimulateResponse,
  TokenResponse,
  UserResponse,
  VerifyResponse,
  VersionResponse,
} from './types'

export function health(): Promise<HealthResponse> {
  return request<HealthResponse>('/health', { token: null })
}

export function register(body: RegisterRequest): Promise<RegisterResponse> {
  return request<RegisterResponse>('/auth/register', { method: 'POST', body, token: null })
}

export function verifyEmail(token: string): Promise<VerifyResponse> {
  return request<VerifyResponse>('/auth/verify', { query: { token }, token: null })
}

export function login(body: LoginRequest): Promise<TokenResponse> {
  return request<TokenResponse>('/auth/login', { method: 'POST', body, token: null })
}

export function forgotPassword(body: ForgotPasswordRequest): Promise<ForgotPasswordResponse> {
  return request<ForgotPasswordResponse>('/auth/forgot-password', { method: 'POST', body, token: null })
}

export function resetPassword(body: ResetPasswordRequest): Promise<MessageResponse> {
  return request<MessageResponse>('/auth/reset-password', { method: 'POST', body, token: null })
}

export function me(token?: string): Promise<UserResponse> {
  return request<UserResponse>('/auth/me', token === undefined ? {} : { token })
}

// ------------------------------------------------------------------- meta
/** Public: parameter bounds + every default the forms are driven by. */
export function metaBounds(): Promise<BoundsResponse> {
  return request<BoundsResponse>('/meta/bounds', { token: null })
}

/** Public: package / model / optimizer versions. */
export function metaVersion(): Promise<VersionResponse> {
  return request<VersionResponse>('/meta/version', { token: null })
}

/** Protected: organ-on-chip conditions -> derived stress_level / repair_rate / cycles. */
export function chipToParams(body: ChipConditions): Promise<ChipParams> {
  return request<ChipParams>('/meta/chip-to-params', { method: 'POST', body })
}

/** Public: named illustrative organ-chip presets + their derived params (ROADMAP.md candidate feature #3). */
export function metaChipPresets(): Promise<ChipPresetsResponse> {
  return request<ChipPresetsResponse>('/meta/chip-presets', { token: null })
}

// --------------------------------------------------------------- simulate
export function simulate(body: SimulateRequest): Promise<SimulateResponse> {
  return request<SimulateResponse>('/simulate', { method: 'POST', body })
}

/** Run N seeds of one config and return the spread across seeds (ROADMAP.md candidate feature #2). */
export function simulateEnsemble(body: EnsembleRequest): Promise<EnsembleResponse> {
  return request<EnsembleResponse>('/simulate/ensemble', { method: 'POST', body })
}

// ------------------------------------------------------------------- jobs
export function startEvolve(body: EvolveRequest): Promise<JobStartResponse> {
  return request<JobStartResponse>('/evolve', { method: 'POST', body })
}

export function startPareto(body: ParetoRequest): Promise<JobStartResponse> {
  return request<JobStartResponse>('/pareto', { method: 'POST', body })
}

export function startSensitivity(body: SensitivityRequest): Promise<JobStartResponse> {
  return request<JobStartResponse>('/sensitivity', { method: 'POST', body })
}

export function startGxE(body: GxERequest): Promise<JobStartResponse> {
  return request<JobStartResponse>('/gxe', { method: 'POST', body })
}

export function startActiveLearning(body: ActiveLearningRequest): Promise<JobStartResponse> {
  return request<JobStartResponse>('/active-learning', { method: 'POST', body })
}

export function getJob<P, R>(jobId: string): Promise<JobStatusResponse<P, R>> {
  return request<JobStatusResponse<P, R>>(`/jobs/${encodeURIComponent(jobId)}`)
}

export function stopJob<P, R>(jobId: string): Promise<JobStatusResponse<P, R>> {
  return request<JobStatusResponse<P, R>>(`/jobs/${encodeURIComponent(jobId)}/stop`, { method: 'POST' })
}

// ---------------------------------------------------------------- compare
/** Synchronous: up to six named scenarios, deltas vs. the first one. */
export function compare(body: CompareRequest): Promise<CompareResponse> {
  return request<CompareResponse>('/compare', { method: 'POST', body })
}

// ------------------------------------------------------------ experiments
export function listExperiments(mine: boolean): Promise<ExperimentSummary[]> {
  return request<ExperimentSummary[]>('/experiments', { query: { mine } })
}

export function getExperiment(runId: string): Promise<ExperimentDetail> {
  return request<ExperimentDetail>(`/experiments/${encodeURIComponent(runId)}`)
}

export function listArtifacts(runId: string): Promise<ArtifactInfo[]> {
  return request<ArtifactInfo[]>(`/experiments/${encodeURIComponent(runId)}/artifacts`)
}

/** The download route's URL (for `href`s); fetching it needs the bearer token, see downloadArtifact. */
export function artifactUrl(runId: string, name: string): string {
  return `${API_BASE}/experiments/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}`
}

/** Authenticated fetch of one artifact file as a Blob. */
export function downloadArtifact(runId: string, name: string): Promise<Blob> {
  return requestBlob(`/experiments/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}`)
}
