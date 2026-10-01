import { useState } from 'react'
import type { FormEvent } from 'react'

import { createAccessRequest } from '../api/endpoints'
import type { AccessRequest } from '../api/types'
import { Button } from '../components/ui/Button'
import { useToast } from '../components/ui/Toast'

export const MAX_REQUEST_MESSAGE = 500

/** "Request Pro access": a short note to the admin. One open request per user (the API answers 409 otherwise). */
export function AccessRequestForm({ onSubmitted }: { onSubmitted?: (r: AccessRequest) => void }) {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { toast } = useToast()

  const trimmed = message.trim()
  const over = message.length > MAX_REQUEST_MESSAGE

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (over) return
    setBusy(true)
    setError(null)
    try {
      const created = await createAccessRequest(trimmed)
      toast({ tone: 'success', title: 'Request sent', description: 'An administrator will review it. You will see the outcome here.' })
      setMessage('')
      onSubmitted?.(created)
    } catch (err: unknown) {
      setError(
        err instanceof Error
            ? err.message
            : 'Could not reach the API.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3" aria-label="Request Pro access">
      <div>
        <label htmlFor="access-message" className="label">
          Why do you need Pro access?
        </label>
        <textarea
          id="access-message"
          className="input min-h-28 resize-y"
          value={message}
          maxLength={MAX_REQUEST_MESSAGE + 50}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="A line or two about your project is plenty."
          aria-describedby="access-message-count"
          aria-invalid={over}
        />
        <p
          id="access-message-count"
          className={`mt-1 text-right text-xs ${over ? 'text-rose-600 dark:text-rose-400' : 'text-slate-500'}`}
        >
          {message.length}/{MAX_REQUEST_MESSAGE}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy || over}>
        {busy ? 'Sending…' : 'Send request'}
      </Button>
    </form>
  )
}
