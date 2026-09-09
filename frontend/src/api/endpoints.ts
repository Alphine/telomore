// One function per endpoint in docs/API.md. Shapes are the Pydantic models in
// backend/schemas.py, mirrored in ./types.ts.
import { request } from './client'
import type {
  BoundsResponse,
  ChipConditions,
  ChipParams,
  EvolveRequest,
  ForgotPasswordRequest,
  ForgotPasswordResponse,
  HealthResponse,
  JobStartResponse,
  JobStatusResponse,
  LoginRequest,
  MessageResponse,
  RegisterRequest,
  RegisterResponse,
  ResetPasswordRequest,
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

// --------------------------------------------------------------- simulate
export function simulate(body: SimulateRequest): Promise<SimulateResponse> {
  return request<SimulateResponse>('/simulate', { method: 'POST', body })
}

// ------------------------------------------------------------------- jobs
export function startEvolve(body: EvolveRequest): Promise<JobStartResponse> {
  return request<JobStartResponse>('/evolve', { method: 'POST', body })
}

export function getJob<P, R>(jobId: string): Promise<JobStatusResponse<P, R>> {
  return request<JobStatusResponse<P, R>>(`/jobs/${encodeURIComponent(jobId)}`)
}

export function stopJob<P, R>(jobId: string): Promise<JobStatusResponse<P, R>> {
  return request<JobStatusResponse<P, R>>(`/jobs/${encodeURIComponent(jobId)}/stop`, { method: 'POST' })
}
