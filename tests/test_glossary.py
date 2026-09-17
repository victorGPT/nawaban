"""Keep every current CLI subcommand registered in the bilingual glossary."""

from pathlib import Path
import re


def test_every_cli_subcommand_is_registered_in_glossary():
    root = Path(__file__).resolve().parents[1]
    source = (root / "nawaban" / "cli.py").read_text(encoding="utf-8")
    glossary = (root / "CONTEXT.md").read_text(encoding="utf-8")
    commands = set(re.findall(r"\.add_parser\(\s*['\"]([^'\"]+)['\"]", source))
    entries = re.findall(
        r"^\*\*([^*\n]+)\*\*\([^\n)]+\)\n(.*?)(?=^\*\*|^#{1,6} |\Z)",
        glossary,
        flags=re.MULTILINE | re.DOTALL,
    )
    assert commands, "No argparse subcommands found in nawaban/cli.py"
    assert entries, "No bilingual glossary entries found in CONTEXT.md"
    registered = {term.casefold() for term, _ in entries}
    for _, body in entries:
        registered.update(re.findall(r"`([^`\n]+)`", body))
    missing = sorted(commands - registered)
    assert not missing, "CLI subcommands missing from CONTEXT.md: " + ", ".join(missing)
