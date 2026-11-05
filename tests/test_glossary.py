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
                        "backup", "migrate", "json"}
    missing = sorted(commands - registered)
    assert not missing, "CLI subcommands missing from GLOSSARY.md: " + ", ".join(missing)


def test_no_compatibility_names_return():
    """One concept, one name: a rename moves every caller instead of keeping the old name alive."""
    root = Path(__file__).resolve().parents[1]
    cli = (root / "nawaban" / "cli.py").read_text(encoding="utf-8")
    assert "sub.choices[" not in cli and "aliases=" not in cli, "CLI subcommand alias registered"
    doubled = re.findall(r"add_argument\(\s*(\"--[^\"]+\",\s*\"--[^\"]+\")", cli)
    assert not doubled, "CLI flag alias registered: " + ", ".join(doubled)
    shims = [name for name in ("foreman_card.py", "foreman_liveness.py") if (root / name).exists()]
    assert not shims, "Retired import shim restored: " + ", ".join(shims)
    runtime = [*(root / "nawaban").rglob("*.py"), *(root / "nawaban").rglob("*.sh"),
               *(root / "scripts").iterdir()]
    retired = sorted(
        f"{path.relative_to(root)}: {name}"
        for path in runtime if path.is_file()
        for name in set(re.findall(r"\b(?:WORKOS|FOREMAN)_[A-Z_]+", path.read_text(encoding="utf-8")))
    )
    assert not retired, "Retired environment names still read: " + ", ".join(retired)
    verbs = sorted(
        f"{path.relative_to(root)}: {verb}"
        for path in runtime if path.is_file() and path.suffix in {".py", ".sh"}
        for verb in set(re.findall(r"\b(?:advance|letter-read) (?:--to|[A-Z{'\"]|\d)", path.read_text(encoding="utf-8")))
    )
    assert not verbs, "Retired CLI verbs still suggested: " + ", ".join(verbs)

