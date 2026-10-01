import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach } from 'vitest'

import { clearPersistentState } from '../state/usePersistentState'

// findBy*/waitFor default to 1 s, too tight when ~50 jsdom files run in parallel.
configure({ asyncUtilTimeout: 5000 })

afterEach(() => {
  cleanup()
  clearPersistentState()
  window.localStorage.clear()
})
