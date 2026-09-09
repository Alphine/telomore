// Wire types -- field names copied verbatim from backend/schemas.py
// (the Pydantic models). Do not add fields that are not in that file.

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
