import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { clearPersistentState, usePersistentState } from './usePersistentState'

describe('usePersistentState', () => {
  it('restores the value when the component remounts (route change)', () => {
    const first = renderHook(() => usePersistentState('t:a', 0))
    act(() => first.result.current[1](5))
    first.unmount()
    const second = renderHook(() => usePersistentState('t:a', 0))
    expect(second.result.current[0]).toBe(5)
  })

  it('keeps a value written after unmount (an in-flight request finishing)', () => {
    const first = renderHook(() => usePersistentState<string | null>('t:b', null))
    const set = first.result.current[1]
    first.unmount()
    set('finished while away')
    const second = renderHook(() => usePersistentState<string | null>('t:b', null))
    expect(second.result.current[0]).toBe('finished while away')
  })

  it('supports functional updates and separate keys', () => {
    const { result } = renderHook(() => [usePersistentState('t:c', 1), usePersistentState('t:d', 10)] as const)
    act(() => result.current[0][1]((n) => n + 1))
    expect(result.current[0][0]).toBe(2)
    expect(result.current[1][0]).toBe(10)
  })

  it('is emptied by clearPersistentState (logout)', () => {
    const first = renderHook(() => usePersistentState('t:e', 'x'))
    act(() => first.result.current[1]('secret'))
    first.unmount()
    clearPersistentState()
    expect(renderHook(() => usePersistentState('t:e', 'x')).result.current[0]).toBe('x')
  })
})
