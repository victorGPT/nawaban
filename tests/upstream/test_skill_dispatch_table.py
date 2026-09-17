#!/usr/bin/env python3
"""Validate bundled skills without requiring any global skill installation."""
from pathlib import Path
import importlib.util
import re
import unittest
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
SKILLS = ("nawaban", "foreman-pattern", "nawaban-wrapup")


@unittest.skipUnless(importlib.util.find_spec("yaml"), "Skill YAML parsing requires optional PyYAML")
def test_bundled_skill_frontmatter() -> None:
    import yaml
    for name in SKILLS:
        path = ROOT / "skills" / name / "SKILL.md"
        text = path.read_text(encoding="utf-8")
        assert text.startswith("---\n"), f"Missing frontmatter: {path}"
        metadata = yaml.safe_load(text.split("---", 2)[1])
        assert metadata["name"] == name, path
        assert isinstance(metadata.get("description"), str) and metadata["description"].strip(), path


def test_local_markdown_links() -> None:
    documents = sorted((ROOT / "skills").rglob("*.md"))
    documents += sorted((ROOT / "integrations").rglob("*.md"))
    missing = []
    links = 0
    for document in documents:
        text = document.read_text(encoding="utf-8")
        text = re.sub(r"```.*?```", "", text, flags=re.S)
        for raw in re.findall(r"\]\(([^)]+)\)", text):
            target = urlsplit(raw.strip().strip("<>"))
            if target.scheme or target.netloc or not target.path:
                continue
            links += 1
            path = (document.parent / unquote(target.path)).resolve()
            if not path.exists():
                missing.append(f"{document.relative_to(ROOT)} -> {raw}")
    assert links > 0, "No local links found in bundled documentation"
    assert not missing, "Missing local links:\n" + "\n".join(missing)


if __name__ == "__main__":
    if importlib.util.find_spec("yaml"):
        test_bundled_skill_frontmatter()
    else:
        print("SKIP: skill YAML parsing requires optional PyYAML")
    test_local_markdown_links()
    print("OK: all local Markdown links; no global skill dependency")
