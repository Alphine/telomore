import { AlertTriangle, Check, Copy } from 'lucide-react'
import { useState } from 'react'
import type { FormEvent } from 'react'

import { Button } from '../components/ui/Button'
import { Dialog, DialogContent } from '../components/ui/Dialog'
import { useToast } from '../components/ui/Toast'
import { createUser } from './api'
import { copyText } from './clipboard'
import { errorMessage } from './format'
import { Field, PlanToggle } from './shared'
import type { AdminUser } from './types'

const PRESETS: Array<{ label: string; days: number | null }> = [
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '1 year', days: 365 },
  { label: 'No expiry', days: null },
]

function CreateForm({ onCreated, onClose }: { onCreated: (user: AdminUser, password: string) => void; onClose: () => void }) {
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [plan, setPlan] = useState<'free' | 'pro'>('free')
  const [days, setDays] = useState<number | null>(30)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await createUser({
        username: username.trim(),
        email: email.trim(),
        ...(password ? { password } : {}),
        plan,
        plan_days: plan === 'pro' ? days : null,
      })
      onCreated(res.user, res.temporary_password)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Field label="Username" htmlFor="cu-username">
        <input id="cu-username" className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" required />
      </Field>
      <Field label="Email" htmlFor="cu-email">
        <input id="cu-email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" required />
      </Field>
      <Field label="Password (optional)" htmlFor="cu-password" hint="Leave empty to generate a temporary password.">
        <input
          id="cu-password"
          type="password"
          className="input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
        />
      </Field>
      <div>
        <span className="label">Plan</span>
        <PlanToggle value={plan} onChange={setPlan} />
      </div>
      {plan === 'pro' && (
        <div>
          <span className="label">Pro duration</span>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Pro duration">
            {PRESETS.map((p) => (
              <Button
                key={p.label}
                size="sm"
                variant={days === p.days ? 'primary' : 'outline'}
                aria-pressed={days === p.days}
                onClick={() => setDays(p.days)}
              >
                {p.label}
              </Button>
            ))}
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !username.trim() || !email.trim()}>
          {busy ? 'Creating...' : 'Create user'}
        </Button>
      </div>
    </form>
  )
}

function PasswordView({ user, password, onDone }: { user: AdminUser; password: string; onDone: () => void }) {
  const { toast } = useToast()
  const [copied, setCopied] = useState(false)

  async function copy() {
    const ok = await copyText(password)
    if (ok) {
      setCopied(true)
      toast({ tone: 'success', title: 'Password copied' })
    } else {
      toast({ tone: 'error', title: 'Could not copy', description: 'Select the password and copy it manually.' })
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm">
        Account <strong>{user.username}</strong> ({user.email}) is created and already verified.
      </p>
      <div>
        <p className="label">Temporary password</p>
        <div className="flex items-stretch gap-2">
          <code data-testid="temp-password" className="mono-block min-w-0 flex-1 select-all break-all !p-2.5">
            {password}
          </code>
          <Button variant="outline" onClick={copy} aria-label="Copy password">
            {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </div>
      <div
        role="note"
        className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p>This password will not be shown again. Copy it now and pass it to the user over a private channel.</p>
      </div>
      <div className="flex justify-end">
        <Button onClick={onDone}>Done</Button>
      </div>
    </div>
  )
}

export function CreateUserDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const [created, setCreated] = useState<{ user: AdminUser; password: string } | null>(null)

  function close(o: boolean) {
    if (!o) setCreated(null) // the password is dropped from memory as soon as the dialog closes
    onOpenChange(o)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        title={created ? 'User created' : 'Create user'}
        description={created ? 'Save the temporary password now.' : 'Creates a pre-verified account.'}
        onInteractOutside={(e) => {
          if (created) e.preventDefault() // do not lose the one-time password to a stray click
        }}
      >
        {created ? (
          <PasswordView user={created.user} password={created.password} onDone={() => close(false)} />
        ) : (
          <CreateForm
            onClose={() => close(false)}
            onCreated={(user, password) => {
              setCreated({ user, password })
              onCreated()
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
