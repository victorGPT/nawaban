"""Keep every current CLI subcommand registered in the bilingual glossary."""

from pathlib import Path
import re


def test_every_cli_subcommand_is_registered_in_glossary():
    root = Path(__file__).resolve().parents[1]
    source = (root / "nawaban" / "cli.py").read_text(encoding="utf-8")
    glossary = (root / "GLOSSARY.md").read_text(encoding="utf-8")
    commands = set(re.findall(r"\.add_parser\(\s*['\"]([^'\"]+)['\"]", source))
    entries = re.findall(
        r"^\*\*([^*\n]+)\*\*\([^\n)]+\)\n(.*?)(?=^\*\*|^#{1,6} |\Z)",
        glossary,
        flags=re.MULTILINE | re.DOTALL,
    )
    assert commands, "No argparse subcommands found in nawaban/cli.py"
    assert entries, "No bilingual glossary entries found in GLOSSARY.md"
    registered = set()
    for _, body in entries:
        for line in body.splitlines():
            if line.startswith("_Current identifiers_:"):
                registered.update(re.findall(r"`([^`\n]+)`", line))
    assert commands == {"init", "create", "block", "claim", "close", "event", "show", "list",
                        "backup", "json", "index", "brief"}
    missing = sorted(commands - registered)
    assert not missing, "CLI subcommands missing from GLOSSARY.md: " + ", ".join(missing)

