"""Privacy scans distinguish source provenance from executable fixture data."""

import subprocess

import pytest

from scripts.check_public_task_ids import scan


def test_scan_flags_fixture_and_output_but_keeps_provenance_separate(tmp_path):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    (tmp_path / "fixture.py").write_text(
        '"""Origin of regression: DEMO-PRIVATE-001."""\n'
        '# Regression reference: DEMO-PRIVATE-001\n'
        'fixture = "DEMO-PRIVATE-001"  # DEMO-PRIVATE-001\n'
        'print("DEMO-PRIVATE-001")\n'
        'other = "DEMO-PRIVATE-001-SUFFIX"\n'
        'context = "示例DEMO-PRIVATE-001卡"\n'
    )
    (tmp_path / "fixture.ts").write_text(
        '// Regression reference: DEMO-PRIVATE-001\n'
        'const fixture = "DEMO-PRIVATE-001";\n'
    )
    (tmp_path / "binary.bin").write_bytes(b"\xff\xfe")
    subprocess.run(["git", "-C", str(tmp_path), "add", "."], check=True)
    (tmp_path / "ignored.py").write_text('fixture = "DEMO-PRIVATE-001"')
    files, findings = scan(tmp_path, {"DEMO-PRIVATE-001"})
    assert files == 2
    assert findings == [
        ("fixture.py", 1, "provenance"), ("fixture.py", 2, "provenance"),
        ("fixture.py", 3, "data"), ("fixture.py", 3, "provenance"),
        ("fixture.py", 4, "data"), ("fixture.py", 6, "data"),
        ("fixture.ts", 1, "data"),
        ("fixture.ts", 2, "data"),
    ]
    assert scan(tmp_path, set()) == (2, [])


@pytest.mark.parametrize("filename,source", [
    ("fixture.py", 'fixture = """\n// DEMO-PRIVATE-001\n"""\n'),
    ("fixture.ts", 'const fixture = `\n// DEMO-PRIVATE-001\n`;\n'),
    ("fixture.md", '// DEMO-PRIVATE-001\n'),
    ("fixture.sh", 'fixture="\n# DEMO-PRIVATE-001\n"\n'),
])
def test_comment_like_fixture_text_still_blocks(tmp_path, filename, source):
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    (tmp_path / filename).write_text(source)
    subprocess.run(["git", "-C", str(tmp_path), "add", "."], check=True)
    _, findings = scan(tmp_path, {"DEMO-PRIVATE-001"})
    assert len(findings) == 1
    assert findings[0][2] == "data"
