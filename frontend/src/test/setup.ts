import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

import { clearPersistentState } from '../state/usePersistentState'

afterEach(() => {
  cleanup()
  clearPersistentState()
  window.localStorage.clear()
})
