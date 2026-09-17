#!/usr/bin/env python3
"""WORKOS-GUARD-001 回归自检:STALE 对账器 · 零依赖。

跑法:python3 tests/upstream/test_workos_stale.py → 全绿 OK / 任一失败 exit 1。
覆盖:merge_sha ref+coord 事件留痕 · 有验收证据自动推 staging-verified(waiting_on=decision
+status_change 留痕)· 无证据不代推(验收闸/no_fabrication)· 幂等(重跑零重复写)·
open/claimed 异常形态只报不动 · PR ref 值格式容错("#N"/裸数字/URL)· dry-run 零写入。
gh 不进测试:reconcile() 收注入的 merged dict(fetch_merged 单独薄层)。
"""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
from pathlib import Path

FOREMAN = (Path(__file__).resolve().parents[2])  # 本文件所在树,worktree 里也测自己
sys.path.insert(0, str(FOREMAN))

from nawaban import db  # noqa: E402
from nawaban import stale_recon as recon  # noqa: E402

FAILED: list[str] = []


def case(name: str, fn) -> None:
    try:
        fn()
        print(f"  ✓ {name}")
    except Exception as e:  # noqa: BLE001
        FAILED.append(name)
        print(f"  ✗ {name}: {type(e).__name__}: {e}")


def fresh(tmp: Path) -> Path:
    d = Path(tempfile.mkdtemp(prefix="board-", dir=tmp))
    p = d / "workos.db"
    db.init_db(p)
    return p


def mk(p: Path, tid: str = "T-1", *, status: str = "in_progress",
       pr: str | None = "#2385", acceptance: bool = False) -> None:
    db.create_task(p, task_id=tid, title="测试卡:一行绿字")
    if status != "open":
        db.claim_task(p, tid, owner="w1", session_id=f"s-{tid}")
        if status == "in_progress":
            db.start_task(p, tid, owner="w1", session_id=f"s-{tid}")
    if pr:
        db.add_ref(p, tid, kind="pr", value=pr)
    if acceptance:
        db.add_ref(p, tid, kind="acceptance_run", value="test://run", note="夹具")


def snap(p: Path, tid: str = "T-1") -> dict:
    con = sqlite3.connect(p)
    status, waiting = con.execute(
        "SELECT status, waiting_on FROM tasks WHERE id=?", (tid,)).fetchone()
    refs = con.execute(
        "SELECT kind, count(*) FROM task_refs WHERE task_id=? GROUP BY kind", (tid,)).fetchall()
    events = con.execute(
        "SELECT kind, count(*) FROM task_events WHERE task_id=? GROUP BY kind", (tid,)).fetchall()
    con.close()
    return {"status": status, "waiting_on": waiting,
            "refs": dict(refs), "events": dict(events)}


MERGED = {2385: "abc123def"}


def run(p: Path, merged=None, dry_run: bool = False) -> dict:
    return recon.reconcile(p, MERGED if merged is None else merged,
                           author="recon-test", session_id="s-recon", dry_run=dry_run)


def main() -> int:  # noqa: PLR0915
    tmp = Path(tempfile.mkdtemp(prefix="workos-stale-test-"))
    print(f"[workos stale 对账器自检] tmp={tmp}")

    def t_record_no_evidence():
        p = fresh(tmp); mk(p)
        rep = run(p)
        assert rep["recorded"] == [("T-1", [2385])], rep
        assert rep["needs_evidence"] == [("T-1", [2385])] and not rep["advanced"], rep
        s = snap(p)
        assert s["status"] == "in_progress", "无验收证据不得代推(验收闸)"
        assert s["refs"].get("merge_sha") == 1 and s["events"].get("coord") == 1, s
        con = sqlite3.connect(p)
        body = con.execute(
            "SELECT body FROM task_events WHERE kind='coord'").fetchone()[0]
        author = con.execute(
            "SELECT author FROM task_events WHERE kind='coord'").fetchone()[0]
        con.close()
        assert "PR#2385" in body and "缺 acceptance_run" in body and author == "recon-test", body

    def t_advance_with_evidence():
        p = fresh(tmp); mk(p, acceptance=True)
        rep = run(p)
        assert rep["advanced"] == ["T-1"] and not rep["needs_evidence"], rep
        s = snap(p)
        assert s["status"] == "staging-verified" and s["waiting_on"] == "decision", s
        assert s["events"].get("status_change", 0) >= 3, "advance 须留 status_change 痕"

    def t_evidence_later_then_advance():
        p = fresh(tmp); mk(p)
        run(p)  # 第一轮:落痕,不推
        db.add_ref(p, "T-1", kind="acceptance_run", value="test://run2")
        rep = run(p)  # 第二轮:证据补齐 → 推
        assert rep["advanced"] == ["T-1"] and not rep["recorded"], rep
        assert snap(p)["status"] == "staging-verified"

    def t_idempotent():
        p = fresh(tmp); mk(p, acceptance=True)
        run(p)
        rep = run(p)  # 已 verified,出了 active 集
        assert not any(rep.values()), f"重跑应零动作:{rep}"
        s = snap(p)
        assert s["refs"].get("merge_sha") == 1 and s["events"].get("coord") == 1, \
            f"重跑不得重复写:{s}"

    def t_rerun_no_dup_event():
        p = fresh(tmp); mk(p)  # 无证据 · 卡留在 in_progress
        run(p); rep = run(p)
        assert not rep["recorded"] and rep["needs_evidence"], rep
        s = snap(p)
        assert s["events"].get("coord") == 1, f"coord 事件不得随重跑累积:{s}"

    def t_open_anomaly():
        p = fresh(tmp); mk(p, status="open")
        rep = run(p)
        assert rep["anomalies"] == [("T-1", "open", [2385])] and not rep["advanced"], rep
        assert snap(p)["status"] == "open", "异常形态不得自动动状态"

    def t_unmerged_untouched():
        p = fresh(tmp); mk(p, pr="#999")
        rep = run(p)
        assert not any(rep.values()), rep
        assert "merge_sha" not in snap(p)["refs"]

    def t_pr_value_formats():
        p = fresh(tmp)
        mk(p, "T-A", pr="2385")
        mk(p, "T-B", pr="https://github.com/x/y/pull/2385")
        rep = run(p)
        assert {t for t, _ in rep["recorded"]} == {"T-A", "T-B"}, rep

    def t_dry_run():
        p = fresh(tmp); mk(p, acceptance=True)
        rep = run(p, dry_run=True)
        assert rep["advanced"] == ["T-1"] and rep["recorded"], rep
        s = snap(p)
        assert s["status"] == "in_progress" and "merge_sha" not in s["refs"] \
            and "coord" not in s["events"], f"dry-run 必须零写入:{s}"

    def t_cli_default_dry():
        # 总监裁定 2026-08-12:真库 CUTOVER 前 import-only → CLI 缺省 dry-run,--write 显式
        import subprocess
        p = fresh(tmp)
        mk(p, acceptance=True)
        repo = p.parent / "repo"
        (repo / ".foreman").mkdir(parents=True)
        (repo / ".foreman" / "workos.db").symlink_to(p)
        bindir = p.parent / "bin"
        bindir.mkdir()
        fake_gh = bindir / "gh"
        fake_gh.write_text(
            '#!/bin/sh\necho \'[{"number":2385,"mergeCommit":{"oid":"abc123def"}}]\'\n',
            encoding="utf-8")
        fake_gh.chmod(0o755)
        env = dict(os.environ, PATH=f"{bindir}:{os.environ['PATH']}",
                   FOREMAN_OWNER="recon-test")
        cli = FOREMAN / "nawaban" / "stale_recon.py"
        r = subprocess.run([sys.executable, str(cli), "--repo", str(repo)],
                           capture_output=True, text=True, env=env)
        assert r.returncode == 0 and "dry-run" in r.stdout, r.stdout + r.stderr
        assert snap(p)["status"] == "in_progress", "缺省必须 dry-run(import-only 裁定)"
        r = subprocess.run([sys.executable, str(cli), "--repo", str(repo), "--write"],
                           capture_output=True, text=True, env=env)
        assert r.returncode == 0, r.stderr
        assert snap(p)["status"] == "staging-verified", "--write 才真落库"

    for name, fn in [
        ("落痕:merge_sha ref+coord 事件 · 无证据不代推", t_record_no_evidence),
        ("自动推:有 acceptance_run → staging-verified(decision)", t_advance_with_evidence),
        ("补证据后重跑即推", t_evidence_later_then_advance),
        ("幂等:推完重跑零动作零重复", t_idempotent),
        ("幂等:未推卡重跑 coord 不累积", t_rerun_no_dup_event),
        ("异常形态:open 卡带 merged PR 只报不动", t_open_anomaly),
        ("未 merged 的 PR 零动作", t_unmerged_untouched),
        ("PR ref 值格式容错(裸数字/URL)", t_pr_value_formats),
        ("dry-run 零写入", t_dry_run),
        ("CLI 缺省 dry-run · --write 显式(import-only 裁定)", t_cli_default_dry),
    ]:
        case(name, fn)

    if FAILED:
        print(f"\nFAILED({len(FAILED)}): {FAILED}")
        return 1
    print("\nOK · 10/10")
    return 0


if __name__ == "__main__":
    sys.exit(main())
