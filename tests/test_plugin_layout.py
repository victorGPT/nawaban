"""The repository loads as a plugin: manifests parse and the skill names every tracker verb."""

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


def test_skill_names_every_tracker_verb():
    verbs = set(re.findall(r"\.add_parser\(\s*['\"]([^'\"]+)['\"]",
                           (ROOT / "nawaban" / "cli.py").read_text(encoding="utf-8")))
    skill = (ROOT / "skills" / "nawaban" / "SKILL.md").read_text(encoding="utf-8")
    assert verbs and not {v for v in verbs if not re.search(rf"\bnawaban {v}\b", skill)}
