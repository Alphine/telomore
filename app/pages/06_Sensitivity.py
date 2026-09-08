"""Page 6 - Sensitivity: one-at-a-time (OAT) parameter sensitivity, a tornado
chart of which parameters move fitness the most around the baseline."""

import json

import streamlit as st

import ui  # noqa: F401
from ui import charts
from ui.components import baseline_config, disclaimer, page_setup, set_state, weights

from telomere_lab.experiments.registry import ExperimentRegistry, _json_default
from telomere_lab.experiments.runner import run_sensitivity
from telomere_lab.schemas import EVOLVABLE_PARAMETERS, SensitivityConfig

page_setup("Sensitivity", "📐")
disclaimer()

base = baseline_config()
st.markdown(
    "**One-at-a-time (OAT) sensitivity.** Each parameter is perturbed +/- a fraction of its allowed "
    "range while every other parameter stays at the baseline; the fitness swing (high − low) shows how "
    "much that single knob matters here, holding everything else fixed. It does **not** capture "
    "interactions between parameters — for that, see the **Pareto** and **Evolve** pages."
)
st.caption(
    f"Baseline: stress {base.stress_level:.2f} · maintenance {base.maintenance_rate:.2f} · repair "
    f"{base.repair_rate:.2f} · {base.cycles} cycles. Change it on the Simulate page."
)

defaults = st.session_state.get("sensitivity_config") or SensitivityConfig(weights=weights())

with st.form("sensitivity_form"):
    params = st.multiselect("Parameters to test", list(EVOLVABLE_PARAMETERS), list(defaults.parameters))
    c1, c2 = st.columns(2)
    frac = c1.slider("Perturbation (+/- fraction of range)", 0.02, 0.30, float(defaults.perturbation_fraction), 0.01)
    seeds = c2.text_input("Simulator seeds to average (comma-separated)",
                          ",".join(str(s) for s in defaults.eval_seeds))
    notes = st.text_input("Notes for the ledger", "")
    submitted = st.form_submit_button("📐 Run sensitivity analysis", type="primary", width="stretch")

if submitted:
    try:
        eval_seeds = tuple(int(s.strip()) for s in seeds.split(",") if s.strip())
        sens = SensitivityConfig(
            parameters=tuple(params) or defaults.parameters,
            perturbation_fraction=float(frac),
            eval_seeds=eval_seeds or defaults.eval_seeds,
            weights=weights(),
        ).validate()
    except Exception as exc:  # noqa: BLE001
        st.error(f"Invalid configuration: {exc}")
        st.stop()
    set_state("sensitivity_config", sens)
    progress = st.progress(0.0, text="Initialising…")
    n = len(sens.parameters)
    seen = []

    def on_item(item):
        seen.append(item)
        progress.progress(min(len(seen) / max(n, 1), 1.0),
                          text=f"{item.parameter}: swing {item.swing:+.4f} ({len(seen)}/{n})")

    with st.spinner("Running sensitivity analysis…"):
        result, record = run_sensitivity(base, sens, ExperimentRegistry(), callback=on_item, notes=notes)
    set_state("sensitivity_result", result)
    set_state("sensitivity_record", record)
    progress.empty()
    st.rerun()

result = st.session_state.get("sensitivity_result")
record = st.session_state.get("sensitivity_record")
if result is None:
    st.info("Choose parameters and press **Run sensitivity analysis**.")
    st.stop()

frame = result.to_frame()
c = st.columns(4)
c[0].metric("Baseline fitness", f"{result.baseline_fitness:+.3f}")
c[1].metric("Parameters tested", len(frame))
c[2].metric("Simulations run", result.evaluations)
c[3].metric("Runtime", f"{result.runtime_seconds:.1f} s")
if record:
    st.success(f"Recorded as **{record['run_id']}** · config hash `{record['configuration_hash']}`")

st.plotly_chart(charts.tornado_chart(frame), width="stretch", key="tornado")

st.markdown("#### Sensitivity table (sorted by |swing|)")
st.dataframe(frame.style.format(precision=4), hide_index=True, width="stretch", height=320)

st.markdown("#### Export")
c1, c2 = st.columns(2)
c1.download_button("⬇ Sensitivity result (JSON)",
                   json.dumps(result.to_json_dict(), indent=2, default=_json_default),
                   f"{record['run_id'] if record else 'sensitivity'}.json", "application/json", width="stretch")
c2.download_button("⬇ Sensitivity table (CSV)", frame.to_csv(index=False),
                   f"{record['run_id'] if record else 'sensitivity'}.csv", "text/csv", width="stretch")
st.caption("A large swing means fitness is sensitive to that parameter *around this baseline* — it is not "
           "a global ranking and ignores interactions between parameters.")
