#!/usr/bin/env python3
"""workos inbox budget regression 判据验证 · 构造四种局面各跑一次 lint。

判据全部**验能力不验快照**:自己造局,不依赖真库当时有多少条。
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "nawaban"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from nawaban import db  # noqa: E402

LINT = str(Path(__file__).resolve().parents[2] / "scripts/foreman_lint.py")
FAILED = []


def run_lint(repo: Path) -> tuple[int, str]:
    p = subprocess.run([sys.executable, LINT, "--repo", str(repo)],
                       capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


def mkrepo(tmp: Path, name: str) -> Path:
    repo = tmp / name
    (repo / ".foreman").mkdir(parents=True)
    db.init_db(repo / ".foreman" / "workos.db")
    return repo


def seed(repo: Path, n: int, kind: str = "accept", prefix: str = "T") -> None:
    p = repo / ".foreman" / "workos.db"
    for i in range(n):
        tid = f"{prefix}-{i:03d}"
        db.create_task(p, task_id=tid, title=f"{tid} 卡", context="budget 自检")
        db.raise_ask(p, kind=kind, question=f"{tid} 收下吗?",
                     evidence="真机实测证据", task_ids=[tid], raised_by="verify")


def case(name: str, fn) -> None:
    try:
        fn()
        print(f"  ✓ {name}")
    except AssertionError as e:
        FAILED.append(name)
        print(f"  ✗ {name}: {e}")


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="budget-"))
    print(f"BUDGET 判据验证 · {tmp}\n")

    def t_within():
        r = mkrepo(tmp, "within")
        seed(r, 5)
        code, out = run_lint(r)
        assert code == 0, f"预算内不该红:code={code}\n{out}"
        assert "收件箱" not in out, f"预算内不该提收件箱:\n{out}"

    def t_over_hard():
        r = mkrepo(tmp, "over")
        seed(r, 21)                      # > INBOX_FAIL(20)
        code, out = run_lint(r)
        assert code != 0, f"超硬顶必须非 0 退出:\n{out}"
        assert "超硬顶" in out, out
        assert "最旧一条停了" in out, f"必须点名最旧那条:\n{out}"

    def t_escape_hatch():
        """逃生口:同样 21 条,但多数是 authorize → 不计入硬顶,不红。"""
        r = mkrepo(tmp, "escape")
        seed(r, 6, kind="accept", prefix="A")
        seed(r, 15, kind="authorize", prefix="Z")
        code, out = run_lint(r)
        assert code == 0, f"authorize 不该计入硬顶:code={code}\n{out}"

    def t_warn_band():
        r = mkrepo(tmp, "warn")
        seed(r, 13)                      # > 12 且 <= 20
        code, out = run_lint(r)
        assert code == 0, f"警戒区只黄不红:code={code}\n{out}"
        assert "超警戒" in out, out

    def t_orphan_card():
        """staging-verified 且 waiting_on 为空 —— 干完了没说在等谁,必须红。"""
        r = mkrepo(tmp, "orphan")
        p = r / ".foreman" / "workos.db"
        import sqlite3
        db.create_task(p, task_id="ORPH-001", title="孤儿卡", context="自检")
        con = sqlite3.connect(p)
        with con:
            con.execute("UPDATE tasks SET status='staging-verified', waiting_on=NULL"
                        " WHERE id='ORPH-001'")
        con.close()
        code, out = run_lint(r)
        assert code != 0, f"孤儿卡必须红:\n{out}"
        assert "waiting_on 为空" in out, out

    def t_no_asks_table():
        """老库没建 asks 表 → 静默跳过,不炸。"""
        r = tmp / "nodb"
        (r / ".foreman").mkdir(parents=True)
        code, out = run_lint(r)
        assert code == 0, f"无库应静默跳过:\n{out}"

    for name, fn in [
        ("预算内不报警", t_within),
        ("超硬顶红 + 点名最旧", t_over_hard),
        ("逃生口:authorize 不计入硬顶", t_escape_hatch),
        ("警戒区只黄不红", t_warn_band),
        ("孤儿卡(verified 且 waiting_on 空)红", t_orphan_card),
        ("无库静默跳过", t_no_asks_table),
    ]:
        case(name, fn)

    shutil.rmtree(tmp, ignore_errors=True)
    if FAILED:
        print(f"\nFAILED({len(FAILED)}): {FAILED}")
        return 1
    print("\nOK · 6/6")
    return 0


if __name__ == "__main__":
    sys.exit(main())
