import subprocess
from pathlib import Path


def test_no_zhuren_in_tracked_files():
    root = Path(__file__).resolve().parent.parent
    files = subprocess.run(["git", "ls-files"], cwd=root, capture_output=True, text=True, check=True).stdout.split("\n")
    hits = [f for f in files if f and f != "tests/test_naming.py" and (root / f).is_file() and "主人" in (root / f).read_text(errors="ignore")]
    assert hits == [], f"用「决策者」，不用「主人」：{hits}"
