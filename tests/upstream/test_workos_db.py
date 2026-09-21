#!/usr/bin/env python3
"""workos schema regression 回归自检 · 零依赖(不需 pytest)。

跑法:python3 tests/upstream/test_workos_db.py → 全绿 OK / 任一失败 exit 1。
覆盖(对照卡 success):DDL CHECK 生效 · CAS 并发恰一胜 · 身份从环境(CLI 层)·
events/decisions 物理 append-only · success 改动强制 decisions · 边幻觉闸+环检测 ·
handoff 三件套原子+artifact 保存闸 · 状态闸 · 时间戳为工具副作用。
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

FOREMAN = (Path(__file__).resolve().parents[2])  # 本文件所在树,worktree 里也测自己
sys.path.insert(0, str(FOREMAN))

from nawaban import db  # noqa: E402

CLI = FOREMAN / "nawaban" / "cli.py"

FAILED: list[str] = []


def case(name: str, fn) -> None:
    try:
        fn()
        print(f"  ✓ {name}")
    except Exception as e:  # noqa: BLE001
        FAILED.append(name)
        print(f"  ✗ {name}: {type(e).__name__}: {e}")


def fresh(tmp: Path) -> Path:
    p = tmp / "workos.db"
    if p.exists():
        p.unlink()
    db.init_db(p)
    return p


def _status(path: Path, tid: str) -> str:
    con = db.connect(path)
    try:
        return con.execute("SELECT status FROM tasks WHERE id=?", (tid,)).fetchone()[0]
    finally:
        con.close()


def mk(path: Path, tid: str = "T-XX-001", **kw) -> None:
    db.create_task(
        path,
        task_id=tid,
        title=kw.pop("title", "测试卡:做完后能看见一行绿字"),
        context=kw.pop("context", "测试建卡"),
        **kw,
    )


def main() -> int:  # noqa: C901, PLR0915
    tmp = Path(tempfile.mkdtemp(prefix="workos-test-"))
    print(f"[workos 自检] tmp={tmp}")

    # ── 1 · DDL CHECK ────────────────────────────────────────────
    def t_ddl_title():
        p = fresh(tmp)
        try:
            mk(p, title="长" * 81)
        except sqlite3.IntegrityError:
            return
        raise AssertionError("title 81 字未被 CHECK 拦")

    def t_ddl_now():
        p = fresh(tmp)
        mk(p)
        con = db.connect(p)
        try:
            con.execute("UPDATE tasks SET now=? WHERE id=?", ("长" * 201, "T-XX-001"))
        except sqlite3.IntegrityError:
            return
        finally:
            con.close()
        raise AssertionError("now 201 字未被 CHECK 拦")

    def t_ddl_event_body():
        p = fresh(tmp)
        mk(p)
        try:
            db.add_event(p, "T-XX-001", kind="note", body="长" * 2049,
                         author="tester", session_id="s1")
        except sqlite3.IntegrityError:
            return
        raise AssertionError("event body 2049 字未被 CHECK 拦")

    def t_ddl_status_enum():
        p = fresh(tmp)
        mk(p)
        con = db.connect(p)
        try:
            con.execute("UPDATE tasks SET status='weird' WHERE id=?", ("T-XX-001",))
        except sqlite3.IntegrityError:
            return
        finally:
            con.close()
        raise AssertionError("非法 status 未被 CHECK 拦")

    def t_ddl_edge_enum():
        p = fresh(tmp)
        mk(p, tid="T-A-001")
        mk(p, tid="T-B-001")
        con = db.connect(p)
        try:
            con.execute(
                "INSERT INTO task_edges(src,dst,kind,created_at) VALUES(?,?,?,?)",
                ("T-A-001", "T-B-001", "relates", 1),
            )
        except sqlite3.IntegrityError:
            return
        finally:
            con.close()
        raise AssertionError("relates 未被 CHECK 拦")

    # ── 2 · CAS 并发 claim 恰一胜 ────────────────────────────────
    def t_cas_claim():
        p = fresh(tmp)
        mk(p)
        wins: list[str] = []
        lock = threading.Lock()

        def worker(i: int) -> None:
            ok = db.claim_task(p, "T-XX-001", owner=f"w{i}", session_id=f"s{i}")
            if ok:
                with lock:
                    wins.append(f"w{i}")

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        assert len(wins) == 1, f"8 claimer 应恰 1 胜,实得 {wins}"
        con = db.connect(p)
        row = con.execute("SELECT owner,status FROM tasks WHERE id='T-XX-001'").fetchone()
        srow = con.execute("SELECT count(*) FROM task_sessions WHERE task_id='T-XX-001'").fetchone()
        con.close()
        assert row[0] == wins[0] and row[1] == "claimed", row
        assert srow[0] == 1, "胜者应恰有 1 行 session 履历"

    # ── 3 · events/decisions 物理 append-only ────────────────────
    def t_same_session_reclaim():
        p = fresh(tmp)
        mk(p)
        assert db.claim_task(p, "T-XX-001", owner="w1", session_id="s1")
        db.handoff(p, "T-XX-001", owner="w1", session_id="s1", outcome="blocked",
                   summary="waiting for dependency", body="detailed handoff",
                   now="blocked", release=True)
        assert db.claim_task(p, "T-XX-001", owner="w1", session_id="s1")
        assert not db.claim_task(p, "T-XX-001", owner="w2", session_id="s2")
        con = db.connect(p)
        try:
            row = con.execute("SELECT owner,ended_at,outcome,summary FROM task_sessions"
                              " WHERE task_id='T-XX-001'").fetchone()
            assert tuple(row) == ("w1", None, None, None), tuple(row)
            note = con.execute("SELECT note FROM task_sessions WHERE task_id='T-XX-001'").fetchone()[0]
            assert "waiting for dependency" in (note or ""), note
            assert con.execute("SELECT count(*) FROM task_events WHERE kind='handoff'"
                               " AND body='detailed handoff'").fetchone()[0] == 1
        finally:
            con.close()
        assert db.open_claims(p, session_id="s1") == [("T-XX-001", 0)]
        assert db.open_claim_rows(p, session_id="s1")[0]["events"] == 0
        db.add_event(p, "T-XX-001", kind="note", body="new work", author="w1", session_id="s1")
        assert db.open_claims(p, session_id="s1") == [("T-XX-001", 1)]
        db.handoff(p, "T-XX-001", owner="w1", session_id="s1", outcome="handed_off",
                   summary="resumed successfully", now="ready", release=True)
        assert db.claim_task(p, "T-XX-001", owner="w1", session_id="s1")
        assert db.reclaim_task(p, "T-XX-001", expected_owner="w1", reason="exited")
        assert db.claim_task(p, "T-XX-001", owner="w1", session_id="s1")
        con = db.connect(p)
        try:
            note = con.execute("SELECT note FROM task_sessions WHERE task_id='T-XX-001'").fetchone()[0]
            attempts = [json.loads(line.removeprefix("Resumed attempt: ")) for line in note.splitlines()]
            assert len(attempts) == 3 and attempts[-1]["ended_at"] is None, attempts
        finally:
            con.close()

    def t_append_only():
        p = fresh(tmp)
        mk(p)
        db.add_event(p, "T-XX-001", kind="note", body="x", author="a", session_id="s")
        con = db.connect(p)
        for sql in (
            "UPDATE task_events SET body='hack' WHERE id=1",
            "DELETE FROM task_events WHERE id=1",
        ):
            try:
                con.execute(sql)
                con.close()
                raise AssertionError(f"未拦:{sql}")
            except sqlite3.DatabaseError as e:
                assert "append-only" in str(e), e
        con.close()

    # ── 4 · success 改动强制 decisions 留痕 ──────────────────────
    def t_success_needs_decision():
        p = fresh(tmp)
        mk(p, success=["旧判据"])
        db.decide(p, "T-XX-001", question="判据要不要加一条?", verdict="加",
                  rejected=[{"option": "不加", "reason": "覆盖不足"}],
                  decided_by="agent:tester",
                  set_success=["旧判据", "新判据"])
        con = db.connect(p)
        s = json.loads(con.execute("SELECT success FROM tasks WHERE id='T-XX-001'").fetchone()[0])
        n = con.execute("SELECT count(*) FROM task_decisions WHERE task_id='T-XX-001'").fetchone()[0]
        con.close()
        assert s == ["旧判据", "新判据"] and n == 1
        assert not hasattr(db, "update_success"), "不得存在绕过 decisions 的 success 写路径"

    def t_decide_user_guard():
        p = fresh(tmp)
        mk(p)
        try:
            db.decide(p, "T-XX-001", question="q", verdict="v", decided_by="user")
        except db.NawabanError:
            return
        raise AssertionError("decided_by=user 不经拍板通道应被拒(no_fabrication)")

    # ── 5 · 边:幻觉闸 + 环检测 ─────────────────────────────────
    def t_edge_dst_exists():
        p = fresh(tmp)
        mk(p)
        try:
            db.link_tasks(p, "T-XX-001", "T-GHOST-999", kind="depends_on", created_by="t")
        except db.NawabanError:
            return
        raise AssertionError("指向不存在卡的边未被拒")

    def t_edge_cycle():
        p = fresh(tmp)
        mk(p, tid="T-A-001")
        mk(p, tid="T-B-001")
        db.link_tasks(p, "T-A-001", "T-B-001", kind="depends_on", created_by="t")
        try:
            db.link_tasks(p, "T-B-001", "T-A-001", kind="depends_on", created_by="t")
        except db.NawabanError:
            return
        raise AssertionError("depends_on 环未被拒")

    def t_create_split_from_edge():
        p = fresh(tmp)
        mk(p, tid="T-PARENT-001")
        mk(p, tid="T-CHILD-001", split_from="T-PARENT-001")
        con = db.connect(p)
        try:
            edge = con.execute(
                "SELECT src,dst,kind,note FROM task_edges"
                " WHERE src=? AND dst=? AND kind='split_from'",
                ("T-CHILD-001", "T-PARENT-001"),
            ).fetchone()
        finally:
            con.close()
        assert tuple(edge) == ("T-CHILD-001", "T-PARENT-001", "split_from", "拆卡来源")

    def t_create_split_from_epic():
        p = fresh(tmp)
        mk(p, tid="T-PARENT-001", epic="EPIC-P", constraints=["父卡约束"])
        mk(p, tid="T-INHERIT-001", split_from="T-PARENT-001")
        mk(p, tid="T-EXPLICIT-001", split_from="T-PARENT-001", epic="EPIC-C")
        con = db.connect(p)
        try:
            rows = con.execute(
                "SELECT id,epic,constraints_ FROM tasks WHERE id IN (?,?) ORDER BY id",
                ("T-INHERIT-001", "T-EXPLICIT-001"),
            ).fetchall()
        finally:
            con.close()
        assert [tuple(row) for row in rows] == [
            ("T-EXPLICIT-001", "EPIC-C", None),
            ("T-INHERIT-001", "EPIC-P", None),
        ]

    def t_create_split_from_missing_parent():
        p = fresh(tmp)
        try:
            mk(p, tid="T-CHILD-001", split_from="T-GHOST-999")
        except db.NawabanError:
            pass
        else:
            raise AssertionError("父卡不存在时 create 应失败")
        con = db.connect(p)
        try:
            child = con.execute(
                "SELECT 1 FROM tasks WHERE id=?", ("T-CHILD-001",)
            ).fetchone()
        finally:
            con.close()
        assert child is None, "父卡不存在时不得建子卡"

    # ── 6 · handoff 三件套原子 + artifact 保存闸 ─────────────────
    def t_handoff_artifact_gate():
        p = fresh(tmp)
        mk(p)
        db.claim_task(p, "T-XX-001", owner="w1", session_id="s1")
        try:
            db.handoff(p, "T-XX-001", owner="w1", session_id="s1",
                       outcome="handed_off", summary="干了一半",
                       now="进行中:剩导入器", artifacts=[str(tmp / "不存在.md")])
        except db.NawabanError:
            pass
        else:
            raise AssertionError("artifact 缺失未拒收尾")
        con = db.connect(p)
        row = con.execute(
            "SELECT ended_at,outcome FROM task_sessions WHERE task_id='T-XX-001'").fetchone()
        ev = con.execute(
            "SELECT count(*) FROM task_events WHERE task_id='T-XX-001' AND kind='handoff'"
        ).fetchone()[0]
        con.close()
        assert row[0] is None and row[1] is None and ev == 0, "拒收尾后三件套必须零写入(原子)"

        art = tmp / "报告.md"
        art.write_text("ok", encoding="utf-8")
        db.handoff(p, "T-XX-001", owner="w1", session_id="s1",
                   outcome="handed_off", summary="干了一半",
                   now="进行中:剩导入器", artifacts=[str(art)])
        con = db.connect(p)
        row = con.execute(
            "SELECT ended_at,outcome,summary FROM task_sessions WHERE task_id='T-XX-001'").fetchone()
        now_val = con.execute("SELECT now FROM tasks WHERE id='T-XX-001'").fetchone()[0]
        ev = con.execute(
            "SELECT count(*) FROM task_events WHERE task_id='T-XX-001' AND kind='handoff'"
        ).fetchone()[0]
        ref = con.execute(
            "SELECT count(*) FROM task_refs WHERE task_id='T-XX-001' AND kind='artifact'"
        ).fetchone()[0]
        con.close()
        assert row[0] and row[1] == "handed_off" and now_val.startswith("进行中") and ev == 1 and ref == 1

    # ── 7 · 状态闸 + 时间戳副作用 ────────────────────────────────
    def t_status_gates():
        p = fresh(tmp)
        mk(p)
        db.claim_task(p, "T-XX-001", owner="w1", session_id="s1")
        db.start_task(p, "T-XX-001", owner="w1", session_id="s1")
        try:
            db.advance_task(p, "T-XX-001", to="staging-verified", owner="w1", session_id="s1")
        except db.NawabanError:
            pass
        else:
            raise AssertionError("无 waiting_on 翻 verified 未被拦")
        try:
            db.advance_task(p, "T-XX-001", to="staging-verified", waiting_on="decision",
                            owner="w1", session_id="s1")
        except db.NawabanError:
            pass
        else:
            raise AssertionError("无 acceptance ref 翻 verified 未被拦")
        db.add_ref(p, "T-XX-001", kind="acceptance_run", value="test://run/1", note="自检")
        db.raise_ask(p, kind="accept", question="T-XX-001:收下吗?", evidence="test://run/1",
                     task_ids=["T-XX-001"], raised_by="w1")  # 入口闸:decision 卡须先有 ask
        db.advance_task(p, "T-XX-001", to="staging-verified", waiting_on="decision",
                        owner="w1", session_id="s1")
        # done 闸②:waiting_on=decision 而无 user 拍板行 → 拒(agent 不得静默自批)
        try:
            db.advance_task(p, "T-XX-001", to="done", owner="w1", session_id="s1")
        except db.NawabanError:
            pass
        else:
            raise AssertionError("无 user 拍板行的 done 未被拦")
        os.environ["WORKOS_DECISION_CHANNEL"] = "chat"
        # 拍板须**严格晚于**锚点秒(workos compile gate regression 修掉 `>=` 的同秒 fail-open:
        # created_at 秒级,同秒先后不可分辨 → 不认)。真人拍板要先说话,真机天然满足;
        # 这里是机器速度把三步压进同一秒,睡过秒界即可,断言与契约语义不变。
        time.sleep(1.1)
        try:
            db.decide(p, "T-XX-001", question="验收过不过?", verdict="过(用户原话:done)",
                      decided_by="user")
        finally:
            del os.environ["WORKOS_DECISION_CHANNEL"]
        db.advance_task(p, "T-XX-001", to="done", owner="w1", session_id="s1")
        con = db.connect(p)
        row = con.execute(
            "SELECT status,created_at,started_at,completed_at FROM tasks WHERE id='T-XX-001'"
        ).fetchone()
        ev = con.execute(
            "SELECT count(*) FROM task_events WHERE task_id='T-XX-001' AND kind='status_change'"
        ).fetchone()[0]
        con.close()
        assert row[0] == "done" and all(row[1:]), f"时间戳应全为工具副作用:{row}"
        assert ev >= 3, "每次转移应自动记 status_change 事件"

    # ── 8 · CLI 层:身份只从环境来 ───────────────────────────────
    def t_cli_identity():
        p = fresh(tmp)
        mk(p)
        env = {k: v for k, v in os.environ.items()
               if k not in ("CLAUDE_CODE_SESSION_ID", "FOREMAN_OWNER")}
        env["WORKOS_DB"] = str(p)
        r = subprocess.run([sys.executable, str(CLI), "claim", "T-XX-001"],
                           capture_output=True, text=True, env=env)
        assert r.returncode != 0, "无环境身份的 claim 应失败"
        env["CLAUDE_CODE_SESSION_ID"] = "deadbeef-0000-0000-0000-000000000000"
        r = subprocess.run([sys.executable, str(CLI), "claim", "T-XX-001"],
                           capture_output=True, text=True, env=env)
        assert r.returncode == 0, r.stderr
        con = db.connect(p)
        row = con.execute("SELECT owner FROM tasks WHERE id='T-XX-001'").fetchone()
        con.close()
        assert row[0] == "ac:deadbeef-0000-0000-0000-000000000000", f"owner 应从 session-id 派生,实得 {row[0]}"
        # claim 子命令不存在 --owner 旗标(身份不可伪造)
        r = subprocess.run([sys.executable, str(CLI), "claim", "T-XX-001", "--owner", "hacker"],
                           capture_output=True, text=True, env=env)
        assert r.returncode != 0, "claim 不得接受 --owner 参数"

    # ── 9 · 不静默建库:动词对不存在的库必须响亮失败 ─────────────
    def t_no_silent_init():
        bogus = tmp / "不存在的目录" / "workos.db"
        env = dict(os.environ)
        env["WORKOS_DB"] = str(bogus)
        env["CLAUDE_CODE_SESSION_ID"] = "deadbeef-0000-0000-0000-000000000000"
        r = subprocess.run([sys.executable, str(CLI), "backup"],
                           capture_output=True, text=True, env=env)
        assert r.returncode != 0, "对不存在的库 backup 应失败(空库备份永绿=错误的成功)"
        assert not bogus.exists(), "失败路径不得留下静默新建的空库"
        r = subprocess.run([sys.executable, str(CLI), "init"],
                           capture_output=True, text=True, env=env)
        assert r.returncode == 0, r.stderr
        assert bogus.exists(), "显式 init 应建库"

    # ── 12 · 直通 done(foreman simplify regression):merge_sha 即归档;verified 路不要 acceptance 正文 ──
    def t_direct_done():
        adv = dict(owner="ac:tester", session_id="s1")
        p = fresh(tmp)
        mk(p)
        db.claim_task(p, "T-XX-001", **adv)
        db.start_task(p, "T-XX-001", **adv)
        try:
            db.advance_task(p, "T-XX-001", to="done", **adv)
            raise AssertionError("无 merge_sha 直通 done 该拒")
        except db.NawabanError as e:
            assert "merge_sha" in str(e), str(e)
        db.add_ref(p, "T-XX-001", kind="merge_sha", value="abc1234")
        db.advance_task(p, "T-XX-001", to="done", **adv)
        assert _status(p, "T-XX-001") == "done"
        con = db.connect(p)
        try:
            assert con.execute("SELECT completed_at FROM tasks WHERE id='T-XX-001'").fetchone()[0]
        finally:
            con.close()

        # verified 路(prod/observe/external):acceptance_run 仍必需,acceptance 正文不再强制
        p = fresh(tmp)
        mk(p)
        db.claim_task(p, "T-XX-001", **adv)
        db.start_task(p, "T-XX-001", **adv)
        try:
            db.advance_task(p, "T-XX-001", to="staging-verified", waiting_on="prod", **adv)
            raise AssertionError("无 acceptance_run 翻 verified 该拒")
        except db.NawabanError:
            pass
        db.add_ref(p, "T-XX-001", kind="acceptance_run", value="https://x/run")
        db.advance_task(p, "T-XX-001", to="staging-verified", waiting_on="prod", **adv)
        db.advance_task(p, "T-XX-001", to="done", **adv)
        assert _status(p, "T-XX-001") == "done"

        # 打回:理由必填 · done→in_progress · completed_at 清空 · 留痕
        try:
            db.reopen_task(p, "T-XX-001", reason="   ", **adv)
            raise AssertionError("空理由该拒")
        except db.NawabanError:
            pass
        db.reopen_task(p, "T-XX-001", reason="prod 那条证据是 staging 的", **adv)
        con = db.connect(p)
        try:
            r = con.execute("SELECT status, completed_at FROM tasks WHERE id=?",
                            ("T-XX-001",)).fetchone()
            assert r[0] == "in_progress" and r[1] is None, tuple(r)
        finally:
            con.close()

    # ── 11 · meta:epic 只补空不改写,且必留痕 ──
    def t_meta_fill_if_empty():
        p = fresh(tmp)
        mk(p)
        for kw in ({"epic": "   "},           # 全空白:等于没给
                   {"grill": "退役列"},        # 白名单外(foreman simplify regression 退役)
                   {"owner": "不是 meta 列"}):  # 白名单外
            try:
                db.set_meta(p, "T-XX-001", fields=kw, author="ac:tester")
            except db.NawabanError:
                continue
            raise AssertionError(f"应拒:{kw}")
        # epic:补空可以,'n/a' 视同空,已有真值拒;必留痕
        db.set_meta(p, "T-XX-001", fields={"epic": "EPIC-X"}, author="ac:tester", session_id="s1")
        con = db.connect(p)
        try:
            n = con.execute(
                "SELECT count(*) FROM task_events WHERE task_id=? AND kind='note'"
                " AND body LIKE 'meta 补填:%'", ("T-XX-001",)).fetchone()[0]
            assert n == 1, f"补填必须落一条 note 留痕,实得 {n}"
        finally:
            con.close()
        mk(p, tid="T-NA-001", epic="n/a")
        db.set_meta(p, "T-NA-001", fields={"epic": "EPIC-X"}, author="ac:tester")
        for tid in ("T-XX-001", "T-NA-001"):
            try:
                db.set_meta(p, tid, fields={"epic": "EPIC-Y"}, author="ac:tester")
            except db.NawabanError:
                continue
            raise AssertionError(f"epic 已有真值应拒改写:{tid}")

    def remodule_cli(p, tids, *args):
        env = dict(os.environ, FOREMAN_OWNER="ac:organizer")
        env.pop("CLAUDE_CODE_SESSION_ID", None)
        return subprocess.run([sys.executable, str(CLI), "--db", str(p),
                               "remodule", *tids, *args],
                              capture_output=True, text=True, env=env)

    def t_remodule_changes_and_skips():
        for old_values in (("BOARD-UI",), ("BOARD-UI", "", None, "看板界面")):
            p = fresh(tmp)
            tids = [f"T-{i}" for i in range(len(old_values))]
            for tid, old in zip(tids, old_values):
                mk(p, tid=tid, epic=old)
            db.claim_task(p, tids[0], owner="ac:builder", session_id="builder")
            db.start_task(p, tids[0], owner="ac:builder", session_id="builder", now="继续施工")
            con = db.connect(p)
            try:
                before = con.execute("SELECT id, status, owner, now FROM tasks ORDER BY id").fetchall()
                r = remodule_cli(p, tids, "--epic", "看板界面", "--reason", "统一中文短名")
                assert r.returncode == 0, r.stderr
                skipped = old_values.count("看板界面")
                assert f"改了 {len(tids) - skipped} 张" in r.stdout, r.stdout
                assert f"跳过 {skipped} 张" in r.stdout, r.stdout
                assert len(r.stdout.splitlines()) == 1, r.stdout
                assert con.execute("SELECT id, status, owner, now FROM tasks ORDER BY id").fetchall() == before
                for tid, old in zip(tids, old_values):
                    assert con.execute("SELECT epic FROM tasks WHERE id=?", (tid,)).fetchone()[0] == "看板界面"
                    notes = con.execute(
                        "SELECT body, author FROM task_events WHERE task_id=? AND kind='note'", (tid,)
                    ).fetchall()
                    expected = [] if old == "看板界面" else [
                        (f"模块 {old or '(空)'} → 看板界面 · 统一中文短名", "ac:organizer")]
                    assert notes == expected, notes
                events = con.execute("SELECT * FROM task_events").fetchall()
                r = remodule_cli(p, tids, "--epic", "看板界面", "--reason", "重复整理")
                assert r.returncode == 0, r.stderr
                assert "改了 0 张" in r.stdout and f"跳过 {len(tids)} 张" in r.stdout, r.stdout
                assert con.execute("SELECT * FROM task_events").fetchall() == events
            finally:
                con.close()

    def t_remodule_missing_rolls_back():
        p = fresh(tmp)
        mk(p, epic="BOARD-UI")
        con = db.connect(p)
        try:
            tasks = con.execute("SELECT * FROM tasks").fetchall()
            events = con.execute("SELECT * FROM task_events").fetchall()
            r = remodule_cli(p, ["T-XX-001", "T-MISSING"], "--epic", "看板界面", "--reason", "统一中文短名")
            assert r.returncode == 1, r.stderr
            assert "卡不存在:T-MISSING" in r.stderr, r.stderr
            assert con.execute("SELECT * FROM tasks").fetchall() == tasks
            assert con.execute("SELECT * FROM task_events").fetchall() == events
        finally:
            con.close()

    def t_remodule_invalid_input():
        p = fresh(tmp)
        mk(p, epic="BOARD-UI")
        con = db.connect(p)
        try:
            tasks = con.execute("SELECT * FROM tasks").fetchall()
            events = con.execute("SELECT * FROM task_events").fetchall()
            for epic, error in (("", "不能为空"), (" \t", "不能为空"),
                                ("看板·界面", "不能包含"), ("看板(界面)", "不能包含"),
                                ("看板（界面）", "不能包含"), ("n/a待分组", "不能以"),
                                (" N/A待分组", "不能以"), ("无档待分组", "不能以"),
                                ("名" * 21, "20")):
                r = remodule_cli(p, ["T-XX-001"], "--epic", epic, "--reason", "统一中文短名")
                assert r.returncode == 1 and error in r.stderr, (epic, r.stderr)
                assert con.execute("SELECT * FROM tasks").fetchall() == tasks
                assert con.execute("SELECT * FROM task_events").fetchall() == events
            r = remodule_cli(p, ["T-XX-001"], "--epic", "看板界面")
            assert r.returncode == 2 and "--reason" in r.stderr, r.stderr
            r = remodule_cli(p, ["T-XX-001"], "--epic", "看板界面", "--reason", "  ")
            assert r.returncode == 1 and "理由不能为空" in r.stderr, r.stderr
            assert con.execute("SELECT * FROM tasks").fetchall() == tasks
            assert con.execute("SELECT * FROM task_events").fetchall() == events
            r = remodule_cli(p, ["T-XX-001"], "--epic", "名" * 20, "--reason", "长度边界")
            assert r.returncode == 0, r.stderr
            assert con.execute("SELECT epic FROM tasks").fetchone()[0] == "名" * 20
        finally:
            con.close()

    # ── 10 · touches 双向:scope+ 只增 · scope- 只减,都必须带理由与留痕 ──
    def t_touches_scope_and_release():
        p = fresh(tmp)
        mk(p, touches=["a.py", "b.py"])
        db.release_touches(p, "T-XX-001", drop=["a.py"], reason="占路者窗口已死+代码已合并",
                           owner="ac:tester", session_id="s1")
        con = db.connect(p)
        try:
            row = con.execute("SELECT touches FROM tasks WHERE id=?", ("T-XX-001",)).fetchone()
            assert json.loads(row[0]) == ["b.py"], row[0]
            n = con.execute(
                "SELECT count(*) FROM task_events WHERE task_id=? AND kind='coord'"
                " AND body LIKE 'scope-%'", ("T-XX-001",)).fetchone()[0]
            assert n == 1, f"收窄必须落一条 coord 留痕,实得 {n}"
        finally:
            con.close()
        for kw in ({"drop": ["a.py"], "reason": "已经摘过了"},      # 空操作:不留污染审计的空事件
                   {"drop": ["b.py"], "reason": "  "}):            # 空手摘:理由必填
            try:
                db.release_touches(p, "T-XX-001", owner="ac:tester", session_id="s1", **kw)
            except db.NawabanError:
                continue
            raise AssertionError(f"release_touches 未拒:{kw}")

    # ── 13 · kin relationships ──────────────────────────────────
    def t_kin_blocked_chain():
        p = fresh(tmp)
        for tid in ("T-A", "T-B", "T-C"):
            mk(p, tid=tid, title=f"卡 {tid}")
        db.link_tasks(p, "T-A", "T-B", kind="depends_on", created_by="t")
        db.link_tasks(p, "T-B", "T-C", kind="depends_on", created_by="t")
        got = db.kin(p, "T-A")
        assert got["blocked_by"] == [
            {"id": "T-B", "title": "卡 T-B", "status": "open", "depth": 1},
            {"id": "T-C", "title": "卡 T-C", "status": "open", "depth": 2},
        ], got
        assert got["stuck_at"] == "T-C", got

        env = dict(os.environ)
        env["WORKOS_DB"] = str(p)
        r = subprocess.run([sys.executable, str(CLI), "kin", "T-A"],
                           capture_output=True, text=True, env=env)
        assert r.returncode == 0, r.stderr
        assert "被挡" in r.stdout and "真正卡在 T-C" in r.stdout, r.stdout

    def t_kin_unblocks():
        p = fresh(tmp)
        for tid in ("T-A", "T-B", "T-D"):
            mk(p, tid=tid, title=f"卡 {tid}")
        db.link_tasks(p, "T-D", "T-A", kind="depends_on", created_by="t")
        db.link_tasks(p, "T-D", "T-B", kind="depends_on", created_by="t")
        assert db.kin(p, "T-A")["unblocks"] == [
            {"id": "T-D", "title": "卡 T-D", "status": "open", "others_waiting": 1}
        ]
        con = db.connect(p)
        try:
            con.execute("UPDATE tasks SET status='done' WHERE id='T-B'")
        finally:
            con.close()
        assert db.kin(p, "T-A")["unblocks"][0]["others_waiting"] == 0

    def t_kin_lineage():
        p = fresh(tmp)
        for tid in ("T-PARENT", "T-ME", "T-CHILD", "T-OLD", "T-NEW"):
            mk(p, tid=tid, title=f"卡 {tid}")
        db.link_tasks(p, "T-ME", "T-PARENT", kind="split_from", created_by="t")
        db.link_tasks(p, "T-CHILD", "T-ME", kind="split_from", created_by="t")
        db.link_tasks(p, "T-ME", "T-OLD", kind="supersedes", created_by="t")
        db.link_tasks(p, "T-NEW", "T-ME", kind="supersedes", created_by="t")
        db.decide(p, "T-ME", question="旧问题", verdict="旧决定", decided_by="agent:t")
        con = db.connect(p)
        try:
            old_id = con.execute("SELECT id FROM task_decisions WHERE task_id='T-ME'").fetchone()[0]
        finally:
            con.close()
        db.decide(p, "T-ME", question="新问题", verdict="新" * 90,
                  decided_by="agent:t", supersedes=old_id)
        got = db.kin(p, "T-ME")["lineage"]
        assert got["split_from"] == "T-PARENT", got
        assert got["split_out"] == ["T-CHILD"], got
        assert got["supersedes"] == ["T-OLD"], got
        assert got["superseded_by"] == ["T-NEW"], got
        assert got["latest_decision"].startswith("新" * 80), got
        assert f"修订自 #{old_id + 1} ← #{old_id}" in got["latest_decision"], got

    def t_kin_empty():
        p = fresh(tmp)
        mk(p, epic=None)
        assert db.kin(p, "T-XX-001") == {
            "blocked_by": [],
            "stuck_at": None,
            "unblocks": [],
            "lineage": {
                "split_from": None,
                "split_out": [],
                "supersedes": [],
                "superseded_by": [],
                "latest_decision": None,
            },
            "epic": None,
        }

    cases = [
        ("DDL:title≤80", t_ddl_title),
        ("DDL:now≤200", t_ddl_now),
        ("DDL:event body≤2KB", t_ddl_event_body),
        ("DDL:status 枚举", t_ddl_status_enum),
        ("DDL:edge 枚举拒绝 relates", t_ddl_edge_enum),
        ("CAS:8 并发 claim 恰一胜", t_cas_claim),
        ("same session can resume after blocked handoff", t_same_session_reclaim),
        ("append-only:events 触发器", t_append_only),
        ("规则①:success 改动走 decide 原子留痕", t_success_needs_decision),
        ("no_fabrication:decided_by=user 拒代填", t_decide_user_guard),
        ("边:幻觉闸(dst 必须存在)", t_edge_dst_exists),
        ("边:depends_on 环检测", t_edge_cycle),
        ("create --split-from:自动挂家谱边", t_create_split_from_edge),
        ("create --split-from:epic 继承边界", t_create_split_from_epic),
        ("create --split-from:父卡不存在零写入", t_create_split_from_missing_parent),
        ("handoff:三件套原子+artifact 保存闸", t_handoff_artifact_gate),
        ("状态闸+时间戳副作用+done 需 user 拍板行", t_status_gates),
        ("CLI:身份只从环境来", t_cli_identity),
        ("不静默建库:init 显式其余拒", t_no_silent_init),
        ("touches:scope- 收窄只减+理由必填+留痕", t_touches_scope_and_release),
        ("meta:epic 只补空+留痕", t_meta_fill_if_empty),
        ("remodule:single/batch audit, empty values and idempotent skips", t_remodule_changes_and_skips),
        ("remodule:missing task rolls back the whole batch", t_remodule_missing_rolls_back),
        ("remodule:invalid names and required reason", t_remodule_invalid_input),
        ("直通 done:merge_sha 即归档 · verified 路不强制正文 · 可打回", t_direct_done),
        ("kin:链式被挡定位到根", t_kin_blocked_chain),
        ("kin:最后一张上游完成即放开", t_kin_unblocks),
        ("kin:split 与 supersedes 家谱", t_kin_lineage),
        ("kin:无边全空", t_kin_empty),
    ]
    for name, fn in cases:
        case(name, fn)

    if FAILED:
        print(f"\nFAILED({len(FAILED)}): {FAILED}")
        return 1
    print(f"\nOK · {len(cases)}/{len(cases)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
