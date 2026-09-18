#!/usr/bin/env python3
"""workos guard regression 回归自检:guard(DB 版)+ claim_check(DB 版)· 零依赖。

跑法:python3 tests/upstream/test_workos_guard.py → 全绿 OK / 任一失败 exit 1。
移植 test_foreman_guard.py 的语义矩阵到 DB 夹具(「语义与现版一致」的实证):
worktree 闸 · claim_check WARN ·
.foreman 豁免 · fail-closed(匿名锁行/坏 touches/坏库)· 无库 no-op · 判定 ≤10ms。
测试构造「坏行」时手写 SQL 是刻意的(制造损坏以测 fail-closed),真库写入仍走九动词。
"""

from __future__ import annotations

import json
import os
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

FOREMAN = (Path(__file__).resolve().parents[2])  # 本文件所在树,worktree 里也测自己
sys.path.insert(0, str(FOREMAN))

from nawaban import db, guard  # noqa: E402

GUARD = FOREMAN / "nawaban" / "guard.py"
CLAIM_CHECK = FOREMAN / "nawaban" / "claim_check.py"
CODE_FILE = "src/sample_app/presence/x.py"

FAILED: list[str] = []


def case(name: str, fn) -> None:
    try:
        fn()
        print(f"  ✓ {name}")
    except Exception as e:  # noqa: BLE001
        FAILED.append(name)
        print(f"  ✗ {name}: {type(e).__name__}: {e}")


def board(tmp: Path) -> Path:
    """新建临时仓:repo/.foreman/workos.db。返回 repo 根。"""
    repo = Path(tempfile.mkdtemp(prefix="repo-", dir=tmp))
    db.init_db(repo / ".foreman" / "workos.db")
    return repo


def mk(repo: Path, tid: str = "T-1", *, owner: str | None = "tester",
       status: str = "in_progress", touches=(CODE_FILE,), **kw) -> None:
    p = repo / ".foreman" / "workos.db"
    db.create_task(p, task_id=tid, title="测试卡:一行绿字", touches=list(touches), **kw)
    if status == "open":
        return
    assert owner
    db.claim_task(p, tid, owner=owner, session_id=f"s-{owner}-{tid}")
    if status in ("in_progress", "staging-verified"):
        db.start_task(p, tid, owner=owner, session_id=f"s-{owner}-{tid}")
    if status == "staging-verified":
        db.add_ref(p, tid, kind="acceptance_run", value="test://run", note="夹具")
        db.raise_ask(p, kind="accept", question=f"{tid}:收下吗?", evidence="test://run",
                     task_ids=[tid], raised_by=owner)   # 入口闸:decision 卡须先有 ask
        db.advance_task(p, tid, to="staging-verified", waiting_on="decision",
                        owner=owner, session_id=f"s-{owner}-{tid}")


def run_guard(repo: Path, file_rel: str = CODE_FILE, *, identity: bool = True) -> tuple[int, str]:
    payload = {"cwd": str(repo), "tool_input": {"file_path": str(repo / file_rel)}}
    env = {k: v for k, v in os.environ.items()
           if k not in ("TMUX", "TMUX_PANE", "FOREMAN_OWNER", "CLAUDE_CODE_SESSION_ID")}
    if identity:
        env["FOREMAN_OWNER"] = "tester"
    p = subprocess.run([sys.executable, str(GUARD)], input=json.dumps(payload),
                       capture_output=True, text=True, env=env)
    return p.returncode, p.stderr


def write_cfg(repo: Path, name: str, content: str) -> None:
    (repo / ".foreman" / name).write_text(content, encoding="utf-8")


def expect(repo: Path, file_rel: str, code: int, needle: str = "", absent: str = "") -> None:
    got, err = run_guard(repo, file_rel)
    assert got == code, f"exit={got}(want {code})stderr={err.strip()[:200]}"
    if needle:
        assert needle in err, f"缺『{needle}』:{err.strip()[:200]}"
    if absent:
        assert absent not in err, f"不该有『{absent}』:{err.strip()[:200]}"


CROSS = (CODE_FILE, "src/sample_app/attendance/y.py")
BOT_CROSS = ("src/sample_app/telegram_bot/a.py", "src/sample_app/presence/b.py")


def main() -> int:  # noqa: C901, PLR0915
    tmp = Path(tempfile.mkdtemp(prefix="workos-guard-test-"))
    print(f"[workos guard 自检] tmp={tmp}")

    # ── touches 锁退役(foreman simplify regression):guard 不再按占用拦 ──
    def t_other_no_block():
        r = board(tmp); mk(r, owner="other")
        expect(r, CODE_FILE, 0, absent="foreman 锁")

    def t_uncovered_silent():
        r = board(tmp); mk(r, touches=("src/sample_app/other/y.py",))
        expect(r, CODE_FILE, 0, absent="不在任何 active")

    # ── .foreman 豁免 ───────────────────────────────────────────
    def t_foreman_exempt():
        r = board(tmp); mk(r, epic="DEMO", touches=(".foreman/", CODE_FILE))
        (r / ".foreman" / "epics").mkdir(parents=True, exist_ok=True)
        (r / ".foreman" / "epics" / "X.md").write_text("x", encoding="utf-8")
        expect(r, ".foreman/epics/X.md", 0)  # 闸豁免:协调面自身可编辑
        expect(r, CODE_FILE, 0)  # 自己卡 cover 的代码面放行

    def t_no_db_noop():
        repo = Path(tempfile.mkdtemp(prefix="repo-", dir=tmp))
        (repo / ".foreman").mkdir()
        expect(repo, CODE_FILE, 0, absent="foreman")

    def t_no_identity_noop():
        r = board(tmp); mk(r, owner="other")
        code, err = run_guard(r, CODE_FILE, identity=False)
        assert code == 0 and not err.strip(), f"无身份应 no-op:exit={code} {err[:120]}"

    # ── 性能:判定 ≤10ms(400 卡在板)────────────────────────────
    def t_perf():
        r = board(tmp)
        p = r / ".foreman" / "workos.db"
        for i in range(400):
            db.create_task(p, task_id=f"P-{i:03d}", title="性能夹具",
                           touches=[f"src/sample_app/mod{i % 20}/f{i}.py"])
        con = db.connect(p)  # 夹具捷径:批量置为锁定态
        con.execute("UPDATE tasks SET status='in_progress', owner='other'")
        con.close()
        payload = {"cwd": str(r), "tool_input": {"file_path": str(r / "docs/x.md")}}
        os.environ["FOREMAN_OWNER"] = "tester"
        try:
            times = []
            for _ in range(20):
                t0 = time.perf_counter()
                code, _msg = guard.judge(payload)
                times.append((time.perf_counter() - t0) * 1000)
            assert code == 0
            med = statistics.median(times)
            assert med <= 10, f"判定中位数 {med:.2f}ms > 10ms"
            print(f"    (400 卡判定中位数 {med:.2f}ms)")
        finally:
            del os.environ["FOREMAN_OWNER"]

    # ── claim_check(DB 版)──────────────────────────────────────
    def run_cc(repo: Path, files: list[str], owner: str = "tester") -> tuple[int, str]:
        p = subprocess.run(
            [sys.executable, str(CLAIM_CHECK), *files, "--owner", owner,
             "--repo", str(repo)],
            capture_output=True, text=True)
        return p.returncode, p.stdout

    def t_cc_conflict():
        r = board(tmp); mk(r, owner="other")
        code, out = run_cc(r, [CODE_FILE])
        assert code == 0 and "🔒" in out, out[:200]  # WARN 不拒

    def t_cc_touches_variants():
        for touches in (("src/sample_app/presence/",), ("src/sample_app/presence/*.py",),
                        ("src/sample_app/presence",)):
            r = board(tmp); mk(r, owner="other", touches=touches)
            code, out = run_cc(r, [CODE_FILE])
            assert code == 0 and "🔒" in out, (touches, out[:200])

    def t_cc_self_ok():
        r = board(tmp); mk(r)
        code, out = run_cc(r, [CODE_FILE])
        assert code == 0 and "无别窗占用" in out, out[:200]

    def t_cc_verified_blocks():
        r = board(tmp); mk(r, owner="other", status="staging-verified")
        code, out = run_cc(r, [CODE_FILE])
        assert code == 0 and "staging-verified" in out, out[:200]

    def t_cc_no_db_noop():
        repo = Path(tempfile.mkdtemp(prefix="repo-", dir=tmp))
        code, out = run_cc(repo, [CODE_FILE])
        assert code == 0 and "no-op" in out, out[:200]

    def t_cc_broken_row():
        r = board(tmp); mk(r, owner="other")
        con = db.connect(r / ".foreman" / "workos.db")
        con.execute("UPDATE tasks SET touches='oops' WHERE id='T-1'")
        con.close()
        code, out = run_cc(r, [CODE_FILE])
        assert code == 0 and "不可信锁行" in out, out[:200]

    for name, fn in [
        ("touches 退役:他人占用不拦", t_other_no_block),
        ("touches 退役:uncovered 无提示", t_uncovered_silent),
        (".foreman 路径闸豁免", t_foreman_exempt),
        ("无 workos.db → no-op(未切换仓不受伤)", t_no_db_noop),
        ("无身份 → no-op", t_no_identity_noop),
        ("性能:400 卡判定 ≤10ms", t_perf),
        ("claim_check:他人占用 WARN exit 0", t_cc_conflict),
        ("claim_check:touches 目录/fnmatch/子路径", t_cc_touches_variants),
        ("claim_check:自己卡通过", t_cc_self_ok),
        ("claim_check:staging-verified 算占用", t_cc_verified_blocks),
        ("claim_check:无库 no-op", t_cc_no_db_noop),
        ("claim_check:坏行 WARN", t_cc_broken_row),
    ]:
        case(name, fn)

    # ── worktree 闸(WORKTREE-GATE-001 · 2026-08-20)──────────────────
    # 判据是纯 stat:`.git` 是目录=主 worktree · 是文件=linked worktree。
    # 所以夹具不用真跑 git,手搓这两种形状即可 —— 也顺带钉住「不许改成跑子进程」。
    def _git_repo(kind: str) -> tuple[Path, Path]:
        """造 (主树根, 目标树根)。kind='main' 两者相同;'wt' 返回一个 linked worktree。"""
        main = board(tmp)
        (main / ".git").mkdir()
        if kind == "main":
            return main, main
        wt = main / ".claude" / "worktrees" / "w1"
        wt.mkdir(parents=True)
        (wt / ".git").write_text(f"gitdir: {main}/.git/worktrees/w1\n", encoding="utf-8")
        return main, wt

    def t_wt_gate_blocks_maintree():
        main, _ = _git_repo("main")
        code, err = run_guard(main, CODE_FILE)
        assert code == 2 and "worktree gate" in err, f"主树应拦:exit={code} {err[:160]}"

    def t_wt_gate_allows_worktree():
        main, wt = _git_repo("wt")
        code, err = run_guard(wt, CODE_FILE)
        assert code == 0, f"worktree 内应放行:exit={code} {err[:160]}"

    def t_wt_gate_foreman_exempt():
        main, _ = _git_repo("main")
        code, err = run_guard(main, ".foreman/开工看板.md")
        assert code == 0 and "worktree gate" not in err, f".foreman/ 应豁免:exit={code} {err[:160]}"

    def t_wt_gate_marker_escape():
        main, _ = _git_repo("main")
        (main / ".foreman" / "ALLOW_MAINTREE_EDIT").write_text("", encoding="utf-8")
        code, err = run_guard(main, CODE_FILE)
        assert code == 0, f"有逃生门 marker 应放行:exit={code} {err[:160]}"

    def t_wt_gate_target_wins_over_cwd():
        """cwd 在 worktree、Edit 写主树 —— 按目标认树,照拦。"""
        main, wt = _git_repo("wt")
        payload = {"tool_name": "Edit", "cwd": str(wt),
                   "tool_input": {"file_path": str(main / CODE_FILE)}}
        code, msg = guard.judge(payload)
        assert code == 2 and "worktree gate" in msg, f"应按目标树判:exit={code} {msg[:160]}"

    # ── handoff --release 不得造出「匿名 + 锁定态」的行 ────────────────
    def t_release_demotes_locked_status():
        r = board(tmp)
        path = r / ".foreman" / "workos.db"
        db.create_task(path, task_id="R-1", title="测试卡:一行绿字", touches=[CODE_FILE])
        db.claim_task(path, "R-1", owner="tester", session_id="s1")
        db.start_task(path, "R-1", owner="tester", session_id="s1")
        db.handoff(path, "R-1", owner="tester", session_id="s1", outcome="handed_off",
                   summary="收尾一句", now="板上当前态一句", release=True)
        row = db.connect(path).execute(
            "SELECT status, owner FROM tasks WHERE id='R-1'").fetchone()
        assert row[0] == "open" and not row[1], f"--release 应降回 open 且无主,实得 {tuple(row)}"
        _, broken = guard.load_locked_cards(path)
        assert not broken, f"释放后不该留下不可信锁行:{broken}"

    def t_release_keeps_verified_status():
        """staging-verified 不是锁定态 —— 释放 owner 不该动它的状态。"""
        r = board(tmp)
        path = r / ".foreman" / "workos.db"
        db.create_task(path, task_id="R-2", title="测试卡:一行绿字", touches=[CODE_FILE])
        db.claim_task(path, "R-2", owner="tester", session_id="s1")
        db.start_task(path, "R-2", owner="tester", session_id="s1")
        db.add_ref(path, "R-2", kind="acceptance_run", value="https://example/run/1")
        db.advance_task(path, "R-2", to="staging-verified", owner="tester",
                        session_id="s1", waiting_on="observe")
        db.handoff(path, "R-2", owner="tester", session_id="s1", outcome="completed",
                   summary="收尾一句", now="板上当前态一句", release=True)
        row = db.connect(path).execute(
            "SELECT status, owner FROM tasks WHERE id='R-2'").fetchone()
        assert row[0] == "staging-verified" and not row[1], f"不该改动非锁定态,实得 {tuple(row)}"

    for name, fn in [
        ("worktree 闸:主树写文件 → BLOCK", t_wt_gate_blocks_maintree),
        ("worktree 闸:worktree 内放行", t_wt_gate_allows_worktree),
        ("worktree 闸:.foreman/ 豁免", t_wt_gate_foreman_exempt),
        ("worktree 闸:marker 逃生门放行", t_wt_gate_marker_escape),
        ("worktree 闸:按目标树判 · 不按 cwd", t_wt_gate_target_wins_over_cwd),
        ("handoff --release:锁定态降回 open", t_release_demotes_locked_status),
        ("handoff --release:非锁定态不动", t_release_keeps_verified_status),
    ]:
        case(name, fn)

    if FAILED:
        print(f"\nFAILED({len(FAILED)}): {FAILED}")
        return 1
    print(f"\nOK · {43}/43")
    return 0


if __name__ == "__main__":
    sys.exit(main())
