/** Only allow same-app relative paths as a post-login redirect target. */
export function safeNext(raw: string | null, fallback = '/'): string {
  if (!raw) return fallback
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback
  return raw
}
