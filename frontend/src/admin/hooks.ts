import { useCallback, useEffect, useRef, useState } from 'react'

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export interface QueryState<T> {
  data: T | null
  error: unknown
  /** True while a request is in flight (data from the previous key stays visible). */
  loading: boolean
  reload: () => void
  setData: (updater: (prev: T | null) => T | null) => void
}

interface Settled {
  key: string
  error: unknown
}

/** Minimal fetch-on-key hook; stale responses are ignored. `key` must encode every input of `fetcher`. */
export function useAdminQuery<T>(fetcher: () => Promise<T>, key: string): QueryState<T> {
  const [data, setDataState] = useState<T | null>(null)
  const [settled, setSettled] = useState<Settled | null>(null)
  const [nonce, setNonce] = useState(0)
  const fetchRef = useRef(fetcher)
  useEffect(() => {
    fetchRef.current = fetcher
  })

  const fullKey = `${key}#${nonce}`
  useEffect(() => {
    let cancelled = false
    fetchRef.current().then(
      (d) => {
        if (cancelled) return
        setDataState(d)
        setSettled({ key: fullKey, error: null })
      },
      (e: unknown) => {
        if (cancelled) return
        setSettled({ key: fullKey, error: e ?? new Error('Request failed') })
      },
    )
    return () => {
      cancelled = true
    }
  }, [fullKey])

  const current = settled?.key === fullKey
  const reload = useCallback(() => setNonce((n) => n + 1), [])
  const setData = useCallback((updater: (prev: T | null) => T | null) => setDataState((p) => updater(p)), [])
  return { data, error: current ? settled.error : null, loading: !current, reload, setData }
}
