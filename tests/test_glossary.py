"""Keep every current CLI subcommand registered in the bilingual glossary."""

from pathlib import Path
import json
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
    registered = set()
    for _, body in entries:
        for line in body.splitlines():
            if line.startswith("_Current identifiers_:"):
                registered.update(re.findall(r"`([^`\n]+)`", line))
    assert {"deps", "transition", "notify", "notifications", "notify-read"} <= commands
    missing = sorted(commands - registered)
    assert not missing, "CLI subcommands missing from CONTEXT.md: " + ", ".join(missing)


def test_every_english_ui_message_is_registered_in_glossary():
    root = Path(__file__).resolve().parents[1]
    glossary = (root / "CONTEXT.md").read_text(encoding="utf-8")
    registered = set(re.findall(r"^\*\*([^*\n]+)\*\*\(", glossary, re.MULTILINE))
    messages_section = glossary.split("### Interface messages\n", 1)[1].split("|---|---|---|\n", 1)[1]
    registered.update(
        match
        for match in re.findall(r"^\| ([^|]+) \| [^|]+ \| [^|]+ \|$", messages_section, re.MULTILINE)
    )
    directory = root / "nawaban" / "webui" / "src" / "i18n"
    english = json.loads((directory / "en.json").read_text(encoding="utf-8"))
    chinese = json.loads((directory / "zh-CN.json").read_text(encoding="utf-8"))
    assert english, "English UI messages must not be empty"
    assert english.keys() == chinese.keys(), "Locale keys must match"
    missing = sorted({value for value in english.values() if value not in registered})
    assert not missing, "English UI messages missing from CONTEXT.md: " + ", ".join(missing)
    for key, value in english.items():
        assert set(re.findall(r"\{\w+\}", value)) == set(re.findall(r"\{\w+\}", chinese[key])), key


def test_ui_source_has_no_hardcoded_chinese():
    source = Path(__file__).resolve().parents[1] / "nawaban" / "webui" / "src"
    offending = [
        str(path.relative_to(source))
        for path in source.rglob("*")
        if path.suffix in {".ts", ".tsx"} and re.search(r"[\u4e00-\u9fff]", path.read_text(encoding="utf-8"))
    ]
    assert not offending, "Chinese UI text must live in zh-CN.json: " + ", ".join(offending)
