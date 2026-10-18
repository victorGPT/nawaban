"""The repository loads as a plugin: manifests parse, no hooks are registered, and one skill describes the tracker."""

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MANIFESTS = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]


@pytest.mark.parametrize("manifest", MANIFESTS)
def test_manifest_has_identity(manifest):
    data = json.loads((ROOT / manifest).read_text(encoding="utf-8"))
    assert data["name"] == "nawaban"
    assert data["version"] and data["description"] and data["author"]["name"]


@pytest.mark.parametrize("manifest", MANIFESTS)
def test_manifest_registers_no_hooks(manifest):
    assert "hooks" not in json.loads((ROOT / manifest).read_text(encoding="utf-8"))


def test_no_hook_scripts_ship():
    # Both Claude Code and Codex discover hooks/hooks.json by convention.
    assert not (ROOT / "hooks").exists()


def test_plugin_ships_exactly_the_nawaban_skill():
    assert sorted(p.name for p in (ROOT / "skills").iterdir()) == ["nawaban"]


def test_skill_names_every_tracker_verb():
    verbs = set(re.findall(r"\.add_parser\(\s*['\"]([^'\"]+)['\"]",
                           (ROOT / "nawaban" / "tracker.py").read_text(encoding="utf-8")))
    skill = (ROOT / "skills" / "nawaban" / "SKILL.md").read_text(encoding="utf-8")
    assert verbs and not {v for v in verbs if not re.search(rf"\bnawaban {v}\b", skill)}
