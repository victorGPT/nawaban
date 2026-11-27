"""Keep every everyday board CLI verb registered in the bilingual glossary."""

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
EVERYDAY_GROUPS = {"看", "写", "派"}


def everyday_verbs():
    source = (ROOT / "board" / "src" / "cli.ts").read_text(encoding="utf-8")
    return {v for v, group in re.findall(r"^  '?([a-z-]+)'?: \{\s*\n?\s*group: '([^']+)'", source, re.M) if group in EVERYDAY_GROUPS}


def test_every_everyday_verb_is_registered_in_glossary():
    glossary = (ROOT / "GLOSSARY.md").read_text(encoding="utf-8")
    entries = re.findall(r"^\*\*([^*\n]+)\*\*\([^\n)]+\)\n(.*?)(?=^\*\*|^#{1,6} |\Z)", glossary, flags=re.MULTILINE | re.DOTALL)
    registered = set()
    for _, body in entries:
        for line in body.splitlines():
            if line.startswith("_Current identifiers_:"):
                registered.update(w.split()[0] for w in re.findall(r"`([^`\n]+)`", line))
    verbs = everyday_verbs()
    assert verbs == {"status", "show", "list", "okr", "create", "claim", "event", "close", "dispatch", "merge"}
    missing = sorted(verbs - registered)
    assert not missing, "CLI verbs missing from GLOSSARY.md: " + ", ".join(missing)
