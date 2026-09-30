import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LLMMetaResponse, LLMProposeResponse, ModelConfig } from '../api/types'
import { mockFetch } from '../test/helpers'
import { ProtocolProposer } from './ProtocolProposer'
import { LLM_KEY_STORAGE, PROPOSE_FOOTER } from './llmKey'

const META: LLMMetaResponse = {
  providers: ['anthropic'],
  models: [
    { id: 'claude-opus-5', label: 'Claude Opus 5 (default, most thorough)', input_usd_per_mtok: 5, output_usd_per_mtok: 25 },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 (faster, cheaper)', input_usd_per_mtok: 2, output_usd_per_mtok: 10 },
  ],
  default_model: 'claude-opus-5',
  efforts: ['low', 'medium', 'high'],
  default_effort: 'medium',
  rate_limit: { calls: 10, window_seconds: 600 },
}

const BASE_CONFIG: ModelConfig = {
  initial_length: 7500, initial_length_sd: 800, population_size: 100, carrying_capacity: 400,
  telomeres_per_cell: 32, shortening_rate: 55, stress_level: 0.6, stress_sensitivity: 100,
  maintenance_rate: 0.1, maintenance_max_gain: 120, repair_rate: 0.15, senescence_threshold: 3000,
  noise_sd: 30, senescent_death_rate: 0.03,
  replication_error_rate: 0, oxidative_mutation_sensitivity: 0, checkpoint_strength: 0, mutation_threshold: 1e9,
  repair_rate_mutation_sigma: 0,
  hours_per_cycle: 0,
  initial_within_cell_sd: 0,
  shortening_rate_cv: 0,
  senescence_softness_bp: 0,
  random_arrest_rate: 0,
  cycles: 120, seed: 42, record_distribution_every: 0,
}

const PROPOSED: LLMProposeResponse = {
  rationale: 'Concentrate repair into the high-stress phases, per Experiment G.',
  config: {
    ...BASE_CONFIG,
    stress_level: 0.9, maintenance_rate: 1.0, repair_rate: 1.0,
    schedule: {
      phases: 6,
      values: {
        stress_level: [0.9, 0.3, 0.9, 0.3, 0.9, 0.3],
        maintenance_rate: [1.0, 0.7, 0.3, 1.0, 1.0, 0.8],
        repair_rate: [1.0, 0.4, 0.9, 0.0, 0.7, 0.0],
      },
    },
  },
  model: 'claude-opus-5',
  usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: null },
  estimated_cost_usd: 0.0075,
  warnings: [],
}

const KEY = 'sk-ant-api03-test-key'

function llmError(status: number, code: string, message: string) {
  return { status, body: { detail: { code, message } } }
}

beforeEach(() => {
  window.sessionStorage.clear()
  window.localStorage.clear()
})
afterEach(() => vi.unstubAllGlobals())

function open() {
  const panel = screen.getByTestId('protocol-proposer') as HTMLDetailsElement
  panel.open = true
  fireEvent(panel, new Event('toggle'))
}

describe('ProtocolProposer', () => {
  it('posts goal + base_config, then hands the validated config to onLoad without running anything itself', async () => {
    window.sessionStorage.setItem(LLM_KEY_STORAGE, KEY)
    const fetchMock = mockFetch({
      'GET /api/meta/llm': { status: 200, body: META },
      'POST /api/llm/propose-protocol': { status: 200, body: PROPOSED },
    })
    const onLoad = vi.fn()
    render(<ProtocolProposer baseConfig={BASE_CONFIG} onLoad={onLoad} />)
    open()
    expect(screen.getByText('Propose a protocol (bring your own key)')).toBeInTheDocument()
    expect(screen.getByLabelText('Anthropic API key')).toHaveValue(KEY)

    await waitFor(() => expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('claude-opus-5'))
    fireEvent.change(screen.getByLabelText('What do you want to try?'), {
      target: { value: 'an intermittent-fasting-like protocol' },
    })

    const proposeBtn = screen.getByRole('button', { name: 'Propose protocol' })
    expect(proposeBtn).toBeEnabled()
    fireEvent.click(proposeBtn)

    await screen.findByTestId('propose-result')
    // Never calls anything that would run a simulation -- only the propose route.
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/api/simulate'))).toBe(false)

    const call = fetchMock.mock.calls.find(([u, init]) => String(u).endsWith('/api/llm/propose-protocol') && init?.method === 'POST')!
    expect(JSON.parse(call[1]!.body as string)).toEqual({
      goal: 'an intermittent-fasting-like protocol',
      base_config: BASE_CONFIG,
      api_key: KEY,
      provider: 'anthropic',
      model: 'claude-opus-5',
      effort: 'medium',
    })

    expect(onLoad).toHaveBeenCalledWith(PROPOSED.config, PROPOSED.rationale)
    expect(screen.getByTestId('propose-rationale')).toHaveTextContent(PROPOSED.rationale)
    expect(screen.getByText(/Loaded into the form on the left/)).toBeInTheDocument()
    expect(screen.getByText(PROPOSE_FOOTER)).toBeInTheDocument()
  })

  it('disables Propose protocol until a key and a non-empty goal are both present', async () => {
    mockFetch({ 'GET /api/meta/llm': { status: 200, body: META } })
    render(<ProtocolProposer baseConfig={BASE_CONFIG} onLoad={vi.fn()} />)
    open()
    const proposeBtn = () => screen.getByRole('button', { name: 'Propose protocol' })
    expect(proposeBtn()).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Anthropic API key'), { target: { value: KEY } })
    expect(proposeBtn()).toBeDisabled() // no goal yet

    fireEvent.change(screen.getByLabelText('What do you want to try?'), { target: { value: '  ' } })
    expect(proposeBtn()).toBeDisabled() // whitespace-only goal

    fireEvent.change(screen.getByLabelText('What do you want to try?'), { target: { value: 'try something' } })
    await waitFor(() => expect(proposeBtn()).toBeEnabled())
  })

  it.each([
    [llmError(401, 'llm_auth_failed', 'Anthropic rejected the API key (401).'), /Anthropic rejected this API key/],
    [llmError(429, 'llm_rate_limited', 'At most 10 proposals per 10 minutes per user.'), /Rate limit: At most 10/],
    [llmError(422, 'llm_proposal_invalid', 'phases=99 is out of range [1, 8].'), /did not pass validation.*phases=99/],
  ])('shows a plain message for %o and never calls onLoad', async (response, expected) => {
    window.sessionStorage.setItem(LLM_KEY_STORAGE, KEY)
    mockFetch({ 'GET /api/meta/llm': { status: 200, body: META }, 'POST /api/llm/propose-protocol': response })
    const onLoad = vi.fn()
    render(<ProtocolProposer baseConfig={BASE_CONFIG} onLoad={onLoad} />)
    open()
    fireEvent.change(screen.getByLabelText('What do you want to try?'), { target: { value: 'try something' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Propose protocol' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Propose protocol' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(expected)
    expect(onLoad).not.toHaveBeenCalled()
    expect(screen.queryByTestId('propose-result')).not.toBeInTheDocument()
  })

  it('disables the controls while a request is in flight', async () => {
    window.sessionStorage.setItem(LLM_KEY_STORAGE, KEY)
    let resolve!: (r: Response) => void
    const pending = new Promise<Response>((r) => {
      resolve = r
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/meta/llm')) return new Response(JSON.stringify(META), { status: 200 })
      if (url.endsWith('/api/llm/propose-protocol') && init?.method === 'POST') return pending
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ProtocolProposer baseConfig={BASE_CONFIG} onLoad={vi.fn()} />)
    open()
    fireEvent.change(screen.getByLabelText('What do you want to try?'), { target: { value: 'try something' } })
    const propose = () => screen.getByRole('button', { name: /Propos/ })
    await waitFor(() => expect(propose()).toBeEnabled())
    fireEvent.click(propose())
    expect(propose()).toHaveTextContent('Proposing…')
    expect(propose()).toBeDisabled()
    expect(screen.getByLabelText('Anthropic API key')).toBeDisabled()
    resolve(new Response(JSON.stringify(PROPOSED), { status: 200 }))
    await screen.findByTestId('propose-result')
    expect(propose()).toBeEnabled()
  })
})
