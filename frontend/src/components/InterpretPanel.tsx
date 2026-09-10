// LLM Layer 1 (docs/ROADMAP.md): a collapsible "AI interpretation" card that
// asks POST /api/llm/interpret for a narrative of one recorded run, on the
// user's own Anthropic key. The key lives in sessionStorage only
// (`tel_llm_key`: this tab, until it closes) and is sent to our server solely
// so it can relay the request to Anthropic -- never to localStorage, never to
// the ledger. Read-only by construction: the panel can show text about a run,
// nothing here can start or change one.
import { Suspense, lazy, useEffect, useState } from 'react'

import { interpretRun, metaLLM, validateLLMKey } from '../api/llm'
import type { LLMEffort, LLMInterpretResponse, LLMMetaResponse } from '../api/types'
import { Callout } from './Callout'
import { INTERPRET_FOOTER, describeLLMError, readStoredKey, storeKey } from './llmKey'

const LazyMarkdown = lazy(() => import('./MarkdownView'))

function formatUsd(v: number): string {
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(3)}`
}

export function InterpretPanel({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false)
  const [meta, setMeta] = useState<LLMMetaResponse | null>(null)
  const [metaError, setMetaError] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState<string>(() => readStoredKey())
  const [model, setModel] = useState<string | null>(null)
  const [effort, setEffort] = useState<LLMEffort | null>(null)
  const [busy, setBusy] = useState<'validate' | 'interpret' | null>(null)
  const [keyStatus, setKeyStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Keyed by run id so switching runs needs no reset-in-effect.
  const [result, setResult] = useState<{ id: string; data: LLMInterpretResponse } | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!open || meta) return
    let cancelled = false
    metaLLM()
      .then((m) => {
        if (!cancelled) setMeta(m)
      })
      .catch((err: unknown) => {
        if (!cancelled) setMetaError(err instanceof Error ? err.message : 'Could not load the model list.')
      })
    return () => {
      cancelled = true
    }
  }, [open, meta])

  const effectiveModel = model ?? meta?.default_model ?? null
  const effectiveEffort = effort ?? meta?.default_effort ?? 'medium'
  const current = result?.id === runId ? result.data : null
  const trimmedKey = apiKey.trim()

  function onKeyChange(next: string) {
    setApiKey(next)
    storeKey(next.trim())
    setKeyStatus(null)
  }

  async function validate() {
    if (!trimmedKey) return
    setBusy('validate')
    setError(null)
    setKeyStatus(null)
    try {
      const r = await validateLLMKey({ api_key: trimmedKey, provider: 'anthropic' })
      setKeyStatus({ ok: r.valid, text: r.detail })
    } catch (err: unknown) {
      setKeyStatus({ ok: false, text: describeLLMError(err) })
    } finally {
      setBusy(null)
    }
  }

  async function interpret() {
    if (!trimmedKey || !effectiveModel) return
    setBusy('interpret')
    setError(null)
    setCopied(false)
    try {
      const data = await interpretRun({
        run_id: runId,
        api_key: trimmedKey,
        provider: 'anthropic',
        model: effectiveModel,
        effort: effectiveEffort,
      })
      setResult({ id: runId, data })
    } catch (err: unknown) {
      setError(describeLLMError(err))
    } finally {
      setBusy(null)
    }
  }

  async function copy() {
    if (!current) return
    try {
      await navigator.clipboard.writeText(current.narrative_markdown)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const selectedModel = meta?.models.find((m) => m.id === effectiveModel)

  return (
    <details
      className="card p-5"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      data-testid="interpret-panel"
    >
      <summary className="cursor-pointer select-none text-sm font-semibold">
        AI interpretation (bring your own key)
      </summary>

      <div className="mt-4 space-y-4">
        <p className="prose-muted">
          Ask an LLM to narrate what this run recorded — Problem, Method, AI contribution, Evidence, Trade-offs &amp;
          caveats — under the same scope policy as the rest of this lab. It reads the ledger record and artifacts
          only; it cannot run or change a simulation.
        </p>

        {metaError && (
          <Callout tone="error" role="alert">
            Could not load the model list: {metaError}
          </Callout>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="label" htmlFor={`llm-provider-${runId}`}>
              Provider
            </label>
            <select id={`llm-provider-${runId}`} className="input" value="anthropic" disabled>
              <option value="anthropic">Anthropic</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor={`llm-key-${runId}`}>
              Anthropic API key
            </label>
            <input
              id={`llm-key-${runId}`}
              className="input font-mono"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-…"
              value={apiKey}
              onChange={(e) => onKeyChange(e.target.value)}
              disabled={busy !== null}
            />
            <p className="prose-muted mt-1 text-xs">
              Kept in this tab only (sessionStorage), sent to our server only to relay to Anthropic, never stored. You
              pay Anthropic directly for the tokens used.
            </p>
          </div>
          <div>
            <label className="label" htmlFor={`llm-model-${runId}`}>
              Model
            </label>
            <select
              id={`llm-model-${runId}`}
              className="input"
              value={effectiveModel ?? ''}
              onChange={(e) => setModel(e.target.value)}
              disabled={!meta || busy !== null}
            >
              {!meta && <option value="">Loading…</option>}
              {meta?.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — ${m.input_usd_per_mtok}/{m.output_usd_per_mtok} per MTok in/out
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor={`llm-effort-${runId}`}>
              Effort
            </label>
            <select
              id={`llm-effort-${runId}`}
              className="input"
              value={effectiveEffort}
              onChange={(e) => setEffort(e.target.value as LLMEffort)}
              disabled={!meta || busy !== null}
            >
              {(meta?.efforts ?? ['medium']).map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-ghost" onClick={() => void validate()} disabled={!trimmedKey || busy !== null}>
            {busy === 'validate' ? 'Checking…' : 'Validate key'}
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void interpret()}
            disabled={!trimmedKey || !effectiveModel || busy !== null}
          >
            {busy === 'interpret' ? 'Interpreting… (this can take a minute)' : 'Interpret this run'}
          </button>
          {meta && (
            <span className="prose-muted text-xs">
              Max {meta.rate_limit.calls} interpretations per {Math.round(meta.rate_limit.window_seconds / 60)} min per
              user.
            </span>
          )}
        </div>

        {keyStatus && (
          <Callout tone={keyStatus.ok ? 'success' : 'error'} role="status">
            {keyStatus.text}
          </Callout>
        )}
        {error && (
          <Callout tone="error" role="alert">
            {error}
          </Callout>
        )}
        {busy === 'interpret' && (
          <p className="prose-muted" role="status">
            Waiting for {selectedModel?.label ?? effectiveModel}…
          </p>
        )}

        {current && (
          <section className="space-y-3" aria-label="AI interpretation" data-testid="interpret-result">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-base font-semibold">Interpretation of {current.run_id}</h3>
              <button type="button" className="btn-ghost !px-3 !py-1" onClick={() => void copy()}>
                {copied ? '✓ Copied' : 'Copy Markdown'}
              </button>
            </div>
            {current.warnings.map((w) => (
              <Callout key={w} tone="warning">
                {w}
              </Callout>
            ))}
            <Suspense fallback={<pre className="mono-block whitespace-pre-wrap text-xs">{current.narrative_markdown}</pre>}>
              <LazyMarkdown source={current.narrative_markdown} />
            </Suspense>
            <p className="prose-muted text-xs" data-testid="interpret-usage">
              {current.model} · {current.usage.input_tokens.toLocaleString()} in / {current.usage.output_tokens.toLocaleString()}{' '}
              out tokens
              {current.usage.cache_read_input_tokens ? ` (${current.usage.cache_read_input_tokens.toLocaleString()} cached)` : ''}
              {current.estimated_cost_usd !== null && ` · estimated cost ${formatUsd(current.estimated_cost_usd)} (list price; your invoice is the authority)`}
            </p>
            <Callout tone="info">{INTERPRET_FOOTER}</Callout>
          </section>
        )}
      </div>
    </details>
  )
}
