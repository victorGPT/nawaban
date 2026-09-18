#!/usr/bin/env python3
"""workos context loader regression 回归自检 · 零依赖 · 格式照 test_workos_db.py。

跑法:python3 tests/upstream/test_workos_loader.py
隔离:临时库(WORKOS_DB / 显式 --db),真库 .foreman/workos.db 一个字节都不碰。

覆盖(对照卡 success 逐条):全区渲染 · 相对年龄 + 快照免责 · ≤8KB 预算与可见截断 ·
top-k 检索(线索非证据 · 排除已成边)· 导入期呈现(needs_retitle / now 空 / 归属标对) ·
错误处理(查无此卡给 14 坏卡提示)· 只读不写 ·
SessionStart 分流(默认关**逐字节等价** = 硬验收 · 开走装载器 · fail-soft 落回)。
"""

from __future__ import annotations

import os
import re
import sqlite3
import sys
import json
import subprocess
import importlib.util
import tempfile
from pathlib import Path

FOREMAN = (Path(__file__).resolve().parents[2])  # 本文件所在树,worktree 里也测自己
sys.path.insert(0, str(FOREMAN))

from nawaban import board_view  # noqa: E402
from nawaban import context_loader as cl  # noqa: E402
from nawaban import db  # noqa: E402

FAILED: list[str] = []
DAY = 86400


def case(name: str, fn) -> None:
    try:
        fn()
        print(f"  ✓ {name}")
    except Exception as e:  # noqa: BLE001
        FAILED.append(name)
        print(f"  ✗ {name}: {type(e).__name__}: {e}")


def build_db(tmp: Path, name: str, *, now: int) -> Path:
    """造一张历史卡(走 import_task,含 provenance)+ 若干邻居 + 一条运行时拍板。"""
    p = tmp / f"{name}.db"
    if p.exists():
        p.unlink()
    db.init_db(p)
    prov = {"source": "import", "file": "x/CARD.md", "line": 12, "raw": "原文"}
    db.import_task(
        p, task_id="T-MAIN-001", title="离职后那个人的授权角色列表变空",
        status="staging-verified", waiting_on="decision", owner="ac:aaaa1111",
        created_at=now - 9 * DAY, started_at=now - 8 * DAY,
        epic="DEMO",
        context="建卡缘由:离职审批不撤授权,是不变量被破坏。" * 6,
        now="实现完成待出 PR",
        success=["授权到未注册 client 被拒(400)"], constraints=["别低估 fixture 连带面"],
        touches=["src/a.py"], adr="ADR-0041",
        sessions=[{"owner": "ac:aaaa1111", "session_id": "s-1",
                   "started_at": now - 8 * DAY, "ended_at": now - 7 * DAY,
                   "outcome": "handed_off", "summary": "切片1 done"}],
        events=[
            {"kind": "handoff", "body": "切片1 done · 下一步 src/a.py:10",
             "author": "ac:aaaa1111", "created_at": now - 7 * DAY, "session_id": "s-1"},
            {"kind": "note", "body": "needs_retitle · 旧标题原样导入 · 原始 H1:T-MAIN-001 · 老标题",
             "author": "import", "created_at": now - 9 * DAY, "session_id": None},
            {"kind": "status_change", "body": "in_progress→staging-verified",
             "author": "import", "created_at": now - 2 * DAY, "session_id": None},
        ],
        decisions=[{"question": "旧卡对齐行", "verdict": "用户拍板:就按 A 方案做",
                    "decided_by": "user", "created_at": now - 8 * DAY,
                    "rejected": [{"option": "只拆 capabilities.py", "reason": "owner 仍 bypass"}],
                    "provenance": prov}],
        refs=[{"kind": "pr", "value": "#2347", "created_at": now - 3 * DAY},
              {"kind": "acceptance_run", "value": "CI 四条全绿", "created_at": now - 2 * DAY}],
    )
    for tid, title, st in (("T-DEP-001", "前置卡:授权角色写入口的闸", "done"),
                           ("T-FAR-001", "毫不相干:办公室空调排班表", "open"),
                           ("T-SIM-001", "离职审批级联撤销授权角色的存量清扫", "in_progress")):
        db.import_task(p, task_id=tid, title=title, status=st, created_at=now - 20 * DAY,
                       context="离职 授权 角色 撤销 不变量" if tid == "T-SIM-001" else "空调 排班")
    db.link_tasks(p, "T-MAIN-001", "T-DEP-001", kind="depends_on", created_by="import")
    return p


def main() -> int:  # noqa: C901, PLR0915
    tmp = Path(tempfile.mkdtemp(prefix="workos-ctx-test-"))
    NOW = 1_800_000_000
    print(f"[nawaban context 自检] tmp={tmp}")
    p = build_db(tmp, "main", now=NOW)

    def ctx(**kw) -> str:
        return cl.build_context(p, "T-MAIN-001", now_ts=NOW, **kw)

    def t_全区渲染() -> None:
        t = ctx()
        for section in ("## 当前态", "## 验收判据 success", "## 约束 constraints",
                        "## touches", "## 对齐决策", "## 关系", "## 此前尝试",
                        "## 最近事件", "## 指针"):
            assert section in t, f"缺分区 {section}\n{t[:400]}"
        assert "T-MAIN-001" in t and "离职后那个人的授权角色列表变空" in t
        assert "ADR-0041" in t and "#2347" in t

    def t_相对年龄与免责() -> None:
        t = ctx()
        assert "时点快照,不是实况" in t, "缺快照免责头"
        assert "先回源复核" in t
        assert "9d ago" in t, f"建卡年龄该是 9d ago\n{t[:300]}"
        assert "7d ago" in t, "handoff 事件该带相对年龄"
        # 裸时间戳绝不出现(会让 LLM 不去想新鲜度)
        assert str(NOW - 9 * DAY) not in t, "渲染了裸 epoch"
        assert not re.search(r"20\d\d-\d\d-\d\dT", t), "渲染了 ISO 裸时间戳"

    def t_归属标对() -> None:
        """判例(2026-08-12):board_view.task_detail 不返回 provenance,
        导致 314 条历史导入行全被标成「运行时拍板」——恰好标反,而这正是闸②的判据。"""
        t = ctx()
        assert "历史导入·归属推断" in t, f"导入的决策行该标为历史回放\n{t}"
        assert "运行时拍板" not in t, "本卡只有导入决策,不该出现运行时拍板"
        # 补一条真运行时拍板 → 两类都要能出现且区分
        os.environ["WORKOS_DECISION_CHANNEL"] = "chat"
        try:
            db.decide(p, "T-MAIN-001", question="要不要 X", verdict="用户原话:做",
                      decided_by="user")
        finally:
            os.environ.pop("WORKOS_DECISION_CHANNEL", None)
        t2 = cl.build_context(p, "T-MAIN-001", now_ts=NOW)
        assert "运行时拍板" in t2 and "历史导入·归属推断" in t2, "两类归属都该可见且可区分"

    def t_被否项可见() -> None:
        t = ctx()
        assert "✗ 否:只拆 capabilities.py" in t, "被否项必须进装载(别重走已否决的路)"
        assert "owner 仍 bypass" in t

    def t_needs_retitle_系统标注分层() -> None:
        """G3(eval 缺口):`⚠ 旧标题制产物` 曾印在标题旁,被失忆接手者当成
        **这张卡的一个坑**写进答案。它是数据来源注解,不是任务事实 → 页脚 + [系统] 前缀。"""
        t = ctx()
        assert "[系统]" in t and "needs_retitle" in t, "系统标注该在,但要划界"
        assert t.count("needs_retitle") == 1, "既提示又占事件位 = 重复"
        title_line = next(ln for ln in t.splitlines() if ln.startswith("[T-MAIN-001]"))
        idx = t.splitlines().index(title_line)
        near_title = "\n".join(t.splitlines()[idx:idx + 3])
        assert "needs_retitle" not in near_title, f"系统标注仍贴在标题旁:{near_title}"
        assert t.rstrip().splitlines()[-1].startswith("[系统]"), "该落在页脚最后"
        assert "不是本卡的任务内容或风险" in t, "要明说它不是任务事实"

    def t_now空与origin去重() -> None:
        """now 为空(144/395 张的现实)→ 明说去 context;context==now → 不打两遍。"""
        p2 = tmp / "e.db"
        db.init_db(p2)
        db.import_task(p2, task_id="T-EMPTY-001", title="无当前态", status="open",
                       created_at=NOW - DAY, context="很长的叙事" * 50)
        t = cl.build_context(p2, "T-EMPTY-001", now_ts=NOW)
        assert "空,且无可顶替的事件" in t, f"无事件可顶替时该明说\n{t[:400]}"
        assert "## 缘由" in t
        # G2:有 handoff/status_change 时,now 空位由最近事件顶替(并标明出处,不伪装成 now)
        db.import_task(p2, task_id="T-PROMO-001", title="空 now 但有事件", status="in_progress",
                       created_at=NOW - 3 * DAY,
                       events=[{"kind": "handoff", "body": "阶段②对方 PR#627 未合并,路由仍 404",
                                "author": "ac:b", "created_at": NOW - DAY,
                                "session_id": None},
                               {"kind": "note", "body": "更早的杂记", "author": "ac:b",
                                "created_at": NOW - 2 * DAY, "session_id": None}])
        t3 = cl.build_context(p2, "T-PROMO-001", now_ts=NOW)
        state = t3.split("## 当前态")[1].split("##")[0]
        assert "以最近一条 handoff 事件顶替" in state, f"该顶替\n{state}"
        assert "路由仍 404" in state, "顶替的应是最近那条 handoff 的正文"
        assert "1d ago" in state, "顶替内容要带年龄(它是事件不是当前态)"
        db.import_task(p2, task_id="T-SAME-001", title="同文", status="open",
                       created_at=NOW - DAY, context="一句话", now="一句话")
        t2 = cl.build_context(p2, "T-SAME-001", now_ts=NOW)
        assert "## 缘由" not in t2, "context 与 now 逐字相同不该重复成两区"
        assert t2.count("一句话") == 1

    def t_预算与可见截断() -> None:
        assert len(ctx(budget=8192).encode()) <= 8192
        small = ctx(budget=1200)
        assert len(small.encode()) <= 1200, f"未守住预算:{len(small.encode())}"
        assert "## 验收判据 success" in small, "判据是硬区,预算再紧也不许砍"
        tiny = ctx(budget=700)
        assert len(tiny.encode()) <= 700
        assert "truncated" in tiny or "未展开" in tiny, "截断必须可见,不许静默丢"

    def t_检索_线索非证据() -> None:
        t = ctx()
        assert "## 相关线索" in t and "线索不是证据" in t, "检索区必须自带红线标头"
        assert "T-SIM-001" in t, "词面相近的卡该被召回"
        # 已经作为结构化边出现的卡不该在检索区重复
        lens_part = t.split("## 相关线索")[1]
        assert "T-DEP-001" not in lens_part, "已成边的卡不该再进检索区"

    def t_检索_可关与排序() -> None:
        assert "## 相关线索" not in ctx(lens_k=0), "--lens 0 该关掉检索区"
        rows = cl.related(p, "T-MAIN-001", k=3, exclude={"T-DEP-001"})
        assert rows and rows[0]["id"] == "T-SIM-001", f"最相近的该排第一:{rows}"
        assert all(r["score"] > 0 for r in rows)
        assert rows[0]["score"] >= rows[-1]["score"], "该按分降序"
        assert all(r["id"] != "T-MAIN-001" for r in rows), "不该召回自己"

    def t_边带对端实时状态() -> None:
        t = ctx()
        assert "→depends_on→ [T-DEP-001]" in t
        assert "«done»" in t, "边必须带对端实时 status(手写快照绝种)"

    def t_查无此卡给坏卡提示() -> None:
        """14 张 YAML 炸的卡不在库里 —— 报「是那 14 张之一」,不报成「不存在」。"""
        root = tmp / "repo"
        (root / ".foreman" / "tasks" / "g" / "done").mkdir(parents=True, exist_ok=True)
        (root / ".foreman" / "tasks" / "g" / "done" / "T-BROKEN-001.md").write_text(
            "---\ntask_id: T-BROKEN-001\n---\n# 坏卡\n", encoding="utf-8")
        hint = cl._not_found_hint(root, "T-BROKEN-001")
        assert "YAML 解析失败的 14 张之一" in hint, hint
        assert "import_md.py --apply" in hint, "该给出补救路径"
        assert cl._not_found_hint(root, "T-NOWHERE-001") == "✗ 卡不存在:T-NOWHERE-001"

    def t_只读不写库() -> None:
        before = (p.stat().st_mtime_ns,
                  {t: sqlite3.connect(str(p)).execute(
                      f"SELECT count(*) FROM {t}").fetchone()[0]
                   for t in ("tasks", "task_events", "task_decisions", "task_refs")})
        for tid in ("T-MAIN-001", "T-DEP-001", "T-SIM-001"):
            cl.build_context(p, tid, now_ts=NOW)
        after = (p.stat().st_mtime_ns,
                 {t: sqlite3.connect(str(p)).execute(
                     f"SELECT count(*) FROM {t}").fetchone()[0]
                  for t in ("tasks", "task_events", "task_decisions", "task_refs")})
        assert before[1] == after[1], f"行数变了:{before[1]} → {after[1]}"

    def t_done卡显示完成年龄() -> None:
        t = cl.build_context(p, "T-DEP-001", now_ts=NOW)
        assert "状态 done" in t
        assert "20d ago" in t

    # ── G1-G4:事件预算(eval workos handoff eval regression 缺口)──────────

    def _many_events_db() -> Path:
        """Exercise a synthetic task with many densely spaced events."""
        p3 = tmp / "ev.db"
        if p3.exists():
            p3.unlink()
        db.init_db(p3)
        evs = [{"kind": "note", "body": f"第 {i} 条进展 " + "填" * 200, "author": "ac:c",
                "created_at": NOW - i * 3600, "session_id": None} for i in range(1, 21)]
        # 最新一条塞进「下一步」赖以判断的密集事实(657 字量级,曾被写死的 400 字腰斩)
        evs.insert(0, {"kind": "handoff", "author": "ac:c", "created_at": NOW - 600,
                       "session_id": None,
                       "body": "阶段②对方已开工 PR#627 OPEN 未合并 · " + "背景" * 250
                               + " · 关键结论:路由仍 404,阶段②未达判据"})
        db.import_task(p3, task_id="T-EV-001", title="事件很多的卡", status="in_progress",
                       created_at=NOW - 30 * DAY, now="当前态",
                       success=["判据一"], constraints=["约束" + "长" * 300] * 6,
                       touches=[f"src/f{i}.py" for i in range(12)], events=evs)
        return p3

    def t_G1_事件先分预算() -> None:
        """G1:静态字段曾吃掉 66% 预算、事件只剩 7.8%(20取2),接手者答不出「现在到哪一步」。
        修后事件区必须是预算大头,且约束/touches 这类**几乎不变**的区先让路。"""
        p3 = _many_events_db()
        t = cl.build_context(p3, "T-EV-001", now_ts=NOW, lens_k=0)
        total = len(t.encode())
        ev_part = t.split("## 最近事件")[1].split("\n## ")[0]
        share = len(ev_part.encode()) / total
        assert share >= 0.35, f"事件区仅占 {share:.1%},G1 没生效(修前 7.8%)"
        shown = len(re.findall(r"\n  \[(?:note|handoff) ", t))
        assert shown >= 4, f"事件只展示 {shown} 条(修前 20取2)"
        tight = cl.build_context(p3, "T-EV-001", now_ts=NOW, budget=4000, lens_k=0)
        assert "已折叠" in tight, "预算紧张时约束/touches 该折叠让位(它们几乎不变)"
        assert "## 验收判据 success" in tight, "折叠的是静态区,不是判据"

    def t_G1_密集事件不被腰斩() -> None:
        """判例:单条配额写死 400 字,把含「路由仍 404」的 657 字事件从中间裁断
        —— 与 G1 同型的错误,只是尺度更小。最新事件要按新近度拿到足额配额。"""
        p3 = _many_events_db()
        t = cl.build_context(p3, "T-EV-001", now_ts=NOW, lens_k=0)
        assert "PR#627" in t, "最新事件的开头该在"
        assert "路由仍 404" in t, "最新事件**结尾**的关键结论也必须在(别腰斩)"

    def t_G4_截断是祈使句() -> None:
        p3 = _many_events_db()
        t = cl.build_context(p3, "T-EV-001", now_ts=NOW, lens_k=0)
        assert "⚠ 还有" in t and "先取全" in t, "截断提示要能被读成警告+动作"
        assert "nawaban context T-EV-001 --events" in t, "要给出可直接跑的补全命令"
        m = re.search(r"共 (\d+) 条", t)
        assert m and int(m.group(1)) == 21, f"总数要说真话(21 条),实际写了 {m and m.group(1)}"

    def t_事件总数不被上游limit骗() -> None:
        """判例(与 provenance 同族):board_view.EVENT_LIMIT=20 是按人视图设的,
        复用它 → 33 条的卡表头写「共 20 条」、祈使句叫人 --events 20,两处都撒谎且不报错。"""
        p3 = _many_events_db()
        rows, total = cl._fetch_events(p3, "T-EV-001", 999)
        assert total == 21, f"真实总数该是 21,得到 {total}"
        assert len(board_view.task_detail(p3, "T-EV-001")["events"]) <= 20, \
            "前提:上游确实截断在 20(此断言失效说明上游改了,本测试要重估)"

    def t_G1_不饿死验收判据() -> None:
        """G1 抬事件不许把 B 视图唯一胜过 md 的维度(验收复述 15:14)压垮。"""
        p3 = _many_events_db()
        for b in (8192, 3000, 1500, 1200):
            t = cl.build_context(p3, "T-EV-001", now_ts=NOW, budget=b, lens_k=0)
            assert len(t.encode()) <= b, f"budget={b} 超了:{len(t.encode())}"
            assert "## 验收判据 success" in t, f"budget={b} 把判据挤掉了"
            assert "判据一" in t, f"budget={b} 判据只剩标题没内容"

    # ── SessionStart 分流(success⑤)────────────────────────────────
    HOOK = FOREMAN / "hooks/foreman_session_start.py"

    def mkrepo(name: str, *, with_db: bool, card_in_db: bool = True) -> Path:
        root = tmp / name
        d = root / ".foreman" / "tasks" / "demo" / "active"
        d.mkdir(parents=True, exist_ok=True)
        (d / "T-BANNER-001.md").write_text(
            '---\ntask_id: T-BANNER-001\nstatus: in_progress\nowner: "ac:zzzz9999"\n'
            "touches:\n  - src/z.py\nnotes: 横幅测试卡\n---\n# T-BANNER-001 · 横幅测试\n",
            encoding="utf-8")
        if with_db:
            dbp = root / ".foreman" / "workos.db"
            db.init_db(dbp)
            if card_in_db:
                db.import_task(dbp, task_id="T-BANNER-001", title="横幅测试",
                               status="in_progress", owner="ac:zzzz9999",
                               created_at=NOW - DAY, now="当前态一句")
        return root

    def run_hook(root: Path, *, flag: str | None) -> str:
        env = dict(os.environ)
        env.pop("WORKOS_CONTEXT_BANNER", None)
        if flag:
            env["WORKOS_CONTEXT_BANNER"] = flag
        env["FOREMAN_OWNER"] = "ac:zzzz9999"
        r = subprocess.run(
            [sys.executable, str(HOOK)],
            input=json.dumps({"cwd": str(root),
                              "session_id": "zzzz9999-0000-0000-0000-000000000001"}),
            capture_output=True, text=True, env=env, timeout=60)
        return r.stdout

    def t_默认关_零输出() -> None:
        """硬验收:开关关时分流函数必须返回 False 且一个字节都不打 —— 调用点是
        `if not _context_banner(...)`,所以这等价于旧分支逐字节原样跑。"""
        import io
        from contextlib import redirect_stdout
        sys.path.insert(0, str(FOREMAN))
        from hooks import foreman_session_start as ss
        os.environ.pop("WORKOS_CONTEXT_BANNER", None)
        buf = io.StringIO()
        with redirect_stdout(buf):
            got = ss._context_banner([{"task_id": "X", "status": "open", "waiting": "",
                                       "touches": "a.py"}], tmp)
        assert got is False, "默认必须关"
        assert buf.getvalue() == "", f"默认关却打了字:{buf.getvalue()!r}"

    def t_默认关_端到端仍是db横幅() -> None:
        """md 轨已退役(workos retire regression):默认关时横幅读 db 出卡,不走装载器。"""
        out = run_hook(mkrepo("r-off", with_db=True), flag=None)
        assert "T-BANNER-001" in out, f"该有 db 横幅卡行\n{out}"
        assert "冷启动装载" not in out, "默认关不该出现装载器输出"

    def t_开启_走装载器() -> None:
        out = run_hook(mkrepo("r-on", with_db=True), flag="1")
        assert "NAWABAN 冷启动装载" in out, f"开关开该走装载器\n{out}"
        assert "当前态一句" in out
        assert "T-BANNER-001 · touches: src/z.py" not in out, "装载应**替代** md 片段"

    def t_failsoft_无库落回() -> None:
        out = run_hook(mkrepo("r-nodb", with_db=False), flag="1")
        assert "T-BANNER-001 · touches: src/z.py" in out, f"无库该落回 md 片段\n{out}"
        assert "冷启动装载" not in out

    cases = [
        ("全区渲染齐", t_全区渲染),
        ("相对年龄 + 快照免责 · 无裸时间戳", t_相对年龄与免责),
        ("决策归属:历史导入 vs 运行时拍板 标对", t_归属标对),
        ("被否项进装载(别重走已否决的路)", t_被否项可见),
        ("G3 系统标注分层(页脚 · 不贴标题)", t_needs_retitle_系统标注分层),
        ("G2 now 空位由最近事件顶替 + context/now 去重", t_now空与origin去重),
        ("G1 事件先分预算(修前 7.8%)", t_G1_事件先分预算),
        ("G1 密集事件不被单条配额腰斩", t_G1_密集事件不被腰斩),
        ("G4 截断提示是祈使句 + 总数说真话", t_G4_截断是祈使句),
        ("事件总数不被上游 EVENT_LIMIT 骗", t_事件总数不被上游limit骗),
        ("G1 不饿死验收判据(多档预算)", t_G1_不饿死验收判据),
        ("预算守得住 + 截断可见 + 判据不被砍", t_预算与可见截断),
        ("检索区:线索非证据 + 排除已成边", t_检索_线索非证据),
        ("检索:可关 · 排序 · 不召回自己", t_检索_可关与排序),
        ("边带对端实时状态", t_边带对端实时状态),
        ("查无此卡 → 给 14 坏卡提示与补救路径", t_查无此卡给坏卡提示),
        ("只读不写库", t_只读不写库),
        ("done 卡显示完成年龄", t_done卡显示完成年龄),
        ("SessionStart 默认关:零输出(逐字节等价的机械保证)", t_默认关_零输出),
        ("SessionStart 默认关:端到端是 db 横幅", t_默认关_端到端仍是db横幅),
        ("SessionStart 开启:走装载器并替代 md 片段", t_开启_走装载器),
        ("SessionStart fail-soft:无库落回", t_failsoft_无库落回),
    ]
    skipped = 0
    for name, fn in cases:
        if fn is t_failsoft_无库落回 and importlib.util.find_spec("yaml") is None:
            print(f"  SKIP: {name}: historical Markdown parsing requires optional PyYAML")
            skipped += 1
            continue
        case(name, fn)

    if FAILED:
        print(f"\nFAILED({len(FAILED)}): {FAILED}")
        return 1
    print(f"\nOK · {len(cases) - skipped} passed, {skipped} skipped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
