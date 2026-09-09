// One function per endpoint in docs/API.md (auth + health). Shapes are the
// Pydantic models in backend/schemas.py, mirrored in ./types.ts.
import { request } from './client'
import type {
  ForgotPasswordRequest,
  ForgotPasswordResponse,
  HealthResponse,
  LoginRequest,
  MessageResponse,
  RegisterRequest,
  RegisterResponse,
  ResetPasswordRequest,
  TokenResponse,
  UserResponse,
  VerifyResponse,
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
