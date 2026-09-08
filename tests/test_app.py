"""GUI smoke tests with Streamlit's AppTest (SDD §29)."""

from pathlib import Path

import pytest

st = pytest.importorskip("streamlit")
from streamlit.testing.v1 import AppTest  # noqa: E402

APP = Path(__file__).resolve().parents[1] / "app"


def _run(path: str, timeout: float = 60) -> AppTest:
    at = AppTest.from_file(str(APP / path), default_timeout=timeout)
    at.run()
    assert not at.exception, at.exception
    return at


def test_home_loads():
    at = _run("streamlit_app.py")
    assert any("Telomere Evolution Lab" in t.value for t in at.title)


def test_simulate_page_runs_simulation_and_shows_results():
    at = _run("pages/01_Simulate.py")
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
    at = _run("pages/02_Evolve.py")
    assert any("Evolve" in t.value for t in at.title)


def test_compare_page_loads_without_session_evolution_result():
    at = _run("pages/03_Compare.py")
    assert any("Compare" in t.value for t in at.title)
    # Either the ledger is empty (warning tells the user to run Evolve) or the page fell back to
    # the most recent registered evolution run (selectbox + caption).
    assert at.warning or at.selectbox
    # The baseline scenario must always render its fitness composition chart.
    assert any("Baseline" in c.value for c in at.caption) or at.get("plotly_chart")


def test_pareto_page_loads():
    at = _run("pages/05_Pareto.py")
    assert any("Pareto" in t.value for t in at.title)
    assert at.multiselect  # objectives selector present


def test_experiments_page_loads():
    at = _run("pages/04_Experiments.py")
    assert any("Experiments" in t.value for t in at.title)
