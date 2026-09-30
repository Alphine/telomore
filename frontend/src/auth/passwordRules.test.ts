import { describe, expect, it } from 'vitest'

import { passwordProblem } from './passwordRules'

describe('passwordProblem', () => {
  it('accepts 8 to 72 bytes', () => {
    expect(passwordProblem('hunter22')).toBeNull()
    expect(passwordProblem('a'.repeat(72))).toBeNull()
  })
  it('rejects short passwords', () => {
    expect(passwordProblem('short')).toMatch(/at least 8/)
  })
  it('counts bytes, not characters', () => {
    expect(passwordProblem('a'.repeat(73))).toMatch(/at most 72/)
    expect(passwordProblem('é'.repeat(37))).toMatch(/at most 72/) // 74 bytes
    expect(passwordProblem('é'.repeat(36))).toBeNull() // 72 bytes
  })
})
