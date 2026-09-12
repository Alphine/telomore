// LLM Layer 2 (docs/ROADMAP.md "LLM agentic layer"): a collapsible "Propose a
// protocol" card that asks POST /api/llm/propose-protocol for a candidate
// stress_level/maintenance_rate/repair_rate protocol on the user's own
// Anthropic key, given a free-text goal and the current Simulate-page config.
// Same session-only key handling as InterpretPanel.tsx (llmKey.ts). Hard
// safety boundary: this component can only hand a proposed config to its
// `onLoad` callback for the caller to load into the *form* -- it never calls
// the simulate endpoint itself, so running one still requires the user's own
// "Run simulation" click, and the config it hands over has already passed
// the same ModelConfig.validate() every other config passes (enforced
// server-side, backend/llm.py::propose_protocol).
import { useEffect, useState } from 'react'

import { metaLLM, proposeProtocol, validateLLMKey } from '../api/llm'
import type { LLMEffort, LLMMetaResponse, ModelConfig } from '../api/types'
import { Callout } from './Callout'
import { PROPOSE_FOOTER, describeLLMError, readStoredKey, storeKey } from './llmKey'

export interface ProtocolProposerProps {
  /** The current Simulate-page config -- only stress_level/maintenance_rate/
   * repair_rate/schedule may change; everything else is held fixed by the
   * backend regardless of what the model returns. */
  baseConfig: ModelConfig
  /** Called with the validated proposed config and its rationale; the caller
   * loads it into the form exactly like a named preset (ScheduleEditor's
   * onLoadPreset) -- nothing runs until the user presses "Run simulation". */
  onLoad: (config: ModelConfig, rationale: string) => void
  disabled?: boolean
}

export function ProtocolProposer({ baseConfig, onLoad, disabled = false }: ProtocolProposerProps) {
  const [open, setOpen] = useState(false)
  const [meta, setMeta] = useState<LLMMetaResponse | null>(null)
  const [metaError, setMetaError] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState<string>(() => readStoredKey())
  const [model, setModel] = useState<string | null>(null)
  const [effort, setEffort] = useState<LLMEffort | null>(null)
  const [goal, setGoal] = useState('')
  const [busy, setBusy] = useState<'validate' | 'propose' | null>(null)
  const [keyStatus, setKeyStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ rationale: string; loaded: boolean } | null>(null)

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
  const trimmedKey = apiKey.trim()
  const trimmedGoal = goal.trim()

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

  async function propose() {
    if (!trimmedKey || !effectiveModel || !trimmedGoal) return
    setBusy('propose')
    setError(null)
    setResult(null)
    try {
      const data = await proposeProtocol({
        goal: trimmedGoal,
        base_config: baseConfig,
        api_key: trimmedKey,
        provider: 'anthropic',
        model: effectiveModel,
        effort: effectiveEffort,
      })
      setResult({ rationale: data.rationale, loaded: false })
      onLoad(data.config, data.rationale)
      setResult({ rationale: data.rationale, loaded: true })
    } catch (err: unknown) {
      setError(describeLLMError(err))
    } finally {
      setBusy(null)
    }
  }

  const selectedModel = meta?.models.find((m) => m.id === effectiveModel)

  return (
    <details
      className="card p-5"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      data-testid="protocol-proposer"
    >
      <summary className="cursor-pointer select-none text-sm font-semibold">
        Propose a protocol (bring your own key)
      </summary>

      <div className="mt-4 space-y-4">
        <p className="prose-muted">
          Describe what you want to try (e.g. "something like intermittent fasting") and an LLM proposes a
          stress/maintenance/repair protocol for this model, informed by what Experiments E and G already found
          within it. This only proposes -- it loads the parameters into the form on the left for you to review and
          edit; nothing runs until you press <em>Run simulation</em> yourself.
        </p>

        {metaError && (
          <Callout tone="error" role="alert">
            Could not load the model list: {metaError}
          </Callout>
        )}

        <div>
          <label className="label" htmlFor="propose-goal">
            What do you want to try?
          </label>
          <textarea
            id="propose-goal"
            className="input min-h-20 font-mono text-sm"
            placeholder="e.g. an intermittent-fasting-like protocol that keeps senescence low"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            disabled={disabled || busy !== null}
            maxLength={2000}
          />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className="label" htmlFor="propose-key">
              Anthropic API key
            </label>
            <input
              id="propose-key"
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
            <label className="label" htmlFor="propose-model">
              Model
            </label>
            <select
              id="propose-model"
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
            <label className="label" htmlFor="propose-effort">
              Effort
            </label>
            <select
              id="propose-effort"
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
            onClick={() => void propose()}
            disabled={disabled || !trimmedKey || !effectiveModel || !trimmedGoal || busy !== null}
          >
            {busy === 'propose' ? 'Proposing… (this can take a minute)' : 'Propose protocol'}
          </button>
          {meta && (
            <span className="prose-muted text-xs">
              Max {meta.rate_limit.calls} proposals per {Math.round(meta.rate_limit.window_seconds / 60)} min per user.
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
        {busy === 'propose' && (
          <p className="prose-muted" role="status">
            Waiting for {selectedModel?.label ?? effectiveModel}…
          </p>
        )}

        {result && (
          <section className="space-y-3" aria-label="Proposed protocol" data-testid="propose-result">
            {result.loaded && (
              <Callout tone="success" role="status">
                Loaded into the form on the left -- review and edit the parameters, then press "Run simulation"
                yourself.
              </Callout>
            )}
            <p className="prose-narrative text-sm" data-testid="propose-rationale">
              {result.rationale}
            </p>
            <Callout tone="info">{PROPOSE_FOOTER}</Callout>
          </section>
        )}
      </div>
    </details>
  )
}
