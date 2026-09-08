"""Reusable page pieces: disclaimer, metric rows, exports, session helpers."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

import streamlit as st

from telomere_lab.config import CONFIG_DIR, load_model_config
from telomere_lab.experiments.artifacts import simulation_csv, simulation_json
from telomere_lab.schemas import EvolutionConfig, FitnessWeights, ModelConfig, SimulationResult

DISCLAIMER = (
    "**Scope.** This is a computational research prototype. Every number on this page is a "
    "*model output* under the stated assumptions. It does not provide medical advice, clinical "
    "predictions, or validated therapeutic recommendations. Parameters named after biological "
    "processes are simulation parameters, not interventions."
)


def inject_css() -> None:
    """Light-touch, theme-adaptive CSS for cards, spacing and badges.

    Uses Streamlit's own CSS variables (or structural rules with no hardcoded
    colors) so this looks correct in both light and dark themes.
    """
    st.markdown(
        """
        <style>
        /* Bordered containers (st.container(border=True)) read as cards */
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
        /* Breathing room between major page sections */
        h4 {
            margin-top: 1.25rem;
        }
        /* Softer, theme-adaptive divider */
        hr {
            margin: 1.75rem 0;
            opacity: 0.5;
        }
        </style>
        """,
        unsafe_allow_html=True,
    )


def page_setup(title: str, icon: str = "🧬") -> None:
    st.set_page_config(page_title=f"{title} · Telomere Evolution Lab", page_icon=icon, layout="wide")
    inject_css()
    st.title(f"{icon} {title}")


def disclaimer() -> None:
    st.info(DISCLAIMER, icon="ℹ️")


def demo_config() -> ModelConfig:
    path = CONFIG_DIR / "demo.yaml"
    return load_model_config(path) if path.exists() else ModelConfig()


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
