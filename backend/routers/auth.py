"""Auth endpoints: register / verify / login / forgot-password / reset-password / me.

Behavior mirrors ``app/ui/components.py`` (the Streamlit auth flow) exactly,
adapted to return JSON instead of rendering ``st.info``/``st.success``: same
dev-mode-fallback philosophy for verification + password-reset links (show
the raw link in the response when Resend is not configured, per
``telomere_lab.email.send_email``'s documented contract), same
generic-message-regardless-of-account-existence security property for
forgot-password.

Token query-param contract (documented for the future React app):
``GET /api/auth/verify?token=...`` and ``POST /api/auth/reset-password``
(body field ``token``) both use ``token`` -- NOT the Streamlit app's
``verify_token``/``reset_token`` query-param names, which are a
Streamlit-page-routing artifact specific to that UI. This is a deliberate,
documented choice (see docs/API.md) since a later phase's React code is
written against this contract.
"""

from __future__ import annotations

import os

from fastapi import APIRouter, Depends, HTTPException, status

from telomere_lab import db as _db
from telomere_lab.email import send_email

from .. import schemas as api_schemas
from ..auth import create_access_token, get_current_user

router = APIRouter(prefix="/auth", tags=["auth"])


def _frontend_link(query_param: str, token: str) -> str:
    """Build a link the (not-yet-built) React app will parse.

    Mirrors ``app/ui/components.py::_auth_link``: relative by default, or
    rooted at ``FRONTEND_BASE_URL`` if that env var is set (analogous to the
    Streamlit app's ``APP_BASE_URL``). Kept as a separate env var from
    ``APP_BASE_URL`` since the two UIs may end up on different origins.
    """
    base = os.environ.get("FRONTEND_BASE_URL", "").rstrip("/")
    return f"{base}/?{query_param}={token}"


@router.post("/register", response_model=api_schemas.RegisterResponse, status_code=status.HTTP_201_CREATED)
def register(body: api_schemas.RegisterRequest) -> api_schemas.RegisterResponse:
    try:
        user = _db.create_user(body.username, body.email, body.password)
    except _db.DuplicateUsernameError:
        raise HTTPException(status.HTTP_409_CONFLICT, f"username {body.username!r} is already taken")
    except _db.DuplicateEmailError:
        raise HTTPException(status.HTTP_409_CONFLICT, f"email {body.email!r} is already registered")
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))

    token = _db.generate_verification_token(user.id)
    link = _frontend_link("token", token)
    sent = send_email(
        user.email,
        "Verify your Telomere Evolution Lab account",
        f"<p>Click the link below to verify your email and unlock full access:</p>"
        f'<p><a href="{link}">{link}</a></p>',
    )
    if sent:
        return api_schemas.RegisterResponse(
            message=f"Account created. A verification email was sent to {user.email}."
        )
    return api_schemas.RegisterResponse(
        message="Account created. Email not configured (dev mode) -- use dev_verification_link to verify.",
        dev_verification_link=link,
    )


@router.get("/verify", response_model=api_schemas.VerifyResponse)
def verify(token: str) -> api_schemas.VerifyResponse:
    user = _db.verify_email(token)
    if user is None:
        return api_schemas.VerifyResponse(message="That verification link is invalid or has already been used.",
                                           verified=False)
    return api_schemas.VerifyResponse(message=f"Email verified for {user.username!r}. You can now log in.",
                                       verified=True)


@router.post("/login", response_model=api_schemas.TokenResponse)
def login(body: api_schemas.LoginRequest) -> api_schemas.TokenResponse:
    user = _db.authenticate(body.username, body.password)
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong username or password.")
    if not user.is_verified:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Please verify your email before logging in. Check your inbox for a verification link.",
        )
    token = create_access_token(user)
    return api_schemas.TokenResponse(access_token=token)


@router.post("/forgot-password", response_model=api_schemas.ForgotPasswordResponse)
def forgot_password(body: api_schemas.ForgotPasswordRequest) -> api_schemas.ForgotPasswordResponse:
    result = _db.request_password_reset(body.email)
    # Always the same generic message, regardless of whether the account
    # exists (security requirement already established in the Streamlit
    # version -- see db.request_password_reset's docstring).
    response = api_schemas.ForgotPasswordResponse(
        message="If an account with that email exists, a reset link has been sent."
    )
    if result is not None:
        user, token = result
        link = _frontend_link("reset_token", token)
        sent = send_email(
            user.email,
            "Reset your Telomere Evolution Lab password",
            f"<p>Click the link below to set a new password (valid for 1 hour):</p>"
            f'<p><a href="{link}">{link}</a></p>',
        )
        if not sent:
            # Dev-mode asymmetry (documented, deliberate, matches
            # app/ui/components.py): production never leaks account
            # existence via this response, but local/dev testing needs the
            # raw link somewhere -- only included because a user WAS found.
            response.dev_reset_link = link
    return response


@router.post("/reset-password", response_model=api_schemas.MessageResponse)
def reset_password(body: api_schemas.ResetPasswordRequest) -> api_schemas.MessageResponse:
    ok = _db.reset_password(body.token, body.new_password)
    if not ok:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                             "That reset link is invalid or has expired. Request a new one.")
    return api_schemas.MessageResponse(message="Password updated -- you can now log in with your new password.")


@router.get("/me", response_model=api_schemas.UserResponse)
def me(user: _db.User = Depends(get_current_user)) -> api_schemas.UserResponse:
    return api_schemas.UserResponse(id=user.id, username=user.username, email=user.email,
                                     is_verified=user.is_verified)
