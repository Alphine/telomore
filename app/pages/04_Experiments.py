"""Page 4 - Experiments: reproducibility ledger and bundle export (SDD §16, §20)."""

import json

import streamlit as st

import ui  # noqa: F401
from ui.components import current_user, disclaimer, page_setup, require_login

from telomere_lab import db as _db
from telomere_lab.experiments.artifacts import bundle_run_dir
from telomere_lab.experiments.registry import ExperimentRegistry, environment_metadata

page_setup("Experiments", "📒")
disclaimer()
require_login()

registry = ExperimentRegistry()
ledger = registry.ledger_frame()

st.markdown(f"Ledger location: `{registry.runs_dir}` · {len(ledger)} run(s)")
if ledger.empty:
    st.info("No runs recorded yet. Tick *Record run* on the Simulate page or run the Evolve page, "
            "or use the CLI scripts.")
    st.stop()

user = current_user()
my_run_ids = set(_db.list_user_runs(user.id)) if user is not None else set()

tab_all, tab_mine = st.tabs(["All experiments", "My experiments"])
with tab_all:
    st.dataframe(ledger, hide_index=True, width="stretch", height=320)
with tab_mine:
    my_ledger = ledger[ledger["run_id"].isin(my_run_ids)]
    if my_ledger.empty:
        st.info("You have not recorded any runs yet in this session. Tick *Record run* on the "
                "Simulate page, or run Evolve/Pareto/Sensitivity/Active Learning, while logged in.")
    else:
        st.dataframe(my_ledger, hide_index=True, width="stretch", height=320)

st.markdown("#### Inspect a run")
run_id = st.selectbox("Run ID", ledger["run_id"].tolist())
record = registry.load(run_id)

c1, c2, c3, c4 = st.columns(4)
c1.metric("Kind", record["kind"])
c2.metric("Seed", record["seed"])
c3.metric("Fitness", "n/a" if record.get("fitness") is None else f"{record['fitness']:+.4f}")
c4.metric("Git commit", record.get("git_commit") or "n/a")

st.markdown("**Reproduce**")
cfg = record["configuration"]
if record["kind"] == "evolution":
    st.code(f"# write the two blocks below to a YAML file, then\n"
            f"python scripts/run_evolution.py --config <file>.yaml --seed {record['seed']}", language="bash")
else:
    model = cfg.get("model", {})
    st.code("python scripts/run_simulation.py --seed {seed} {sets}".format(
        seed=model.get("seed", record["seed"]),
        sets=" ".join(f"--set {k}={v}" for k, v in model.items() if k != "seed")), language="bash")

with st.expander("Full record (JSON)", expanded=False):
    st.json(record)

st.markdown("**Artifacts**")
for name, path in (record.get("artifacts") or {}).items():
    st.markdown(f"- `{name}` → `{path}`")

run_dir = registry.run_dir(run_id)
if run_dir.exists():
    st.download_button("⬇ Download complete experiment bundle (.zip)", bundle_run_dir(run_dir),
                       f"{run_id}.zip", "application/zip", type="primary")

with st.expander("Current environment"):
    st.json(environment_metadata())
