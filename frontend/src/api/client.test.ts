import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, request } from './client'
import { mapBackendLink } from './devLinks'

afterEach(() => vi.unstubAllGlobals())

describe('ApiError', () => {
  it('uses a string detail as the message', () => {
    expect(new ApiError(401, 'Wrong username or password.').message).toBe('Wrong username or password.')
  })
  it('flattens FastAPI validation-error details', () => {
    const e = new ApiError(422, [{ loc: ['body', 'email'], msg: 'String should have at least 3 characters' }])
    expect(e.message).toBe('email: String should have at least 3 characters')
  })
})

describe('request', () => {
  it('throws ApiError with status + detail on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ detail: 'nope' }), { status: 403 })),
    )
    await expect(request('/x')).rejects.toMatchObject({ status: 403, detail: 'nope' })
  })
})

describe('mapBackendLink', () => {
  it('routes /?token= to /verify', () => {
    expect(mapBackendLink('/?token=abc')).toMatchObject({ kind: 'verify', to: '/verify?token=abc' })
  })
  it('routes absolute /?reset_token= to /reset-password', () => {
    expect(mapBackendLink('https://lab.example/?reset_token=xyz')).toMatchObject({
      kind: 'reset',
      to: '/reset-password?token=xyz',
    })
  })
})
