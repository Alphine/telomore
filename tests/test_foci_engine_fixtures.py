"""The golden fixtures of the browser engine must still be what segment.py produces.

foci/tests/fixtures/engine_golden/manifest.json holds the Python reference results for the stored PNG inputs;
the Node tests assert the JavaScript engine reproduces them exactly. If segment.py (or the upload normalisation,
or numpy / scipy) changes what it computes, this test fails and says which fixtures drifted: regenerate with
``python scripts/make_engine_fixtures.py`` and re-run ``node --test "foci/tests/*.test.mjs"``.
"""

import importlib.util
import json
import platform
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "make_engine_fixtures.py"
GOLD = ROOT / "foci" / "tests" / "fixtures" / "engine_golden"
MANIFEST = GOLD / "manifest.json"


@pytest.fixture(scope="module")
def gen():
    pytest.importorskip("scipy")
    pytest.importorskip("PIL")
    pytest.importorskip("fastapi")  # backend.foci_upload imports it
    spec = importlib.util.spec_from_file_location("make_engine_fixtures", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["make_engine_fixtures"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def manifest():
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def recomputed(gen, manifest):
    return gen.recompute_from_disk(manifest, GOLD)


def test_manifest_is_complete(manifest):
    assert manifest["format"] == 1
    assert len(manifest["cases"]) >= 30
    assert sum(c["kind"] == "idr0010" for c in manifest["cases"]) >= 12
    assert len({s["case"] for s in manifest["sweeps"]}) == 3
    for c in manifest["cases"]:
        for f in c["files"].values():
            assert (GOLD / f).is_file(), f
        assert "error" not in c["python"], f"{c['id']}: Python itself raised"
    assert sum(f.stat().st_size for f in GOLD.iterdir()) < 3_000_000


def test_default_params_match_fociparams(manifest):
    import dataclasses

    from telomere_lab.foci.segment import FociParams

    assert manifest["default_params"] == dataclasses.asdict(FociParams())


def _strip_env_dependent(py: dict) -> dict:
    """Results that must match on every platform: everything but the intermediate-array hashes / stats / threshold."""
    return {k: v for k, v in py.items() if k not in ("hashes", "stats", "threshold")}


def test_results_match_current_reference(manifest, recomputed):
    drift = [
        e["id"] for e, r in zip(manifest["cases"], recomputed["cases"])
        if _strip_env_dependent(e["python"]) != _strip_env_dependent(r["python"])
    ]
    assert not drift, f"segment.py / upload normalisation no longer reproduces the fixtures: {drift}"


def test_sweeps_match_current_reference(manifest, recomputed):
    drift = [
        (s["case"], s["params"]) for s, r in zip(manifest["sweeps"], recomputed["sweeps"])
        if _strip_env_dependent(s["python"]) != _strip_env_dependent(r["python"])
    ]
    assert not drift, f"parameter sweeps drifted: {drift}"


def test_intermediate_hashes_match_on_the_generating_platform(manifest, recomputed):
    """sha256 of float32 intermediates is bit-exact only with the same numpy / scipy / libm; compare when it is the same stack."""
    env = manifest["env"]
    import numpy
    import scipy

    same_stack = (env["numpy"], env["scipy"], env["platform"]) == (
        numpy.__version__, scipy.__version__, f"{platform.system()}-{platform.machine()}")
    if not same_stack:
        pytest.skip(f"manifest generated with {env}; hashes are only compared on the same numpy/scipy/platform")
    drift = [e["id"] for e, r in zip(manifest["cases"], recomputed["cases"]) if e["python"] != r["python"]]
    assert not drift, f"intermediate arrays drifted for {drift}"


def test_png_inputs_round_trip_as_documented(gen, manifest):
    import numpy as np

    for c in manifest["cases"][:40]:
        dna, foc = gen.read_case_images(c, GOLD)
        assert dna.shape == (c["height"], c["width"]) == foc.shape
        assert dna.dtype == (np.uint8 if c["bit_depth"] == 8 else np.uint16)
