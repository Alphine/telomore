"""Reusable page pieces: disclaimer, metric rows, exports, session helpers."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

import streamlit as st

from telomere_lab import db as _db
from telomere_lab.config import CONFIG_DIR, load_model_config
from telomere_lab.email import send_email
from telomere_lab.experiments.artifacts import simulation_csv, simulation_json
from telomere_lab.schemas import EvolutionConfig, FitnessWeights, ModelConfig, SimulationResult

DISCLAIMER = (
    "**Scope.** This is a computational research prototype. Every number on this page is a "
    "*model output* under the stated assumptions. It does not provide medical advice, clinical "
    "predictions, or validated therapeutic recommendations. Parameters named after biological "
    "processes are simulation parameters, not interventions."
)


def inject_css() -> None:
    """Light-touch, theme-adaptive CSS for typography, cards, spacing and badges.

    Uses Streamlit's own CSS variables (or structural rules with no hardcoded
    colors) so this looks correct in both light and dark themes.
    """
    st.markdown(
        """
        <style>
        /* -------------------------------------------------------- typography
           Inter for body text, Sora for headings - a common "modern SaaS
           product" pairing. Pure structural change: no colors are set here,
           so light/dark theming is untouched. */
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Sora:wght@600;700&display=swap');

        html, body, [class*="css"] {
            font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        h1, h2, h3, h4, h5,
        [data-testid="stMarkdownContainer"] h1,
        [data-testid="stMarkdownContainer"] h2,
        [data-testid="stMarkdownContainer"] h3,
        [data-testid="stMarkdownContainer"] h4 {
            font-family: "Sora", "Inter", sans-serif;
            letter-spacing: -0.01em;
        }

        /* -------------------------------------------------------- spacing/rhythm
           Consistent breathing room around the "#### Section" headers used
           throughout every page, and a touch more room at the top/bottom of
           the main content column. */
        div.block-container {
            padding-top: 2.5rem;
            padding-bottom: 3rem;
        }
        h4 {
            margin-top: 1.75rem;
            margin-bottom: 0.75rem;
        }
        /* Softer, theme-adaptive divider */
        hr {
            margin: 1.75rem 0;
            opacity: 0.5;
        }

        /* -------------------------------------------------------- cards
           Bordered containers (st.container(border=True)) read as cards */
        div[data-testid="stVerticalBlockBorderWrapper"] {
            border-radius: 0.75rem;
            transition: box-shadow 0.15s ease, transform 0.15s ease;
        }
        div[data-testid="stVerticalBlockBorderWrapper"]:has(.feature-card-marker):hover {
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
            transform: translateY(-1px);
        }
        .feature-card-icon {
            font-size: 1.8rem;
            line-height: 1;
            margin-bottom: 0.25rem;
        }

        /* -------------------------------------------------------- sidebar
           A subtle divider between the page-navigation list and whatever
           this app renders below it (login status, model parameters, ...),
           plus tidier icon+label alignment on the nav links themselves. */
        section[data-testid="stSidebar"] div[data-testid="stSidebarNav"] {
            border-bottom: 1px solid rgba(128, 128, 128, 0.25);
            padding-bottom: 0.75rem;
            margin-bottom: 0.75rem;
        }
        section[data-testid="stSidebar"] div[data-testid="stSidebarNav"] li {
            display: flex;
            align-items: center;
        }

        /* -------------------------------------------------------- buttons
           Shape/motion polish only (no hardcoded colors, so this stays
           correct against Streamlit's own theme colors in light and dark). */
        .stButton > button, .stDownloadButton > button, .stFormSubmitButton > button {
            border-radius: 0.6rem;
            transition: box-shadow 0.15s ease, transform 0.1s ease;
        }
        .stButton > button:hover, .stDownloadButton > button:hover,
        .stFormSubmitButton > button:hover {
            transform: translateY(-1px);
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
        }
        .stButton > button:active, .stDownloadButton > button:active,
        .stFormSubmitButton > button:active {
            transform: translateY(0);
        }

        /* -------------------------------------------------------- metrics
           Card-like grouping for st.metric rows, consistent with the
           feature-card radius used on the landing page. */
        div[data-testid="stMetric"] {
            background: rgba(128, 128, 128, 0.06);
            border: 1px solid rgba(128, 128, 128, 0.12);
            border-radius: 0.75rem;
            padding: 0.75rem 1rem 0.5rem;
        }
        </style>
        """,
        unsafe_allow_html=True,
    )


def page_setup(title: str, icon: str = "🧬") -> None:
    st.set_page_config(page_title=f"{title} · Telomere Evolution Lab", page_icon=icon, layout="wide")
    inject_css()
    handle_auth_query_params()
    st.title(f"{icon} {title}")


def disclaimer() -> None:
    st.info(DISCLAIMER, icon="ℹ️")


def demo_config() -> ModelConfig:
    path = CONFIG_DIR / "demo.yaml"
    return load_model_config(path) if path.exists() else ModelConfig()


# ----------------------------------------------------------------- auth
# NOTE (deliberate scope limitation): login state lives only in
# ``st.session_state["user"]`` for the current browser session/tab - there
# is no persistent cookie / "remember me". Closing the tab or restarting the
# Streamlit server logs everyone out. This keeps the auth layer simple; a
# persistent-session mechanism (signed cookies, etc.) is out of scope here.
#
# NOTE (verification links / base URL): emailed verification and
# password-reset links are constructed as *relative* query-param links
# (``?verify_token=...``) rather than fully-qualified URLs. Streamlit has no
# simple, reliable way to learn its own public base URL from within a page,
# and the user will already be pointed at the right host when they open the
# link from their inbox on the same machine/browser that has the app
# bookmarked - so a relative link is enough for a link *shown on screen*
# (dev mode) and works fine as the href in an emailed HTML link too, as long
# as the mail client resolves it against the app's origin, which browsers do
# for a clicked link opened directly. If this ever needs to work reliably
# from an arbitrary device (e.g. verifying on a phone after registering on a
# laptop), set an ``APP_BASE_URL`` env var and update ``_auth_link`` below to
# use it - that plumbing is intentionally left out for now to keep this
# feature small.
def _auth_link(query_param: str, token: str) -> str:
    base = os.environ.get("APP_BASE_URL", "").rstrip("/")
    return f"{base}/?{query_param}={token}"


def current_user() -> Optional[_db.User]:
    return st.session_state.get("user")


def handle_auth_query_params() -> None:
    """React to ``?verify_token=...`` in the URL (set by an emailed or
    dev-mode-displayed verification link).

    Must be called on every page load - it's wired into ``page_setup()`` and
    also called directly from ``streamlit_app.py`` (whose Home page does not
    go through ``page_setup()``) so a verification link lands correctly no
    matter which page it points at. Idempotent: the token is consumed and
    the query param cleared on first use, so refreshing the page afterwards
    is a no-op.

    ``?reset_token=...`` is handled separately by
    :func:`maybe_render_password_reset_form`, since (unlike verification) it
    drives an interactive form rather than a one-shot action.
    """
    token = st.query_params.get("verify_token")
    if not token:
        return
    user = _db.verify_email(token)
    if user is not None:
        st.success(f"✅ Email verified for `{user.username}` — you can now log in.", icon="✅")
    else:
        st.error("That verification link is invalid or has already been used.")
    del st.query_params["verify_token"]


def _send_verification_email(user: _db.User) -> None:
    """Generate a fresh verification token for ``user`` and either email it
    (production, ``RESEND_API_KEY`` set) or show it directly on screen (dev
    mode, no ``RESEND_API_KEY``)."""
    token = _db.generate_verification_token(user.id)
    link = _auth_link("verify_token", token)
    sent = send_email(
        user.email,
        "Verify your Telomere Evolution Lab account",
        f"<p>Click the link below to verify your email and unlock full access:</p>"
        f'<p><a href="{link}">{link}</a></p>',
    )
    if sent:
        st.success(f"Verification email sent to {user.email}. Check your inbox (and spam folder).")
    else:
        st.info(
            f"Email not configured (dev mode) — use this link directly to verify:\n\n{link}",
            icon="🔗",
        )
        st.caption("In production (RESEND_API_KEY set on Railway) this link is emailed instead of shown here.")


def _login_register_form() -> None:
    st.subheader("Log in required")
    st.caption("Create a free account or log in to use this feature. Your login lasts only for "
               "this browser tab/session.")
    tab_login, tab_register = st.tabs(["Log in", "Register"])

    with tab_login:
        with st.form("login_form"):
            username = st.text_input("Username", key="login_username")
            password = st.text_input("Password", type="password", key="login_password")
            submitted = st.form_submit_button("Log in", type="primary")
        if submitted:
            if not username or not password:
                st.error("Enter both a username and a password.")
            else:
                user = _db.authenticate(username, password)
                if user is None:
                    st.error("Wrong username or password.")
                else:
                    st.session_state["user"] = user
                    st.rerun()

        with st.expander("Forgot password?"):
            with st.form("forgot_password_form"):
                forgot_email = st.text_input("Account email", key="forgot_password_email")
                forgot_submitted = st.form_submit_button("Send reset link")
            if forgot_submitted:
                if not forgot_email:
                    st.error("Enter your account email.")
                else:
                    result = _db.request_password_reset(forgot_email)
                    # Same generic message whether or not the email exists,
                    # so the UI never reveals which emails are registered.
                    st.success(
                        "If an account with that email exists, a reset link has been sent."
                    )
                    if result is not None:
                        user, token = result
                        link = _auth_link("reset_token", token)
                        sent = send_email(
                            user.email,
                            "Reset your Telomere Evolution Lab password",
                            f"<p>Click the link below to set a new password (valid for 1 hour):</p>"
                            f'<p><a href="{link}">{link}</a></p>',
                        )
                        if not sent:
                            # Dev-mode asymmetry (documented, deliberate): production
                            # never leaks account existence via this message, but
                            # local/dev testing needs the raw link somewhere to click.
                            st.info(
                                f"Email not configured (dev mode) — use this link directly: {link}",
                                icon="🔗",
                            )

    with tab_register:
        with st.form("register_form"):
            new_username = st.text_input("Choose a username", key="register_username")
            new_email = st.text_input("Email address", key="register_email")
            new_password = st.text_input("Choose a password", type="password", key="register_password")
            confirm_password = st.text_input("Confirm password", type="password", key="register_confirm")
            submitted = st.form_submit_button("Create account", type="primary")
        if submitted:
            if not new_username or not new_email or not new_password:
                st.error("Fill in username, email and password.")
            elif new_password != confirm_password:
                st.error("Passwords do not match.")
            else:
                try:
                    user = _db.create_user(new_username, new_email, new_password)
                except _db.DuplicateUsernameError:
                    st.error(f"Username {new_username!r} is already taken.")
                except _db.DuplicateEmailError:
                    st.error(f"Email {new_email!r} is already registered.")
                except ValueError as exc:
                    st.error(str(exc))
                else:
                    st.session_state["user"] = user
                    st.success("Account created. Verify your email below to unlock full access.")
                    _send_verification_email(user)


def _verification_gate() -> None:
    user = current_user()
    st.subheader("Verify your email")
    st.caption(
        f"We sent a verification link to `{user.email}` when you registered. "
        "Click it to unlock Simulate/Evolve/Pareto/Sensitivity/Active Learning/Compare/Experiments."
    )
    if st.button("Resend verification email"):
        _send_verification_email(user)
    if st.button("Log out"):
        logout()
        st.rerun()


def maybe_render_password_reset_form() -> bool:
    """If the URL carries ``?reset_token=...``, render the "set a new
    password" form and return ``True`` (the caller should stop rendering the
    rest of the page). Returns ``False`` (no-op) otherwise.

    Unlike verification, the reset token is only consumed on a successful
    (or explicitly rejected) submit - not merely by loading the page - since
    the form needs the token to stay in the URL across the reruns Streamlit
    performs while the user is typing/submitting.
    """
    token = st.query_params.get("reset_token")
    if not token:
        return False

    st.subheader("Set a new password")
    with st.form("reset_password_form"):
        new_password = st.text_input("New password", type="password", key="reset_new_password")
        confirm = st.text_input("Confirm new password", type="password", key="reset_confirm_password")
        submitted = st.form_submit_button("Set new password", type="primary")
    if submitted:
        if not new_password:
            st.error("Enter a new password.")
        elif new_password != confirm:
            st.error("Passwords do not match.")
        else:
            ok = _db.reset_password(token, new_password)
            if ok:
                st.success("Password updated — you can now log in with your new password.")
            else:
                st.error("That reset link is invalid or has expired. Request a new one from the login tab.")
            del st.query_params["reset_token"]
    return True


def require_login() -> None:
    """Gate the rest of the current page behind login *and* email
    verification.

    If a ``reset_token`` is present in the URL, the password-reset form
    takes over the page regardless of login state (it's a self-contained
    flow from an emailed link, independent of whatever session happens to
    be active in this browser tab).

    Otherwise: if no user is logged in, render the login/register form and
    ``st.stop()``. If a user is logged in but not yet ``is_verified``, show
    the verification gate instead of the real page and ``st.stop()``. Only
    a logged-in, verified user reaches the real page content.
    """
    if maybe_render_password_reset_form():
        st.stop()
    user = current_user()
    if user is None:
        _login_register_form()
        st.stop()
    if not user.is_verified:
        _verification_gate()
        st.stop()


def logout() -> None:
    st.session_state["user"] = None


# ------------------------------------------------------------ session state
def get_state(key: str, default=None):
    return st.session_state.get(key, default)


def set_state(key: str, value) -> None:
    st.session_state[key] = value


def baseline_config() -> ModelConfig:
    """Baseline shared by Simulate / Evolve / Compare."""
    cfg = get_state("baseline_config")
    if cfg is None:
        cfg = demo_config()
        set_state("baseline_config", cfg)
    return cfg


def weights() -> FitnessWeights:
    w = get_state("fitness_weights")
    if w is None:
        w = FitnessWeights()
        set_state("fitness_weights", w)
    return w


def evolution_defaults() -> EvolutionConfig:
    evo = get_state("evolution_config")
    if evo is None:
        evo = EvolutionConfig()
        set_state("evolution_config", evo)
    return evo


# ---------------------------------------------------------------- displays
def terminal_metric_row(result: SimulationResult, fitness: Optional[float] = None) -> None:
    tm = result.terminal_metrics
    cols = st.columns(6 if fitness is not None else 5)
    cols[0].metric("Final mean length", f"{tm['final_mean_length_bp']/1000:.2f} kb")
    cols[1].metric("Mean shortest / cell", f"{tm['final_mean_shortest_bp']/1000:.2f} kb")
    cols[2].metric("Senescent fraction", f"{tm['final_senescent_fraction']:.1%}")
    t50 = tm["time_to_50pct_senescence"]
    cols[3].metric("Cycles to 50 % senescent", "not reached" if t50 == float("inf") else f"{int(t50)}")
    cols[4].metric("Final living cells", f"{tm['final_population_size']}")
    if fitness is not None:
        cols[5].metric("Fitness (objective)", f"{fitness:+.3f}")


def provenance(result: SimulationResult) -> None:
    with st.expander("Provenance (reproducibility metadata)"):
        st.code(
            f"model_version = {result.model_version}\n"
            f"seed          = {result.seed}\n"
            f"config_hash   = {result.config.config_hash()}\n"
            f"runtime       = {result.runtime_seconds*1000:.1f} ms\n"
            f"reproduce     : python scripts/run_simulation.py --seed {result.seed} "
            + " ".join(f"--set {k}={v}" for k, v in result.config.to_dict().items() if k != "seed"),
            language="text",
        )
        st.json(result.config.to_dict(), expanded=False)


def export_buttons(result: SimulationResult, stem: str = "simulation") -> None:
    c1, c2 = st.columns(2)
    c1.download_button("⬇ Export JSON", simulation_json(result), f"{stem}_seed{result.seed}.json",
                       "application/json", width="stretch")
    c2.download_button("⬇ Export CSV", simulation_csv(result), f"{stem}_seed{result.seed}.csv",
                       "text/csv", width="stretch")


def failure_banner(result: SimulationResult) -> bool:
    if result.valid:
        return False
    st.error(f"Simulation marked **invalid**: {result.failure_reason}. "
             "Invalid runs never receive a fitness score (SDD §30).")
    return True


def file_download(path: str | Path, label: str) -> None:
    p = Path(path)
    if p.exists():
        st.download_button(label, p.read_bytes(), p.name, width="stretch")
