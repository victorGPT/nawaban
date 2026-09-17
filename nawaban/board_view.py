#!/usr/bin/env python3
"""NAWABAN-BOARD-VIEW-001 · 人视图:本地只读 web 板(替代 Obsidian 开工看板.md)。

跑法:python3 nawaban/board_view.py [--db PATH] [--port 8813] [--host 127.0.0.1]
     → http://127.0.0.1:8813/           列表板(Linear 皮 · 字段仍是现卡)
     → http://127.0.0.1:8813/?view=dag&focus=<id>  本卡 ego 子图(卡面 DAG 按钮 / 快捷键 g)
       (?view=dag 无 focus 的全图仍可访问,但 nav 入口已摘——模块视图取代了它,BOARD-REVAMP-DAG-PRUNE-001)
     → http://127.0.0.1:8813/?view=inbox  收件箱(人侧队列:等拍板/放行/验收的 ask)
     → http://127.0.0.1:8813/?view=modules  模块流转(epic 聚合:进度 + 内部依赖链,可 &epic=<名> 直达)

本体/投影原则:板是投影不是真相——本模块只开只读连接(file:...?mode=ro),
物理上不可能写库;人的写操作走 CLI / 对话拍板通道。
反陈旧:全部历史条目渲染相对年龄("18h ago"),不显示裸时间戳(Hermes 研究 §5)。

排序(NAWABAN-BOARD-LIVE-001 起):等拍板钉最前,其余按**最近活动**倒序
(task_events 最后一条 → started_at → created_at),躺着不动的自然沉底。
存活:owner 窗口在不在经 foreman_liveness(herdr)标在卡上——探测不可用一律不标,
未知绝不渲染成已死。
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sqlite3
import subprocess
import sys
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import foreman_liveness  # noqa: E402
from nawaban import db  # noqa: E402

DAG_DIR = Path(__file__).resolve().parent / "dagview"  # 单卡 ego 子图页(卡面 DAG 按钮 / 快捷键 g)
VENDOR_DIR = DAG_DIR / "vendor"
# 新版前端(webui/ · vite build 产物)。有 dist 就 / 吐它;没有回落到内嵌旧板,永不 404。
WEBUI_DIST = Path(__file__).resolve().parent / "webui" / "dist"
_ACTIVE = frozenset({"open", "claimed", "in_progress", "staging-verified"})

# 五列:验收队列在最左(它才是在等人的);done 只取最近 12 张(对齐 开工看板.md「最近完成」)
COLUMNS = [
    ("staging-verified", "验收队列", "#c0392b"),
    ("in_progress", "进行中", "#3b82f6"),
    ("claimed", "已认领", "#d19a00"),
    ("open", "待认领", "#8a8a8a"),
    ("done", "最近完成", "#2e9e5b"),
]
DONE_LIMIT = 12
EVENT_LIMIT = 20
# 只有这两列意味着「本该有人在干」——在别处标窗口存活是噪音(验收队列 51 张会糊一墙墓碑)
LIVE_COLUMNS = frozenset({"claimed", "in_progress"})
TRANSCRIPTS = Path.home() / ".claude" / "projects"
BUSY_WINDOW_S = 120  # 转录多久没追写就不算在跑(板 30s 刷一次,窗口取宽一点容得下慢工具)


# ── 数据层(只读) ────────────────────────────────────────────────

def _ro(path: Path | str) -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{Path(path)}?mode=ro", uri=True, timeout=10)
    con.row_factory = sqlite3.Row
    return con


def _j(s):
    if not s:
        return None
    try:
        return json.loads(s)
    except ValueError:
        return s  # letters.links 是裸文本(URL 等),不是 JSON


#: 前缀归并阈值 —— 该前缀下**有 capability 的卡**里某功能占比达标,才把它的兜底卡也归过去。
#: 低于阈值的前缀(实测 SSC 34% / OBS 50% / KB 50%)下面确实分属多个功能,归并就是硬凑。
PREFIX_MERGE_SHARE = 0.6
PREFIX_MERGE_MIN = 3   # 样本太少时占比不可信


def prefix_hints(con: sqlite3.Connection) -> dict[str, str]:
    """ID 前缀 → 主功能。修的是「同一功能被拆成两组」:填了 epic 的卡与没填的走兜底
    归到 ID 前缀,同一个功能域会裂成两组并在 DAG 上伪造假边。这份映射把兜底卡拉回它本来的组。

    数据驱动,不硬编码映射表:填过 epic 的卡自己投票决定这个前缀属于谁。
    """
    tally: dict[str, dict[str, int]] = {}
    for tid, cap in con.execute("SELECT id, epic FROM tasks"):
        k = fold_key(tid, cap)
        pre = tid.split("-")[0]
        if k == pre:          # 自己就是走兜底来的,没有投票权
            continue
        tally.setdefault(pre, {})
        tally[pre][k] = tally[pre].get(k, 0) + 1
    out = {}
    for pre, votes in tally.items():
        total = sum(votes.values())
        top, n = max(votes.items(), key=lambda kv: kv[1])
        if total >= PREFIX_MERGE_MIN and n / total >= PREFIX_MERGE_SHARE:
            out[pre] = top
    return out


def fold_key(task_id: str, epic: str | None,
             hints: dict[str, str] | None = None) -> str:
    """卡 → 折叠组名。同一功能的不同写法必须落到同一个键上。

    epic 是**自由文本**(capability 列退役后由它承担分组 · FOREMAN-SIMPLIFY-003),同一功能有多种写法:
        运维开关面板(加载提速 · stale-while-revalidate)
        运维开关面板(OPS-FLAGS-PANEL-001 后继 · 版本开关分区)
    直接 GROUP BY 会把本该一组的拆开。所以截到第一个分隔符 —— 后面那串全是
    「哪份文档 / 哪张卡 / 哪个 ADR」的注解,不是功能名的一部分。

    ``n/a`` / ``无档…`` 不是功能名,是「没填」的各种说法 —— 走 ID 前缀兜底,
    好过留一个叫「未归类」的大杂烩分组(那等于没分)。
    """
    s = (epic or "").strip()
    if s and not s.startswith(("n/a", "无档")):
        if s.startswith("docs/capabilities/"):
            return s.rsplit("/", 1)[-1].removesuffix(".md")
        cuts = [i for i in (s.find("·"), s.find("("), s.find("（")) if i > 0]
        k = (s[:min(cuts)] if cuts else s).strip()
        if k:
            return k
    # 兜底:ID 前缀第一段。曾试过识别「有意义的子域」(把 IAM2-SSO-* 留成 IAM2-SSO),
    # 但 SSO 与 SSC-POOL-* 里的 POOL、MEM-CORE-* 里的 CORE 在字符层面分不开 ——
    # 任何长度/字母规则都是瞎猜。兜底本就是粗粒度:要精细就把 epic 填上。
    pre = task_id.split("-")[0]
    return (hints or {}).get(pre, pre)


def _dep_map(con: sqlite3.Connection, hints: dict[str, str]) -> dict[str, dict]:
    """卡 → {blocked_by: [组名], blocks: [组名]}。**只算活跃的跨组依赖**。

    两条过滤都不是可选项:
    - 上游已 done 的边不算阻塞 —— 否则卡上永远挂着一条早就解开的假红。
    - 组内边不算 —— 实测 64 条活跃边里 59 条是同功能内部的先后,那是实现细节;
      全渲染出来就是噪音,而人在看板上真正要知道的是「这摊活是不是卡在别人身上」。
    """
    fold: dict[str, str] = {}
    alive: set[str] = set()
    for tid, cap, st in con.execute("SELECT id, epic, status FROM tasks"):
        fold[tid] = fold_key(tid, cap, hints)
        if st != "done":
            alive.add(tid)
    out: dict[str, dict] = {}
    for src, dst in con.execute("SELECT src, dst FROM task_edges WHERE kind='depends_on'"):
        if src not in fold or dst not in fold:
            continue
        gs, gd = fold[src], fold[dst]
        if gs == gd:
            continue                      # 组内 = 实现细节
        if dst in alive:                  # 上游还没完成 → 下游真被卡着
            out.setdefault(src, {}).setdefault("blocked_by", set()).add(gd)
        if src in alive:                  # 下游还活着 → 上游确实挡着别人
            out.setdefault(dst, {}).setdefault("blocks", set()).add(gs)
    return {k: {kk: sorted(vv) for kk, vv in v.items()} for k, v in out.items()}


def _fold(tasks: list[dict]) -> list[dict]:
    """列内按 fold_key 分组。只有一张的**不套壳**(套了等于白占一行还多一次点击)。

    组保持原顺序:按组内第一张卡的位置排,所以「等拍板钉最前」的排序不被打乱。
    """
    order: list[str] = []
    buckets: dict[str, list[dict]] = {}
    for t in tasks:
        k = t.get("fold") or t["id"]
        if k not in buckets:
            buckets[k] = []
            order.append(k)
        buckets[k].append(t)
    out: list[dict] = []
    for k in order:
        members = buckets[k]
        if len(members) == 1:
            out.append({"kind": "card", "task": members[0]})
            continue
        # 大卡携带组内信号,不是纯计数 —— 光写「12 张」帮不了人决定要不要点开
        decision = sum(1 for m in members
                       if m.get("waiting_on") == "decision" and m["status"] != "done")
        working = sum(1 for m in members if (m.get("live") or {}).get("tier") == "working")
        blocked = sorted({g for m in members for g in (m.get("dep") or {}).get("blocked_by", [])
                          if g != k})
        blocks = sorted({g for m in members for g in (m.get("dep") or {}).get("blocks", [])
                         if g != k})
        out.append({"kind": "group", "name": k, "n": len(members),
                    "decision": decision, "working": working,
                    "blocked_by": blocked, "blocks": blocks, "tasks": members})
    return out


def _card(r: sqlite3.Row, hints: dict[str, str] | None = None) -> dict:
    return {
        "id": r["id"], "title": r["title"], "status": r["status"],
        "waiting_on": r["waiting_on"], "owner": r["owner"], "epic": r["epic"],
        "now": r["now"], "created_at": r["created_at"],
        "fold": fold_key(r["id"], r["epic"], hints),
        "started_at": r["started_at"], "completed_at": r["completed_at"],
    }


_BASE = ("SELECT t.*, MAX(e.created_at) AS last_event_at"
         " FROM tasks t LEFT JOIN task_events e ON e.task_id = t.id"
         " WHERE t.status = :status{touched} GROUP BY t.id")
# 「更新时间」筛(Linear 式 filter · 用户 2026-09-08 选定):时间段内有事件、或段内建/开工/完成的卡。
# 用 EXISTS 而不是改 LEFT JOIN 的范围,否则 last_event_at(卡面「没动」)会变成「段内最后一次」。
_TOUCHED = (" AND (EXISTS (SELECT 1 FROM task_events x WHERE x.task_id = t.id"
            " AND x.created_at >= :lo AND x.created_at < :hi)"
            " OR t.created_at BETWEEN :lo AND :hi - 1"
            " OR t.started_at BETWEEN :lo AND :hi - 1"
            " OR t.completed_at BETWEEN :lo AND :hi - 1)")


def range_bounds(since: str, until: str) -> tuple[int, int]:
    """'YYYY-MM-DD' 两端(本机时区 · 含 until 当天)→ [since 0 点, until 次日 0 点) epoch。非法抛 ValueError。"""
    lo = datetime.strptime(since, "%Y-%m-%d")
    hi = datetime.strptime(until, "%Y-%m-%d") + timedelta(days=1)
    if hi <= lo:
        raise ValueError("until 早于 since")
    return int(lo.timestamp()), int(hi.timestamp())


# 活性三档的边界。板 30s 刷一次,working 窗口取宽一点容得下慢工具。
IDLE_WINDOW_S = 8 * 3600   # 超过这个就不叫「闲着」,叫「早没动静」
SCAN_BUDGET_S = 1.5        # 扫转录目录的时间预算 —— 板不能因为探测慢而卡住


def _transcript_index() -> tuple[dict[str, float], bool]:
    """一次扫描建 session 前缀 → 最新 mtime 索引。返回 (索引, 是否完整)。

    为什么不用 herdr 的 agent_status:实测它对 claude 窗口**恒报 idle**
    (2026-08-13:本窗口正跑工具时它仍报 idle,只有 grok/codex 那两个 pane 报得出
    working)。照它渲染的话绿点永远不亮 —— 一个从不触发的指示器比没有更坏。
    而且 herdr 没装/没跑时整张表是 None,那会让**所有**卡退化成未知。

    转录文件每次工具调用都会追写,是这台机器上最诚实的「这个窗口还活着吗」信号。
    """
    idx: dict[str, float] = {}
    deadline = time.monotonic() + SCAN_BUDGET_S
    complete = True
    for p in TRANSCRIPTS.glob("*/*.jsonl"):
        if time.monotonic() > deadline:
            complete = False   # 预算用完:已扫到的照用,没扫到的按「未知」留白
            break
        try:
            m = p.stat().st_mtime
        except OSError:
            continue
        k = p.stem[:8]
        if m > idx.get(k, 0.0):
            idx[k] = m
    return idx, complete


def _live_of(owner: str | None, idx: dict[str, float] | None) -> dict | None:
    """owner → 活性档位。None = 未知,**必须留白不许渲染成已死**。

    未知的来源有两种,都不能当「已关」:owner 不是 ac: 派生的(grok / ac/main 这类),
    或者索引本身不可用。渲染成已死会让人放心去收窄一把真在用的锁。

    档位:working(此刻在动)/ idle(窗口在但闲着)/ cold(早没动静)/ no-window(找不到窗口)。
    cold 与 no-window 是**渲染上弱化**的依据,不是「这卡废了」的判断 ——
    人可能只是关了窗口而活还在推进。那个判断要带置信度,不在本函数里做。
    """
    if idx is None or not owner or not owner.startswith("ac:"):
        return None
    newest = idx.get(owner[3:])
    if newest is None:
        return {"tier": "no-window", "age_s": None}
    age = int(time.time() - newest)
    tier = ("working" if age < BUSY_WINDOW_S
            else "idle" if age < IDLE_WINDOW_S else "cold")
    return {"tier": tier, "age_s": age}


def board_data(path: Path | str, live: dict | None = None,
               idx: dict[str, float] | None = None,
               touched: tuple[int, int] | None = None) -> dict:
    """五列投影。等拍板钉最前,其余按最近活动倒序。

    ``idx`` = ``_transcript_index()`` 的索引;None(默认)= 不探测,本函数保持纯函数。
    ``live`` 保留是为了不破坏既有调用方签名,本函数已不再使用它 ——
    活性改从转录 mtime 直接算(见 ``_live_of``)。
    ``touched`` = (lo, hi) epoch:只留这段时间动过的卡(列仍按**当前**状态分)。
    """
    params: dict = {}
    if touched:
        params["lo"], params["hi"] = touched
    base = _BASE.format(touched=_TOUCHED if touched else "")
    con = _ro(path)
    try:
        hints = prefix_hints(con)
        try:
            deps = _dep_map(con, hints)
        except sqlite3.Error:   # 看板是底线:边查询挂了就不显示依赖,不阻塞渲染
            deps = {}
        # 「未开工却已有 PR/合并」:巡检结论(foreman-stale.txt)同口径,直接从库算,不读文件
        merged: dict[str, list[str]] = {}
        try:
            for r in con.execute(
                "SELECT r.task_id, r.kind, r.value FROM task_refs r JOIN tasks t ON t.id=r.task_id"
                " WHERE t.status='open' AND r.kind IN ('pr','merge_sha') ORDER BY r.created_at"):
                v = r["value"] if r["kind"] == "pr" else r["value"][:8]
                merged.setdefault(r["task_id"], []).append(v)
        except sqlite3.Error:   # 看板是底线:这层查询挂了就不显示徽标
            merged = {}
        cols = []
        for key, title, color in COLUMNS:
            if key == "done":
                rows = con.execute(
                    base + " ORDER BY COALESCE(t.completed_at, t.created_at) DESC LIMIT :lim",
                    # 筛了时间段要的是「那段做完的全部」,不是「最近 12 张」;-1 = 不限
                    {**params, "status": key, "lim": -1 if touched else DONE_LIMIT},
                ).fetchall()
            else:
                rows = con.execute(
                    base + " ORDER BY (t.waiting_on IS NOT 'decision'),"
                           " COALESCE(last_event_at, t.started_at, t.created_at) DESC",
                    {**params, "status": key},
                ).fetchall()
            tasks = []
            for r in rows:
                c = _card(r, hints)
                if r["id"] in deps:
                    c["dep"] = deps[r["id"]]
                if r["id"] in merged:
                    c["merged_refs"] = merged[r["id"]]
                c["active_at"] = r["last_event_at"] or r["started_at"] or r["created_at"]
                if key in LIVE_COLUMNS:
                    c["live"] = _live_of(r["owner"], idx)
                tasks.append(c)
            col = {"key": key, "title": title, "color": color, "tasks": tasks,
                   "rows": _fold(tasks)}
            if key in LIVE_COLUMNS:
                # 列头汇总:34 张里只有 3 张真在动,这个反差本身就是最该被看见的信息
                tally: dict[str, int] = {}
                for t in tasks:
                    tier = (t.get("live") or {}).get("tier", "unknown")
                    tally[tier] = tally.get(tier, 0) + 1
                col["live_tally"] = tally
            cols.append(col)
        return {"columns": cols}
    finally:
        con.close()


def inbox_data(path: Path | str) -> dict:
    """人侧收件箱投影(NAWABAN-INBOX-VIEW-001)。

    看板回答「所有任务什么状态」,收件箱回答「现在轮到我做什么」——
    前者是 agent 需要的,后者是人需要的。整个界面就是 db.open_asks() 一个查询,
    没有列、没有状态机、没有过滤器要选。

    `flow` 是**活性自证**:空态句「没有需要你的事」若因上游断了而恒为真,它就成了
    一个从不触发的指示器 —— 把「信号源坏了」伪装成「没事发生」,比没有更坏。
    带上流量数,人一眼看得出这条路径还活着。
    """
    con0 = _ro(path)
    try:
        has_asks = con0.execute(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='asks'"
        ).fetchone()[0]
    finally:
        con0.close()
    if not has_asks:
        # 老库(未迁移)。看板是底线:这里返回空结构而不是抛 —— 叠加层不可用时
        # 页面该当它不存在,不该看到崩掉的连接。
        return {"total": 0, "oldest_days": 0.0, "unavailable": True,
                "groups": [{"kind": k, "title": t, "items": []} for k, t in
                           (("authorize", "放行"), ("accept", "验收"), ("decide", "拍板"))],
                "flow": {"raised_7d": 0, "closed_7d": 0}, "agent_side": 0}

    asks = db.open_asks(path)
    order = {"authorize": 0, "accept": 1, "decide": 2}
    # agent 没把握的(<0.5)沉到本组末尾,但一条不藏 —— 藏起来它就变成人的盲区
    # (ADR-0209 原则 6)。人手工提的没有分数,按有把握处理(0.5)。
    def _conf(a: dict) -> float:
        # 人手工提的没有分数,按有把握处理(0.5)。注意不能写 `or 0.5` —— 0.0 是
        # 合法的「毫无把握」,被 falsy 吞掉之后反而不沉底。
        c = a.get("confidence")
        return 0.5 if c is None else float(c)

    asks.sort(key=lambda a: (order.get(a["kind"], 9), _conf(a) < 0.5, -a["stalled_days"]))

    con = _ro(path)
    try:
        week = int(time.time()) - 7 * 86400
        raised = con.execute("SELECT count(*) FROM asks WHERE raised_at>?", (week,)).fetchone()[0]
        closed = con.execute("SELECT count(*) FROM asks WHERE closed_at>?", (week,)).fetchone()[0]
        agent_side = con.execute(
            "SELECT count(*) FROM tasks WHERE status NOT IN ('done','cancelled') AND id NOT IN"
            " (SELECT task_id FROM ask_tasks WHERE ask_id IN"
            "  (SELECT id FROM asks WHERE closed_at IS NULL))").fetchone()[0]
    finally:
        con.close()

    groups = [
        {"kind": "authorize", "title": "放行", "items": [a for a in asks if a["kind"] == "authorize"]},
        {"kind": "accept", "title": "验收", "items": [a for a in asks if a["kind"] == "accept"]},
        {"kind": "decide", "title": "拍板", "items": [a for a in asks if a["kind"] == "decide"]},
    ]
    return {
        "total": len(asks),
        "oldest_days": max((a["stalled_days"] for a in asks), default=0.0),
        "groups": groups,
        "flow": {"raised_7d": raised, "closed_7d": closed},
        "agent_side": agent_side,
    }


def modules_data(path: Path | str) -> dict:
    """模块(epic)聚合视图数据(BOARD-REVAMP-DAG-IMPL-001)。

    全量卡 + depends_on 边,分组/分层/进度全在前端算——766 卡量级一次传输 <100KB,
    比在服务端做聚合再开 N 个细化端点省(形态定稿见 BOARD-REVAMP-DAG-PROTO-001 decide 行)。
    """
    con = _ro(path)
    try:
        tasks = [{"i": r["id"], "t": (r["title"] or "")[:60], "s": r["status"],
                  "e": r["epic"] or ""}
                 for r in con.execute("SELECT id, title, status, epic FROM tasks")]
        deps = [[r["src"], r["dst"]] for r in con.execute(
            "SELECT src, dst FROM task_edges WHERE kind='depends_on'")]
    finally:
        con.close()
    return {"tasks": tasks, "deps": deps}


def task_detail(path: Path | str, task_id: str) -> dict:
    """卡详情。边双向渲染(出边+入边)并 JOIN 对端实时 status——手写快照注解绝种。"""
    con = _ro(path)
    try:
        row = con.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if row is None:
            raise db.NawabanError(f"卡不存在:{task_id}")
        d = _card(row)
        d.update({
            "origin": row["origin"], "adr": row["adr"],
            "success": _j(row["success"]), "constraints": _j(row["constraints_"]),
            "touches": _j(row["touches"]),
        })
        d["edges_out"] = [
            {"kind": e["kind"], "other": e["dst"], "dir": "out", "note": e["note"],
             "other_title": e["title"], "other_status": e["status"],
             "other_waiting_on": e["waiting_on"]}
            for e in con.execute(
                "SELECT e.kind, e.dst, e.note, t.title, t.status, t.waiting_on"
                " FROM task_edges e JOIN tasks t ON t.id=e.dst WHERE e.src=?"
                " ORDER BY e.kind, e.dst", (task_id,))
        ]
        d["edges_in"] = [
            {"kind": e["kind"], "other": e["src"], "dir": "in", "note": e["note"],
             "other_title": e["title"], "other_status": e["status"],
             "other_waiting_on": e["waiting_on"]}
            for e in con.execute(
                "SELECT e.kind, e.src, e.note, t.title, t.status, t.waiting_on"
                " FROM task_edges e JOIN tasks t ON t.id=e.src WHERE e.dst=?"
                " ORDER BY e.kind, e.src", (task_id,))
        ]
        d["decisions"] = [
            {"id": r["id"], "question": r["question"], "verdict": r["verdict"],
             "rejected": _j(r["rejected"]), "decided_by": r["decided_by"],
             "adr": r["adr"], "supersedes": r["supersedes"],
             "created_at": r["created_at"]}
            for r in con.execute(
                "SELECT * FROM task_decisions WHERE task_id=? ORDER BY created_at DESC, id DESC",
                (task_id,))
        ]
        d["events"] = [
            {"kind": r["kind"], "body": r["body"], "author": r["author"],
             "session_id": r["session_id"], "created_at": r["created_at"]}
            for r in con.execute(
                "SELECT * FROM task_events WHERE task_id=?"
                " ORDER BY created_at DESC, id DESC LIMIT ?", (task_id, EVENT_LIMIT))
        ]
        d["refs"] = [
            {"kind": r["kind"], "value": r["value"], "note": r["note"],
             "created_at": r["created_at"]}
            for r in con.execute(
                "SELECT * FROM task_refs WHERE task_id=? ORDER BY created_at DESC", (task_id,))
        ]
        d["sessions"] = [
            {"owner": r["owner"], "session_id": r["session_id"],
             "started_at": r["started_at"], "ended_at": r["ended_at"],
             "outcome": r["outcome"], "summary": r["summary"], "note": r["note"]}
            for r in con.execute(
                "SELECT * FROM task_sessions WHERE task_id=? ORDER BY started_at DESC",
                (task_id,))
        ]
        # 信件(worker→总监汇报,NAWABAN-LETTERS-DB-001)只读投影;标已读仍走 cli letter-read
        d["letters"] = [
            {"id": r["id"], "kind": r["kind"], "msg": r["msg"], "links": _j(r["links"]),
             "session_id": r["session_id"], "created_at": r["created_at"],
             "read_at": r["read_at"]}
            for r in con.execute(
                "SELECT * FROM letters WHERE task_id=? ORDER BY created_at DESC LIMIT ?",
                (task_id, EVENT_LIMIT))
        ]
        return d
    finally:
        con.close()


def _clamp(n, lo: int, hi: int, default: int) -> int:
    if n is None or n == "":
        return default
    try:
        v = int(n)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, v))


def _ego_keep(
    root: str,
    edges: list[dict],
    *,
    max_depth: int,
    max_nodes: int,
) -> tuple[set[str], dict]:
    """本卡 + depends 上游 1-hop + 下游传递。

    src depends_on dst ⇒ dst 是上游, src 是下游。
    """
    up: dict[str, list[str]] = {}
    down: dict[str, list[str]] = {}
    for e in edges:
        s, d, k = e["src"], e["dst"], e["kind"]
        if k == "depends_on":
            up.setdefault(s, []).append(d)
            down.setdefault(d, []).append(s)

    keep = {root}
    truncated = False
    downstream_n = 0
    upstream_n = 0

    def take(nid: str) -> bool:
        nonlocal truncated
        if nid in keep:
            return True
        if len(keep) >= max_nodes:
            truncated = True
            return False
        keep.add(nid)
        return True

    dq: deque[tuple[str, int]] = deque([(root, 0)])
    seen_down = {root}
    while dq:
        cur, depth = dq.popleft()
        kids = down.get(cur, [])
        if depth >= max_depth:
            if kids:
                truncated = True
            continue
        for nxt in kids:
            if nxt in seen_down:
                continue
            if not take(nxt):
                break
            seen_down.add(nxt)
            downstream_n += 1
            dq.append((nxt, depth + 1))

    for nxt in up.get(root, []):
        if take(nxt):
            upstream_n += 1

    return keep, {
        "root": root,
        "max_depth": max_depth,
        "max_nodes": max_nodes,
        "upstream": upstream_n,
        "downstream": downstream_n,
        "truncated": truncated,
    }


def _stats_of(nodes: list[dict], n_links: int) -> dict:
    stats = {
        "total": len(nodes),
        "edges": n_links,
        "by_status": {},
        "needs_decision": 0,
        "blocked": 0,
        "frontier": 0,
        "done": 0,
        "by_epic": {},
    }
    for n in nodes:
        status = n["status"]
        epic = n["epic"]
        stats["by_status"][status] = stats["by_status"].get(status, 0) + 1
        stats["by_epic"][epic] = stats["by_epic"].get(epic, 0) + 1
        if n["flags"]["done"]:
            stats["done"] += 1
        if n["flags"]["blocked"]:
            stats["blocked"] += 1
        if n["flags"]["frontier"]:
            stats["frontier"] += 1
        if n["flags"]["needs_decision"]:
            stats["needs_decision"] += 1
    return stats


#: 组节点的紧急度 —— 组的 role 取组内最紧急的那张卡,不然一组里有一张等拍板会被 309 张 done 淹掉
_ROLE_RANK = ("decision", "blocked", "frontier", "active", "staging", "open", "done")


def fold_graph(g: dict, hints: dict[str, str]) -> dict:
    """把卡级图折成功能级图(DAG-FOLD-001)。

    实测 435 节点 419 边平铺时糊成屏幕中间一小片,任何关系都读不出来;而按功能折叠后
    真正的跨功能流转只有个位数条 —— 那才是能一眼看懂的图。组内边(实测占 90%+)是实现细节,
    折进组里不显示。

    复用 board_view.fold_key/prefix_hints —— 看板与 DAG **必须同一套分组**,
    否则两处各说各话,人会以为是两个系统。
    """
    members: dict[str, list[dict]] = {}
    of: dict[str, str] = {}
    for n in g["nodes"]:
        k = fold_key(n["id"], n.get("epic"), hints)
        of[n["id"]] = k
        members.setdefault(k, []).append(n)

    nodes = []
    for k, ms in members.items():
        roles = {m.get("role") for m in ms}
        role = next((r for r in _ROLE_RANK if r in roles), "active")
        alive = [m for m in ms if m.get("role") != "done"]
        nodes.append({
            "id": f"grp:{k}", "kind": "group", "title": k, "n": len(ms),
            "alive": len(alive), "role": role,
            "status": f"{len(alive)}/{len(ms)} 活跃",
            "decision": sum(1 for m in ms if m.get("role") == "decision"),
            "members": [m["id"] for m in ms],
            "val": min(2 + len(ms) ** 0.5, 8),
        })

    agg: dict[tuple[str, str, str], int] = {}
    for l in g["links"]:
        a, b = of.get(l["source"]), of.get(l["target"])
        if not a or not b or a == b:      # 组内边 = 实现细节,不出现在功能级图上
            continue
        agg[(a, b, l["kind"])] = agg.get((a, b, l["kind"]), 0) + 1
    links = [{"source": f"grp:{a}", "target": f"grp:{b}", "kind": kind, "count": c,
              "note": f"{c} 条卡级依赖" if c > 1 else None}
             for (a, b, kind), c in agg.items()]

    return {**g, "nodes": nodes, "links": links, "folded": True,
            "stats": {**g.get("stats", {}), "folded_groups": len(nodes),
                      "folded_edges": len(links),
                      "raw_nodes": len(g["nodes"]), "raw_edges": len(g["links"])}}


def graph_data(
    path: Path | str,
    *,
    root: str | None = None,
    max_depth: int = 8,
    max_nodes: int = 80,
) -> dict:
    """DAG 投影(只读)。无 root=全库;有 root=ego 子图。

    节点字段 = tasks 表现有列 + 派生 flags/role,不发明业务字段。
    """
    con = _ro(path)
    try:
        tasks = [
            dict(r)
            for r in con.execute(
                """
                SELECT id, title, status, waiting_on, owner, epic, now,
                       origin, created_at, started_at, completed_at
                FROM tasks
                """
            )
        ]
        edges = [
            dict(r)
            for r in con.execute("SELECT src, dst, kind, note FROM task_edges")
        ]
    finally:
        con.close()

    by_id = {t["id"]: t for t in tasks}
    upstream: dict[str, list[str]] = {t["id"]: [] for t in tasks}
    for e in edges:
        if e["kind"] == "depends_on" and e["src"] in upstream:
            upstream[e["src"]].append(e["dst"])

    nodes = []
    for t in tasks:
        tid = t["id"]
        status = t["status"] or "open"
        owner = (t["owner"] or "").strip()
        epic = (t["epic"] or "").strip() or "∅"
        waiting = t["waiting_on"]
        unfinished_up = [
            u for u in upstream[tid]
            if u in by_id and by_id[u]["status"] not in ("done", "cancelled")
        ]
        is_done = status in ("done", "cancelled")  # 终态:不再算 blocked/待拍板
        is_blocked = (not is_done) and bool(unfinished_up)
        is_frontier = (
            (not is_done)
            and (not owner)
            and (not unfinished_up)
            and status in _ACTIVE
        )
        needs_decision = (not is_done) and waiting == "decision"
        flags = {
            "done": is_done,
            "blocked": is_blocked,
            "frontier": is_frontier,
            "needs_decision": needs_decision,
        }
        if needs_decision:
            role = "decision"
        elif is_blocked:
            role = "blocked"
        elif is_frontier:
            role = "frontier"
        elif is_done:
            role = "done"
        elif status == "in_progress":
            role = "active"
        elif status == "staging-verified":
            role = "staging"
        else:
            role = "open"
        nodes.append({
            "id": tid,
            "title": t["title"],
            "status": status,
            "waiting_on": waiting,
            "owner": owner or None,
            "epic": epic,
            "now": t["now"],
            "origin": t["origin"],
            "created_at": t["created_at"],
            "started_at": t["started_at"],
            "completed_at": t["completed_at"],
            "flags": flags,
            "role": role,
            "blocked_by": unfinished_up,
            "val": 1 if is_done else (4 if needs_decision or is_frontier else 2),
        })

    links = []
    for e in edges:
        if e["kind"] == "depends_on":
            source, target = e["dst"], e["src"]
        else:
            source, target = e["src"], e["dst"]
        if source in by_id and target in by_id:
            links.append({
                "source": source, "target": target,
                "kind": e["kind"], "note": e["note"],
            })

    focus = None
    if root:
        if root not in by_id:
            raise db.NawabanError(f"卡不存在:{root}")
        keep, focus = _ego_keep(
            root, edges,
            max_depth=max_depth, max_nodes=max_nodes,
        )
        nodes = [n for n in nodes if n["id"] in keep]
        for n in nodes:
            if n["id"] == root:
                n["is_root"] = True
                n["val"] = max(int(n["val"]), 5)
        ids = {n["id"] for n in nodes}
        links = [l for l in links if l["source"] in ids and l["target"] in ids]

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "stats": _stats_of(nodes, len(links)),
        "nodes": nodes,
        "links": links,
        "focus": focus,
    }


# ── HTML(内嵌 js · 零构建链) ──────────────────────────────────

MODULES_PAGE = r"""<!doctype html>
<html lang=zh><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>NAWABAN 模块</title>
<style>
:root{
  --bg:#09090b; --panel:#18181b; --panel-2:#2e2e33; --line:#27272a; --ink:#fafafa; --dim:#a1a1aa;
  --accent:#5e6ad2;
  --done:#2e9e6b; --sv:#fbbf24; --wip:#2f7de1; --claimed:#8a5cf6; --open:#98a1b0;
  --chip:#232327; --chip-done:#1b1b1f; --edge:#3f3f46; --blocked:#fbbf24;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;height:100vh;display:flex;flex-direction:column}
.mono{font-family:ui-monospace,Menlo,monospace}
header{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--bg)}
header h1{font-size:14px;font-weight:600;margin:0;letter-spacing:.02em}
.nav{display:flex;gap:4px;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:2px}
.nav a{color:var(--dim);text-decoration:none;font-size:13px;padding:5px 10px;border-radius:4px}
.nav a:hover{color:var(--ink)}
.nav a.on{background:var(--panel-2);color:var(--ink);font-weight:600}
header label{margin-left:auto;display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dim);cursor:pointer;user-select:none}
main{flex:1;display:flex;min-height:0}
aside{width:290px;flex-shrink:0;overflow-y:auto;border-right:1px solid var(--line);background:var(--panel);padding:8px}
.mod{width:100%;text-align:left;border:1px solid transparent;border-radius:6px;padding:8px 10px;cursor:pointer;background:none;color:var(--ink);font:inherit;display:block}
.mod:hover{border-color:var(--line)}
.mod.sel{background:var(--bg);border-color:var(--accent)}
.mod .row{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.mod .name{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mod .pct{font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums}
.bar{display:flex;height:5px;border-radius:3px;overflow:hidden;background:var(--line);margin-top:6px}
.bar i{display:block;height:100%}
.mod .sub{font-size:11px;color:var(--dim);margin-top:4px;font-variant-numeric:tabular-nums}
.rail-h{font-size:11px;color:var(--dim);letter-spacing:.08em;padding:10px 10px 4px;text-transform:uppercase}
#view{flex:1;overflow:auto;padding:18px 22px}
#ep-head h2{font-size:18px;font-weight:600;margin:0 0 2px}
#ep-head .stats{font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums}
.legend{display:flex;gap:14px;font-size:11px;color:var(--dim);margin:10px 0 16px;flex-wrap:wrap}
.legend b{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px}
#stages-wrap{position:relative}
#svg{position:absolute;inset:0;pointer-events:none;overflow:visible}
#stages{position:relative;display:flex;gap:46px;align-items:flex-start;width:max-content;padding-bottom:8px}
.stage{width:250px;flex-shrink:0}
.stage-h{font-size:11px;color:var(--dim);letter-spacing:.06em;margin-bottom:8px}
.cards{display:flex;flex-direction:column;gap:8px}
.card{background:var(--chip);border:1px solid var(--panel-2);border-left:3px solid var(--open);border-radius:6px;padding:10px 12px}
.focus-on #view .card:hover{border-color:var(--edge)}
.card .id{font-size:10px;color:var(--dim);word-break:break-all}
.card .t{font-size:12px;margin-top:2px}
.card.s-done{border-left-color:var(--done);background:var(--chip-done)}
.card.s-done .t{color:var(--dim)}
.card.s-staging-verified{border-left-color:var(--sv)}
.card.s-in_progress{border-left-color:var(--wip)}
.card.s-claimed{border-left-color:var(--claimed)}
.badges{display:flex;gap:5px;margin-top:4px;flex-wrap:wrap}
.badge{font-size:10px;border-radius:999px;padding:0 7px;line-height:16px}
.b-blocked{color:var(--blocked);border:1px solid var(--blocked)}
.b-wip{background:var(--wip);color:#09090b}
.b-sv{background:var(--sv);color:#09090b}
.b-x{color:var(--dim);border:1px solid var(--line)}
#loose{margin-top:26px;border-top:1px dashed var(--line);padding-top:14px}
#loose h3{font-size:12px;color:var(--dim);font-weight:500;margin:0 0 10px}
#loose .cards{flex-direction:row;flex-wrap:wrap}
#loose .card{width:250px}
#now{margin:2px 0 0;font-size:12px;color:var(--dim)}
#now b{color:var(--ink);font-weight:600}
.empty{color:var(--dim);font-size:13px;padding:30px 0}
.focus-on #view .card{cursor:pointer}
.card.dim{opacity:.22}
.card.hot{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
@media (max-width:760px){aside{width:170px}.mod .sub{display:none}}
</style>
<header>
  <h1>NAWABAN</h1>
  <nav class=nav>
    <a href="/">Board</a>
    <a class=on href="/?view=modules">模块</a>
    <a href="/?view=inbox">收件箱</a>
  </nav>
  <label><input type="checkbox" id="focus"> 专注模式 · 点卡看它的链</label>
</header>
<main>
  <aside id="rail"></aside>
  <section id="view">
    <div id="ep-head"></div>
    <div class="legend">
      <span><b style="background:var(--done)"></b>done</span>
      <span><b style="background:var(--sv)"></b>staging-verified</span>
      <span><b style="background:var(--wip)"></b>in_progress</span>
      <span><b style="background:var(--claimed)"></b>claimed</span>
      <span><b style="background:var(--open)"></b>open</span>
      <span style="color:var(--blocked)">▸ 被挡 = 上游未 done</span>
    </div>
    <div id="stages-wrap"><svg id="svg"></svg><div id="stages"></div></div>
    <div id="loose"></div>
  </section>
</main>
<script>
// 形态定稿:BOARD-REVAMP-DAG-PROTO-001 decide 行(2026-08-29 用户点验)。
// 进度口径只数 done;staging-verified 在分段条与统计里单独可见。
let D = {tasks: [], deps: []};
const noEpic = e => !e || e === 'n/a';
let byId, upOf, downOf, EPICS;
const ST = ['done','staging-verified','in_progress','claimed','open'];
const STC = {done:'--done','staging-verified':'--sv',in_progress:'--wip',claimed:'--claimed',open:'--open'};
const cnt = list => { const c = {}; for (const s of ST) c[s] = 0; for (const t of list) c[t.s] = (c[t.s]||0)+1; return c; };
const pct = c => { const tot = ST.reduce((a,s)=>a+c[s],0); return tot ? Math.round(100*c.done/tot) : 0; };
let sel = null;

function index(){
  byId = new Map(D.tasks.map(t => [t.i, t]));
  upOf = new Map(); downOf = new Map();
  for (const [s, d] of D.deps) {
    if (!byId.has(s) || !byId.has(d)) continue;
    (upOf.get(s) || upOf.set(s, []).get(s)).push(d);
    (downOf.get(d) || downOf.set(d, []).get(d)).push(s);
  }
  EPICS = {};
  for (const t of D.tasks) {
    const k = noEpic(t.e) ? '__none__' : t.e;
    (EPICS[k] = EPICS[k] || []).push(t);
  }
}

function rail() {
  const keys = Object.keys(EPICS).filter(k => k !== '__none__')
    .sort((a,b) => { const ca=cnt(EPICS[a]), cb=cnt(EPICS[b]);
      const oa=EPICS[a].length-ca.done, ob=EPICS[b].length-cb.done;
      return ob-oa || EPICS[b].length-EPICS[a].length; });
  if (EPICS['__none__']) keys.push('__none__');
  const el = document.getElementById('rail');
  el.innerHTML = '<div class="rail-h">模块 · 按未完成量排序</div>';
  for (const k of keys) {
    const list = EPICS[k], c = cnt(list);
    const b = document.createElement('button');
    b.className = 'mod' + (k === sel ? ' sel' : '');
    const name = k === '__none__' ? '未分组' : k;
    const segs = ST.map(s => c[s] ? `<i style="width:${100*c[s]/list.length}%;background:var(${STC[s]})"></i>` : '').join('');
    b.innerHTML = `<div class="row"><span class="name"></span><span class="pct">${pct(c)}%</span></div>
      <div class="bar">${segs}</div>
      <div class="sub">${list.length} 卡 · 剩 ${list.length - c.done}</div>`;
    b.querySelector('.name').textContent = name;
    b.onclick = () => { sel = k; focusId = null; render(); };
    el.appendChild(b);
  }
}

function layers(list) {
  const ids = new Set(list.map(t => t.i)), memo = new Map();
  const L = id => { if (memo.has(id)) return memo.get(id); memo.set(id, 0);
    const ups = (upOf.get(id) || []).filter(u => ids.has(u));
    const v = ups.length ? 1 + Math.max(...ups.map(L)) : 0;
    memo.set(id, v); return v; };
  const inChain = t => (upOf.get(t.i)||[]).some(u=>ids.has(u)) || (downOf.get(t.i)||[]).some(d=>ids.has(d));
  const chained = list.filter(inChain), loose = list.filter(t => !inChain(t));
  const cols = [];
  for (const t of chained) { const l = L(t.i); (cols[l] = cols[l] || []).push(t); }
  return { cols, loose };
}
const TERM = new Set(['done','cancelled']);
const blocked = t => !TERM.has(t.s) && (upOf.get(t.i) || []).some(u => !TERM.has(byId.get(u).s));
const esc = s => String(s==null?"":s).replace(/[&<>"']/g, c =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

function card(t, ids) {
  const xdep = (upOf.get(t.i) || []).filter(u => !ids.has(u)).map(u => noEpic(byId.get(u).e) ? '未分组' : byId.get(u).e);
  let badges = '';
  if (blocked(t)) badges += '<span class="badge b-blocked">▸ 被挡</span>';
  if (t.s === 'in_progress') badges += '<span class="badge b-wip">进行中</span>';
  if (t.s === 'staging-verified') badges += '<span class="badge b-sv">待验收</span>';
  for (const x of new Set(xdep)) badges += `<span class="badge b-x">← 依赖 ${esc(x)}</span>`;
  return `<div class="card s-${t.s}" data-id="${esc(t.i)}"><div class="id mono">${esc(t.i)}</div><div class="t">${esc(t.t)}</div>${badges ? `<div class="badges">${badges}</div>` : ''}</div>`;
}

function render() {
  rail();
  const list = EPICS[sel] || [], c = cnt(list), ids = new Set(list.map(t => t.i));
  const name = sel === '__none__' ? '未分组' : sel;
  const wip = list.filter(t => t.s === 'in_progress' || t.s === 'claimed');
  const { cols, loose } = layers(list);
  const stageOf = new Map(); cols.forEach((col, i) => col.forEach(t => stageOf.set(t.i, i + 1)));
  const now = wip.length
    ? '现在动着的:' + wip.map(t => `<b>${esc(t.i)}</b>${stageOf.has(t.i) ? `(第 ${stageOf.get(t.i)}/${cols.length} 级)` : '(独立卡)'}`).join(' · ')
    : '没有进行中的卡';
  document.getElementById('ep-head').innerHTML =
    `<h2>${esc(name)}</h2><div class="stats">${list.length} 卡 · 完成 ${pct(c)}% · done ${c.done} / 待验收 ${c['staging-verified']} / 进行中 ${c.in_progress + c.claimed} / open ${c.open}</div><p id="now">${now}</p>`;
  const st = document.getElementById('stages');
  st.innerHTML = cols.length
    ? cols.map((col, i) => `<div class="stage"><div class="stage-h">第 ${i + 1} 级${i === 0 ? ' · 上游' : i === cols.length - 1 ? ' · 下游' : ''}</div><div class="cards">${col.map(t => card(t, ids)).join('')}</div></div>`).join('')
    : '<div class="empty">这个模块内部没有依赖链——所有卡都是独立卡。</div>';
  const lo = document.getElementById('loose');
  lo.innerHTML = loose.length
    ? `<h3>独立卡(不在链上)· ${loose.length}</h3><div class="cards">${ST.flatMap(s => loose.filter(t => t.s === s)).map(t => card(t, ids)).join('')}</div>` : '';
  requestAnimationFrame(applyFocus);
}

let focusId = null, focusSet = null;
function applyFocus() {
  focusSet = null;
  if (focusBox.checked && focusId) {
    focusSet = new Set([focusId]);
    const walk = (i, m) => { for (const n of (m.get(i) || [])) if (!focusSet.has(n)) { focusSet.add(n); walk(n, m); } };
    walk(focusId, upOf); walk(focusId, downOf);
  }
  document.querySelectorAll('#view .card').forEach(el => {
    el.classList.toggle('dim', !!focusSet && !focusSet.has(el.dataset.id));
    el.classList.toggle('hot', !!focusSet && el.dataset.id === focusId);
  });
  wires();
}

function wires() {
  const svg = document.getElementById('svg'), wrap = document.getElementById('stages-wrap');
  const wr = wrap.getBoundingClientRect();
  svg.setAttribute('width', wrap.scrollWidth); svg.setAttribute('height', wrap.scrollHeight);
  const pos = new Map();
  wrap.querySelectorAll('.card').forEach(el => pos.set(el.dataset.id, el));
  let p = '', hot = '';
  for (const [s, d] of D.deps) {
    const a = pos.get(d), b = pos.get(s);           // a 上游 → b 下游
    if (!a || !b) continue;
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const x1 = ra.right - wr.left, y1 = ra.top + ra.height / 2 - wr.top;
    const x2 = rb.left - wr.left, y2 = rb.top + rb.height / 2 - wr.top;
    const m = (x1 + x2) / 2;
    const seg = `M${x1},${y1} C${m},${y1} ${m},${y2} ${x2},${y2} `;
    if (focusSet && focusSet.has(s) && focusSet.has(d)) hot += seg; else p += seg;
  }
  svg.innerHTML =
    (p ? `<path d="${p}" fill="none" stroke="var(--edge)" stroke-width="1.2" opacity="${focusSet ? 0.18 : 1}"/>` : '') +
    (hot ? `<path d="${hot}" fill="none" stroke="var(--accent)" stroke-width="1.8"/>` : '');
}

const focusBox = document.getElementById('focus');
focusBox.onchange = () => { focusId = null; document.body.classList.toggle('focus-on', focusBox.checked); applyFocus(); };
document.getElementById('view').addEventListener('click', e => {
  if (!focusBox.checked) return;
  const c = e.target.closest('.card');
  focusId = (c && c.dataset.id !== focusId) ? c.dataset.id : null;
  applyFocus();
});
addEventListener('resize', () => requestAnimationFrame(wires));

fetch('/api/modules').then(r => r.json()).then(d => {
  if (d.unavailable) throw new Error(d.error || 'unavailable');
  D = d; index();
  const q = new URLSearchParams(location.search).get('epic');
  sel = (q && EPICS[q]) ? q : (EPICS['IAM2'] ? 'IAM2' : Object.keys(EPICS)[0]);
  render();
}).catch(e => {
  document.getElementById('ep-head').innerHTML = '<div class=empty>模块数据不可用:' + esc(e.message) + '</div>';
});
</script>
"""

INBOX_PAGE = r"""<!doctype html>
<meta charset="utf-8"><title>NAWABAN 收件箱</title>
<style>
:root{
  --bg:#09090b;--surface:#18181b;--surface-2:#232327;
  --fg:#fafafa;--muted:#a1a1aa;--dim:#82828b;
  --line:#27272a;--line-2:#3f3f46;
  --accent:#5e6ad2;--amber:#fbbf24;--red:#eb5757;--green:#4cb782;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font:13px/1.5 Inter,-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
header{padding:14px 18px;border-bottom:1px solid var(--line);display:flex;
  gap:12px;align-items:baseline;flex-wrap:wrap}
h1{font-size:15px;margin:0;font-weight:600;letter-spacing:.01em}
.sub{font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim)}
.nav{margin-left:auto;display:flex;gap:4px;background:var(--surface);
  border:1px solid var(--line);border-radius:6px;padding:2px}
.nav a{color:var(--dim);text-decoration:none;padding:5px 10px;border-radius:4px}
.nav a:hover{color:var(--fg)}
main{max-width:860px;margin:0 auto;padding:16px 18px 60px}
.grp{margin-top:22px}
.grph{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);
  font-weight:600;padding-bottom:8px;border-bottom:1px solid var(--line);margin-bottom:10px}
.ask{background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--accent);
  border-radius:6px;padding:13px 15px;margin-bottom:8px}
.ask.accept{border-left-color:var(--amber)}
.ask.decide{border-left-color:var(--red)}
.q{font-size:14px;font-weight:500;line-height:1.4;display:flex;gap:10px;align-items:baseline}
.q .days{margin-left:auto;font:11px ui-monospace,Menlo,monospace;color:var(--dim);
  flex:0 0 auto;font-variant-numeric:tabular-nums}
.q .days.old{color:var(--amber)}
.hands{display:inline-block;font-size:10.5px;color:var(--amber);
  border:1px solid rgba(251,191,36,.4);border-radius:999px;padding:0 7px;margin-left:6px;
  vertical-align:1px;font-weight:400}
.ev{margin-top:9px;font:11.5px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--muted);white-space:pre-wrap;word-break:break-word;
  background:var(--surface-2);border-radius:5px;padding:8px 10px;max-height:11em;overflow:auto}
.blast{margin-top:8px;font-size:11.5px;color:var(--muted)}
.blast b{color:var(--dim);font-weight:400}
.conf{margin-top:8px;font-size:11.5px;color:var(--dim);line-height:1.7}
.conf b{color:var(--muted);font-weight:600}
.cards{margin-top:8px;font:10.5px ui-monospace,Menlo,monospace;color:var(--dim);
  word-break:break-all;line-height:1.7}
.acts{margin-top:10px;display:flex;gap:6px;flex-wrap:wrap}
.acts button{font:inherit;font-size:12px;padding:4px 12px;border-radius:5px;
  border:1px solid var(--line-2);background:var(--surface-2);color:var(--fg);cursor:pointer}
.acts button:hover:not(:disabled){border-color:var(--accent);color:var(--fg)}
.acts button:disabled{opacity:.45;cursor:not-allowed}
.acts .msg{font-size:11.5px;color:var(--muted);align-self:center}
.reply{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}
.reply input{flex:1;min-width:180px;background:var(--surface-2);border:1px solid var(--line-2);
  border-radius:5px;padding:5px 9px;color:var(--fg);font:inherit;font-size:12px;outline:none}
.reply input:focus{border-color:var(--accent)}
.reply button{font:inherit;font-size:12px;padding:4px 12px;border-radius:5px;
  border:1px solid var(--line-2);background:var(--surface-2);color:var(--fg);cursor:pointer}
.reply button:disabled{opacity:.45;cursor:not-allowed}
.ask.done{opacity:.55}
.outcome{margin-top:8px;font:11.5px/1.7 ui-monospace,Menlo,monospace;color:var(--green);
  white-space:pre-wrap;background:var(--surface-2);border-radius:5px;padding:7px 9px}
.hint{margin-top:8px;font-size:11.5px;line-height:1.7;color:var(--amber);
  border-left:2px solid var(--amber);padding-left:8px}
.hint code{font-size:11px;color:var(--fg)}
.empty{text-align:center;padding:70px 20px;color:var(--muted)}
.empty .big{font-size:17px;color:var(--fg);margin-bottom:10px}
footer{max-width:860px;margin:0 auto;padding:18px;border-top:1px solid var(--line);
  color:var(--dim);font-size:11.5px;display:flex;gap:14px;flex-wrap:wrap}
footer a{color:var(--dim)}
.aid{font:11px ui-monospace,Menlo,monospace;color:var(--dim);margin-right:7px}
</style>
<header>
  <h1>收件箱</h1>
  <span class=sub id=hd>载入中…</span>
  <nav class=nav><a href="/?view=board">看板</a><a href="/?view=modules">模块</a></nav>
</header>
<main id=main></main>
<footer id=ft></footer>
<script>
// 单引号也转:目前所有插值都在元素内容位或双引号属性里,不转 ' 暂时咬不到人 ——
// 但下一个人在单引号属性里用它就中招,转义函数本该是完整的。
const esc = s => String(s==null?"":s).replace(/[&<>"']/g, c =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

function askHTML(a){
  const old = a.stalled_days >= 2 ? " old" : "";
  const hands = a.hands_on ? '<span class=hands>要你亲自点</span>' : "";
  let blast = "";
  if (a.blast && typeof a.blast === "object")
    blast = '<div class=blast>' + Object.entries(a.blast)
      .map(([k,v]) => '<b>'+esc(k)+'</b> '+esc(v)).join(" · ") + '</div>';
  let opts = "";
  if (Array.isArray(a.options) && a.options.length)
    opts = '<div class=blast>' + a.options.map(o =>
      '<b>'+esc(o.option)+'</b> '+esc(o.consequence||"")).join("<br>") + '</div>';
  // 回答走 POST /api/answer → 板 fork cli(选型 B:板自己的连接仍只读)
  const yes = a.kind === "accept" ? "收下" : a.kind === "authorize" ? "授权" : "就这么定";
  return '<div class="ask '+esc(a.kind)+'" data-id="'+a.id+'">'
    + '<div class=q><span><span class=aid>#'+a.id+'</span>'+esc(a.question)+hands+'</span>'
    + '<span class="days'+old+'">'+a.stalled_days+'d</span></div>'
    + blast + opts
    + (a.kind === "authorize"
        ? '<div class=hint>授权只记录你的决定 —— <b>不会自动执行</b>。'
          + '动作真跑完之后再收口:<code>nawaban fanout '+a.id+' --ok</code>(失败用 --failed)</div>'
        : "")
    + (a.evidence ? '<div class=ev>'+esc(a.evidence)+'</div>' : "")
    + (a.confidence!=null
        ? '<div class=conf><b>'+Math.round(a.confidence*100)+'% 把握</b> · '
          + esc(a.confidence_reason||'') + '</div>'
        : "")
    + '<div class=cards>'+a.task_ids.map(esc).join(" · ")+'</div>'
    + '<div class=acts>'
    + '<button class=go data-act=yes>'+yes+'</button>'
    + (a.kind === "accept" ? '<button class=go data-act=no>打回</button>' : "")
    + '<span class=msg></span></div></div>';
}

// 内联输入,不用 prompt():modal 会阻塞页面事件,也让这条路径没法被自动化验证。
function openReply(box, reject){
  if (box.querySelector(".reply")) return;
  const acts = box.querySelector(".acts");
  const wrap = document.createElement("div");
  wrap.className = "reply";
  wrap.innerHTML = '<input class=rin placeholder="'
    + (reject ? "打回理由" : "回答") + '(会原样进决策记录)">'
    + '<button class=send>提交</button><button class=cancel>取消</button>';
  acts.after(wrap);
  const input = wrap.querySelector(".rin");
  input.focus();
  wrap.querySelector(".cancel").onclick = () => wrap.remove();
  const go = () => submit(box, wrap, reject);
  wrap.querySelector(".send").onclick = go;
  input.onkeydown = e => { if (e.key === "Enter") go(); };
}

async function submit(box, wrap, reject){
  const verdict = wrap ? wrap.querySelector(".rin").value.trim()
                       : "验收通过(收件箱一键)";  // 收下一键过:默认句进决策记录
  const msg = box.querySelector(".msg");
  if (!verdict){ msg.textContent = "回答不能为空(它会进决策记录)"; return; }
  // 不可撤销动作在飞行中禁用,避免重复提交
  if (wrap) wrap.querySelectorAll("button,input").forEach(b => b.disabled = true);
  box.querySelectorAll("button.go").forEach(b => b.disabled = true);
  msg.textContent = "提交中…";
  let r;
  try {
    r = await fetch("/api/answer", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ask_id:+box.dataset.id, verdict, reject:!!reject})});
  } catch (e) {
    // 网络失败按「未知」呈现,不按「失败」—— 服务端可能已经提交了
    msg.textContent = "结果未知,刷新页面确认(别直接重试)";
    return;
  }
  const d = await r.json().catch(() => ({ok:false, out:"响应不是 JSON,结果未知"}));
  if (d.ok){
    if (wrap) wrap.remove(); box.classList.add("done"); msg.textContent = "";
    const note = document.createElement("div");
    note.className = "outcome";
    note.textContent = d.out || "已处理";
    box.appendChild(note);
  }
  else {
    if (wrap) wrap.querySelectorAll("button,input").forEach(b => b.disabled = false);
    box.querySelectorAll("button.go").forEach(b => b.disabled = false);
    msg.textContent = d.out || "失败";
  }
}

fetch("/api/inbox").then(r=>r.json()).then(d=>{
  const flow = "本周进 "+d.flow.raised_7d+" 件 · 已清 "+d.flow.closed_7d+" 件";
  document.getElementById("hd").textContent = d.total
    ? d.total+" 件事等你 · 最久的停了 "+d.oldest_days+" 天 · "+flow
    : flow;
  const m = document.getElementById("main");
  if (!d.total){
    // 空态是常态不是异常(暗驾驶舱)。flow 是活性自证:没有它,
    // 一个因上游断了而恒真的「没事」会把「信号源坏了」伪装成「没事发生」。
    m.innerHTML = '<div class=empty><div class=big>没有需要你决定的事</div><div>'
      + esc(flow) + '</div></div>';
  } else {
    m.innerHTML = d.groups.filter(g=>g.items.length).map(g =>
      '<section class=grp><div class=grph>'+esc(g.title)+' · '+g.items.length+'</div>'
      + g.items.map(askHTML).join("") + '</section>').join("");
  }
  document.getElementById("ft").innerHTML =
    '<span>agent 侧 '+d.agent_side+' 张卡在跑或在等</span>'
    + '<a href="/?view=board">看板 ▸</a>';
  m.addEventListener("click", e => {
    const b = e.target.closest("button.go");
    if (!b) return;
    const box = b.closest(".ask");
    // 收下一键过(用户 2026-08-29 拍板):验收直接提交默认句;打回仍必须写理由
    if (b.dataset.act === "yes" && box.classList.contains("accept")) submit(box, null, false);
    else openReply(box, b.dataset.act === "no");
  });
});
</script>
"""

PAGE = r"""<!doctype html>
<meta charset="utf-8"><title>NAWABAN 板</title>
<style>
:root{
  --bg:#09090b;--surface:#18181b;--surface-2:#232327;--surface-3:#2e2e33;
  --fg:#fafafa;--muted:#a1a1aa;--dim:#82828b;
  --line:#27272a;--line-2:#3f3f46;
  --accent:#5e6ad2;--accent-soft:rgba(94,106,210,.18);
  --red:#eb5757;--green:#4cb782;--amber:#fbbf24;
  --speed:.12s
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.45 Inter,-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}
header{padding:10px 16px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap;background:var(--bg)}
h1{font-size:14px;margin:0;letter-spacing:.02em;font-weight:600}
.nav{display:flex;gap:4px;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:2px}
.nav a{color:var(--dim);text-decoration:none;padding:5px 10px;border-radius:4px}
.nav a.on{background:var(--surface-3);color:var(--fg)}
#q{flex:1;min-width:180px;max-width:360px;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:7px 10px;color:var(--fg);outline:none;font:inherit}
#q:focus{border-color:rgba(94,106,210,.5)}
#hint{font-size:11px;color:var(--dim);flex:1 1 220px}
#board{display:flex;gap:14px;align-items:flex-start;padding:14px 16px;flex-wrap:nowrap;overflow:auto;min-height:calc(100vh - 52px)}
.col{flex:1;min-width:230px;max-width:360px;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:8px}
.colh{font-weight:600;font-size:12.5px;padding:4px 4px 10px;color:var(--fg);display:flex;gap:8px;align-items:center;position:sticky;top:0;background:var(--surface);border-bottom:1px solid var(--line);margin-bottom:8px}
.colh .n{color:var(--dim);font-weight:400}
/* 聚焦一个功能:非本族压暗 —— 压暗不是隐藏,hover 与选中一律恢复全亮(ADR-0209 原则 2) */
#fambar{margin:0 18px 10px;padding:8px 12px;border-radius:6px;font-size:12px;
  background:var(--surface-2);color:var(--muted);display:flex;gap:10px;align-items:center}
#fambar b{color:var(--fg);font-weight:600}
#fambar button{font:inherit;color:var(--muted);background:none;cursor:pointer;
  border:1px solid var(--line);border-radius:4px;padding:2px 8px}
#fambar button:hover{color:var(--fg)}
.card.dim{opacity:.26}
.card.dim:hover{opacity:1}
.card.kin{box-shadow:inset 2px 0 0 var(--accent,#5b8def)}
.kintag{font-size:10px;color:var(--dim);border:1px solid var(--line);
  border-radius:999px;padding:0 6px;margin-left:6px}
.card{background:var(--surface-2);border:1px solid #2e2e33;border-radius:6px;padding:12px 13px 10px;margin-bottom:8px;cursor:pointer;text-align:left;width:100%;color:inherit;font:inherit;transition:background var(--speed),border-color var(--speed)}
.card:hover{background:#26262b;border-color:var(--line-2)}
.card.sel{border-color:rgba(94,106,210,.55);box-shadow:0 0 0 1px rgba(94,106,210,.35);background:var(--surface-2)}
.card.gone{opacity:.5}
.card.hid{display:none}
.tid{font:10.5px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim);letter-spacing:.02em;margin-bottom:4px;word-break:break-all}
.t{font-weight:500;font-size:13px;line-height:1.35}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex:0 0 auto;background:#52525b}
.dot.idle{background:var(--amber)}
.dot.cold{background:#3f3f46}
/* 弱化只作用在「本该有人在干却没人在」的卡上。hover 全亮 —— 压暗是降噪,不是藏东西 */
.card.lv-cold,.card.lv-no-window{opacity:.42}
.card.lv-cold:hover,.card.lv-no-window:hover,.card.lv-cold.sel,.card.lv-no-window.sel{opacity:1}
.card.lv-idle{opacity:.78}
.card.lv-idle:hover,.card.lv-idle.sel{opacity:1}
.meta .faint{color:var(--dim)}
.card.grp{background:var(--surface-2);border-color:var(--line-2)}
.card.grp:hover{background:var(--surface-3)}
.card.grp .grph{display:flex;gap:6px;align-items:baseline}
.card.grp .caret{color:var(--dim);font-size:10px;flex:0 0 auto}
.card.grp .gname{font-weight:600;font-size:12.5px;flex:1;text-align:left;word-break:break-all}
.card.grp .gn{color:var(--dim);font-size:11px;flex:0 0 auto}
.card.grp.open{border-bottom-left-radius:0;border-bottom-right-radius:0;margin-bottom:0}
.card.ingrp{margin-left:10px;border-left-width:2px}
.dep{margin-top:5px;display:flex;flex-wrap:wrap;gap:5px;font-size:10.5px}
.dep .blocked{color:var(--amber);border:1px solid rgba(251,191,36,.35);
  border-radius:999px;padding:0 7px}
.dep .blocks{color:var(--accent);border:1px solid rgba(94,106,210,.35);
  border-radius:999px;padding:0 7px}
.colh .tally{font-size:10.5px;font-weight:400;color:var(--muted)}
.colh .tally.on{color:var(--green)}
.colh .tally.dimmed{color:var(--dim)}
#livewarn{margin:0 16px;font-size:11px;color:var(--dim);padding:4px 0}
.dot.working{background:var(--green);animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(76,183,130,.55)}70%{box-shadow:0 0 0 6px rgba(76,183,130,0)}}
@media(prefers-reduced-motion:reduce){.dot.working{animation:none;outline:2px solid var(--green);outline-offset:2px}}
.on{color:var(--green);font-weight:600}
.meta{font-size:11px;color:var(--dim);margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.tag{border-radius:999px;padding:1px 6px;font-weight:500;font-size:10px}
.red{background:rgba(235,87,87,.14);color:var(--red);border:1px solid rgba(235,87,87,.28)}
.grey{background:var(--surface-3);color:var(--muted);border-radius:999px;padding:1px 6px}
#detail{position:fixed;top:0;right:0;width:min(560px,100%);height:100%;background:var(--bg);border-left:1px solid var(--line);overflow:auto;padding:16px 18px;display:none;z-index:5}
#detail h2{font-size:16px;margin:0 0 2px;font-weight:600}
#detail h3{font-size:11px;color:var(--dim);margin:16px 0 6px;letter-spacing:.08em;text-transform:uppercase}
#close{float:right;cursor:pointer;color:var(--muted);border:1px solid var(--line);border-radius:6px;padding:2px 8px;background:transparent}
.blk{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin-bottom:6px;font-size:12.5px;white-space:pre-wrap;word-break:break-word}
.sub{font-size:11px;color:var(--dim);margin-top:4px}
.edge{cursor:pointer;color:var(--accent)}
ul{margin:4px 0;padding-left:18px;font-size:12.5px}
.rej{color:var(--red)}
.dag{font-size:10px;color:var(--accent);border:1px solid var(--accent-soft);border-radius:999px;padding:1px 6px;cursor:pointer;letter-spacing:.04em}
.dag:hover{background:var(--accent-soft)}
.dag-link{display:inline-block;margin-top:10px;color:var(--accent);text-decoration:none;border:1px solid var(--line-2);border-radius:6px;padding:5px 10px}
.dag-link:hover{background:var(--accent-soft)}
.keys{position:fixed;bottom:10px;left:50%;transform:translateX(-50%);font-size:11px;color:var(--dim);background:rgba(9,9,11,.92);border:1px solid var(--line);border-radius:999px;padding:5px 12px;pointer-events:none;z-index:8}
kbd{font:10px ui-monospace,monospace;border:1px solid var(--line-2);border-radius:3px;padding:0 4px;color:var(--muted)}
.inb{background:var(--accent-soft);border-radius:999px;padding:0 6px;font-size:10px}
</style>
<header>
  <h1>NAWABAN</h1>
  <nav class=nav>
    <a class=on href="/">Board</a>
    <a href="/?view=modules">模块</a>
    <a href="/?view=inbox">收件箱 <span id=inbadge class=inb hidden></span></a>
  </nav>
  <input id=q type=search placeholder="找寻 id / title / owner / epic  ·  /" autocomplete=off>
  <span class=sub id=hint>等拍板钉最前 · 最近活动倒序 · 🟢在跑 · 只读</span>
</header>
<div id=fambar hidden></div>
<div id=board></div>
<div id=detail></div>
<div class=keys><kbd>j</kbd><kbd>k</kbd> 卡 · <kbd>Enter</kbd> 详情 · <kbd>g</kbd> DAG · <kbd>/</kbd> 找寻 · <kbd>Esc</kbd> 关 · <kbd>f</kbd> 顶</div>
<script>
const $=(t,c,txt)=>{const e=document.createElement(t);if(c)e.className=c;if(txt!=null)e.textContent=txt;return e};
// 收件箱计数徽标 · fail-soft:API 挂/降级(total=0)就不显示,不破看板底线
fetch("/api/inbox").then(r=>r.json()).then(d=>{
  if(d && d.total && !d.unavailable){const b=document.getElementById("inbadge");b.textContent=d.total;b.hidden=false;}
}).catch(()=>{});
function ago(ts){
  if(!ts) return "—";
  let s=Math.floor(Date.now()/1000)-ts;
  if(s<0) s=0;
  if(s<60) return s+"s ago";
  if(s<3600) return Math.floor(s/60)+"m ago";
  if(s<86400) return Math.floor(s/3600)+"h ago";
  return Math.floor(s/86400)+"d ago";
}
let FOCUS=[], FI=-1, SEL=null, DATA=null, FAMILY=null;
function hay(t){
  return [t.id,t.title,t.owner,t.epic,t.status,t.waiting_on].map(x=>String(x||"").toLowerCase()).join(" ");
}
function searchToks(){
  const q=(document.getElementById("q").value||"").trim().toLowerCase();
  return q.split(/\s+/).filter(Boolean);
}
function hits(t,toks){ return toks.every(tok=>hay(t).includes(tok)); }
function applySearch(){
  const toks=searchToks();
  document.querySelectorAll(".card.tk").forEach(c=>{
    const t=c._task;
    const ok=!toks.length || hits(t,toks);
    c.classList.toggle("hid", !ok);
  });
  // 组头不在 .card.tk 里,得单独过滤 —— 否则搜索时命中 0 个成员的组头还杵在那。
  // 组内卡是组头的**后续兄弟**(列内 DOM 是平的),所以扫到下一个组头为止;
  // 没展开的组本来就没有 ingrp 卡,而搜索命中会自动展开,所以「扫不到可见成员」= 没命中。
  document.querySelectorAll(".card.grp").forEach(g=>{
    let any=false;
    for(let n=g.nextElementSibling; n && !n.classList.contains("grp"); n=n.nextElementSibling)
      if(n.classList.contains("ingrp") && !n.classList.contains("hid")){ any=true; break; }
    g.classList.toggle("hid", toks.length>0 && !any);
  });
  FOCUS=[...document.querySelectorAll(".card.tk:not(.hid)")];
  if(SEL){ const i=FOCUS.findIndex(c=>c._task.id===SEL); FI=i; }
}
const OPEN = new Set(JSON.parse(localStorage.getItem("foldOpen")||"[]"));
function foldKey(colKey,name){ return colKey+"\u0000"+name; }
function toggleGroup(colKey,name){
  const k=foldKey(colKey,name);
  OPEN.has(k) ? OPEN.delete(k) : OPEN.add(k);
  localStorage.setItem("foldOpen", JSON.stringify([...OPEN]));
  load(true);
}
function depEl(blockedBy, blocks){
  if(!(blockedBy&&blockedBy.length) && !(blocks&&blocks.length)) return null;
  const d=$("div","dep");
  if(blockedBy&&blockedBy.length){
    d.appendChild($("span","blocked","⟵ 等 "+blockedBy.join("、")));
  }
  if(blocks&&blocks.length){
    d.appendChild($("span","blocks","⟶ "+blocks.length+" 个功能在等它"));
  }
  return d;
}
function groupEl(g,col){
  const color=col.color, open=OPEN.has(foldKey(col.key,g.name));
  const c=$("button","card grp"+(open?" open":"")); c.type="button";
  if(FAMILY && g.name!==FAMILY.fold && !FAMILY.deps.has(g.name)) c.classList.add("dim");
  c.onclick=(e)=>{ e.stopPropagation(); toggleGroup(col.key,g.name); };
  const hd=$("div","grph");
  hd.appendChild($("span","caret",open?"▾":"▸"));
  hd.appendChild($("span","gname",g.name));
  hd.appendChild($("span","gn",g.n+" 张"));
  c.appendChild(hd);
  // 大卡携带组内信号 —— 只写「12 张」帮不了人决定要不要点开
  const m=$("div","meta");
  if(g.decision) m.appendChild($("span","tag red",g.decision+" 等拍板"));
  if(g.working){ m.appendChild($("span","dot working")); m.appendChild($("span","on",g.working+" 在跑")); }
  if(!g.decision && !g.working) m.appendChild($("span","grey","无人在等"));
  c.appendChild(m);
  const dep=depEl(g.blocked_by,g.blocks); if(dep) c.appendChild(dep);
  return c;
}
function cardEl(t,color){
  // .card 是样式锚点(折叠大卡也用),.tk 才是「这是一张真任务卡」—— 凡是要读 _task 的
  // 遍历都必须按 .tk 选,否则会在大卡身上炸(点卡无详情 / 搜索炸 / j·k 落到大卡)。
  const c=$("button","card tk"); c.type="button";
  c._task=t;
  // 活性三档 —— 实测 in_progress 里 85% 是「标着在干、窗口已经不在」。
  // 未知(live=null)一律不标不压暗:探测不到 ≠ 已死,渲染成已死会让人放心去收窄一把真在用的锁。
  if(t.live && t.live.tier) c.classList.add("lv-"+t.live.tier);
  if(t.id===SEL) c.classList.add("sel");
  if(FAMILY && t.id!==SEL){
    if(FAMILY.kin.has(t.id)) c.classList.add("kin");
    else if(!FAMILY.rel.has(t.id)) c.classList.add("dim");
  }
  c.appendChild($("div","tid",t.id));
  c.appendChild($("div","t",t.title));
  const m=$("div","meta");
  if(FAMILY && FAMILY.rel.has(t.id) && !FAMILY.kin.has(t.id)){
    const d=t.dep||{};
    m.appendChild($("span","kintag",
      (d.blocks||[]).includes(FAMILY.fold) ? "它挡着这摊活" : "这摊活在等它"));
  }
  if(t.epic){m.appendChild($("span","grey",t.epic))}
  if(t.waiting_on==="decision" && t.status!=="done" && t.status!=="cancelled"){
    m.appendChild($("span","tag red","等拍板"));
  } else if(t.status==="staging-verified"){
    m.appendChild($("span","grey",t.waiting_on||"staging"));
  }
  m.appendChild($("span",null,ago(t.status==="done"?t.completed_at:t.active_at)));
  m.appendChild($("span",null,t.owner||"—"));
  const dag=$("span","dag","DAG");
  dag.title="本卡关系子图";
  dag.addEventListener("click",e=>{
    e.preventDefault(); e.stopPropagation();
    location.href="/?view=dag&focus="+encodeURIComponent(t.id);
  });
  m.appendChild(dag);
  if(t.live && t.live.tier){
    const L={working:["dot working","在跑"],idle:["dot idle","窗口闲着"],
             cold:["dot cold","窗口早没动静"],"no-window":["dot cold","找不到窗口"]}[t.live.tier];
    m.appendChild($("span",L[0]));
    m.appendChild($("span",t.live.tier==="working"?"on":"faint",
      L[1]+(t.live.age_s!=null && t.live.tier!=="working"?" · "+ago(Math.floor(Date.now()/1000)-t.live.age_s):"")));
  }
  c.appendChild(m);
  const dep=depEl(t.dep&&t.dep.blocked_by, t.dep&&t.dep.blocks); if(dep) c.appendChild(dep);
  c.onclick=()=>select(t.id,true);
  return c;
}
function allTasks(){
  const out=[];
  for(const col of (DATA&&DATA.columns||[]))
    for(const row of (col.rows || (col.tasks||[]).map(t=>({kind:"card",task:t}))))
      row.kind==="group" ? out.push(...row.tasks) : out.push(row.task||row);
  return out;
}
// 选中一张卡 → 它所属的整族。归属看 fold(capability 组),关系看 dep(存的是组名)。
function familyOf(id){
  const all=allTasks(), me=all.find(t=>t.id===id);
  if(!me) return null;
  const dep=me.dep||{};
  const deps=new Set([...(dep.blocked_by||[]), ...(dep.blocks||[])]);
  return {fold:me.fold, deps,
          kin:new Set(all.filter(t=>t.fold===me.fold).map(t=>t.id)),
          rel:new Set(all.filter(t=>deps.has(t.fold)).map(t=>t.id))};
}
function famBar(){
  const el=document.getElementById("fambar");
  if(!FAMILY){ el.hidden=true; el.textContent=""; return; }
  el.hidden=false; el.textContent="";
  // capability 是自由文本(任何 agent 都能 create --capability 写进去),这里绝不拼裸 HTML
  const s=$("span",null,"聚焦 ");
  s.appendChild($("b",null,FAMILY.fold));
  s.appendChild(document.createTextNode(
    " · 同一功能 "+FAMILY.kin.size+" 张"
    +(FAMILY.rel.size?" · 有依赖关系 "+FAMILY.rel.size+" 张":"")
    +" · 其余压暗(鼠标移上去恢复)"));
  el.appendChild(s);
  const b=$("button",null,"显示全部  Esc"); b.onclick=()=>clearFamily(); el.appendChild(b);
}
function clearFamily(){ FAMILY=null; SEL=null; load(true); }
async function select(id, open){
  SEL=id; FAMILY=familyOf(id);
  await load(true);
  const el=[...document.querySelectorAll(".card.tk")].find(c=>c._task.id===id);
  if(el && open!==false) el.scrollIntoView({block:"nearest"});
  if(open) openTask(id);
}
async function load(useCache){
  const d = (useCache && DATA) ? DATA : await (await fetch("/api/board")).json();
  DATA=d;
  const toks=searchToks();
  const b=document.getElementById("board"); b.textContent="";
  FOCUS=[];
  for(const col of d.columns){
    const el=$("div","col");
    const h=$("div","colh");
    h.appendChild($("span",null,col.title));
    const n=$("span","n",String(col.tasks.length)); h.appendChild(n);
    if(col.live_tally && col.tasks.length){
      const w=col.live_tally.working||0, i=col.live_tally.idle||0;
      const gone=(col.live_tally.cold||0)+(col.live_tally["no-window"]||0);
      // 空态要**显式说**:只显示「🟢 0」看着像没数据,而「无窗口在动」是一条真信息
      h.appendChild($("span","tally"+(w?" on":""), w? "🟢 "+w+" 在动" : "无窗口在动"));
      if(i) h.appendChild($("span","tally","· "+i+" 闲着"));
      if(gone) h.appendChild($("span","tally dimmed","· "+gone+" 窗口已不在"));
    }
    el.appendChild(h);
    if(!col.tasks.length) el.appendChild($("div","sub","空列"));
    const rows = col.rows || col.tasks.map(t=>({kind:"card",task:t}));
    for(const row of rows){
      if(row.kind!=="group"){ const c=cardEl(row.task||row,col.color); el.appendChild(c); FOCUS.push(c); continue; }
      // 不 push 进 FOCUS:键盘序列只走真任务卡,大卡用鼠标点开(applySearch 也是这么重建的)
      const g=groupEl(row,col); el.appendChild(g);
      const famOpen = FAMILY && (row.name===FAMILY.fold || FAMILY.deps.has(row.name));
      if(OPEN.has(foldKey(col.key,row.name)) || famOpen
         || (toks.length && row.tasks.some(t=>hits(t,toks))))
        for(const t of row.tasks){
        const c=cardEl(t,col.color); c.classList.add("ingrp"); el.appendChild(c); FOCUS.push(c);
      }
    }
    b.appendChild(el);
  }
  applySearch();
  famBar();
}
function sec(p,title){p.appendChild($("h3",null,title))}
function blk(p,text,sub){
  const e=$("div","blk",text); if(sub){const s=$("div","sub",sub); e.appendChild(s)} p.appendChild(e);
}
function list(p,arr){const u=$("ul");for(const x of arr||[])u.appendChild($("li",null,String(x)));p.appendChild(u)}
async function openTask(id){
  const r=await fetch("/api/task?id="+encodeURIComponent(id));
  const p=document.getElementById("detail"); p.textContent=""; p.style.display="block";
  if(!r.ok){p.appendChild($("div","blk","读不到:"+id));return}
  const t=await r.json();
  const x=$("div","",""); x.id="close"; x.textContent="✕"; x.onclick=()=>p.style.display="none"; p.appendChild(x);
  p.appendChild($("h2",null,t.title));
  p.appendChild($("div","sub",[t.id,t.status,t.waiting_on?"waiting:"+t.waiting_on:null,t.owner||"无主",
      t.epic].filter(Boolean).join(" · ")));
  p.appendChild($("div","sub","建于 "+ago(t.created_at)+(t.started_at?" · 开工 "+ago(t.started_at):"")+
      (t.completed_at?" · 完成 "+ago(t.completed_at):"")));
  const dagA=$("a","dag-link","DAG 关系图");
  dagA.href="/?view=dag&focus="+encodeURIComponent(t.id);
  p.appendChild(dagA);
  if(t.now){sec(p,"当前态");blk(p,t.now)}
  if(t.origin){sec(p,"缘由");blk(p,t.origin)}
  if(t.success&&t.success.length){sec(p,"验收判据");list(p,t.success)}
  if(t.constraints&&t.constraints.length){sec(p,"约束");list(p,t.constraints)}
  const edges=(t.edges_out||[]).concat(t.edges_in||[]);
  if(edges.length){
    sec(p,"关联(对端状态实时)");
    for(const e of edges){
      const d=$("div","blk");
      const a=$("span","edge",(e.dir==="out"?e.kind+" → ":"← "+e.kind+" ")+e.other);
      a.onclick=()=>openTask(e.other); d.appendChild(a);
      d.appendChild($("div","sub",e.other_title+" · "+e.other_status+
        (e.other_waiting_on?"("+e.other_waiting_on+")":"")+(e.note?" · "+e.note:"")));
      p.appendChild(d);
    }
  }
  if(t.decisions&&t.decisions.length){
    sec(p,"决策");
    for(const d of t.decisions){
      const e=$("div","blk");
      e.appendChild($("div",null,d.question));
      e.appendChild($("div",null,"→ "+d.verdict));
      for(const r of d.rejected||[]) e.appendChild($("div","rej","否 "+(r.option||"")+" — "+(r.reason||"")));
      e.appendChild($("div","sub",d.decided_by+" · "+ago(d.created_at)+(d.adr?" · "+d.adr:"")+
        (d.supersedes?" · 修订 #"+d.supersedes:"")));
      p.appendChild(e);
    }
  }
  if(t.sessions&&t.sessions.length){
    sec(p,"执行履历");
    for(const s of t.sessions)
      blk(p,(s.summary||"(在飞)"),s.owner+" · 起 "+ago(s.started_at)+
        (s.ended_at?" · 收 "+ago(s.ended_at):"")+(s.outcome?" · "+s.outcome:""));
  }
  if(t.events&&t.events.length){
    sec(p,"最近事件");
    for(const e of t.events) blk(p,e.body,e.kind+" · "+e.author+" · "+ago(e.created_at));
  }
  if(t.refs&&t.refs.length){
    sec(p,"指针");
    for(const r of t.refs) blk(p,r.kind+" "+r.value,(r.note?r.note+" · ":"")+ago(r.created_at));
  }
  if(t.touches&&t.touches.length){sec(p,"touches");list(p,t.touches)}
}
document.getElementById("q").addEventListener("input", ()=>load(true));
document.addEventListener("keydown", e=>{
  const inQ=e.target.id==="q";
  if(e.key==="/" && !inQ){ e.preventDefault(); document.getElementById("q").focus(); document.getElementById("q").select(); return; }
  if(e.key==="Escape"){
    if(inQ && document.getElementById("q").value){ document.getElementById("q").value=""; load(true); return; }
    document.getElementById("detail").style.display="none";
    if(FAMILY){ clearFamily(); return; }
    document.getElementById("q").blur();
    return;
  }
  if(inQ) return;
  if(e.key==="j"||e.key==="ArrowDown"){ e.preventDefault(); if(!FOCUS.length)return; FI=Math.min(FOCUS.length-1, Math.max(0,FI)+1); select(FOCUS[FI]._task.id, false); return; }
  if(e.key==="k"||e.key==="ArrowUp"){ e.preventDefault(); if(!FOCUS.length)return; FI=Math.max(0,(FI<0?0:FI)-1); select(FOCUS[FI]._task.id, false); return; }
  if(e.key==="Enter" && SEL){ e.preventDefault(); openTask(SEL); return; }
  if(e.key==="g" && SEL){ e.preventDefault(); location.href="/?view=dag&focus="+encodeURIComponent(SEL); return; }
  if(e.key==="f"){ e.preventDefault(); window.scrollTo({top:0,behavior:"smooth"}); document.querySelector(".card.sel")?.scrollIntoView({block:"nearest"}); return; }
});
load();
setInterval(load,30000);
</script>
"""


# ── HTTP ─────────────────────────────────────────────────────────

class _Handler(BaseHTTPRequestHandler):
    db_path: Path = Path()

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def do_GET(self) -> None:  # noqa: N802
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        if u.path == "/":
            view = (qs.get("view") or [""])[0]
            if view == "dag":
                dag = DAG_DIR / "index.html"
                if not dag.exists():
                    self._json(404, {"error": "dagview/index.html missing"})
                    return
                self._send(200, dag.read_bytes(), "text/html; charset=utf-8")
            elif view == "modules":
                self._send(200, MODULES_PAGE.encode(), "text/html; charset=utf-8")
            elif view == "inbox":
                self._send(200, INBOX_PAGE.encode(), "text/html; charset=utf-8")
            elif view == "legacy" or not (WEBUI_DIST / "index.html").exists():
                # 看板是底线(用户 2026-08-14 拍板):asks 表坏了、巡检 agent 挂了、
                # LLM 不可用 —— 看板都必须照常可用。收件箱是叠在它上面的一层,不是替代品。
                self._send(200, PAGE.encode(), "text/html; charset=utf-8")
            else:
                self._send(200, (WEBUI_DIST / "index.html").read_bytes(), "text/html; charset=utf-8")
        elif u.path == "/api/modules":
            try:
                self._json(200, modules_data(self.db_path))
            except Exception as e:  # noqa: BLE001  # 叠加层坏了也得给合法响应,看板不陪葬
                self._json(200, {"tasks": [], "deps": [], "unavailable": True,
                                 "error": f"{type(e).__name__}: {e}"})
        elif u.path == "/api/inbox":
            try:
                self._json(200, inbox_data(self.db_path))
            except Exception as e:  # noqa: BLE001  # 边界:叠加层坏了也得给出合法响应
                self._json(200, {"total": 0, "oldest_days": 0.0, "unavailable": True,
                                 "error": f"{type(e).__name__}: {e}", "groups": [],
                                 "flow": {"raised_7d": 0, "closed_7d": 0}, "agent_side": 0})
        elif u.path == "/api/board":
            since = (qs.get("since") or [""])[0]
            until = (qs.get("until") or [""])[0] or since
            touched = None
            if since:
                try:
                    touched = range_bounds(since, until)
                except ValueError:
                    self._json(400, {"error": "since/until 须为 YYYY-MM-DD 且 until ≥ since"})
                    return
            # 活性探测不许拖垮看板:任何异常都降级成「不探测」(全部留白),板照常出
            try:
                idx, complete = _transcript_index()
            except Exception:  # noqa: BLE001  # 边界:探测是增强件
                idx, complete = None, False
            d = board_data(self.db_path, idx=idx, touched=touched)
            d["liveness"] = {"available": idx is not None, "complete": complete,
                             "busy_window_s": BUSY_WINDOW_S, "idle_window_s": IDLE_WINDOW_S}
            self._json(200, d)
        elif u.path == "/api/graph":
            root = ((qs.get("root") or qs.get("focus") or [""])[0] or "").strip() or None
            max_depth = _clamp((qs.get("max_depth") or [None])[0], 1, 32, 8)
            max_nodes = _clamp((qs.get("max_nodes") or [None])[0], 2, 200, 80)
            fold = (qs.get("fold") or ["0"])[0].lower() in ("1", "true", "yes")
            try:
                g = graph_data(
                    self.db_path, root=root,
                    max_depth=max_depth, max_nodes=max_nodes,
                )
                if fold and not root:      # ego 子图本来就小,折叠没意义
                    con = _ro(self.db_path)
                    try:
                        g = fold_graph(g, prefix_hints(con))
                    finally:
                        con.close()
                self._json(200, g)
            except db.NawabanError as e:
                self._json(404, {"error": str(e)})
        elif u.path == "/api/task":
            tid = (qs.get("id") or [""])[0]
            try:
                self._json(200, task_detail(self.db_path, tid))
            except db.NawabanError as e:
                self._json(404, {"error": str(e)})
        elif u.path == "/api/kin":
            tid = (qs.get("id") or [""])[0]
            try:
                self._json(200, db.kin(self.db_path, tid))
            except db.NawabanError as e:
                self._json(404, {"error": str(e)})
        elif u.path.startswith("/assets/") or u.path == "/favicon.svg":
            self._static(WEBUI_DIST, unquote(u.path.lstrip("/")))
        elif u.path.startswith("/vendor/"):
            self._static(VENDOR_DIR, unquote(u.path[len("/vendor/"):]))
        else:
            self._json(404, {"error": "no such path"})

    def _static(self, root: Path, rel: str) -> None:
        if ".." in rel.split("/") or rel.startswith("/"):  # 绝对路径会让 root / rel 直接丢掉 root
            self._json(400, {"error": "bad path"})
            return
        fp = (root / rel).resolve()
        # 按目录祖先判,不按字符串前缀:vendor-private/ 也以 vendor 开头
        if not fp.is_relative_to(root.resolve()) or not fp.is_file():
            self._json(404, {"error": "no such static file"})
            return
        ctype = mimetypes.guess_type(str(fp))[0] or "application/octet-stream"
        if fp.suffix == ".js":
            ctype = "application/javascript"
        self._send(200, fp.read_bytes(), ctype)

    # 信任边界(刻意,不是遗漏):板不做身份校验 —— 能连到这个端口 = 有权代表人拍板。
    # 前提是它只绑 127.0.0.1 或 tailnet IP(board-up.sh 保证),而 tailnet 内全是本人设备。
    # 因此**绝不能**绑 0.0.0.0 / 公网地址;真要多人用,这里得先加共享 token。
    # 拍板通道闸(decided_by=user 需 NAWABAN_DECISION_CHANNEL)在进程身份层生效,拦的是
    # agent 冒充人,不是网络层的伪造 —— 两者防的不是一回事。
    def do_POST(self) -> None:  # noqa: N802
        """回答一个 ask(NAWABAN-INBOX-WRITE-001 · 选型 B)。

        **板自己的库连接仍然只读** —— 模块头那条不变量没破。写走 cli 子进程,
        于是自动继承库层全部闸:done 闸(须真人拍板行且严格晚于翻 verified 的秒)、
        拍板通道闸、幻觉闸、CAS、append-only trigger。在板里开写连接就得把这些
        重实现一遍或绕过,而它们恰恰刚实测证明了会拦住 agent 自批。
        """
        u = urlparse(self.path)
        if u.path != "/api/answer":
            self._json(404, {"error": "no such path"})
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            if not isinstance(body, dict):
                # null / [1] / "x" / true 都是合法 JSON 但没有 .get —— 边界要挡
                raise TypeError("body 必须是 JSON 对象")
        except (ValueError, TypeError):
            self._json(400, {"error": "body 不是合法 JSON"})
            return
        try:
            aid = int(body.get("ask_id") or 0)
        except (ValueError, TypeError):
            aid = 0
        verdict = (body.get("verdict") or "").strip()
        if not aid or not verdict:
            self._json(400, {"error": "ask_id 与 verdict 必填"})
            return
        cmd = [sys.executable, str(Path(__file__).with_name("cli.py")),
               "--db", str(self.db_path), "answer", str(aid), "--verdict", verdict]
        if body.get("reject"):
            cmd.append("--reject")
        # 身份:人在收件箱里点的。owner 固定 inbox,与 agent 的 ac:xxxxxx 分开,审计可辨。
        env = dict(os.environ, FOREMAN_OWNER="inbox",
                   CLAUDE_CODE_SESSION_ID=f"inbox-{os.getpid()}")
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=30)
        except subprocess.TimeoutExpired:
            # 客户端超时按「未知」呈现,不按「失败」—— 子进程可能已经提交了
            self._json(504, {"ok": False, "unknown": True,
                             "out": "cli 超时,结果未知 —— 刷新页面看条目是否已关闭,别重试"})
            return
        out = (r.stdout + r.stderr).strip()
        self._json(200 if r.returncode == 0 else 400,
                   {"ok": r.returncode == 0, "out": out})

    def log_message(self, fmt: str, *args) -> None:
        pass  # 本地只读板,访问日志无消费者


def serve(path: Path, port: int, host: str = "127.0.0.1") -> None:
    """在给定地址上起板。``host`` 可给多个(逗号分隔),每个一个监听。

    为什么要多个:为了手机能连,板得绑 tailnet IP;可那样一来本机输 localhost 反而打不开
    (实测 127.0.0.1:8813 直接连不上)—— 同一个人在两台设备上要记两个地址,还撞过两次。
    **不用 0.0.0.0 解决**:板没有鉴权,能连到端口就等于能替人拍板,信任边界必须停在
    「本机 + 自己的 tailnet」,不能对整个局域网敞开(见 do_POST 上方那段)。
    """
    _Handler.db_path = path
    hosts = [h.strip() for h in host.split(",") if h.strip()]
    if any(h in ("0.0.0.0", "::", "*") for h in hosts):  # noqa: S104
        print("✗ 拒绝绑 0.0.0.0:板无鉴权,只许绑 127.0.0.1 与自己的 tailnet IP",
              file=sys.stderr)
        raise SystemExit(2)

    servers = [ThreadingHTTPServer((h, port), _Handler) for h in hosts]
    for h in hosts:
        print(f"NAWABAN 板 → http://{h}:{port}/  DAG → /?view=dag[&focus=id]  (库:{path} · 只读)")
    # 除最后一个外都放后台线程,主线程守着最后一个 —— Ctrl-C 仍能整体退出
    for srv in servers[:-1]:
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    servers[-1].serve_forever()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="board_view", description="NAWABAN 本地只读板")
    ap.add_argument("--db", help="库路径(默认 NAWABAN_DB env → 就近 .nawaban/nawaban.db)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("NAWABAN_BOARD_PORT") or os.environ.get("WORKOS_BOARD_PORT") or "8813"))
    ap.add_argument("--host", default=(os.environ.get("NAWABAN_BOARD_HOST") or os.environ.get("WORKOS_BOARD_HOST")
                                     or os.environ.get("DAGVIEW_HOST", "127.0.0.1")),
                    help="监听地址,逗号分隔可给多个(如 127.0.0.1,100.x.x.x)")
    a = ap.parse_args(argv)
    path = Path(a.db).expanduser() if a.db else db.resolve_db()
    if not path.exists():
        print(f"✗ 库不存在:{path}", file=sys.stderr)
        return 1
    serve(path, a.port, host=a.host)
    return 0


if __name__ == "__main__":
    sys.exit(main())
