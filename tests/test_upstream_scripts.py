"""Collect inherited main-based assertions that pytest cannot discover directly."""

import ast
import importlib.util
from pathlib import Path
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = [
    path for path in sorted((ROOT / "tests/upstream").glob("test_*.py"))
    if any(isinstance(node, ast.FunctionDef) and node.name == "main"
           for node in ast.parse(path.read_text()).body)
]


@pytest.mark.parametrize("script", SCRIPTS, ids=lambda path: path.name)
def test_inherited_script(script):
    if script.name == "test_workos_import.py" and importlib.util.find_spec("yaml") is None:
        pytest.skip("Historical Markdown import requires optional PyYAML")
    result = subprocess.run([sys.executable, str(script)], cwd=Path.cwd(),
                            capture_output=True, text=True, timeout=180, check=False)
    assert result.returncode == 0, result.stdout + result.stderr
