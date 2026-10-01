// Tiny toast system (Radix has a toast primitive, but it is not in the approved
// dependency list). A provider holds the queue; `useToast()` is a no-op outside
// one so components stay renderable in isolation (tests).
import { AnimatePresence, m } from 'framer-motion'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { cn } from '../../lib/cn'

type ToastTone = 'success' | 'error' | 'info'
interface ToastItem {
  id: number
  tone: ToastTone
  title: string
  description?: string
}

interface ToastApi {
  toast: (t: { tone?: ToastTone; title: string; description?: string; durationMs?: number }) => void
}

const NOOP: ToastApi = { toast: () => undefined }
const ToastContext = createContext<ToastApi>(NOOP)

// eslint-disable-next-line react-refresh/only-export-components
export function useToast(): ToastApi {
  return useContext(ToastContext)
}

const ICONS = { success: CheckCircle2, error: AlertCircle, info: Info }
const TONES: Record<ToastTone, string> = {
  success: 'text-emerald-600 dark:text-emerald-400',
  error: 'text-rose-600 dark:text-rose-400',
  info: 'text-sky-600 dark:text-sky-400',
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const next = useRef(1)

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), [])
  const toast = useCallback<ToastApi['toast']>(
    ({ tone = 'info', title, description, durationMs = tone === 'error' ? 7000 : 4000 }) => {
      const id = next.current++
      setItems((xs) => [...xs.slice(-3), { id, tone, title, description }])
      setTimeout(() => dismiss(id), durationMs)
    },
    [dismiss],
  )
  const api = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end"
        role="region"
        aria-label="Notifications"
      >
        <AnimatePresence initial={false}>
          {items.map((t) => {
            const Icon = ICONS[t.tone]
            return (
              <m.div
                key={t.id}
                layout
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                role={t.tone === 'error' ? 'alert' : 'status'}
                className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-slate-200 bg-white p-3.5 shadow-lg dark:border-slate-700 dark:bg-slate-900"
              >
                <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', TONES[t.tone])} aria-hidden />
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-medium">{t.title}</p>
                  {t.description && <p className="mt-0.5 text-slate-600 dark:text-slate-400">{t.description}</p>}
                </div>
                <button
                  type="button"
                  aria-label="Dismiss notification"
                  onClick={() => dismiss(t.id)}
                  className="rounded p-1 text-slate-500 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:hover:bg-slate-800"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </m.div>
            )
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}
