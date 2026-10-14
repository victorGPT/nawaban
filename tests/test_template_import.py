"""The historical task template keeps the section headings the Markdown importer reads."""

from pathlib import Path

import pytest

from nawaban import import_md

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "skills" / "nawaban-setup" / "TEMPLATE.md"


def test_importer_reads_decisions_and_timeline_from_the_template():
    pytest.importorskip("yaml", reason="Legacy Markdown parsing optionally uses PyYAML")
    # The first line is a note for this repository, not part of a copied task.
    text = TEMPLATE.read_text(encoding="utf-8").split("\n", 1)[1]
    fm, body = import_md.parse_card_text(text)
    decisions = import_md._decisions(body, text, fm["task_id"], "o", "TEMPLATE.md", 0)
    events, _ = import_md._events(fm, body, fm["task_id"], 0, "t", [])
    assert decisions, "the alignment section was not found"
    assert any("date owner | event" in e["body"] for e in events), "the timeline section was not found"
