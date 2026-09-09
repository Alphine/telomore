"""Transactional email sending via Resend, with a dev-mode no-op fallback.

Storage backend selection mirrors the pattern used in ``db.py`` for
``DATABASE_URL``:

* If the ``RESEND_API_KEY`` environment variable is set, :func:`send_email`
  POSTs to Resend's HTTP API (https://resend.com) and returns ``True``/
  ``False`` depending on whether the provider accepted the request.
* If ``RESEND_API_KEY`` is *not* set (local dev machine, CI, ``pytest``),
  :func:`send_email` is a no-op that returns ``False`` immediately, without
  attempting any network call. The caller (the Streamlit UI layer) is
  responsible for treating a ``False`` return as "not configured" and
  falling back to showing the verification/reset link directly on screen
  (see ``app/ui/components.py``) — exactly like the ``DATABASE_URL``
  present-vs-absent fallback in ``db.py``.

Only the Python standard library (``urllib.request``) is used for the HTTP
call, since ``requests`` is not already a dependency of this project and a
single JSON POST does not justify adding one.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)

RESEND_API_URL = "https://api.resend.com/emails"

# Resend's shared sandbox sender: works out of the box for any Resend
# account without the account owner having verified their own sending
# domain. This project has not (yet) verified a custom domain, so this is
# the only "from" address Resend will actually accept for us.
DEFAULT_FROM = "Telomere Evolution Lab <onboarding@resend.dev>"


def send_email(to: str, subject: str, html_body: str, *, from_addr: str = DEFAULT_FROM) -> bool:
    """Send an email via Resend. Returns ``True`` on success, ``False`` if
    unconfigured (no ``RESEND_API_KEY``) or on any failure.

    This function deliberately never raises: an email-provider outage (or
    the absence of an API key in dev/CI) should degrade to a warning, not
    crash the page that triggered it.
    """
    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key:
        # Dev mode: no attempt to reach the network at all. The caller must
        # show the link on-screen instead.
        return False

    payload = json.dumps(
        {
            "from": from_addr,
            "to": [to],
            "subject": subject,
            "html": html_body,
        }
    ).encode("utf-8")

    request = urllib.request.Request(
        RESEND_API_URL,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return 200 <= response.status < 300
    except urllib.error.URLError as exc:
        logger.warning("send_email: Resend request failed: %s", exc)
        return False
    except Exception as exc:  # pragma: no cover - defensive catch-all
        logger.warning("send_email: unexpected error sending email: %s", exc)
        return False
