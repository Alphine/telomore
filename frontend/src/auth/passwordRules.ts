// Password rule shown on the register / reset forms.
export const PASSWORD_MIN = 8
export const PASSWORD_MAX_BYTES = 72 // bcrypt limit; the API enforces the same

/** Client-side mirror of the API's password rule (backend/schemas.py), so people see it before submitting. */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) return `Use at most ${PASSWORD_MAX_BYTES} bytes (long passphrases with accents or emoji count more than one byte per character).`
  return null
}
