#!/usr/bin/env python3
"""WORKOS-RECLAIM-STALE-001 自检 · 零依赖。

守四件事:
  ① **dry-run 真的不写** —— 自动改别人的卡,默认不写是唯一的安全前提。
  ② **CAS 挡得住陈旧决策** —— 判据在库外面算,算完到写进去之间那张卡可能已被别人重新
     claim;拿旧快照去写就会把活人正在干的卡踢成无主。这是唯一会毁数据的地方。
  ③ **owner 与 status 一起退** —— 只清 owner 会造出「匿名 + in_progress」的不可信锁行,
     guard 会 fail-closed 拦掉所有窗口的 Edit(判例 PR-SWEEP-STALE-001)。
  ④ **判据分档** —— 认得的 owner 看转录 mtime,不认得的退到「最后一条事件」,都不豁免。
"""

from __future__ import annotations

import sqlite3
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str((Path(__file__).resolve().parents[2])))

from nawaban import db, reclaim_stale  # noqa: E402

FAILED: list[str] = []


def case(name: str, fn) -> None:
    try:
        fn()
        print(f"  ✓ {name}")
    except Exception as e:  # noqa: BLE001
        FAILED.append(name)
        print(f"  ✗ {name}: {type(e).__name__}: {e}")


def _mk(tmp: Path, owner: str = "ac:deadbeef") -> Path:
    p = tmp / "workos.db"
    if p.exists():
        p.unlink()
    db.init_db(p)
    db.create_task(p, task_id="T-A-001", title="占着的卡", context="回收自检")
    con = sqlite3.connect(p)
    with con:
        con.execute("UPDATE tasks SET owner=?, status='in_progress'", (owner,))
    con.close()
    return p


def _status_owner(p: Path) -> tuple[str, str | None]:
    con = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
    try:
        return con.execute("SELECT status, owner FROM tasks WHERE id='T-A-001'").fetchone()
    finally:
        con.close()


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="reclaim-"))
    print(f"WORKOS-RECLAIM-STALE-001 自检 · {tmp}\n")

    def t_dry_run_writes_nothing():
        p = _mk(tmp)
        reclaim_stale.main(["--db", str(p)])          # 转录不存在 → 必判死
        assert _status_owner(p) == ("in_progress", "ac:deadbeef"), "dry-run 不许写"

    def t_apply_releases_owner_and_status():
        p = _mk(tmp)
        reclaim_stale.main(["--db", str(p), "--apply"])
        st, owner = _status_owner(p)
        assert owner is None, f"owner 没清:{owner}"
        assert st == "open", f"只清 owner 不退 status = 不可信锁行,guard 会锁死全board:{st}"

    def t_cas_rejects_stale_decision():
        """决策与写入之间卡被别人重新 claim —— 陈旧的回收必须打空,不能踢掉活人。"""
        p = _mk(tmp, owner="ac:old00000")
        con = sqlite3.connect(p)
        with con:                                     # 模拟:期间已被另一个窗口接手
            con.execute("UPDATE tasks SET owner='ac:new11111'")
        con.close()
        ok = db.reclaim_task(p, "T-A-001", expected_owner="ac:old00000", reason="陈旧决策")
        assert ok is False, "拿旧快照去写居然成功了 —— 活人的卡会被踢成无主"
        assert _status_owner(p) == ("in_progress", "ac:new11111"), "新 owner 被覆盖了"

    def t_cas_is_null_safe():
        """owner 可空,`= NULL` 恒不匹配 —— 用 IS 才比得对。"""
        p = _mk(tmp)
        con = sqlite3.connect(p)
        with con:
            con.execute("UPDATE tasks SET owner=NULL, status='open'")
        con.close()
        assert db.reclaim_task(p, "T-A-001", expected_owner=None, reason="NULL 快照") is True

    def t_judge_tiers():
        now = time.time()
        mt = {"aaaaaaaa": now - 1 * 3600, "bbbbbbbb": now - 99 * 3600}
        ok, why = reclaim_stale._judge("ac:aaaaaaaa", None, mt, now)
        assert not ok and "还在动" in why, why
        ok, why = reclaim_stale._judge("ac:bbbbbbbb", None, mt, now)
        assert ok and "阈值" in why, why
        ok, why = reclaim_stale._judge("ac:cccccccc", None, mt, now)
        assert ok and "找不到" in why, "转录不存在 = 窗口没了,必须判死"
        # 不认得的 owner:mtime 判据无效,退到最后一条事件
        ok, why = reclaim_stale._judge("grok:dagview", int(now - 2 * 86400), mt, now)
        assert not ok, f"2 天前还有事件不该判死:{why}"
        ok, why = reclaim_stale._judge("grok:dagview", int(now - 9 * 86400), mt, now)
        assert ok and "无活性信号" in why, why

    def t_live_owner_untouched():
        """转录还新鲜的卡一张都不许动 —— 误杀活人比留几张僵尸坏得多。"""
        p = _mk(tmp, owner="ac:live0000")
        proj = Path.home() / ".claude" / "projects" / "reclaim-selftest"
        proj.mkdir(parents=True, exist_ok=True)
        f = proj / "live0000-1111-2222-3333-444444444444.jsonl"
        try:
            f.write_text("{}\n")                       # mtime = 现在
            reclaim_stale.main(["--db", str(p), "--apply"])
            assert _status_owner(p) == ("in_progress", "ac:live0000"), "活着的窗口被回收了"
        finally:
            f.unlink(missing_ok=True)
            if not any(proj.iterdir()):
                proj.rmdir()

    def t_live_codex_without_transcript():
        p = _mk(tmp, owner="ac:01234567")
        response = subprocess.CompletedProcess([], 0, json.dumps({"result": {"agents": [{
            "agent": "codex", "name": "test-worker", "agent_status": "working",
            "agent_session": {"kind": "id", "value": "01234567-1111-2222-3333-444444444444"},
        }]}}), "")
        with patch.object(reclaim_stale, "_transcript_mtimes", return_value={}), \
                patch("subprocess.run", return_value=response):
            assert reclaim_stale.sweep(p, apply=True) == []
        assert _status_owner(p) == ("in_progress", "ac:01234567")

    def t_herdr_unavailable_is_not_dead():
        p = _mk(tmp)
        with patch.object(reclaim_stale, "_transcript_mtimes", return_value={}), \
                patch("subprocess.run", side_effect=FileNotFoundError("herdr")):
            assert reclaim_stale.sweep(p, apply=True) == []
        assert _status_owner(p) == ("in_progress", "ac:deadbeef")

    def t_codex_transcript_mtime():
        with tempfile.TemporaryDirectory() as home:
            sessions = Path(home) / ".codex/sessions/2026/09/09"
            sessions.mkdir(parents=True)
            transcript = sessions / "rollout-2026-09-09T12-00-00-01234567-1111-2222-3333-444444444444.jsonl"
            transcript.write_text("{}\n")
            with patch("os.path.expanduser", side_effect=lambda p: p.replace("~", home, 1)):
                mtimes = reclaim_stale._transcript_mtimes()
            assert mtimes["01234567"] == os.path.getmtime(transcript)

    def t_malformed_herdr_is_not_dead():
        p = _mk(tmp)
        for output in ("not-json", '{"result":{}}', '{"result":{"agents":null}}'):
            with patch.object(reclaim_stale, "_transcript_mtimes", return_value={}), \
                    patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, output, "")):
                assert reclaim_stale.sweep(p, apply=True) == []
            assert _status_owner(p) == ("in_progress", "ac:deadbeef")

    cases = [
        ("dry-run 一个字节都不写", t_dry_run_writes_nothing),
        ("回收:owner 与 status 一起退", t_apply_releases_owner_and_status),
        ("CAS:陈旧决策打空,不踢掉重新接手的人", t_cas_rejects_stale_decision),
        ("CAS:owner 为 NULL 时 IS 比得对", t_cas_is_null_safe),
        ("判据分档:认得的看 mtime,不认得的看最后事件", t_judge_tiers),
        ("活着的窗口一张不动", t_live_owner_untouched),
        ("live Codex without Claude transcript keeps its card", t_live_codex_without_transcript),
        ("unavailable Herdr is not proof of death", t_herdr_unavailable_is_not_dead),
        ("Codex rollout contributes session mtime", t_codex_transcript_mtime),
        ("malformed Herdr is not proof of death", t_malformed_herdr_is_not_dead),
    ]
    for name, fn in cases:
        with patch("subprocess.run", return_value=subprocess.CompletedProcess(
                [], 0, '{"result":{"agents":[]}}', "")):
            case(name, fn)

    print(f"\n{'FAILED: ' + ', '.join(FAILED) if FAILED else 'OK'} · "
          f"{len(cases) - len(FAILED)}/{len(cases)}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
