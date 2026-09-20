// useState that survives route changes. Pages unmount when the user picks
// another menu item, which used to throw away a finished run, a half-filled
// form or a running job's id. State lives in a module-level store keyed by a
// caller-chosen string, so remounting the page restores it; a setter called
// after the page has unmounted (an in-flight request finishing) still writes
// the store, so the result is there when the user comes back.
//
// Deliberately in memory only (no sessionStorage): results can be large and a
// reload should start clean. The store is emptied on logout so one user's
// results never show for the next (clearPersistentState) and between tests.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'

const store = new Map<string, unknown>()

export function clearPersistentState(): void {
  store.clear()
}

export function usePersistentState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    if (store.has(key)) return store.get(key) as T
    const v = typeof initial === 'function' ? (initial as () => T)() : initial
    store.set(key, v)
    return v
  })
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const set = useCallback(
    (next: SetStateAction<T>) => {
      const prev = store.get(key) as T
      const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next
      store.set(key, resolved)
      if (mounted.current) setValue(resolved)
    },
    [key],
  )
  return [value, set]
}
