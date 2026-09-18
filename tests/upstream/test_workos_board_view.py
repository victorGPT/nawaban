#!/usr/bin/env python3
"""workos board view regression 回归自检 · 零依赖(不需 pytest)。

跑法:python3 tests/upstream/test_workos_board_view.py → 全绿 OK / 任一失败 exit 1。
覆盖(对照卡 success):五列分栏+等拍板排前 · 最近完成限 12 · 边双向且对端 status 实时
(快照绝种的直接证明)· decisions 含被否 · 全部历史条目给 epoch(相对年龄的数据前提)·
板物理只读 · HTTP 三条路由真起服。
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

FOREMAN = Path(__file__).resolve().parents[2]  # 本文件所在树,worktree 里也测自己
sys.path.insert(0, str(FOREMAN))

from nawaban import foreman_liveness  # noqa: E402
from nawaban import board_view as bv  # noqa: E402
from nawaban import db  # noqa: E402

FAILED: list[str] = []


def case(name: str, fn) -> None:
    try:
        fn()
        print(f"  ✓ {name}")
    except AssertionError as e:
        FAILED.append(name)
        print(f"  ✗ {name}: {e}")
    except Exception as e:  # noqa: BLE001
        FAILED.append(name)
        print(f"  ✗ {name}: {type(e).__name__}: {e}")


def fresh(tmp: Path) -> Path:
    p = tmp / f"b{time.time_ns()}.db"
    db.init_db(p)
    return p


def mk(path: Path, tid: str, **kw) -> None:
    kw.setdefault("title", f"{tid} 做完人能看见的变化")
    db.create_task(path, task_id=tid, **kw)


def verify(path: Path, tid: str, *, owner="ac:t", sid="s1", waiting_on="decision") -> None:
    """把卡推到 staging-verified(带 acceptance_run 证据,过验收闸)。"""
    db.claim_task(path, tid, owner=owner, session_id=sid)
    db.start_task(path, tid, owner=owner, session_id=sid)
    db.add_ref(path, tid, kind="acceptance_run", value=f"run://{tid}")
    if waiting_on == "decision":
        # 入口闸:等人拍板的卡必须先挂一条未关的 ask,否则人永远看不到它
        db.raise_ask(path, kind="accept", question=f"{tid}:收下吗?",
                     evidence=f"run://{tid}", task_ids=[tid], raised_by=owner)
    else:
        # done 闸③(2026-08-28):无人拍板的归档必须留一条 acceptance 正文
        db.add_event(path, tid, kind="acceptance", body=f"{tid}:验过 · 见 run://{tid}",
                     author=owner, session_id=sid)
    db.advance_task(path, tid, to="staging-verified", waiting_on=waiting_on,
                    owner=owner, session_id=sid)


def col(data: dict, key: str) -> dict:
    return next(c for c in data["columns"] if c["key"] == key)


_REAL_NOW = db._now


def freeze(ts: int) -> None:
    """定住库层时钟造出不同年龄的卡 —— 同秒建的卡分不出先后,而事件表物理 append-only,
    事后改时间戳会被触发器当场打回(所以只能在写入时定时钟)。"""
    db._now = lambda: ts  # type: ignore[assignment]


def unfreeze() -> None:
    db._now = _REAL_NOW  # type: ignore[assignment]


def agent(owner: str, status: str) -> foreman_liveness.LiveAgent:
    return foreman_liveness.LiveAgent(owner=owner, session_id="s", status=status,
                                      pane="w1:p1", cwd="/tmp")


def main() -> int:  # noqa: C901, PLR0915
    tmp = Path(tempfile.mkdtemp(prefix="workos-board-"))

    def t_columns():
        p = fresh(tmp)
        mk(p, "T-OPEN-001", epic="E1")
        mk(p, "T-CLAIM-001")
        db.claim_task(p, "T-CLAIM-001", owner="ac:a", session_id="s1")
        mk(p, "T-PROG-001")
        db.claim_task(p, "T-PROG-001", owner="ac:a", session_id="s1")
        db.start_task(p, "T-PROG-001", owner="ac:a", session_id="s1")
        mk(p, "T-VER-001")
        verify(p, "T-VER-001", waiting_on="prod")
        d = bv.board_data(p)
        assert [c["key"] for c in d["columns"]] == \
            ["staging-verified", "in_progress", "claimed", "open", "done"], d["columns"]
        assert [t["id"] for t in col(d, "open")["tasks"]] == ["T-OPEN-001"]
        assert [t["id"] for t in col(d, "claimed")["tasks"]] == ["T-CLAIM-001"]
        assert [t["id"] for t in col(d, "in_progress")["tasks"]] == ["T-PROG-001"]
        assert [t["id"] for t in col(d, "staging-verified")["tasks"]] == ["T-VER-001"]
        assert col(d, "open")["tasks"][0]["epic"] == "E1"

    def t_no_precutover_wording():
        """切换后板不许再说自己是预览:workos.db 就是唯一真相(workos board cutover regression)。"""
        for bad in ("切换前", "非真相", "预览", ".foreman/tasks"):
            assert bad not in bv.PAGE, f"页面残留切换前字样:{bad}"
        assert "banner" not in bv.board_data(fresh(tmp)), "board 载荷不该再带 banner 字段"

    def t_decision_first():
        """验收队列内:等拍板(waiting_on=decision)排在其他 waiting 之前。"""
        p = fresh(tmp)
        for tid, w in (("T-A-001", "prod"), ("T-B-001", "decision"), ("T-C-001", "observe")):
            mk(p, tid)
            verify(p, tid, waiting_on=w)
        ids = [t["id"] for t in col(bv.board_data(p), "staging-verified")["tasks"]]
        assert ids[0] == "T-B-001", ids
        assert set(ids) == {"T-A-001", "T-B-001", "T-C-001"}, ids

    def t_done_limit():
        p = fresh(tmp)
        for i in range(15):
            tid = f"T-D-{i:03d}"
            mk(p, tid)
            verify(p, tid, waiting_on="observe")
            db.advance_task(p, tid, to="done", owner="ac:t", session_id="s1")
        done = col(bv.board_data(p), "done")["tasks"]
        assert len(done) == bv.DONE_LIMIT == 12, len(done)
        # completed_at 同秒时按插入序不保证,只断言全部来自 done 集合且带完成时间
        assert all(t["completed_at"] for t in done)

    def t_edges_live_status():
        """边双向 + 对端 status 实时:翻对端状态后投影跟着变(手写快照注解绝种)。"""
        p = fresh(tmp)
        mk(p, "T-UP-001")
        mk(p, "T-DOWN-001")
        db.link_tasks(p, "T-DOWN-001", "T-UP-001", kind="depends_on", created_by="ac:t")
        d = bv.task_detail(p, "T-DOWN-001")
        assert [e["other"] for e in d["edges_out"]] == ["T-UP-001"]
        assert d["edges_out"][0]["other_status"] == "open", d["edges_out"]
        # 反查:上游卡上看得见谁依赖它(痛点「不可反查」的验收点)
        up = bv.task_detail(p, "T-UP-001")
        assert [e["other"] for e in up["edges_in"]] == ["T-DOWN-001"], up["edges_in"]
        # 翻上游状态 → 下游卡上的对端状态实时跟着变,无需任何重写
        verify(p, "T-UP-001", waiting_on="decision")
        d2 = bv.task_detail(p, "T-DOWN-001")
        assert d2["edges_out"][0]["other_status"] == "staging-verified", d2["edges_out"]
        assert d2["edges_out"][0]["other_waiting_on"] == "decision"

    def t_detail_fields():
        p = fresh(tmp)
        mk(p, "T-X-001", context="因为 X 坏了", success=["判据一"], constraints=["约束一"],
           touches=["a/b.py"])
        db.claim_task(p, "T-X-001", owner="ac:t", session_id="s1")
        db.start_task(p, "T-X-001", owner="ac:t", session_id="s1")
        db.add_event(p, "T-X-001", kind="note", body="一条笔记", author="ac:t", session_id="s1")
        db.decide(p, "T-X-001", question="走 A 还是 B", verdict="走 A",
                  rejected=[{"option": "B", "reason": "太贵"}], decided_by="agent:ac:t")
        db.add_ref(p, "T-X-001", kind="pr", value="#123")
        db.add_letter(p, "T-X-001", kind="stage", msg="Review is ready",
                      links="https://github.com/example/repo/pull/123")
        db.handoff(p, "T-X-001", owner="ac:t", session_id="s1", outcome="handed_off",
                   summary="做了一半", now="当前态一句")
        d = bv.task_detail(p, "T-X-001")
        assert d["context"] == "因为 X 坏了" and d["now"] == "当前态一句"
        assert d["success"] == ["判据一"] and d["constraints"] == ["约束一"]
        assert d["touches"] == ["a/b.py"]
        assert d["decisions"][0]["rejected"] == [{"option": "B", "reason": "太贵"}], d["decisions"]
        assert d["refs"][0]["value"] == "#123"
        assert d["letters"][0]["links"] == "https://github.com/example/repo/pull/123"
        assert d["sessions"][0]["outcome"] == "handed_off"
        kinds = [e["kind"] for e in d["events"]]
        assert "handoff" in kinds and "note" in kinds and "status_change" in kinds, kinds

    def t_relative_age_source():
        """相对年龄的数据前提:全部历史条目给出 epoch 整数(渲染层算 'Nh ago')。"""
        p = fresh(tmp)
        mk(p, "T-T-001")
        db.claim_task(p, "T-T-001", owner="ac:t", session_id="s1")
        db.add_event(p, "T-T-001", kind="note", body="x", author="ac:t")
        db.decide(p, "T-T-001", question="q", verdict="v", decided_by="agent:ac:t")
        db.add_ref(p, "T-T-001", kind="issue", value="#7")
        d = bv.task_detail(p, "T-T-001")
        stamps = ([d["created_at"]] + [e["created_at"] for e in d["events"]]
                  + [x["created_at"] for x in d["decisions"]]
                  + [x["created_at"] for x in d["refs"]]
                  + [s["started_at"] for s in d["sessions"]])
        assert stamps and all(isinstance(s, int) and s > 1_700_000_000 for s in stamps), stamps
        # 页面里不许出现日期格式化(裸时间戳)的痕迹
        assert "toLocaleString" not in bv.PAGE and "toISOString" not in bv.PAGE

    def t_read_only():
        """板物理只读:同一连接上任何写入当场失败(v1 只读约束不靠纪律)。"""
        p = fresh(tmp)
        mk(p, "T-RO-001")
        con = bv._ro(p)
        try:
            for sql in ("UPDATE tasks SET title='x' WHERE id='T-RO-001'",
                        "DELETE FROM tasks WHERE id='T-RO-001'"):
                try:
                    con.execute(sql)
                    raise AssertionError(f"只读连接竟写成功:{sql}")
                except sqlite3.OperationalError:
                    pass
        finally:
            con.close()

    def t_missing_task():
        p = fresh(tmp)
        try:
            bv.task_detail(p, "T-NOPE-001")
            raise AssertionError("不存在的卡应报错")
        except db.NawabanError:
            pass

    def t_sort_recent_activity():
        """非 done 列按最近活动倒序:刚动过的浮上来,躺着的沉底(不再是 id 字母序)。"""
        p = fresh(tmp)
        now = int(time.time())
        try:
            for i, tid in enumerate(["T-S-001", "T-S-002", "T-S-003"]):  # 001 最老 → 003 最新
                freeze(now - 3000 + i * 1000)
                mk(p, tid)
                db.claim_task(p, tid, owner="ac:a", session_id="s1")
                db.start_task(p, tid, owner="ac:a", session_id="s1")
        finally:
            unfreeze()
        got = col(bv.board_data(p), "in_progress")["tasks"]
        assert [t["id"] for t in got] == ["T-S-003", "T-S-002", "T-S-001"], got
        assert got[0]["active_at"] == now - 1000, got[0]

    def t_decision_pinned_over_recency():
        """等拍板仍钉最前 —— 哪怕它是全列最陈旧的一张(排序换了但闸没塌)。"""
        p = fresh(tmp)
        now = int(time.time())
        try:
            for tid, w, ts in (("T-P-001", "prod", now), ("T-P-002", "decision", now - 99999)):
                freeze(ts)
                mk(p, tid)
                verify(p, tid, waiting_on=w)
        finally:
            unfreeze()
        got = [t["id"] for t in col(bv.board_data(p), "staging-verified")["tasks"]]
        assert got == ["T-P-002", "T-P-001"], got

    def t_live_fail_soft():
        """存活判定:未知必须留白 —— 渲染成「已关」会让人放心收窄一把真在用的锁。

        board liveness truth regression 起活性直接从转录 mtime 算,不再经 herdr
        (它没装/没跑时整张表 None,会让**所有**卡退化成未知)。
        """
        idx = {"alive123": time.time()}
        assert bv._live_of("ac:alive123", idx)["tier"] == "working"
        assert bv._live_of("ac:gone9999", idx)["tier"] == "no-window", "查不到窗口是一档,不是未知"
        assert bv._live_of("ac:alive123", None) is None, "索引不可用 → 未知,不是已死"
        assert bv._live_of("编外:grok(w1:p1N)", idx) is None, "owner 非 session 派生 → 对不上账"
        assert bv._live_of(None, idx) is None

    def t_busy_from_transcript():
        """三档全部认转录 mtime —— herdr 的 agent_status 对 claude 窗口恒 idle,
        只认它的话绿色脉冲永远不亮(从不触发的指示器比没有更坏)。"""
        real = bv.TRANSCRIPTS
        box = tmp / "projects" / "proj"
        box.mkdir(parents=True, exist_ok=True)
        try:
            bv.TRANSCRIPTS = tmp / "projects"
            now = time.time()
            for name, age in (("hotsess1", 0), ("idlesess", bv.BUSY_WINDOW_S + 60),
                              ("coldsess", bv.IDLE_WINDOW_S + 60)):
                f = box / f"{name}.jsonl"
                f.write_text("{}")
                os.utime(f, (now - age,) * 2)
            idx, complete = bv._transcript_index()
            assert complete, "预算内该扫完"
            assert bv._live_of("ac:hotsess1", idx)["tier"] == "working"
            assert bv._live_of("ac:idlesess", idx)["tier"] == "idle"
            assert bv._live_of("ac:coldsess", idx)["tier"] == "cold"
            # age_s 要给出来 —— 卡面「窗口早没动静 · 9h ago」全靠它
            assert bv._live_of("ac:coldsess", idx)["age_s"] > bv.IDLE_WINDOW_S
        finally:
            bv.TRANSCRIPTS = real

    def t_live_columns_only():
        """只有 claimed/in_progress 标存活;验收队列几十张全标墓碑是噪音不是信号。

        外加列头汇总 live_tally —— 「35 张里只有 3 张真在动」这个反差本身
        就是最该被看见的信息,不能只藏在每张卡上。
        """
        p = fresh(tmp)
        mk(p, "T-L-001")
        db.claim_task(p, "T-L-001", owner="ac:x", session_id="s1")
        mk(p, "T-L-002")
        verify(p, "T-L-002", owner="ac:x", waiting_on="prod")
        d = bv.board_data(p, idx={})  # 空索引 = 扫过了,一个窗口都没对上
        assert col(d, "claimed")["tasks"][0]["live"]["tier"] == "no-window"
        assert "live" not in col(d, "staging-verified")["tasks"][0]
        assert col(d, "claimed")["live_tally"] == {"no-window": 1}
        assert "live_tally" not in col(d, "staging-verified"), "非存活列不该有汇总"
        assert col(bv.board_data(p), "claimed")["tasks"][0]["live"] is None  # 不探测=未知

    def t_module_card_fields():
        p = fresh(tmp)
        title = "Full task title " * 5
        mk(p, "T-MODULE-001", title=title, epic="MODULE")
        db.claim_task(p, "T-MODULE-001", owner="ac:module", session_id="module")
        idx = {"module": time.time()}
        module = bv.modules_data(p)["tasks"][0]
        assert module["t"] == title, "Module title must not be truncated"
        module = bv.modules_data(p, idx=idx)["tasks"][0]
        board = col(bv.board_data(p, idx=idx), "claimed")["tasks"][0]
        assert module["live"]["tier"] == board["live"]["tier"] == "working"
        assert module["waiting_on"] == board["waiting_on"]
        assert bv.modules_data(p)["tasks"][0]["live"] is None
        mk(p, "T-MODULE-002")
        verify(p, "T-MODULE-002", waiting_on="decision")
        waiting = next(t for t in bv.modules_data(p, idx=idx)["tasks"] if t["i"] == "T-MODULE-002")
        assert waiting["waiting_on"] == "decision"
        assert waiting.get("live") is None

    def t_card_shows_id():
        """任务 ID 在列表正面就可见,不必点进详情。"""
        assert '"tid",t.id' in bv.PAGE, "卡片未渲染任务 ID"
        assert ".tid{" in bv.PAGE, "缺 .tid 样式"

    def t_fold_key_normalizes():
        """同功能异写法必须并到一组 —— epic 是自由文本,直接 GROUP BY 会拆开。

        Synthetic fixtures cover punctuation and descriptive suffix variations.
        """
        same = [
            ("示例控制面板",
             ["示例控制面板(加载提速 · stale-while-revalidate)",
              "示例控制面板(DEMO-CONTROL-001 后继 · 版本开关分区)"]),
            ("示例协作助手",
             ["示例协作助手·三域统一读侧(最近 ADR-0001)",
              "示例协作助手·三域统一读侧(最近 ADR-0002)"]),
            ("示例月报摘要",
             ["示例月报摘要·无档(最近任务档 docs/tasks/x.md)",
              "示例月报摘要·承接 DEMO-SUMMARY-001 复测发现(方案甲弱于方案乙)"]),
            ("示例物品登记",
             ["示例物品登记(同族卡 DEMO-ITEM-001)",
              "示例物品登记 · docs/capabilities/sample-item.md"]),
        ]
        for want, variants in same:
            keys = {bv.fold_key("T-X-001", v) for v in variants}
            assert keys == {want}, f"{variants} 应并成 {want},实得 {keys}"
        # 文档路径取文件名(45 张最大的那组就靠这条)
        assert bv.fold_key("T-1", "docs/capabilities/identity-access.md") == "identity-access"
        # n/a / 无档 不是功能名,是「没填」的说法 → 走 ID 前缀兜底,不留「未归类」大杂烩
        assert bv.fold_key("DEMO-QUEUE-SYNC-001", "n/a") == "DEMO"
        assert bv.fold_key("WORKOS-X-001", "无档(最近 ADR)") == "WORKOS"
        assert bv.fold_key("DEMO-CORE-001", "  ") == "DEMO"
        # 兜底只取第一段:SSO / POOL / CORE 在字符层面分不开谁是「真子域」,
        # 任何长度规则都是瞎猜。要精细就填 epic,别指望 ID 猜得准。
        assert bv.fold_key("DEMO2-AUTH-EXAMPLE-001", None) == "DEMO2"

    def t_fold_rows():
        """列内折叠:多张收成大卡、单张不套壳、五列布局不变、大卡带组内信号。"""
        p = fresh(tmp)
        for i in range(3):
            mk(p, f"T-CAP-{i:03d}", epic="示例控制面板(变体 %d)" % i)
            verify(p, f"T-CAP-{i:03d}", waiting_on="decision")
        mk(p, "T-SOLO-001", epic="独一份功能")
        verify(p, "T-SOLO-001", waiting_on="prod")
        d = bv.board_data(p)
        assert [c["key"] for c in d["columns"]] == \
            ["staging-verified", "in_progress", "claimed", "open", "done"], "五列布局不许变"
        rows = col(d, "staging-verified")["rows"]
        grp = [r for r in rows if r["kind"] == "group"]
        card = [r for r in rows if r["kind"] == "card"]
        assert len(grp) == 1 and grp[0]["name"] == "示例控制面板" and grp[0]["n"] == 3, grp
        assert grp[0]["decision"] == 3, "大卡要带组内信号,不是纯计数"
        assert len(card) == 1 and card[0]["task"]["id"] == "T-SOLO-001", "单卡不许套壳"
        assert len(rows) == 2, f"4 张卡该收成 2 行,实得 {len(rows)}"
        # 组内保留全部成员(展开时要用)。**不断言顺序** —— 列内排序是「等拍板钉最前 +
        # 最近活动倒序」,组只是原样继承,把 ID 序写死会在排序规则变化时假红。
        assert {t["id"] for t in grp[0]["tasks"]} == {f"T-CAP-{i:03d}" for i in range(3)}

    def t_fold_graph():
        """DAG 折叠:卡级图 → 功能级图。组内边是实现细节,不出现在功能图上。

        实测 435 节点 419 边平铺时糊成屏幕中间一小片;折叠后真正的跨功能流转只有个位数条。
        """
        p = fresh(tmp)
        # A 组两张(彼此依赖 = 组内边) · B 组一张 · A 依赖 B(跨组边,应保留并计数)
        for tid in ("T-A1-001", "T-A2-001"):
            mk(p, tid, epic="甲功能(变体)")
        mk(p, "T-B1-001", epic="乙功能")
        db.link_tasks(p, "T-A1-001", "T-A2-001", kind="depends_on", created_by="ac:t")
        db.link_tasks(p, "T-A1-001", "T-B1-001", kind="depends_on", created_by="ac:t")
        db.link_tasks(p, "T-A2-001", "T-B1-001", kind="depends_on", created_by="ac:t")
        g = bv.graph_data(p)
        con = bv._ro(p)
        try:
            f = bv.fold_graph(g, bv.prefix_hints(con))
        finally:
            con.close()
        assert f["folded"] is True
        names = {n["title"] for n in f["nodes"]}
        assert names == {"甲功能", "乙功能"}, names
        a = next(n for n in f["nodes"] if n["title"] == "甲功能")
        assert a["n"] == 2 and a["id"] == "grp:甲功能" and a["kind"] == "group"
        assert set(a["members"]) == {"T-A1-001", "T-A2-001"}
        dep = [l for l in f["links"] if l["kind"] == "depends_on"]
        assert len(dep) == 1, f"组内那条边不该出现在功能图上,实得 {dep}"
        # graph_data 的边方向是「上游在 source」(DAG 布局要上游在上),
        # 甲依赖乙 → 乙是上游 → source=乙。别按直觉写反。
        assert dep[0]["source"] == "grp:乙功能" and dep[0]["target"] == "grp:甲功能"
        assert dep[0]["count"] == 2, "两条卡级依赖要聚合成一条边并计数"
        assert f["stats"]["raw_nodes"] == 3 and f["stats"]["folded_groups"] == 2

    def t_fold_graph_role_is_most_urgent():
        """组的 role 取组内最紧急的 —— 否则一组里有一张等拍板会被一堆 done 淹掉。"""
        p = fresh(tmp)
        mk(p, "T-U1-001", epic="丙功能")
        verify(p, "T-U1-001", waiting_on="decision")
        mk(p, "T-U2-001", epic="丙功能")
        verify(p, "T-U2-001", waiting_on="observe")
        db.advance_task(p, "T-U2-001", to="done", owner="ac:t", session_id="s1")
        con = bv._ro(p)
        try:
            f = bv.fold_graph(bv.graph_data(p), bv.prefix_hints(con))
        finally:
            con.close()
        g = next(n for n in f["nodes"] if n["title"] == "丙功能")
        assert g["role"] == "decision", f"组内有等拍板,组就该是 decision,实得 {g['role']}"
        assert g["n"] == 2 and g["alive"] == 1 and g["decision"] == 1

    def t_http():
        """真起服务:/ 出看板 · ?view=inbox 出收件箱 · /api/board 出五列 · 不存在的卡 404。

        **看板是底线**(用户 2026-08-14):它必须始终是默认视图。中途做反过一版
        (/ 给收件箱),被否 —— 拿走人的全景视野不叫减负。
        """
        p = fresh(tmp)
        mk(p, "T-H-001", epic="E")
        bv._Handler.db_path = p
        from http.server import ThreadingHTTPServer
        srv = ThreadingHTTPServer(("127.0.0.1", 0), bv._Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{srv.server_address[1]}"
        installed_dist = bv.WEBUI_DIST
        test_dist = tmp / "webui-dist"
        test_dist.mkdir()
        (test_dist / "index.html").write_text('<html><div id="root"></div></html>')
        bv.WEBUI_DIST = test_dist
        try:
            html = urllib.request.urlopen(base + "/", timeout=5).read().decode()
            assert html == (test_dist / "index.html").read_text()
            for route in ["/?view=inbox", "/?view=modules", "/?task=T-H-001"]:
                page = urllib.request.urlopen(base + route, timeout=5).read().decode()
                assert page == html, f"Direct entry must use the installed UI: {route}"
            legacy = urllib.request.urlopen(base + "/?view=legacy", timeout=5).read().decode()
            assert legacy == bv.PAGE
            ib = json.loads(urllib.request.urlopen(base + "/api/inbox", timeout=5).read())
            assert ib["total"] == 0 and len(ib["groups"]) == 3, ib
            board = json.loads(urllib.request.urlopen(base + "/api/board", timeout=5).read())
            assert len(board["columns"]) == 5
            modules = json.loads(urllib.request.urlopen(base + "/api/modules", timeout=5).read())
            assert modules["tasks"][0]["i"] == "T-H-001"
            assert "waiting_on" in modules["tasks"][0]
            assert modules["liveness"]["available"] == board["liveness"]["available"]
            assert board["columns"][3]["tasks"][0]["title"].endswith("变化")
            det = json.loads(urllib.request.urlopen(base + "/api/task?id=T-H-001", timeout=5).read())
            assert det["id"] == "T-H-001"
            try:
                urllib.request.urlopen(base + "/api/task?id=T-NOPE-001", timeout=5)
                raise AssertionError("不存在的卡应 404")
            except urllib.error.HTTPError as e:
                assert e.code == 404, e.code
            bv.WEBUI_DIST = tmp / "missing-dist"
            for route, expected in [("/", bv.PAGE), ("/?view=inbox", bv.INBOX_PAGE),
                                    ("/?view=modules", bv.MODULES_PAGE)]:
                page = urllib.request.urlopen(base + route, timeout=5).read().decode()
                assert page == expected, f"Missing build must retain the legacy entry: {route}"
        finally:
            srv.shutdown()
            bv.WEBUI_DIST = installed_dist

    def t_kin_http():
        p = fresh(tmp)
        mk(p, "T-KIN-001", epic="亲缘功能")
        bv._Handler.db_path = p
        from http.server import ThreadingHTTPServer
        srv = ThreadingHTTPServer(("127.0.0.1", 0), bv._Handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{srv.server_address[1]}"
        try:
            kin = json.loads(urllib.request.urlopen(
                base + "/api/kin?id=T-KIN-001", timeout=5).read())
            assert kin["epic"] == "亲缘功能", kin
            try:
                urllib.request.urlopen(base + "/api/kin?id=T-NOPE-001", timeout=5)
                raise AssertionError("不存在的卡应 404")
            except urllib.error.HTTPError as e:
                assert e.code == 404, e.code
        finally:
            srv.shutdown()

    def t_inbox_low_confidence_sinks_but_shows():
        """agent 没把握的沉到组末尾,但**一条不藏** —— 藏起来它就成了人的盲区。"""
        p = fresh(tmp)
        for tid in ("T-SURE-001", "T-UNSURE-001"):
            db.create_task(p, task_id=tid, title=f"{tid} 卡", context="置信度排序自检")
        old = int(time.time()) - 40 * 86400
        # 不确定的那条**停滞更久**,若只按停滞排它会在最前 —— 用它证明沉底真的生效
        db.raise_ask(p, kind="accept", question="没把握的这条?", evidence="材料有缺口",
                     task_ids=["T-UNSURE-001"], raised_by="ac:triage", raised_at=old,
                     confidence=0.0, confidence_reason="卡上 now 提到可能已随上次部署上线")
        db.raise_ask(p, kind="accept", question="有把握的这条?", evidence="staging 真机实测",
                     task_ids=["T-SURE-001"], raised_by="ac:triage",
                     confidence=0.9, confidence_reason="读侧正向证据齐")
        items = [g for g in bv.inbox_data(p)["groups"] if g["kind"] == "accept"][0]["items"]
        assert len(items) == 2, f"低置信度不许被藏起来:{items}"
        assert items[0]["question"] == "有把握的这条?", items
        assert items[1]["confidence"] == 0.0, "0.0 是合法的「毫无把握」· 不许被 falsy 吞成中位数"
        assert items[1]["confidence_reason"]

    def t_card_selector_invariant():
        """`.card` 是样式锚点(折叠大卡也用),读 `_task` 必须按 `.card.tk` 选。

        判例 2026-08-14:折叠功能让大卡复用了 `.card`,于是遍历 `.card` 读 `c._task.id`
        在大卡身上炸 —— 症状是「点卡没详情」「搜索炸」「j/k 落到大卡」三个,同一个根因。
        前端行为没法在这里真跑,退而守住选择器这条不变量(它正是当时被破的那条)。
        """
        src = (FOREMAN / "nawaban" / "board_view.py").read_text()
        # 按**用法**判不按字面判:`.card.grp` 是故意选大卡的(隐藏组头),它不碰 _task。
        # 真正的坑是「选择器没带 .tk,而紧接着的回调里读 _task」—— 选择器与 _task 常在
        # 相邻两行(applySearch 就是),所以看选择器后面一段窗口,不按单行判。
        bad = []
        for m in re.finditer(r'querySelectorAll\("\.card([^"]*)"', src):
            if ".tk" in m.group(1):
                continue
            if "_task" in src[m.end():m.end() + 220]:
                bad.append(src[max(0, m.start() - 30):m.end() + 70].replace("\n", " ⏎ "))
        assert not bad, f"这些遍历会在没有 _task 的大卡上炸:{bad}"
        assert 'c=$("button","card tk")' in src, "任务卡必须带 tk 标记,否则上面那条闸形同虚设"

    def t_css_lives_in_its_own_template():
        """CSS 必须定义在它服务的那个模板里 —— 一个文件里三个 HTML 模板,
        字符串 replace 认不出自己插进了哪一个。

        本轮踩了两次:`.conf`(置信度)和 `#fambar`/`.card.dim`(家族高亮)都先插进了
        收件箱模板,页面上元素在、样式不生效,真机 opacity 查出来是 1 才发现。

        按**范围**判,不按「全文件第一次出现在哪」判:三个模板各自是完整 HTML 文档,
        同名选择器(如 `.card.dim`)在两个模板里各自独立定义、各自生效是合法的
        (MODULES_PAGE 的专注模式与 PAGE 的家族高亮是两套互不相干的实现)——
        只有「该模板范围内根本找不到这条选择器」才是真的插错了地方。
        """
        src = (FOREMAN / "nawaban" / "board_view.py").read_text()
        i_modules = src.index('MODULES_PAGE = r"""')
        i_inbox = src.index("INBOX_PAGE = r", i_modules)
        i_page = src.index('PAGE = r"""', i_inbox + 10)
        ranges = {"modules": (i_modules, i_inbox), "inbox": (i_inbox, i_page),
                  "page": (i_page, len(src))}
        for sel, tpl in ((".conf{", "inbox"), (".ask{", "inbox"),
                         ("#fambar{", "page"), (".card.dim{", "page"), (".kintag{", "page")):
            lo, hi = ranges[tpl]
            j = src.find(sel, lo)
            assert lo <= j < hi, f"{sel} 没有定义在 {tpl} 模板范围内"

    print("Board view self-test")
    cases = [
        ("五列分栏(open/claimed/in_progress/verified/done)", t_columns),
        ("切换后:页面无「切换前/预览/非真相」字样", t_no_precutover_wording),
        ("验收队列:等拍板排最前", t_decision_first),
        ("排序:非 done 列按最近活动倒序", t_sort_recent_activity),
        ("排序:等拍板压过最近活动,仍钉最前", t_decision_pinned_over_recency),
        ("存活:未知留白(herdr 不可用 ≠ 已死)", t_live_fail_soft),
        ("在跑:认转录 mtime,不认 herdr 的 idle", t_busy_from_transcript),
        ("存活:只标 claimed/in_progress 两列", t_live_columns_only),
        ("卡片正面直接显示任务 ID", t_card_shows_id),
        ("最近完成:限 12 张", t_done_limit),
        ("边:双向 + 对端 status 实时(快照绝种)", t_edges_live_status),
        ("详情:context/now/success/decisions(含被否)/refs/sessions/events", t_detail_fields),
        ("相对年龄:历史条目全给 epoch,页面无绝对时间格式化", t_relative_age_source),
        ("板物理只读:写入当场失败", t_read_only),
        ("不存在的卡:响亮失败", t_missing_task),
        ("折叠键:同功能异写法并成一组", t_fold_key_normalizes),
        ("折叠行:多张收成大卡 · 单张不套壳 · 五列不变", t_fold_rows),
        ("DAG 折叠:组内边不上功能图 · 跨组边计数", t_fold_graph),
        ("DAG 折叠:组的 role 取组内最紧急", t_fold_graph_role_is_most_urgent),
        ("收件箱:低置信度沉底但不隐藏", t_inbox_low_confidence_sinks_but_shows),
        ("选择器不变量:读 _task 必须按 .card.tk 选", t_card_selector_invariant),
        ("CSS 定义在它服务的那个模板里", t_css_lives_in_its_own_template),
        ("Module cards retain full titles and board window signals", t_module_card_fields),
        ("HTTP:/ + /api/board + /api/task(404)", t_http),
        ("HTTP:/api/kin 存在卡返回四块数据 · 不存在卡 404", t_kin_http),
    ]
    for name, fn in cases:
        case(name, fn)

    print(f"\n{'FAILED: ' + ', '.join(FAILED) if FAILED else 'OK'} · "
          f"{len(cases) - len(FAILED)}/{len(cases)}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
