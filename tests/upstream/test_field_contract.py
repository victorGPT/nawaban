#!/usr/bin/env python3
"""字段合同(2026-09-07):success 写侧闸 · start --now 必填 · event --now 刷新。

判据验能力不验快照:自己造局。
"""
from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "nawaban"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from nawaban import db  # noqa: E402
from nawaban.task_content import success_problem  # noqa: E402

CLI = str(Path(__file__).resolve().parents[2] / "nawaban/cli.py")
FAILED = []


def case(name: str, fn) -> None:
    try:
        fn()
        print(f"  ✓ {name}")
    except AssertionError as e:
        FAILED.append(name)
        print(f"  ✗ {name}: {e}")


def cli(dbp: Path, *args: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "NAWABAN_OWNER": "ac:test", "CLAUDE_CODE_SESSION_ID": "s-test"}
    return subprocess.run([sys.executable, CLI, "--db", str(dbp), *args],
                          capture_output=True, text=True, env=env)


def main() -> int:
    print("FIELD CONTRACT 判据验证\n")

    def t_gate_reject():
        for s in ["manifest 里 employee_intake 带 boolean_format=digits",
                  "`revoke_role` 返 True 才写审计",
                  "EMPLOYEE_INTAKE_ENABLED=1 时端点 200"]:
            assert success_problem([s]) is not None, s

    def t_gate_allow():
        for s in ["面板切开关后真机能打开填表页",
                  "docs/integration/biz-report-开放API对接文档.md 存在且与新版一致",
                  "离职审批通过后,该员工在所有接入系统都登录不了",
                  "先写一条会红的测试,修完变绿"]:
            assert success_problem([s]) is None, success_problem([s])
        assert success_problem(None) is None and success_problem([]) is None

    def t_create_gated():
        p = Path(tempfile.mkdtemp(prefix="fc-")) / "workos.db"
        db.init_db(p)
        r = cli(p, "create", "T-001", "--title", "好标题", "--success", '["写 foo_bar 函数"]')
        assert r.returncode == 1 and "success" in r.stderr + r.stdout, r
        assert not sqlite3.connect(p).execute("select 1 from tasks where id='T-001'").fetchone()

    def t_start_now():
        p = Path(tempfile.mkdtemp(prefix="fc-")) / "workos.db"
        db.init_db(p)
        db.create_task(p, task_id="T-002", title="卡", context="x")
        db.claim_task(p, "T-002", owner="ac:test", session_id="s-test")
        r = cli(p, "start", "T-002")
        assert r.returncode != 0 and "--now" in r.stderr, "缺 --now 应拒"
        r = cli(p, "start", "T-002", "--now", "开工:先复现")
        assert r.returncode == 0, r.stderr
        now, st = sqlite3.connect(p).execute("select now,status from tasks where id='T-002'").fetchone()
        assert (now, st) == ("开工:先复现", "in_progress"), (now, st)

    def t_event_now():
        p = Path(tempfile.mkdtemp(prefix="fc-")) / "workos.db"
        db.init_db(p)
        db.create_task(p, task_id="T-003", title="卡", context="x")
        db.add_event(p, "T-003", kind="note", body="只记事", author="ac:test")
        assert sqlite3.connect(p).execute("select now from tasks where id='T-003'").fetchone()[0] is None
        db.add_event(p, "T-003", kind="note", body="推进", author="ac:test", now="下一步:联调")
        assert sqlite3.connect(p).execute("select now from tasks where id='T-003'").fetchone()[0] == "下一步:联调"
        try:
            db.add_event(p, "T-003", kind="note", body="x", author="ac:test", now="长" * 201)
            raise AssertionError("超长应拒")
        except db.NawabanError:
            pass

    def t_claim_warn():
        p = Path(tempfile.mkdtemp(prefix="fc-")) / "workos.db"
        db.init_db(p)
        db.create_task(p, task_id="T-004", title="卡", context="x", success=["写 foo_bar 函数"])
        r = cli(p, "claim", "T-004")
        assert r.returncode == 0, r.stderr
        assert "⚠" in r.stderr and "foo_bar" in r.stderr, "存量错位应 warn 不拦"

    case("success 闸拒:标识符 / 反引号 / flag", t_gate_reject)
    case("success 闸放:用户面现象 / 文件位置 / 红绿测试", t_gate_allow)
    case("create --success 过闸,失败不建卡", t_create_gated)
    case("start 缺 --now 拒 · 带 --now 落 now", t_start_now)
    case("event --now 刷新 now · 无 --now 不动 · 超长拒", t_event_now)
    case("claim 对存量错位 success 只 warn", t_claim_warn)
    print(f"\n{'FAILED: ' + ', '.join(FAILED) if FAILED else 'ALL PASS'}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
