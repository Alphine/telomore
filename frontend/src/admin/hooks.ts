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

/** Minimal fetch-on-key hook; stale responses are ignored. `key` must encode every input of `fetcher`. */
export function useAdminQuery<T>(fetcher: () => Promise<T>, key: string): QueryState<T> {
  const [data, setDataState] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const fetchRef = useRef(fetcher)
  useEffect(() => {
    fetchRef.current = fetcher
  })

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchRef.current().then(
      (d) => {
        if (cancelled) return
        setDataState(d)
        setLoading(false)
      },
      (e: unknown) => {
        if (cancelled) return
        setError(e)
        setLoading(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [key, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  const setData = useCallback((updater: (prev: T | null) => T | null) => setDataState((p) => updater(p)), [])
  return { data, error, loading, reload, setData }
}
