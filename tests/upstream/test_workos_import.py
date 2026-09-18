#!/usr/bin/env python3
"""workos import regression 回归自检 · 零依赖(不需 pytest)· 格式照 test_workos_db.py。

跑法:python3 tests/upstream/test_workos_import.py → 全绿 OK / 任一失败 exit 1。
隔离:每例造临时仓 + 临时库(WORKOS_DB 指过去),真库 .foreman/workos.db 一个字节都不碰。

覆盖(对照卡 success 逐条):
  卡数与 glob 一致 · 逐字段映射齐(6 表)· 失败清单不静默跳过 · prose/字段/epic 三源边 ·
  needs_retitle 不编人话标题 · 幂等重跑无重复行 · 归属规则+provenance · 历史闸绕过而非放松 ·
  边界(title>80 / now>200 / event>2KB / status 枚举外)· 错误处理(卡级事务回滚 · 幻觉边被拒)。
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

FOREMAN = (Path(__file__).resolve().parents[2])  # 本文件所在树,worktree 里也测自己
sys.path.insert(0, str(FOREMAN))

from nawaban import db, import_md  # noqa: E402

FAILED: list[str] = []


def case(name: str, fn) -> None:
    try:
        fn()
        print(f"  ✓ {name}")
    except Exception as e:  # noqa: BLE001
        FAILED.append(name)
        print(f"  ✗ {name}: {type(e).__name__}: {e}")


# ── 造局 ──────────────────────────────────────────────────────────

CARD_FULL = """---
task_id: DEMO-FULL-001
status: done
owner: "ac:aaaa1111"
sessions:
  - ac:aaaa1111 | aaaa1111-dead-beef-cafe-000000000001 | 2026-07-01
  - grok | 2026-07-05 | 切片2
epic: DEMO
capability: 演示能力档
flag: DEMO_FLAG
waiting_on: decision
grill: epics/DEMO.md
design: vault/demo
adr: ADR-0001
pr: 1234
merge: abc123def
issue: 77
acceptance: "真机验收:点了按钮弹出人话提示"
depends_on:
  - DEMO-DEP-001
blocks:
  - DEMO-BLOCKED-001
related:
  - DEMO-OTHER-001
touches:
  - src/a.py
  - src/b.py
success:
  - 做完能看见 X
constraints:
  - 不碰 Y
notes: 一句当前态
handoff:
  - 2026-07-02 ac:aaaa1111 | 切片1 done · 下一步看 src/a.py:10
---
# DEMO-FULL-001 · 演示卡标题

## 对齐
- 2026-07-01 用户拍板:就按 A 方案做。
- 形状 → 技术上选了 B,理由是 C。

## 时间线
- 2026-07-03 ac:aaaa1111 | 协调:释放 src/b.py
- 没有日期的一行

## 范围
正文里引用了 DEMO-DEP-001 和 DEMO-OTHER-001。
"""

CARD_DEP = """---
task_id: DEMO-DEP-001
status: open
touches: []
notes: 前置卡
---
# DEMO-DEP-001 · 前置
"""

CARD_BLOCKED = """---
task_id: DEMO-BLOCKED-001
status: open
touches: []
notes: 被挡卡
---
# DEMO-BLOCKED-001 · 被挡
"""

CARD_OTHER = """---
task_id: DEMO-OTHER-001
status: todo
touches: []
notes: 枚举外 status
---
# DEMO-OTHER-001 · 别的卡
"""

CARD_BAD = """---
task_id: DEMO-BAD-001
status: done
acceptance: &未闭合的 alias
  乱: : :
---
# DEMO-BAD-001 · YAML 炸
"""

CARD_EDGE = """---
task_id: DEMO-EDGE-001
status: done
owner: "ac:bbbb2222"
touches: []
notes: {big}
---
# DEMO-EDGE-001 · {title}

## 时间线
- 2026-07-09 ac:bbbb2222 | {huge}
"""

EPIC = """# DEMO epic

## 卡与依赖

```
DEMO-DEP-001
   ├─→ DEMO-FULL-001
   └─→ DEMO-OTHER-001
```
"""


def mkroot(tmp: Path, name: str, cards: dict[str, str], epic: str | None = None) -> Path:
    root = tmp / name
    d = root / ".foreman" / "tasks" / "demo" / "active"
    d.mkdir(parents=True, exist_ok=True)
    for fn, text in cards.items():
        (d / fn).write_text(text, encoding="utf-8")
    if epic:
        e = root / ".foreman" / "epics"
        e.mkdir(parents=True, exist_ok=True)
        (e / "DEMO.md").write_text(epic, encoding="utf-8")
    return root


def std_cards() -> dict[str, str]:
    return {"DEMO-FULL-001.md": CARD_FULL, "DEMO-DEP-001.md": CARD_DEP,
            "DEMO-BLOCKED-001.md": CARD_BLOCKED, "DEMO-OTHER-001.md": CARD_OTHER,
            "DEMO-BAD-001.md": CARD_BAD}


def freshdb(tmp: Path, name: str) -> Path:
    p = tmp / f"{name}.db"
    if p.exists():
        p.unlink()
    db.init_db(p)
    return p


def q(path: Path, sql: str, args: tuple = ()) -> list:
    con = sqlite3.connect(str(path))
    try:
        return con.execute(sql, args).fetchall()
    finally:
        con.close()


def one(path: Path, sql: str, args: tuple = ()) -> object:
    return q(path, sql, args)[0][0]


def main() -> int:  # noqa: C901, PLR0915
    tmp = Path(tempfile.mkdtemp(prefix="workos-import-test-"))
    print(f"[workos import 自检] tmp={tmp}")

    def t_glob_and_failures() -> None:
        """卡数与源 glob 一致;YAML 炸的卡进人工清单,不静默跳过。"""
        root = mkroot(tmp, "g1", std_cards())
        files, plans, failures, edges, _ = import_md.build(root)
        assert len(files) == 5, f"glob 应见 5 个 md,实际 {len(files)}"
        assert len(plans) == 4, f"应成功 4 张,实际 {len(plans)}"
        assert len(failures) == 1, f"应失败 1 张,实际 {len(failures)}"
        assert len(plans) + len(failures) == len(files), "卡数不守恒"
        assert failures[0].path.endswith("DEMO-BAD-001.md")
        assert "YAML" in failures[0].reason, failures[0].reason

    def t_散落卡不漏() -> None:
        """glob 用 ** :tasks/<组>/ 根下的散落卡(实测 2 张)不许被窄 glob 漏掉。"""
        root = mkroot(tmp, "g2", {"DEMO-DEP-001.md": CARD_DEP})
        stray = root / ".foreman" / "tasks" / "demo" / "STRAY-001.md"
        stray.write_text("---\ntask_id: STRAY-001\nstatus: open\ntouches: []\n"
                         "---\n# STRAY-001 · 散落\n", encoding="utf-8")
        files, plans, _, _, _ = import_md.build(root)
        assert len(files) == 2, f"** glob 应见 2 个(含散落),实际 {len(files)}"
        assert {p.task_id for p in plans} == {"DEMO-DEP-001", "STRAY-001"}

    def t_六表映射齐() -> None:
        """frontmatter→列 · 时间线/handoff→events · 对齐→decisions ·
        sessions→task_sessions · pr/merge/issue/acceptance→refs。"""
        root = mkroot(tmp, "m1", std_cards(), EPIC)
        p = freshdb(tmp, "m1")
        _, plans, _, edges, _ = import_md.build(root)
        res = import_md.apply(p, plans, edges)
        assert res["errors"] == [], res["errors"]

        row = q(p, "SELECT title,status,owner,waiting_on,epic,context,"
                   "now,success,constraints_,touches,adr,created_at,"
                   "started_at,completed_at FROM tasks WHERE id='DEMO-FULL-001'")[0]
        (title, status, owner, waiting, epic, context, now, succ, cons,
         touches, adr, created, started, completed) = row
        assert title == "演示卡标题", f"应剥掉与 PK 重复的 ID 前缀,得到 {title!r}"
        assert (status, owner, waiting) == ("done", "ac:aaaa1111", "decision")
        assert (epic, adr) == ("DEMO", "ADR-0001")  # capability/flag/grill/design 读到即丢
        assert context == "一句当前态" and now == "一句当前态"
        assert json.loads(succ) == ["做完能看见 X"]
        assert json.loads(cons) == ["不碰 Y"]
        assert json.loads(touches) == ["src/a.py", "src/b.py"]
        assert created and started and completed, "done 卡三个时间戳都该有"

        kinds = dict(q(p, "SELECT kind,count(*) FROM task_events WHERE task_id="
                          "'DEMO-FULL-001' GROUP BY kind"))
        assert kinds.get("handoff") == 1, f"handoff 行→events,实际 {kinds}"
        # 时间线 2 行(含无日期那行) + needs_retitle 1 行
        assert kinds.get("note") == 3, f"时间线+needs_retitle,实际 {kinds}"

        sess = q(p, "SELECT owner,session_id FROM task_sessions WHERE task_id="
                    "'DEMO-FULL-001' ORDER BY owner")
        assert len(sess) == 2, f"两行 sessions,实际 {sess}"
        assert sess[0][1] == "aaaa1111-dead-beef-cafe-000000000001"
        assert sess[1][1].startswith("legacy:grok:"), f"无真 sid 应合成 legacy 键:{sess}"

        refs = {(k, v) for k, v in q(p, "SELECT kind,value FROM task_refs "
                                        "WHERE task_id='DEMO-FULL-001'")}
        assert ("pr", "#1234") in refs and ("merge_sha", "abc123def") in refs
        assert ("issue", "#77") in refs
        assert any(k == "acceptance_run" for k, _ in refs), refs
        assert any(k == "artifact" for k, _ in refs), "源卡该留 artifact 指针"

        assert one(p, "SELECT count(*) FROM task_decisions WHERE task_id="
                      "'DEMO-FULL-001'") == 2

    def t_导入边() -> None:
        """depends_on 字段 · blocks 反向 · epic 地图依赖图;related 与正文引用忽略。"""
        root = mkroot(tmp, "e1", std_cards(), EPIC)
        p = freshdb(tmp, "e1")
        _, plans, _, edges, _ = import_md.build(root)
        import_md.apply(p, plans, edges)
        got = {(s, d, k) for s, d, k in q(p, "SELECT src,dst,kind FROM task_edges")}
        assert ("DEMO-FULL-001", "DEMO-DEP-001", "depends_on") in got, got
        assert ("DEMO-BLOCKED-001", "DEMO-FULL-001", "depends_on") in got, "blocks 应反向"
        assert not any(k == "relates" for _, _, k in got), "related/正文引用不应生成边"
        assert ("DEMO-OTHER-001", "DEMO-DEP-001", "depends_on") in got, "epic 图 A→B = B 依赖 A"

    def t_幻觉边被拒() -> None:
        """指向不存在卡的边当场拒(幻觉闸),且计进报告不静默丢。"""
        root = mkroot(tmp, "h1", {"DEMO-DEP-001.md": CARD_DEP})
        p = freshdb(tmp, "h1")
        _, plans, _, _, _ = import_md.build(root)
        res = import_md.apply(p, plans, [("DEMO-DEP-001", "NOPE-999", "depends_on")])
        assert res["edges_ok"] == 0 and len(res["edges_bad"]) == 1, res
        assert "幻觉闸" in res["edges_bad"][0][1], res["edges_bad"]

    def t_prose_引用忽略() -> None:
        """正文里出现已知卡 id 也不生成边。"""
        root = mkroot(tmp, "h2", {
            "DEMO-DEP-001.md": CARD_DEP.replace(
                "# DEMO-DEP-001 · 前置", "# DEMO-DEP-001 · 前置\n\n正文提到 DEMO-OTHER-001。"),
            "DEMO-OTHER-001.md": CARD_OTHER,
        })
        _, _, _, edges, _ = import_md.build(root)
        assert edges == [], edges

    def t_needs_retitle_不编标题() -> None:
        """旧标题原样导入 + 一律打 needs_retitle 事件(不由 agent 判哪条够人话)。"""
        root = mkroot(tmp, "r1", std_cards())
        p = freshdb(tmp, "r1")
        _, plans, _, edges, _ = import_md.build(root)
        import_md.apply(p, plans, edges)
        n_cards = one(p, "SELECT count(*) FROM tasks")
        n_mark = one(p, "SELECT count(*) FROM task_events WHERE body LIKE 'needs_retitle%'")
        assert n_mark == n_cards, f"每张卡都该有标记:{n_mark} vs {n_cards}"
        body = one(p, "SELECT body FROM task_events WHERE task_id='DEMO-FULL-001'"
                      " AND body LIKE 'needs_retitle%'")
        assert "DEMO-FULL-001 · 演示卡标题" in body, "原始 H1 应完整留在标记事件里"

    def t_幂等() -> None:
        """重复跑不产生重复行(卡级跳过——events/decisions 物理 append-only,
        行级去重事后无法修复)。"""
        root = mkroot(tmp, "i1", std_cards(), EPIC)
        p = freshdb(tmp, "i1")
        _, plans, _, edges, _ = import_md.build(root)
        r1 = import_md.apply(p, plans, edges)
        snap = {t: one(p, f"SELECT count(*) FROM {t}") for t in
                ("tasks", "task_events", "task_decisions", "task_sessions",
                 "task_refs", "task_edges")}
        r2 = import_md.apply(p, plans, edges)
        snap2 = {t: one(p, f"SELECT count(*) FROM {t}") for t in snap}
        assert r1["imported"] == 4 and r1["skipped"] == 0, r1
        assert r2["imported"] == 0 and r2["skipped"] == 4, r2
        assert snap == snap2, f"重跑改了行数:{snap} → {snap2}"

    def t_归属与provenance() -> None:
        """卡文本写明用户拍板→user,其余 agent:<卡owner>;每行必带可回溯 provenance。"""
        root = mkroot(tmp, "d1", std_cards())
        p = freshdb(tmp, "d1")
        _, plans, _, edges, _ = import_md.build(root)
        import_md.apply(p, plans, edges)
        rows = q(p, "SELECT decided_by,verdict,provenance FROM task_decisions "
                    "WHERE task_id='DEMO-FULL-001' ORDER BY decided_by")
        assert len(rows) == 2, rows
        by = {r[0] for r in rows}
        assert by == {"user", "agent:ac:aaaa1111"}, by
        u = next(r for r in rows if r[0] == "user")
        assert "用户拍板" in u[1], u[1]
        # 判例(2026-08-12):行号一度算的是 body 内偏移,指到了 frontmatter。
        # 「> 0」这种断言抓不到它——必须把指针**拿回源文件真读一行**比对。
        src = (root / ".foreman" / "tasks" / "demo" / "active"
               / "DEMO-FULL-001.md").read_text(encoding="utf-8").splitlines()
        for _, verdict, prov in rows:
            pv = json.loads(prov)
            assert pv["source"] == "import", pv
            assert pv["file"].endswith("DEMO-FULL-001.md"), pv
            assert isinstance(pv["line"], int) and pv["line"] > 0, pv
            assert pv["raw"], pv
            line = src[pv["line"] - 1]
            assert line.lstrip().startswith("- "), f"L{pv['line']} 不是对齐条目:{line!r}"
            assert line.strip()[2:][:20] in verdict, \
                f"L{pv['line']} 的原文与 verdict 对不上:{line!r} vs {verdict[:40]!r}"

    def t_历史闸绕过而非放松() -> None:
        """import_task 能回放「无 acceptance 证据的 done 卡」(历史如此),
        但 9 动词的 done 闸一行没松:同一张卡走 advance 仍被拒。"""
        root = mkroot(tmp, "b1", {"DEMO-DEP-001.md": CARD_DEP})
        p = freshdb(tmp, "b1")
        db.import_task(p, task_id="HIST-001", title="历史 done 卡", status="done",
                       created_at=1_700_000_000, completed_at=1_700_000_001)
        assert one(p, "SELECT status FROM tasks WHERE id='HIST-001'") == "done"
        assert one(p, "SELECT count(*) FROM task_refs WHERE task_id='HIST-001'") == 0

        db.create_task(p, task_id="NEW-001", title="新卡")
        db.claim_task(p, "NEW-001", owner="ac:x", session_id="s1")
        db.start_task(p, "NEW-001", owner="ac:x", session_id="s1")
        try:
            db.advance_task(p, "NEW-001", to="staging-verified", waiting_on="decision",
                            owner="ac:x", session_id="s1")
            raise AssertionError("9 动词的验收闸被放松了")
        except db.NawabanError as e:
            assert "acceptance_run" in str(e), e

    def t_时间戳来自卡内不是导入时刻() -> None:
        import time as _t
        root = mkroot(tmp, "ts1", std_cards())
        p = freshdb(tmp, "ts1")
        _, plans, _, edges, _ = import_md.build(root)
        import_md.apply(p, plans, edges)
        created = one(p, "SELECT created_at FROM tasks WHERE id='DEMO-FULL-001'")
        assert created < _t.time() - 86400 * 7, "created_at 该是 2026-07-01 不是导入时刻"
        ev = one(p, "SELECT created_at FROM task_events WHERE task_id='DEMO-FULL-001'"
                    " AND kind='handoff'")
        assert ev < _t.time() - 86400 * 7, "handoff 事件时间该来自行首日期"

    def t_边界_超限与枚举外() -> None:
        """title>80 可见截断 · now>200 落 NULL(全文进 context)· event>2KB 可见截断 ·
        status 枚举外的 todo → open。"""
        root = mkroot(tmp, "x1", {
            "DEMO-EDGE-001.md": CARD_EDGE.format(
                big="超长" * 200, title="长标题" * 40, huge="巨" * 3000),
            "DEMO-OTHER-001.md": CARD_OTHER})
        p = freshdb(tmp, "x1")
        _, plans, _, edges, _ = import_md.build(root)
        res = import_md.apply(p, plans, edges)
        assert res["errors"] == [], res["errors"]
        title, now, context = q(p, "SELECT title,now,context FROM tasks "
                                  "WHERE id='DEMO-EDGE-001'")[0]
        assert len(title) <= import_md.TITLE_MAX and "truncated" in title, title
        assert now is None, "notes>200 不该硬塞进 now"
        assert len(context) > import_md.NOW_MAX, "全文该完整留在 context"
        bodies = [b for (b,) in q(p, "SELECT body FROM task_events "
                                     "WHERE task_id='DEMO-EDGE-001'")]
        assert all(len(b) <= import_md.EVENT_MAX for b in bodies), "超 2KB 未截断"
        assert any("truncated" in b for b in bodies), "截断该是可见的"
        assert one(p, "SELECT status FROM tasks WHERE id='DEMO-OTHER-001'") == "open"

    def t_卡级失败事务回滚() -> None:
        """一张卡违反 DDL → 整卡回滚(不留半张),其余卡照常导入,失败计进报告。"""
        root = mkroot(tmp, "f1", {"DEMO-DEP-001.md": CARD_DEP})
        p = freshdb(tmp, "f1")
        _, plans, _, _, _ = import_md.build(root)
        bad = import_md.CardPlan(
            task_id="BAD-001", path="x.md",
            row={"task_id": "BAD-001", "title": "坏卡", "status": "外星状态",
                 "created_at": 1},
            events=[{"kind": "note", "body": "e", "author": "import",
                     "created_at": 1, "session_id": None}])
        res = import_md.apply(p, plans + [bad], [])
        assert res["imported"] == 1 and len(res["errors"]) == 1, res
        assert one(p, "SELECT count(*) FROM tasks WHERE id='BAD-001'") == 0
        assert one(p, "SELECT count(*) FROM task_events WHERE task_id='BAD-001'") == 0

    def t_只读旧md() -> None:
        """只读旧 md,不改不删(归档归 RETIRE 卡)。"""
        root = mkroot(tmp, "ro", std_cards(), EPIC)
        md = sorted((root / ".foreman").rglob("*.md"))
        before = {f: (f.read_bytes(), f.stat().st_mtime_ns) for f in md}
        p = freshdb(tmp, "ro")
        _, plans, _, edges, _ = import_md.build(root)
        import_md.apply(p, plans, edges)
        after = sorted((root / ".foreman").rglob("*.md"))
        assert after == md, "导入器动了文件数量"
        for f, (data, mt) in before.items():
            assert f.read_bytes() == data, f"内容被改:{f}"
            assert f.stat().st_mtime_ns == mt, f"mtime 被动:{f}"

    def t_migrate幂等() -> None:
        p = freshdb(tmp, "mg")
        assert db.migrate_db(p) == [], "新库该已含 provenance 列"
        con = sqlite3.connect(str(p))
        con.executescript("DROP TABLE task_decisions;"
                          "CREATE TABLE task_decisions (id INTEGER PRIMARY KEY,"
                          " task_id TEXT, question TEXT, verdict TEXT, rejected TEXT,"
                          " decided_by TEXT, adr TEXT, supersedes INTEGER,"
                          " created_at INTEGER);")
        con.close()
        assert db.migrate_db(p) == ["task_decisions.provenance"], "旧库该补列"
        assert db.migrate_db(p) == [], "补过不该重复补"

    def t_dry_run_不写库() -> None:
        root = mkroot(tmp, "dr", std_cards(), EPIC)
        p = freshdb(tmp, "dr")
        os.environ["WORKOS_DB"] = str(p)
        try:
            rc = import_md.main(["--root", str(root), "--report", str(tmp / "dr.md")])
        finally:
            os.environ.pop("WORKOS_DB", None)
        assert rc == 0, rc
        assert one(p, "SELECT count(*) FROM tasks") == 0, "dry-run 不该写库"
        text = (tmp / "dr.md").read_text(encoding="utf-8")
        assert "与 glob 一致:True" in text, text[:400]
        assert "DEMO-BAD-001.md" in text, "失败清单该在报告里"

    def t_cli_apply_与退出码() -> None:
        """--apply 真写;有失败时退出码非 0(别让 workflow 拿到恒绿的 0)。"""
        root = mkroot(tmp, "cl", std_cards(), EPIC)
        p = freshdb(tmp, "cl")
        rc = import_md.main(["--root", str(root), "--db", str(p), "--apply",
                             "--report", str(tmp / "cl.md")])
        assert rc == 0, rc
        assert one(p, "SELECT count(*) FROM tasks") == 4
        (root / ".foreman" / "tasks" / "demo" / "active" / "DEMO-NEW-001.md").write_text(
            "---\ntask_id: DEMO-NEW-001\nstatus: 外星状态\ntouches: []\n"
            "---\n# DEMO-NEW-001 · 新\n", encoding="utf-8")
        rc2 = import_md.main(["--root", str(root), "--db", str(p), "--apply",
                              "--report", str(tmp / "cl2.md")])
        assert rc2 == 2, f"卡级失败 → 退出码应为 2,实际 {rc2}"
        assert "DEMO-NEW-001" in (tmp / "cl2.md").read_text(encoding="utf-8")
        assert one(p, "SELECT count(*) FROM tasks") == 4, "坏卡不该落库"

    def t_闸2锚点不被架空() -> None:
        """done 闸② 用「最后一条 →staging-verified 事件」当锚点比对 user 拍板行时间。
        导入卡若没有这个事件,锚点退化成 0 → 任何历史 user 行都满足闸,agent 可静默自批。
        staging_verified_at 必须转写成 status_change 事件(转写非编造)。"""
        card = (CARD_FULL.replace("status: done", "status: staging-verified")
                .replace("task_id: DEMO-FULL-001", "task_id: DEMO-SV-001")
                .replace("# DEMO-FULL-001 ·", "# DEMO-SV-001 ·")
                + "")
        card = card.replace("notes: 一句当前态",
                            "notes: 一句当前态\nstaging_verified_at: 2026-07-20T10:00:00+07:00")
        root = mkroot(tmp, "g2anchor", {"DEMO-SV-001.md": card,
                                        "DEMO-DEP-001.md": CARD_DEP,
                                        "DEMO-BLOCKED-001.md": CARD_BLOCKED,
                                        "DEMO-OTHER-001.md": CARD_OTHER})
        p = freshdb(tmp, "g2anchor")
        _, plans, _, edges, _ = import_md.build(root)
        import_md.apply(p, plans, edges)

        # 闸②原样的锚点查询(与 db.advance_task 里那条同形)
        ts = one(p, "SELECT max(created_at) FROM task_events WHERE task_id='DEMO-SV-001'"
                    " AND kind='status_change' AND body LIKE '%→staging-verified'")
        assert ts, "锚点事件缺失 → 闸② 被架空"
        # 卡里的 user 拍板行是 2026-07-01,早于翻 sv 的 2026-07-20 → 不该算数
        n = one(p, "SELECT count(*) FROM task_decisions WHERE task_id='DEMO-SV-001'"
                   " AND decided_by='user' AND created_at>=?", (ts,))
        assert n == 0, "翻 sv 之前的旧拍板行不该满足闸②"

    def t_依赖字段带快照注解() -> None:
        """Synthetic dependency annotations must preserve known task IDs.

        Splitting on whitespace would mistake revision and prose fragments for
        dependencies. Only IDs already present in the import set are valid.
        """
        cards = std_cards()
        cards["DEMO-BLOCKED-001.md"] = CARD_BLOCKED.replace(
            "notes: 被挡卡",
            "notes: 被挡卡\ndepends_on:\n"
            "  - DEMO-DEP-001(**已合入 main · abc12345`** · done · PR#123)\n"
            "  - 等对方接口就绪(没有卡号)")
        root = mkroot(tmp, "ann", cards)
        p = freshdb(tmp, "ann")
        _, plans, _, edges, _ = import_md.build(root)
        res = import_md.apply(p, plans, edges)
        got = {(s, d, k) for s, d, k in q(p, "SELECT src,dst,kind FROM task_edges")}
        assert ("DEMO-BLOCKED-001", "DEMO-DEP-001", "depends_on") in got, \
            f"带注解的真边被丢了:{got}"
        junk = {d for _, d, _ in got if d not in
                {"DEMO-DEP-001", "DEMO-FULL-001", "DEMO-OTHER-001", "DEMO-BLOCKED-001"}}
        assert not junk, f"注解碎片成了边:{junk}"
        assert res["edges_bad"] == [], res["edges_bad"]
        pl = next(x for x in plans if x.task_id == "DEMO-BLOCKED-001")
        assert any("解析不出任何已知卡" in w for w in pl.warnings), \
            f"无卡号的那条该进告警不该静默吞:{pl.warnings}"

    for name, fn in [
        ("卡数与 glob 一致 + 失败清单不静默跳过", t_glob_and_failures),
        ("散落卡不漏(** glob)", t_散落卡不漏),
        ("六表映射齐(列/事件/决策/履历/指针)", t_六表映射齐),
        ("导入边:字段 + blocks 反向 + epic 图;忽略 related/正文引用", t_导入边),
        ("幻觉边当场拒", t_幻觉边被拒),
        ("正文卡号不生成边", t_prose_引用忽略),
        ("needs_retitle 全量标记 · 不编人话标题", t_needs_retitle_不编标题),
        ("幂等:重跑不产生重复行", t_幂等),
        ("decided_by 归属规则 + provenance 可回溯", t_归属与provenance),
        ("历史闸绕过而非放松(9 动词不松)", t_历史闸绕过而非放松),
        ("时间戳来自卡内而非导入时刻", t_时间戳来自卡内不是导入时刻),
        ("边界:title>80 / now>200 / event>2KB / 枚举外 status", t_边界_超限与枚举外),
        ("错误处理:卡级失败事务回滚", t_卡级失败事务回滚),
        ("只读旧 md(内容与 mtime 都不动)", t_只读旧md),
        ("additive migration 幂等", t_migrate幂等),
        ("dry-run 不写库 + 报告成形", t_dry_run_不写库),
        ("--apply 真写 + 失败时退出码非 0", t_cli_apply_与退出码),
        ("依赖字段带快照注解:真边不丢 · 碎片不成边", t_依赖字段带快照注解),
        ("done 闸②锚点不被导入数据架空", t_闸2锚点不被架空),
    ]:
        case(name, fn)

    if FAILED:
        print(f"\nFAILED({len(FAILED)}): {FAILED}")
        return 1
    print("\nOK · 19/19")
    return 0


if __name__ == "__main__":
    sys.exit(main())
