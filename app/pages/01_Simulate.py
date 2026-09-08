"""Page 1 - Simulate: inspect a single virtual experiment (SDD §16)."""

import streamlit as st

import ui  # noqa: F401
from ui import charts
from ui.components import (
    baseline_config, current_user, disclaimer, export_buttons, failure_banner, page_setup,
    provenance, require_login, set_state, terminal_metric_row, weights,
)
from ui.controls import chip_controls, model_controls

from telomere_lab import db as _db
from telomere_lab.experiments.registry import ExperimentRegistry
from telomere_lab.experiments.runner import record_simulation, run_simulation, score
from telomere_lab.schemas import ModelConfig

page_setup("Simulate", "🔬")
disclaimer()
require_login()

defaults = baseline_config()

with st.sidebar:
    st.header("Model parameters")
    use_chip = st.toggle("Derive stress/repair from organ-on-chip conditions", value=False)
    derived = None
    if use_chip:
        with st.expander("Chip conditions", expanded=True):
            derived = chip_controls()
        defaults = defaults.replace(**derived)
    config: ModelConfig = model_controls(defaults, key_prefix="sim")
    st.markdown("---")
    run = st.button("▶ Run simulation", type="primary", width="stretch")
    c1, c2 = st.columns(2)
    if c1.button("Reset", width="stretch"):
        for k in list(st.session_state.keys()):
            if k.startswith("sim_") or k.startswith("chip_"):
                del st.session_state[k]
        st.session_state.pop("sim_result", None)
        st.rerun()
    make_baseline = c2.button("Set as baseline", width="stretch",
                              help="Use these parameters as the baseline for Evolve and Compare.")
    register = st.checkbox("Record run in experiment registry", value=False)

if make_baseline:
    set_state("baseline_config", config)
    st.toast("Baseline updated for Evolve / Compare.")

if run:
    with st.spinner("Simulating…"):
        result = run_simulation(config)
    set_state("sim_result", result)
    set_state("sim_config", config)
    if register and result.valid:
        rec = record_simulation(result, ExperimentRegistry(), weights())
        user = current_user()
        if user is not None:
            _db.record_user_run(user.id, rec["run_id"])
        st.toast(f"Registered as {rec['run_id']}")

result = st.session_state.get("sim_result")
if result is None:
    st.markdown(
        "Set parameters in the sidebar and press **Run simulation**. The default baseline is the "
        "*stressed culture* scenario from `configs/demo.yaml`."
    )
    st.stop()

if failure_banner(result):
    st.stop()

bd = score(result, weights())
terminal_metric_row(result, fitness=bd.total)

c1, c2 = st.columns(2)
c1.plotly_chart(charts.length_trajectory(result), width="stretch")
c2.plotly_chart(charts.length_distribution(result), width="stretch")
c3, c4 = st.columns(2)
c3.plotly_chart(charts.senescence_curve(result), width="stretch")
c4.plotly_chart(charts.population_curve(result), width="stretch")

with st.expander("Fitness breakdown under current objective weights"):
    st.plotly_chart(charts.fitness_breakdown_bar(bd.to_dict(), weights().to_dict()), width="stretch")
    st.caption("Fitness is the experimenter's objective, not a biological ground truth. "
               "Adjust the weights on the Evolve page.")

st.markdown("#### Export")
export_buttons(result)
provenance(result)
