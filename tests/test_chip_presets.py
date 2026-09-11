"""Tests for the named organ-chip presets (ROADMAP.md candidate feature #3).

Every preset must round-trip through ``chip_to_model_params`` without error,
must be meaningfully different from at least a few of the others (not a
fragile exact-value check), and ``list_chip_presets`` must expose the shape
the API depends on.
"""

from __future__ import annotations

import itertools

import pytest

from telomere_lab.adapters.chip import CHIP_PRESETS, ChipConditions, chip_to_model_params, list_chip_presets


def test_presets_cover_a_small_but_meaningful_set():
    assert 4 <= len(CHIP_PRESETS) <= 6


@pytest.mark.parametrize("name", list(CHIP_PRESETS))
def test_preset_round_trips_through_chip_to_model_params(name):
    preset = CHIP_PRESETS[name]
    derived = chip_to_model_params(preset.conditions)
    assert set(derived) == {"stress_level", "repair_rate", "cycles"}
    assert 0.0 <= derived["stress_level"] <= 1.0
    assert 0.0 <= derived["repair_rate"] <= 1.0
    assert derived["cycles"] >= 1


def test_presets_are_meaningfully_different_from_each_other():
    derived = {name: chip_to_model_params(preset.conditions) for name, preset in CHIP_PRESETS.items()}

    # At least a few pairs must differ by more than a trivial epsilon on
    # stress_level or repair_rate -- not hardcoding exact values, just spread.
    meaningful_pairs = 0
    for a, b in itertools.combinations(derived, 2):
        stress_gap = abs(derived[a]["stress_level"] - derived[b]["stress_level"])
        repair_gap = abs(derived[a]["repair_rate"] - derived[b]["repair_rate"])
        if stress_gap > 0.1 or repair_gap > 0.1:
            meaningful_pairs += 1
    assert meaningful_pairs >= 3

    # The two presets deliberately picked as opposite ends of the stress axis.
    assert derived["injury_stress_chip_like"]["stress_level"] > derived["static_well"]["stress_level"] + 0.2
    assert derived["lung_chip_like"]["repair_rate"] > derived["liver_chip_like"]["repair_rate"]


def test_list_chip_presets_shape():
    listed = list_chip_presets()
    assert set(listed) == set(CHIP_PRESETS)
    for name, entry in listed.items():
        assert set(entry) == {"conditions", "label", "description"}
        assert isinstance(entry["conditions"], dict)
        assert set(entry["conditions"]) == set(ChipConditions().to_dict())
        assert isinstance(entry["label"], str) and entry["label"]
        assert isinstance(entry["description"], str) and entry["description"]
