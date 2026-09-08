"""Telomere Evolution Lab - entry point and home page.

    streamlit run app/streamlit_app.py
"""

import json

import streamlit as st

import ui  # noqa: F401 - puts src/ on sys.path
from ui.components import DISCLAIMER, current_user, inject_css, logout

from telomere_lab import __version__
from telomere_lab.adapters.published_model import available_models
from telomere_lab.config import REPORTS_DIR
from telomere_lab.experiments.registry import environment_metadata
from telomere_lab.schemas import MODEL_VERSION, OPTIMIZER_VERSION

# (icon, title, one-sentence description, page url_path)
FEATURES = [
    ("🔬", "Simulate", "Run a single virtual experiment and inspect telomere length, senescence "
     "and survival trajectories.", "Simulate"),
    ("🧬", "Evolve", "Define an objective and let a genetic algorithm search for parameter "
     "conditions that optimise it.", "Evolve"),
    ("🎯", "Pareto", "Run NSGA-II to see the full trade-off surface between competing objectives, "
     "not just one weighted winner.", "Pareto"),
    ("📐", "Sensitivity", "See which parameters move fitness the most with one-at-a-time (OAT) "
     "sensitivity analysis.", "Sensitivity"),
    ("⚖️", "Compare", "Overlay baseline vs. evolved vs. hand-picked scenarios side by side and "
     "read the deltas.", "Compare"),
    ("📒", "Experiments", "Browse the reproducibility ledger and download complete run bundles "
     "for any past experiment.", "Experiments"),
    ("🧭", "Active Learning", "A Gaussian-process surrogate + Expected Improvement chooses which "
     "configuration to test next, reaching good fitness with fewer real simulator runs.", "ActiveLearning"),
]


def home() -> None:
    st.set_page_config(page_title="Telomere Evolution Lab", page_icon="🧬", layout="wide")
    inject_css()

    # -------------------------------------------------------------- sidebar
    with st.sidebar:
        user = current_user()
        if user is not None:
            st.markdown(f"**Logged in as** `{user.username}`")
            if st.button("Log out", width="stretch"):
                logout()
                st.rerun()
        else:
            st.caption("Log in to save your experiment progress. The Home page is public - "
                       "logging in is only required to use Simulate/Evolve/Pareto/Sensitivity/"
                       "Active Learning/Compare/Experiments.")

    # ------------------------------------------------------------------ hero
    st.title("🧬 Telomere Evolution Lab")
    st.markdown("### Simulate. Evolve. Compare. Learn.")
    st.markdown(
        "An interactive AI-for-Science laboratory where an **evolutionary optimizer** searches a "
        "**telomere-dynamics model** for virtual experiment conditions that optimise an explicit, "
        "user-defined objective."
    )
    st.info(DISCLAIMER, icon="ℹ️")

    # ------------------------------------------------------------ feature cards
    st.markdown("#### Explore the lab")
    for row_start in range(0, len(FEATURES), 3):
        cols = st.columns(3)
        for col, (icon, title, desc, url_path) in zip(cols, FEATURES[row_start:row_start + 3]):
            with col:
                with st.container(border=True):
                    st.markdown(f'<div class="feature-card-marker feature-card-icon">{icon}</div>',
                               unsafe_allow_html=True)
                    st.markdown(f"**{title}**")
                    st.caption(desc)
                    st.page_link(f"pages/{_PAGE_FILES[url_path]}", label=f"Open {title} →")

    st.markdown("---")

    # ------------------------------------------------------------ how it works
    st.markdown("#### The virtual experimentation loop")
    st.code(
        "biological hypothesis / objective\n"
        "        ↓\n"
        "  parameter genome  (stress, maintenance, repair, ...)\n"
        "        ↓\n"
        "  telomere simulation  (population of cells × telomeres, per cycle)\n"
        "        ↓\n"
        "  biological outcomes  (length, senescence, survival)\n"
        "        ↓\n"
        "  fitness score  (explicit weighted objective)\n"
        "        ↓\n"
        "  mutation / selection → next generation  ↺",
        language="text",
    )

    st.markdown("#### Suggested demo flow")
    st.markdown(
        "1. **Simulate** – run the stressed baseline culture and watch telomere reserve collapse.\n"
        "2. **Evolve** – define the objective weights and click *Evolve*; watch fitness climb.\n"
        "3. **Compare** – overlay baseline vs. best evolved candidate; read the deltas.\n"
        "4. **Experiments** – open the reproducibility ledger and export the run bundle."
    )

    # ------------------------------------------------------------ build info
    with st.expander("Build, model backends & measured performance"):
        left, right = st.columns(2)
        with left:
            st.markdown("**Build**")
            env = environment_metadata()
            st.code(
                f"package    {__version__}\nmodel      {MODEL_VERSION}\noptimizer  {OPTIMIZER_VERSION}\n"
                f"git        {env['git_commit'] or 'no commit yet'}\n"
                f"python     {env['python_version']}\nnumpy      {env['numpy_version']}",
                language="text",
            )
            st.markdown("**Model backends**")
            for name, status in available_models().items():
                st.markdown(f"- `{name}` — {status}")
        with right:
            bench = REPORTS_DIR / "benchmark.json"
            if bench.exists():
                try:
                    b = json.loads(bench.read_text(encoding="utf-8"))
                    st.markdown("**Measured performance (this machine)**")
                    st.markdown(
                        f"- single simulation: **{b['simulation_default']['median_ms']:.0f} ms** median\n"
                        f"- evolution: **{b['evolution']['seconds_per_generation']:.1f} s / generation** "
                        f"({b['evolution']['population_size']} candidates)"
                    )
                except (KeyError, json.JSONDecodeError):
                    pass
            else:
                st.caption("No benchmark report found yet.")

    st.markdown("---")
    st.markdown("#### Organ-on-a-chip framing")
    st.markdown(
        "Chip culture conditions (flow, oxygen, nutrients, exogenous stress, duration) are mapped to "
        "abstract simulation parameters on the Simulate page. The mapping is a documented **modelling "
        "assumption**; the model does not reproduce a physical chip. See `docs/MODEL.md` and "
        "`docs/SCIENTIFIC_SCOPE.md`."
    )
    st.caption("Fitness ≠ biological truth. The optimizer optimises the chosen computational objective "
               "under the chosen model assumptions.")


_PAGE_FILES = {
    "Simulate": "01_Simulate.py",
    "Evolve": "02_Evolve.py",
    "Pareto": "05_Pareto.py",
    "Sensitivity": "06_Sensitivity.py",
    "Compare": "03_Compare.py",
    "Experiments": "04_Experiments.py",
    "ActiveLearning": "07_ActiveLearning.py",
}


pages = st.navigation(
    [
        st.Page(home, title="Home", icon="🏠", default=True),
        st.Page("pages/01_Simulate.py", title="Simulate", icon="🔬", url_path="Simulate"),
        st.Page("pages/02_Evolve.py", title="Evolve", icon="🧬", url_path="Evolve"),
        st.Page("pages/05_Pareto.py", title="Pareto", icon="🎯", url_path="Pareto"),
        st.Page("pages/06_Sensitivity.py", title="Sensitivity", icon="📐", url_path="Sensitivity"),
        st.Page("pages/07_ActiveLearning.py", title="Active Learning", icon="🧭", url_path="ActiveLearning"),
        st.Page("pages/03_Compare.py", title="Compare", icon="⚖️", url_path="Compare"),
        st.Page("pages/04_Experiments.py", title="Experiments", icon="📒", url_path="Experiments"),
    ]
)
pages.run()
