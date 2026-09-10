import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LLMInterpretResponse, LLMMetaResponse } from '../api/types'
import { mockFetch } from '../test/helpers'
import { InterpretPanel } from './InterpretPanel'
import { INTERPRET_FOOTER, LLM_KEY_STORAGE, describeLLMError } from './llmKey'
import { ApiError } from '../api/client'

const META: LLMMetaResponse = {
  providers: ['anthropic'],
  models: [
    { id: 'claude-opus-5', label: 'Claude Opus 5 (default, most thorough)', input_usd_per_mtok: 5, output_usd_per_mtok: 25 },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 (faster, cheaper)', input_usd_per_mtok: 2, output_usd_per_mtok: 10 },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (cheapest)', input_usd_per_mtok: 1, output_usd_per_mtok: 5 },
  ],
  default_model: 'claude-opus-5',
  efforts: ['low', 'medium', 'high'],
  default_effort: 'medium',
  rate_limit: { calls: 10, window_seconds: 600 },
}

const RESULT: LLMInterpretResponse = {
  run_id: 'TEL-20260910-001',
  model: 'claude-opus-5',
  narrative_markdown:
    '### Problem\nA stressed culture whose reserve collapses.\n\n### Evidence\n- Best fitness **+0.625** vs baseline −0.134\n\n<script>alert(1)</script>',
  usage: { input_tokens: 1200, output_tokens: 800, cache_read_input_tokens: null },
  estimated_cost_usd: 0.026,
  warnings: [],
}

const KEY = 'sk-ant-api03-test-key'

function llmError(status: number, code: string, message: string, category?: string) {
  return { status, body: { detail: { code, message, ...(category ? { category } : {}) } } }
}

beforeEach(() => {
  window.sessionStorage.clear()
  window.localStorage.clear()
})
afterEach(() => vi.unstubAllGlobals())

function open() {
  const panel = screen.getByTestId('interpret-panel') as HTMLDetailsElement
  panel.open = true
  fireEvent(panel, new Event('toggle'))
}

describe('InterpretPanel', () => {
  it('reads the key from sessionStorage, posts the exact body and renders the Markdown result + cost', async () => {
    window.sessionStorage.setItem(LLM_KEY_STORAGE, KEY)
    const fetchMock = mockFetch({
      'GET /api/meta/llm': { status: 200, body: META },
      'POST /api/llm/interpret': { status: 200, body: RESULT },
    })
    render(<InterpretPanel runId="TEL-20260910-001" />)
    open()
    expect(screen.getByText('AI interpretation (bring your own key)')).toBeInTheDocument()
    expect(screen.getByLabelText('Anthropic API key')).toHaveValue(KEY)
    expect(screen.getByLabelText('Anthropic API key')).toHaveAttribute('type', 'password')
    expect(screen.getByText(/Kept in this tab only/)).toBeInTheDocument()

    const modelSelect = (await screen.findByLabelText('Model')) as HTMLSelectElement
    await waitFor(() => expect(modelSelect.value).toBe('claude-opus-5'))
    expect(screen.getByText(/Claude Opus 5 .* \$5\/25 per MTok/)).toBeInTheDocument()
    expect(screen.getByText(/Max 10 interpretations per 10 min/)).toBeInTheDocument()

    fireEvent.change(modelSelect, { target: { value: 'claude-sonnet-5' } })
    fireEvent.change(screen.getByLabelText('Effort'), { target: { value: 'high' } })
    fireEvent.click(screen.getByRole('button', { name: 'Interpret this run' }))

    await screen.findByTestId('interpret-result')
    const call = fetchMock.mock.calls.find(([u, init]) => String(u).endsWith('/api/llm/interpret') && init?.method === 'POST')!
    expect(JSON.parse(call[1]!.body as string)).toEqual({
      run_id: 'TEL-20260910-001',
      api_key: KEY,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      effort: 'high',
    })

    // Markdown rendered as elements, raw HTML not executed/injected. Generous
    // timeout: MarkdownView is lazy-loaded (React.lazy), and the dynamic
    // import can take longer than the default 1s under a full parallel run.
    const view = await screen.findByTestId('markdown-view', {}, { timeout: 5000 })
    expect(view.querySelector('h3')).toHaveTextContent('Problem')
    expect(view.querySelector('strong')).toHaveTextContent('+0.625')
    expect(view.querySelector('script')).toBeNull()
    expect(screen.getByTestId('interpret-usage')).toHaveTextContent('claude-opus-5 · 1,200 in / 800 out tokens · estimated cost $0.026')
    expect(screen.getByText(INTERPRET_FOOTER)).toBeInTheDocument()

    // The key never touches localStorage.
    expect(Object.keys(window.localStorage)).toEqual([])
    expect(window.sessionStorage.getItem(LLM_KEY_STORAGE)).toBe(KEY)
  })

  it('stores a typed key in sessionStorage only and validates it', async () => {
    const fetchMock = mockFetch({
      'GET /api/meta/llm': { status: 200, body: META },
      'POST /api/llm/validate-key': { status: 200, body: { valid: false, detail: 'Anthropic rejected the API key (401).' } },
    })
    render(<InterpretPanel runId="TEL-1" />)
    open()
    const buttons = () => ({
      validate: screen.getByRole('button', { name: 'Validate key' }),
      interpret: screen.getByRole('button', { name: 'Interpret this run' }),
    })
    expect(buttons().validate).toBeDisabled()
    expect(buttons().interpret).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Anthropic API key'), { target: { value: ' sk-ant-fake ' } })
    expect(window.sessionStorage.getItem(LLM_KEY_STORAGE)).toBe('sk-ant-fake')
    expect(window.localStorage.getItem(LLM_KEY_STORAGE)).toBeNull()
    await waitFor(() => expect(buttons().validate).toBeEnabled())

    fireEvent.click(buttons().validate)
    expect(await screen.findByRole('status')).toHaveTextContent('Anthropic rejected the API key (401).')
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/api/llm/validate-key'))!
    expect(JSON.parse(call[1]!.body as string)).toEqual({ api_key: 'sk-ant-fake', provider: 'anthropic' })
  })

  it.each([
    [llmError(401, 'llm_auth_failed', 'Anthropic rejected the API key (401).'), /Anthropic rejected this API key/],
    [llmError(429, 'llm_rate_limited', 'Anthropic rate limit or spend cap reached (429).'), /rate-limiting this key/],
    [llmError(429, 'llm_rate_limited', 'At most 10 interpretations per 10 minutes per user.'), /Rate limit: At most 10/],
    [llmError(422, 'llm_refusal', 'The model declined to answer.', 'bio'), /declined to write this interpretation \(category: bio\)/],
    [llmError(502, 'llm_upstream_error', 'Could not connect to Anthropic.'), /Could not reach Anthropic/],
  ])('shows a plain message for %o', async (response, expected) => {
    window.sessionStorage.setItem(LLM_KEY_STORAGE, KEY)
    mockFetch({ 'GET /api/meta/llm': { status: 200, body: META }, 'POST /api/llm/interpret': response })
    render(<InterpretPanel runId="TEL-1" />)
    open()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Interpret this run' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Interpret this run' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(expected)
    expect(screen.queryByTestId('interpret-result')).not.toBeInTheDocument()
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
      if (url.endsWith('/api/llm/interpret') && init?.method === 'POST') return pending
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<InterpretPanel runId="TEL-1" />)
    open()
    const interpret = () => screen.getByRole('button', { name: /Interpret/ })
    await waitFor(() => expect(interpret()).toBeEnabled())
    fireEvent.click(interpret())
    expect(interpret()).toHaveTextContent('Interpreting…')
    expect(interpret()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Validate key' })).toBeDisabled()
    expect(screen.getByLabelText('Anthropic API key')).toBeDisabled()
    expect(screen.getByLabelText('Model')).toBeDisabled()
    resolve(new Response(JSON.stringify(RESULT), { status: 200 }))
    await screen.findByTestId('interpret-result')
    expect(interpret()).toBeEnabled()
  })

  it('describeLLMError distinguishes our JWT 401 from an Anthropic key 401', () => {
    expect(describeLLMError(new ApiError(401, 'Could not validate credentials'))).toMatch(/session has expired/)
    expect(describeLLMError(new ApiError(401, { code: 'llm_auth_failed', message: 'x' }))).toMatch(/rejected this API key/)
    expect(describeLLMError(new Error('offline'))).toBe('offline')
  })
})
