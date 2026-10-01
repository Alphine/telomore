import { Link } from 'react-router-dom'

import { mapBackendLink } from '../api/devLinks'
import { Callout } from './Callout'

/**
 * Dev-mode fallback link (no RESEND_API_KEY on the backend): render the
 * verification / reset link the API returned as a clickable in-app link,
 * mirroring the Streamlit `st.info("Email not configured (dev mode) ...")`.
 */
export function DevLink({ link, label }: { link: string; label: string }) {
  const mapped = mapBackendLink(link)
  return (
    <Callout tone="warning">
      <div className="font-medium">
        <span aria-hidden className="mr-1.5">
          🔗
        </span>
        Email not configured (dev mode) — use this link directly
      </div>
      <div className="mt-1 break-all">
        {mapped.kind === 'unknown' ? (
          /^https?:\/\//i.test(mapped.to) || mapped.to.startsWith('/') ? (
            <a className="link" href={mapped.to}>
              {label}
            </a>
          ) : (
            <span>{label}</span> // never put a javascript:/data: URL into href
          )
        ) : (
          <Link className="link" to={mapped.to} data-testid="dev-link">
            {label}
          </Link>
        )}
      </div>
      <div className="mt-1 text-xs opacity-80">
        In production (RESEND_API_KEY set on Railway) this link is emailed instead of shown here.
      </div>
    </Callout>
  )
}
