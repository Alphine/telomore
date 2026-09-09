// The backend (backend/routers/auth.py::_frontend_link) builds dev-mode /
// emailed links as `${FRONTEND_BASE_URL}/?token=<t>` (verification) and
// `${FRONTEND_BASE_URL}/?reset_token=<t>` (password reset) -- i.e. they land
// on the ROOT path with a query param, not on a dedicated route. This maps
// them onto the React routes that actually handle them.

export type MappedLink =
  | { kind: 'verify'; to: string; token: string }
  | { kind: 'reset'; to: string; token: string }
  | { kind: 'unknown'; to: string }

export function mapBackendLink(link: string): MappedLink {
  let url: URL
  try {
    url = new URL(link, window.location.origin)
  } catch {
    return { kind: 'unknown', to: link }
  }
  const verify = url.searchParams.get('token')
  if (verify) {
    return { kind: 'verify', token: verify, to: `/verify?token=${encodeURIComponent(verify)}` }
  }
  const reset = url.searchParams.get('reset_token')
  if (reset) {
    return { kind: 'reset', token: reset, to: `/reset-password?token=${encodeURIComponent(reset)}` }
  }
  return { kind: 'unknown', to: link }
}
