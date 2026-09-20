"""Toy DNA -> RNA -> protein layer (docs/MODEL.md §2.4) + /api/sequence/*."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from telomere_lab import db as db_module  # noqa: E402
from telomere_lab.sequence import (  # noqa: E402
    CODON_TABLE,
    LineageConfig,
    Gene,
    build_genome,
    classify_mutation,
    reverse_complement,
    simulate_lineage,
    subclone_overrides,
    substitution_profile,
    transcribe,
    translate,
)


def test_genetic_code_is_the_standard_one():
    assert len(CODON_TABLE) == 64
    assert CODON_TABLE["ATG"] == "M" and CODON_TABLE["TGG"] == "W"
    assert {c for c, a in CODON_TABLE.items() if a == "*"} == {"TAA", "TAG", "TGA"}
    assert sum(a == "L" for a in CODON_TABLE.values()) == 6


def test_transcribe_translate_revcomp():
    assert transcribe("ATGTTT") == "AUGUUU"
    assert translate("ATGTTTTAAGGG") == "MF"
    assert translate("ATGTTTTAAGGG", to_stop=False) == "MF*G"
    assert reverse_complement("ATGC") == "GCAT"


def test_genome_is_deterministic_and_well_formed():
    g1, g2 = build_genome(), build_genome()
    assert [x.dna for x in g1.genes] == [x.dna for x in g2.genes]
    for gene in g1.genes:
        assert gene.dna.startswith("ATG") and gene.dna.endswith("TAA")
        assert "*" not in gene.protein and len(gene.dna) % 3 == 0


def test_classification_of_hand_built_gene():
    gene = Gene("T", "essential", "ATGGCCTAA")   # M A stop
    assert classify_mutation(gene, 5, "T").effect == "synonymous"   # GCC -> GCT (Ala)
    assert classify_mutation(gene, 4, "A").effect == "missense"     # GCC -> GAC (Asp)
    assert classify_mutation(gene, 3, "T").effect == "missense"     # GCC -> TCC (Ser)
    assert classify_mutation(gene, 3, "T").mutated_protein == "MS"
    n = classify_mutation(Gene("T", "essential", "ATGTGGTAA"), 5, "A")   # TGG -> TGA
    assert n.effect == "nonsense" and n.mutated_protein == "M"
    assert classify_mutation(gene, 0, "C").effect == "start_loss"
    assert classify_mutation(gene, 6, "C").effect == "stop_loss"
    with pytest.raises(ValueError):
        classify_mutation(gene, 0, "A")
    with pytest.raises(ValueError):
        classify_mutation(gene, 99, "A")


def test_substitution_profile_sums_to_one():
    for gene in build_genome().genes:
        prof = substitution_profile(gene)
        assert abs(sum(prof.values()) - 1.0) < 1e-9
        assert prof["missense"] > prof["nonsense"] > 0


def test_damaged_lineage_carries_more_burden_and_normal_lineage_is_reproducible():
    normal = simulate_lineage(LineageConfig(seed=3))
    damaged = simulate_lineage(LineageConfig(seed=3, initial_lof=["TOY-CHK", "TOY-REP"]))
    assert damaged["TOY-CHK_functional"][0] == 0.0 and normal["TOY-CHK_functional"][0] == 1.0
    assert damaged["mean_burden"][-1] > 3 * normal["mean_burden"][-1]
    again = simulate_lineage(LineageConfig(seed=3))
    assert again["mean_burden"] == normal["mean_burden"]


def test_essential_gene_loss_is_lethal_and_extinction_is_nan_safe():
    r = simulate_lineage(LineageConfig(cells=50, generations=5, initial_lof=["TOY-ESS"]))
    assert r["extinct"] is True and r["alive_fraction"][-1] == 0.0
    assert np.isnan(r["mean_burden"][-1])


def test_zero_mutation_rate_changes_nothing():
    r = simulate_lineage(LineageConfig(mutation_rate=0.0, generations=10))
    assert all(f == 1.0 for f in r["alive_fraction"]) and r["mean_burden"][-1] == 0.0


def test_bridge_matches_the_demo_preset():
    assert subclone_overrides(True, True)["checkpoint_strength"] == 0.5
    assert subclone_overrides(False, False)["checkpoint_strength"] == 0.0
    assert subclone_overrides(False, False)["replication_error_rate"] > subclone_overrides(True, True)["replication_error_rate"]


# ---- API ----------------------------------------------------------------

@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    monkeypatch.setattr(db_module, "DATA_DIR", tmp_path / "data")
    db_module.reset_engine()
    yield
    db_module.reset_engine()


@pytest.fixture()
def client():
    from backend.main import create_app
    return TestClient(create_app())


def _auth(client):
    reg = client.post("/api/auth/register", json={"username": "seq_user", "email": "seq@example.com", "password": "hunter22"})
    client.get("/api/auth/verify", params={"token": reg.json()["dev_verification_link"].split("token=")[1]})
    tok = client.post("/api/auth/login", json={"username": "seq_user", "password": "hunter22"}).json()["access_token"]
    return {"Authorization": f"Bearer {tok}"}


def test_sequence_endpoints_require_auth(client):
    assert client.get("/api/sequence/genome").status_code in (401, 403)


def test_genome_mutate_lineage_endpoints(client):
    h = _auth(client)
    g = client.get("/api/sequence/genome", headers=h).json()
    assert g["toy"] is True and [x["name"] for x in g["genes"]] == ["TOY-CHK", "TOY-REP", "TOY-ESS"]
    gene = g["genes"][0]
    assert gene["mrna"] == gene["dna"].replace("T", "U")

    alt = "A" if gene["dna"][10] != "A" else "C"
    m = client.post("/api/sequence/mutate", headers=h, json={"gene": "TOY-CHK", "position": 10, "alt": alt}).json()
    assert m["effect"] in {"synonymous", "missense", "nonsense", "start_loss", "stop_loss"}
    assert client.post("/api/sequence/mutate", headers=h, json={"gene": "NOPE", "position": 1, "alt": "A"}).status_code == 400

    r = client.post("/api/sequence/lineage", headers=h, json={"cells": 100, "generations": 10})
    assert r.status_code == 200
    body = r.json()
    assert body["damaged"]["TOY-CHK_functional"][0] == 0.0
    assert body["model_bridge"]["damaged"]["checkpoint_strength"] == 0.0
    assert client.post("/api/sequence/lineage", headers=h, json={"damaged_genes": ["X"]}).status_code == 400
    ext = client.post("/api/sequence/lineage", headers=h, json={"cells": 50, "generations": 5, "damaged_genes": ["TOY-ESS"]})
    assert ext.status_code == 200 and ext.json()["damaged"]["mean_burden"][-1] is None
