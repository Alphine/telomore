// LLM Layer 1 endpoints (docs/API.md "LLM results interpreter"). Kept apart
// from endpoints.ts because the request bodies carry the user's own API key:
// callers must pass it explicitly from sessionStorage, never from a store.
import { request } from './client'
import type {
  LLMInterpretRequest,
  LLMInterpretResponse,
  LLMMetaResponse,
  LLMProposeRequest,
  LLMProposeResponse,
  LLMValidateKeyRequest,
  LLMValidateKeyResponse,
} from './types'

/** Public: providers, models with list prices, efforts, rate limit. */
export function metaLLM(): Promise<LLMMetaResponse> {
  return request<LLMMetaResponse>('/meta/llm', { token: null })
}

/** Protected: one narrative for one recorded run, on the user's key. */
export function interpretRun(body: LLMInterpretRequest): Promise<LLMInterpretResponse> {
  return request<LLMInterpretResponse>('/llm/interpret', { method: 'POST', body })
}

/** Protected: cheap key check (models.retrieve, no tokens billed). */
export function validateLLMKey(body: LLMValidateKeyRequest): Promise<LLMValidateKeyResponse> {
  return request<LLMValidateKeyResponse>('/llm/validate-key', { method: 'POST', body })
}

/** Protected: LLM Layer 2 -- propose a protocol on the user's key. Never runs anything. */
export function proposeProtocol(body: LLMProposeRequest): Promise<LLMProposeResponse> {
  return request<LLMProposeResponse>('/llm/propose-protocol', { method: 'POST', body })
}
