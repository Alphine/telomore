"""The static demo cache (frontend/public/demo-cache, built by scripts/build_demo_cache.py).

Cheap structural checks run always; the determinism checks re-run one cheap scenario per feature through the
real backend and require equality with the stored response (so a model change that is not followed by a
cache rebuild fails here). ``DEMO_CACHE_FULL=1`` additionally rebuilds the whole cache twice (minutes).
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "frontend" / "public" / "demo-cache"

MAX_FILE_BYTES = int(1.5 * 1024 * 1024)
MAX_TOTAL_BYTES = 15 * 1024 * 1024

EXPECTED_FEATURES = {"simulate", "evolve", "pareto", "sensitivity", "gxe", "active-learning", "compare",
                     "experiments", "genome"}


def _load_builder():
    name = "build_demo_cache"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / "build_demo_cache.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def builder():
    return _load_builder()


@pytest.fixture(scope="module")
def index():
    return json.loads((CACHE / "index.json").read_text(encoding="utf-8"))


def _scenarios(index):
    for feature, items in index["features"].items():
        for it in items:
            yield feature, it


def _load(it):
    return json.loads((CACHE / it["file"]).read_bytes())


# --------------------------------------------------------------------------- structure
def test_index_shape(index):
    assert index["version"] == 1
    assert isinstance(index["generated_at"], str) and index["generated_at"].endswith("Z")
    assert isinstance(index["engine_version"], str) and index["engine_version"]
    assert set(index["features"]) == EXPECTED_FEATURES
    for feature, items in index["features"].items():
        assert 1 <= len(items), feature
        ids = [i["id"] for i in items]
        assert len(ids) == len(set(ids)), f"duplicate ids in {feature}"


def test_preset_counts(index):
    for feature, items in index["features"].items():
        if feature in ("experiments",):
            assert len(items) == 1
        elif feature == "simulate":
            assert 6 <= len(items) <= 12
        else:
            assert 3 <= len(items) <= 6, feature


def test_index_matches_files(index):
    on_disk = {p.relative_to(CACHE).as_posix() for p in CACHE.rglob("*.json")} - {"index.json"}
    listed = set()
    for feature, it in _scenarios(index):
        assert it["file"] == f"{feature}/{it['id']}.json"
        p = CACHE / it["file"]
        assert p.is_file(), it["file"]
        data = p.read_bytes()
        assert it["bytes"] == len(data)
        assert it["sha"] == hashlib.sha256(data).hexdigest()
        assert it["version"] == it["sha"][:10]
        assert it["title"] and it["description"]
        listed.add(it["file"])
    assert listed == on_disk, "files on disk that the index does not list (or vice versa)"


def test_scenario_files_valid(index):
    for feature, it in _scenarios(index):
        doc = _load(it)
        assert {"id", "title", "description", "feature", "endpoint", "request", "response", "meta"} <= set(doc)
        assert doc["id"] == it["id"] and doc["feature"] == feature
        assert doc["title"] == it["title"] and doc["description"] == it["description"]
        assert {"seed", "engine_version", "config_hash"} <= set(doc["meta"])
        assert doc["meta"]["engine_version"] == index["engine_version"]
        assert isinstance(doc["meta"]["seed"], int)
        assert "precomputed" in doc["description"].lower(), "descriptions must say these are precomputed runs"
        assert "not patient data" in doc["description"].lower()
        # strict JSON, no NaN
        json.loads((CACHE / it["file"]).read_text(encoding="utf-8"), parse_constant=_no_const)


def _no_const(c):
    raise AssertionError(f"non-finite JSON constant {c}")


def test_sizes_within_budget(index):
    total = 0
    for _, it in _scenarios(index):
        size = (CACHE / it["file"]).stat().st_size
        assert size < MAX_FILE_BYTES, f"{it['file']} is {size} bytes"
        total += size
    assert total < MAX_TOTAL_BYTES


def test_no_volatile_values(index):
    for _, it in _scenarios(index):
        text = (CACHE / it["file"]).read_text(encoding="utf-8")
        assert "TEL-2" not in text, f"raw ledger run id leaked into {it['file']}"
        assert "Users\\\\" not in text and "/Users/" not in text and "\\\\Temp" not in text, it["file"]


def test_runtime_seconds_zeroed(index):
    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k in ("runtime_seconds", "elapsed_seconds"):
                    assert v == 0.0
                walk(v)
        elif isinstance(o, list):
            for x in o:
                walk(x)

    for _, it in _scenarios(index):
        walk(_load(it)["response"])


# --------------------------------------------------------------------------- response models
def test_responses_validate_against_live_models(index):
    from backend import schemas as S

    for feature, it in _scenarios(index):
        doc = _load(it)
        resp, ep = doc["response"], doc["endpoint"]
        if ep == "/simulate":
            S.SimulateResponse(**resp)
            assert resp["run"]["valid"] is True
            assert resp["run"]["fitness"]
        elif ep == "/simulate/ensemble":
            # The live API itself emits null for undefined per-seed metrics (e.g. time_to_50pct_senescence of a
            # culture that never senesces) although the declared model says float, so validate the structure
            # rather than round-tripping through EnsembleResponse.
            assert resp["n_seeds"] == 8 and len(resp["series"]) == 8 and resp["seeds"] == list(range(100, 108))
            assert {"bands", "config", "config_hash", "applied_schedule"} <= set(resp)
        elif ep == "/compare":
            r = S.CompareResponse(**resp)
            assert r.baseline == r.scenarios[0].name and r.scenarios[0].deltas is None
        elif ep == "/experiments":
            rows = [S.ExperimentSummary(**x) for x in resp]
            assert rows and all(r.run_id.startswith("DEMO-") for r in rows)
            assert set(doc["extra"]["details"]) == {r.run_id for r in rows}
            for d in doc["extra"]["details"].values():
                S.ExperimentDetail(**d)
        elif ep == "/evolve":
            assert {"best", "baseline", "history", "evaluations", "stopped_early"} <= set(resp)
            assert resp["history"] and "genome" in resp["best"]
        elif ep == "/pareto":
            assert resp["front"] and "baseline" in resp and resp["history"]
        elif ep == "/sensitivity":
            assert resp["items"] and "baseline_fitness" in resp
        elif ep == "/gxe":
            assert resp["items"] and "reranking_pairs" in resp
        elif ep == "/active-learning":
            assert resp["records"] and "best_genome" in resp and "best_fitness" in resp
        elif ep == "/sequence/lineage":
            assert resp["toy"] is True and {"normal", "damaged", "model_bridge"} <= set(resp)
        elif ep == "/sequence/genome + /sequence/mutate":
            assert resp["genome"]["toy"] is True and resp["genome"]["genes"]
            assert {m["effect"] for m in resp["mutations"]} >= {"synonymous", "missense", "nonsense"}
        else:  # a new endpoint was added without a check
            pytest.fail(f"unchecked endpoint {ep}")


def test_requests_are_replayable(index):
    """Stored requests must be accepted by the live request models (shape drift guard)."""
    from backend import schemas as S

    models = {"/simulate": S.SimulateRequest, "/simulate/ensemble": S.EnsembleRequest, "/evolve": S.EvolveRequest,
              "/pareto": S.ParetoRequest, "/sensitivity": S.SensitivityRequest, "/gxe": S.GxERequest,
              "/active-learning": S.ActiveLearningRequest, "/compare": S.CompareRequest}
    for _, it in _scenarios(index):
        doc = _load(it)
        m = models.get(doc["endpoint"])
        if m is not None:
            m(**doc["request"])


# --------------------------------------------------------------------------- determinism (live re-run)
# One cheap scenario per feature (ensemble and chip-compare variants are covered by the same code paths).
LIVE_CHECKS = [
    ("simulate", "fibroblast-aging"),
    ("simulate", "ensemble-telomerase-positive"),
    ("compare", "mechanisms"),
    ("genome", "lineage-checkpoint-only"),
    ("genome", "toy-genome"),
    ("gxe", "repair-by-stress"),
    ("sensitivity", "stressed-baseline"),
    ("active-learning", "three-phase-protocol"),
    ("pareto", "survival-vs-cost"),
    ("evolve", "stressed-culture-balanced"),
]


@pytest.fixture(scope="module")
def engine(builder):
    eng = builder.Engine()
    try:
        yield eng
    finally:
        eng.close()


@pytest.mark.parametrize("feature,sid", LIVE_CHECKS)
def test_live_rerun_equals_cache(builder, engine, index, feature, sid):
    sc = next(s for s in builder.SCENARIOS if s["feature"] == feature and s["id"] == sid)
    entry = next(i for i in index["features"][feature] if i["id"] == sid)
    doc = _load(entry)
    if sc["special"] == "genome":
        request, response = engine.genome_scenario()
        assert request == doc["request"]
    else:
        assert sc["request"] == doc["request"], "script request drifted from cached request; rebuild the cache"
        response = engine.run(sc)
    live = builder.normalise_live(feature, sid, response)
    assert live == doc["response"], f"{feature}/{sid} no longer matches the engine -- rebuild the demo cache"
    assert doc["meta"]["config_hash"] == builder._config_hash(sc["model"])


def test_every_script_scenario_is_cached(builder, index):
    cached = {(f, i["id"]) for f, i in _scenarios(index)}
    assert {(s["feature"], s["id"]) for s in builder.SCENARIOS} == cached


# --------------------------------------------------------------------------- idempotence
def test_build_is_idempotent_for_cheap_features(builder, tmp_path, index):
    only = ["simulate", "compare", "genome"]
    a, b = tmp_path / "a", tmp_path / "b"
    builder.build(a, only=only, verbose=False)
    builder.build(b, only=only, verbose=False)
    files = sorted(p.relative_to(a).as_posix() for p in a.rglob("*.json") if p.name != "index.json")
    assert files
    for rel in files:
        assert (a / rel).read_bytes() == (b / rel).read_bytes(), rel
        assert (a / rel).read_bytes() == (CACHE / rel).read_bytes(), f"{rel} differs from the committed cache"
    # index regenerated in place keeps its timestamp when nothing changed
    before = (a / "index.json").read_bytes()
    builder.build(a, only=only, verbose=False)
    assert (a / "index.json").read_bytes() == before


@pytest.mark.skipif(os.environ.get("DEMO_CACHE_FULL") != "1", reason="full rebuild takes minutes; DEMO_CACHE_FULL=1")
def test_full_rebuild_matches_committed(builder, tmp_path):
    builder.build(tmp_path / "full", verbose=False)
    for p in sorted((tmp_path / "full").rglob("*.json")):
        rel = p.relative_to(tmp_path / "full")
        if rel.name == "index.json":
            a = json.loads(p.read_text(encoding="utf-8"))
            b = json.loads((CACHE / rel).read_text(encoding="utf-8"))
            a["generated_at"] = b["generated_at"] = None
            assert a == b
        else:
            assert p.read_bytes() == (CACHE / rel).read_bytes(), rel
