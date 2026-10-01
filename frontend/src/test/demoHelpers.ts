import type { UserResponse } from '../api/types'
import type { FakeResponse } from './helpers'

/** A user body for GET /api/auth/me. */
export function me(over: Partial<UserResponse> = {}): UserResponse {
  return {
    id: 7,
    username: 'alice',
    email: 'a@x.io',
    is_verified: true,
    plan: 'free',
    is_admin: false,
    plan_expires_at: null,
    pending_request: false,
    ...over,
  }
}

export const DEMO_INDEX = {
  version: 1,
  generated_at: '2026-10-01T00:00:00Z',
  engine_version: 'test',
  features: {
    simulate: [
      { id: 'alpha', title: 'Alpha run', description: 'First example', file: 'simulate/alpha.json', sha: 'abcdef0123456789' },
      { id: 'beta', title: 'Beta run', description: 'Second example', file: 'simulate/beta.json' },
    ],
    evolve: [],
  },
}

export function demoScenario(id: string, feature = 'simulate') {
  return {
    id,
    title: `${id} title`,
    description: 'd',
    feature,
    request: { config: { seed: id === 'alpha' ? 1 : 2 } },
    response: { marker: id },
    meta: {},
  }
}

/** Routes for the static demo cache, ready to spread into mockFetch(). */
export function demoCacheRoutes(): Record<string, FakeResponse> {
  return {
    'GET /demo-cache/index.json': { status: 200, body: DEMO_INDEX },
    'GET /demo-cache/simulate/alpha.json': { status: 200, body: demoScenario('alpha') },
    'GET /demo-cache/simulate/beta.json': { status: 200, body: demoScenario('beta') },
  }
}
