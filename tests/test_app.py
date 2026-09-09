"""GUI smoke tests with Streamlit's AppTest (SDD §29)."""

import sys
from pathlib import Path

import pytest

st = pytest.importorskip("streamlit")
from streamlit.testing.v1 import AppTest  # noqa: E402

APP = Path(__file__).resolve().parents[1] / "app"
SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from telomere_lab import db as db_module  # noqa: E402


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    """Every AppTest run gets its own throwaway SQLite database so login
    tests never touch the real data/local.db used by the running app."""
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setattr(db_module, "DATA_DIR", tmp_path / "data")
    db_module.reset_engine()
    yield
    db_module.reset_engine()


def _logged_in_user(verified: bool = True):
    user = db_module.create_user("test_user", "test_user@example.com", "test_password")
    if verified:
        token = db_module.generate_verification_token(user.id)
        user = db_module.verify_email(token)
    return user


def _run(path: str, timeout: float = 60, logged_in: bool = False) -> AppTest:
    at = AppTest.from_file(str(APP / path), default_timeout=timeout)
    if logged_in:
        at.session_state["user"] = _logged_in_user()
    at.run()
    assert not at.exception, at.exception
    return at


def test_home_loads():
    at = _run("streamlit_app.py")
    assert any("Telomere Evolution Lab" in t.value for t in at.title)


def test_functional_page_requires_login():
    """An unauthenticated visitor sees the login form, not the real page."""
    at = _run("pages/01_Simulate.py")
    assert any("Log in required" in s.value for s in at.subheader)
    assert not at.sidebar.slider  # the real Simulate page content never rendered


def test_unverified_user_sees_verification_gate_not_real_page():
    """A logged-in user who has not clicked their verification link must see
    the "verify your email" screen, not the real gated page content."""
    at = AppTest.from_file(str(APP / "pages/01_Simulate.py"), default_timeout=60)
    at.session_state["user"] = _logged_in_user(verified=False)
    at.run()
    assert not at.exception, at.exception
    assert any("Verify your email" in s.value for s in at.subheader)
    assert not at.sidebar.slider  # the real Simulate page content never rendered
    assert any("Resend verification email" in b.label for b in at.button)


def test_simulate_page_runs_simulation_and_shows_results():
    at = _run("pages/01_Simulate.py", logged_in=True)
    # required controls
    labels = " ".join(s.label for s in at.sidebar.slider)
    for word in ("Stress", "Maintenance", "Repair", "shortening", "Initial telomere"):
        assert word.lower() in labels.lower()
    assert any("Run simulation" in b.label for b in at.sidebar.button)
    run_btn = next(b for b in at.sidebar.button if "Run simulation" in b.label)
    run_btn.click().run()
    assert not at.exception
    assert "sim_result" in at.session_state
    assert at.session_state["sim_result"].valid
    assert len(at.metric) >= 5
    # export controls present
    assert len(at.get("download_button")) >= 2


def test_evolve_page_loads():
    at = _run("pages/02_Evolve.py", logged_in=True)
    assert any("Evolve" in t.value for t in at.title)


def test_compare_page_loads_without_session_evolution_result():
    at = _run("pages/03_Compare.py", logged_in=True)
    assert any("Compare" in t.value for t in at.title)
    # Either the ledger is empty (warning tells the user to run Evolve) or the page fell back to
    # the most recent registered evolution run (selectbox + caption).
    assert at.warning or at.selectbox
    # The baseline scenario must always render its fitness composition chart.
    assert any("Baseline" in c.value for c in at.caption) or at.get("plotly_chart")


def test_pareto_page_loads():
    at = _run("pages/05_Pareto.py", logged_in=True)
    assert any("Pareto" in t.value for t in at.title)
    assert at.multiselect  # objectives selector present


def test_sensitivity_page_requires_login():
    at = _run("pages/06_Sensitivity.py")
    assert any("Log in required" in s.value for s in at.subheader)


def test_active_learning_page_requires_login():
    at = _run("pages/07_ActiveLearning.py")
    assert any("Log in required" in s.value for s in at.subheader)


def test_experiments_page_loads():
    at = _run("pages/04_Experiments.py", logged_in=True)
    assert any("Experiments" in t.value for t in at.title)
