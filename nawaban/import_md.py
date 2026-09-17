#!/usr/bin/env python3
"""NAWABAN-IMPORT-001 · md 卡一次性导入器(格式死,数据活)。

跑法:
    python3 nawaban/import_md.py            # dry-run,打对账报告
    python3 nawaban/import_md.py --apply    # 真导入(幂等)
    ... --root <repo> --db <path> --report <out.md>

契约:.foreman/artifacts/看板字段设计-v1草案-2026-08-12.md(19 列 6 表)。
写库只走 nawaban.db 的 import_task / link_tasks——本文件一行 SQL 都没有(方案 B 已被否决)。

只读旧 md,不改不删(归档归 RETIRE 卡)。解析不出的卡进人工清单,不静默跳过。

三条 no_fabrication 边界:
  · 标题:旧标题原样搬(只剥与 PK 重复的 `<id> · ` 前缀),一律打 needs_retitle 事件,不编人话标题。
  · 时间戳:只认卡里真写下的日期(sessions/handoff/时间线/staging_verified_at/done_at);
    一个都没有才退到文件 mtime,并在报告里单列计数——推断出来的时间要能被看见。
  · 决策归属:卡文本写明「用户拍板/用户令」→ decided_by=user,其余 agent:<卡 owner>;
    每行必带 provenance(源文件+行号+原文),误标可回溯可纠(2026-08-12 用户拍板)。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Optional

FOREMAN = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(FOREMAN))

from foreman_card import CardError, parse_card_text  # noqa: E402
from nawaban import db  # noqa: E402

TITLE_MAX = 80
NOW_MAX = 200
EVENT_MAX = 2048

# 卡文本自称用户意志的措辞 → decided_by=user(2026-08-12 用户拍板的归属规则)
USER_VERDICT = re.compile(r"用户拍板|用户令|用户要求|用户明确|用户否|用户选|用户定")
DATE = re.compile(r"(\d{4})-(\d{2})-(\d{2})")
# 「2026-08-12 ac:xxxxxxxx | 正文」——时间线/handoff 的事实行格式
DATED_LINE = re.compile(r"^\s*-?\s*(\d{4}-\d{2}-\d{2})\s+(\S+)\s*\|\s*(.*)$", re.S)
SECTION = r"^##+[ \t]*{}[^\n]*\n(.*?)(?=^##+[ \t]|\Z)"
FENCE = re.compile(r"```.*?\n(.*?)```", re.S)
ARROW = re.compile(r"[→>]")

# 旧字段 → refs.kind(pr 183 卡 / merge 51 / issue 7 / commits 3 / acceptance 248 的现实)
REF_FIELDS = {
    "pr": "pr", "hotfix_pr": "pr", "handoff_pr": "pr", "pr_prereq": "pr",
    "merge": "merge_sha", "issue": "issue", "commits": "commit",
    "acceptance": "acceptance_run", "build": "acceptance_run",
}
EDGE_FIELDS = {"depends_on": "depends_on", "blocked_by": "depends_on",
               "blockers": "depends_on"}


# ── 解析 ──────────────────────────────────────────────────────────

@dataclass
class Failure:
    path: str
    reason: str


@dataclass
class CardPlan:
    task_id: str
    path: str
    row: dict
    events: list[dict] = field(default_factory=list)
    decisions: list[dict] = field(default_factory=list)
    sessions: list[dict] = field(default_factory=list)
    refs: list[dict] = field(default_factory=list)
    edges: list[tuple[str, str, str]] = field(default_factory=list)  # (src,dst,kind)
    raw_edges: list[tuple[str, str, str]] = field(default_factory=list)  # (向,kind,原文)
    warnings: list[str] = field(default_factory=list)


def iter_cards(root: Path) -> list[Path]:
    """全量 glob:tasks/**/*.md。用 ** 而不是 */{active,done}/* ——backend-o/ 根下
    有 2 张散落卡,窄 glob 会把它们静默漏掉(407 vs 409 的差)。"""
    return sorted((root / ".foreman" / "tasks").rglob("*.md"))


def _section(body: str, name: str) -> Optional[str]:
    m = re.search(SECTION.format(name), body, re.M | re.S)
    return m.group(1) if m else None


def _bullets(text: str) -> list[tuple[str, str]]:
    """取「- 」条目 → (拼好的正文, 首个物理行原文)。续行(缩进)并进上一条
    ——对齐段普遍多行折行;保留物理行是为了能在**源文件**里定位行号。"""
    out: list[tuple[str, str]] = []
    for ln in text.splitlines():
        if re.match(r"^\s*[-*]\s+\S", ln):
            out.append((ln.strip()[2:].strip(), ln))
        elif out and ln.strip() and ln.startswith((" ", "\t")):
            out[-1] = (out[-1][0] + " " + ln.strip(), out[-1][1])
    return [(b, raw) for b, raw in out if b]


def _lineno(full_text: str, physical_line: str) -> int:
    """物理行在**源文件全文**里的 1-based 行号(含 frontmatter)。找不到返回 0
    —— 0 是「定位不到」的诚实信号,不拿一个像样的假行号糊弄回溯。"""
    idx = full_text.find(physical_line)
    return full_text[:idx].count("\n") + 1 if idx >= 0 else 0


def _epoch(datestr: str) -> int:
    return int(time.mktime(time.strptime(datestr, "%Y-%m-%d")))


def _iso_epoch(s: str) -> Optional[int]:
    """`2026-08-12T14:55:00+07:00` 优先按 ISO 取(带时分秒),退化到只取日期。"""
    import datetime as _dt
    try:
        return int(_dt.datetime.fromisoformat(s.strip()).timestamp())
    except ValueError:
        m = DATE.search(s)
        return _epoch(m.group(0)) if m else None


def _as_list(v: Any) -> list[str]:
    if v is None or v == "":
        return []
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x or "").strip()]
    return [str(v).strip()]


def _clip(s: str, limit: int) -> tuple[str, bool]:
    """超限可见截断(Hermes 同款标记),绝不静默切。"""
    if len(s) <= limit:
        return s, False
    keep = limit - 40
    return s[:keep] + f"… [truncated, {len(s) - keep} chars omitted]", True


def parse_one(path: Path, root: Path) -> tuple[Optional[dict], Optional[Failure]]:
    try:
        text = path.read_text(encoding="utf-8")
        fm, body = parse_card_text(text)
    except CardError as e:
        return None, Failure(str(path.relative_to(root)), str(e))
    except OSError as e:
        return None, Failure(str(path), f"读文件失败:{e}")
    tid = str(fm.get("task_id") or "").strip()
    if not tid:
        return None, Failure(str(path.relative_to(root)), "frontmatter 无 task_id")
    return {"fm": fm, "body": body, "text": text, "path": path, "task_id": tid}, None


# ── 逐卡建计划 ────────────────────────────────────────────────────

def _title(card: dict) -> tuple[str, str, bool]:
    """返回 (入库 title, 原始 H1, 是否截断)。剥 `<id> · ` 前缀:ID 是 PK,板不渲染前缀。"""
    m = re.search(r"^#\s+(.+)$", card["body"], re.M)
    raw = m.group(1).strip() if m else card["task_id"]
    t = raw
    for sep in (" · ", " — ", " - ", ": "):
        if t.startswith(card["task_id"] + sep):
            t = t[len(card["task_id"] + sep):].strip()
            break
    if not t:
        t = raw
    clipped, was = _clip(t, TITLE_MAX)
    return clipped, raw, was


def _card_dates(fm: dict, body: str) -> list[int]:
    """卡里真写下的日期(不含正文散文里的任意日期——只取结构化位置)。"""
    out: list[int] = []
    for src in (_as_list(fm.get("sessions")), _as_list(fm.get("handoff"))):
        for line in src:
            m = DATE.search(line)
            if m:
                out.append(_epoch(m.group(0)))
    for key in ("staging_verified_at", "done_at", "prod_verified_at"):
        v = fm.get(key)
        if v:
            m = DATE.search(str(v))
            if m:
                out.append(_epoch(m.group(0)))
    tl = _section(body, "时间线")
    if tl:
        for b, _ in _bullets(tl):
            m = DATE.match(b.strip())
            if m:
                out.append(_epoch(m.group(0)))
    return sorted(out)


def _sessions(fm: dict, task_id: str, fallback: int) -> tuple[list[dict], list[str]]:
    """`owner | session_id | date` 是主格式;实测另有 `grok | 2026-07-25 | 切片2+3` 这类
    没有真 session id 的历史行 —— 合成 `legacy:` 键并把原文留 note,不假装它是 uuid。"""
    rows, warns = [], []
    seen = set()
    for raw in _as_list(fm.get("sessions")):
        parts = [p.strip() for p in str(raw).split("|")]
        owner = parts[0] or "unknown"
        sid = parts[1] if len(parts) > 1 else ""
        m = DATE.search(raw)
        started = _epoch(m.group(0)) if m else fallback
        if DATE.fullmatch(sid) or not sid or " " in sid:
            sid = f"legacy:{owner}:{m.group(0) if m else 'nodate'}"
            warns.append(f"session 行无真 session_id,合成 {sid}:{raw[:60]}")
        if sid in seen:
            continue
        seen.add(sid)
        rows.append({"owner": owner, "session_id": sid, "started_at": started,
                     "note": raw})
    return rows, warns


def _events(fm: dict, body: str, task_id: str, fallback: int,
            title_raw: str, sess_ids: list[str]) -> tuple[list[dict], list[str]]:
    out, warns = [], []
    sid = sess_ids[0] if sess_ids else None

    def add(kind: str, raw: str, author: str, ts: int, session: Optional[str]) -> None:
        b, was = _clip(raw, EVENT_MAX)
        if was:
            warns.append(f"{kind} 事件超 2KB,已可见截断(全文在源卡)")
        out.append({"kind": kind, "body": b, "author": author,
                    "created_at": ts, "session_id": session})

    for raw in _as_list(fm.get("handoff")) + _as_list(fm.get("handoff_codex")):
        m = DATED_LINE.match(raw)
        if m:
            add("handoff", m.group(3).strip(), m.group(2), _epoch(m.group(1)), sid)
        else:
            add("handoff", raw, "import", fallback, sid)
            warns.append(f"handoff 行无「日期 作者 |」前缀,时间退到卡首日:{raw[:50]}")
    tl = _section(body, "时间线")
    if tl:
        for b, _ in _bullets(tl):
            m = DATED_LINE.match(b)
            if m:
                add("note", m.group(3).strip(), m.group(2), _epoch(m.group(1)), None)
            else:
                m2 = DATE.match(b.strip())
                add("note", b, "import", _epoch(m2.group(0)) if m2 else fallback, None)

    # staging_verified_at → status_change 事件(转写,不是编造:旧卡记的就是「此刻翻的 sv」)。
    # 必须有:done 闸② 拿「最后一条 →staging-verified 事件」当锚点比对 user 拍板行的时间;
    # 导入卡没有这个事件 → 锚点退化成 0 → **任何历史 user 行都满足闸**,agent 可静默自批。
    # body 必须以「→staging-verified」结尾,闸用 LIKE 匹配。
    sva = fm.get("staging_verified_at")
    if sva:
        ts = _iso_epoch(str(sva))
        if ts:
            add("status_change", "in_progress→staging-verified", "import", ts, None)
        else:
            warns.append(f"staging_verified_at 解析不出时间,闸②锚点缺失:{sva}")

    # needs_retitle:这批标题全部产生于旧标题制,没有一条经过「人话标题」审核。
    # 不由 agent 挑「哪些够人话」——那是编造判断;一律标记,人/后续卡再逐张改。
    mark, _ = _clip(f"needs_retitle · 旧标题原样导入(未经人话标题制审核)· 原始 H1:{title_raw}",
                    EVENT_MAX)
    out.append({"kind": "note", "body": mark, "author": "import",
                "created_at": fallback, "session_id": None})
    return out, warns


def _decisions(body: str, full_text: str, task_id: str, owner: str, rel_path: str,
               fallback: int) -> list[dict]:
    sec = _section(body, "对齐")
    if not sec:
        return []
    rows = []
    for b, physical in _bullets(sec):
        lineno = _lineno(full_text, physical)
        by = "user" if USER_VERDICT.search(b) else f"agent:{owner}"
        m = DATE.search(b)
        rows.append({
            "question": "旧卡「## 对齐」行(NAWABAN-IMPORT-001 导入,未拆 question/verdict)",
            "verdict": b,
            "decided_by": by,
            "created_at": _epoch(m.group(0)) if m else fallback,
            "provenance": {"source": "import", "file": rel_path, "line": lineno,
                           "raw": b[:400],
                           "rule": "USER_VERDICT 命中→user,否则 agent:<卡owner>"},
        })
    return rows


# 归属仍只认明写(USER_VERDICT);TypeSafe Choice 只找可能判反的行列进报告给人核,不改 decided_by(2026-09-17 拍板)
_VERDICT_CRITERIA = {"user": "文本写明或清楚表明由用户拍板、下令或选定(含引用用户原话)",
                     "agent": "agent 自己的判断、结论或记录;文本没有表明是用户定的"}


def verdict_review(plans: list[CardPlan]) -> Optional[dict]:
    """返回 {"rows": 意见相左的行, "unjudged": 没拿到合法判分的行数};无 key = None。"""
    if not os.environ.get("TYPESAFE_API_KEY"):
        return None
    from nawaban.cli import _answers, _prob  # 懒加载:cli 会拉起 board_view
    rows, unjudged = [], 0
    for p in plans:
        if not p.decisions:
            continue
        qs = {f"d{i}": {"type": "choice", "criteria": _VERDICT_CRITERIA,
                        "instructions": f"这条决策记录 `verdicts[{i}]` 是谁拍板的?"}
              for i in range(len(p.decisions))}
        ans = _answers({"verdicts": [d["verdict"] for d in p.decisions]}, qs)
        for i, d in enumerate(p.decisions):
            a = ans.get(f"d{i}")
            probs = a.get("probabilities") if isinstance(a, dict) else None
            pu = _prob(probs.get("user")) if isinstance(probs, dict) else None
            pa = _prob(probs.get("agent")) if isinstance(probs, dict) else None
            if pu is None or pa is None or pu == pa or set(probs) != set(_VERDICT_CRITERIA):
                unjudged += 1
                continue
            model = "user" if pu > pa else "agent"
            rule = "user" if d["decided_by"] == "user" else "agent"
            if model != rule:
                rows.append({"task_id": p.task_id, "file": d["provenance"]["file"],
                             "line": d["provenance"]["line"], "rule": rule, "model": model,
                             "p": max(pu, pa), "verdict": d["verdict"]})
    return {"rows": rows, "unjudged": unjudged}


def _refs(fm: dict, path: Path, ts: int) -> list[dict]:
    out = []
    for fkey, kind in REF_FIELDS.items():
        for raw in _as_list(fm.get(fkey)):
            if kind in ("pr", "issue"):
                nums = re.findall(r"#?(\d{2,6})", raw)
                for n in nums:
                    out.append({"kind": kind, "value": f"#{n}", "note": raw[:200],
                                "created_at": ts})
                if not nums:
                    out.append({"kind": kind, "value": raw[:300], "created_at": ts})
            else:
                out.append({"kind": kind, "value": raw[:2000], "created_at": ts})
    # 源卡本体:事件截断/散文全貌都能回溯到这张 md(保存闸要求文件真实存在)
    out.append({"kind": "artifact", "value": str(path), "created_at": ts,
                "note": "导入源卡(只读)"})
    # 同 (kind,value) 去重:PK 冲突走 INSERT OR IGNORE,这里先收敛报告数字
    seen, dedup = set(), []
    for r in out:
        k = (r["kind"], r["value"])
        if k not in seen:
            seen.add(k)
            dedup.append(r)
    return dedup


def plan_card(card: dict, root: Path) -> CardPlan:
    fm, body, tid = card["fm"], card["body"], card["task_id"]
    rel = str(card["path"].relative_to(root))
    warns: list[str] = []

    dates = _card_dates(fm, body)
    if dates:
        created, last = dates[0], dates[-1]
    else:
        created = last = int(card["path"].stat().st_mtime)
        warns.append("卡内无任何结构化日期,created_at 退到文件 mtime")

    status = str(fm.get("status") or "open").strip()
    if status == "todo":  # 1 张历史遗留;status CHECK 只认 5 态
        status = "open"
        warns.append("status: todo → open(枚举外的历史值)")

    title, title_raw, clipped = _title(card)
    if clipped:
        warns.append(f"标题 >{TITLE_MAX} 字符,已可见截断(全文进 needs_retitle 事件)")

    notes = str(fm.get("notes") or "").strip()
    now = notes if 0 < len(notes) <= NOW_MAX else None

    # 「无主」的哨兵写法归一成 NULL —— claim_task 的 CAS 是 `WHERE owner IS NULL`,
    # 任何非空字符串(包括 foreman_claim_issue.py 写的 "unassigned")都会让卡
    # **永远 claim 不了**,而报错只说「已被占或不在 open 态」,完全不指向根因。
    # 2026-08-23 实测:16 张 open 卡卡在这上面。
    _owner_raw = str(fm.get("owner") or "").strip()
    owner = None if _owner_raw.lower() in {"", "unassigned", "none", "-", "null"} else _owner_raw
    sessions, sw = _sessions(fm, tid, created)
    warns += sw
    events, ew = _events(fm, body, tid, created, title_raw, [s["session_id"] for s in sessions])
    warns += ew

    row = {
        "task_id": tid, "title": title, "status": status, "created_at": created,
        "owner": owner,
        "waiting_on": (str(fm["waiting_on"]).strip()
                       if fm.get("waiting_on") in db.WAITING else None),
        "epic": fm.get("epic"), "context": notes or None, "now": now,
        "success": _as_list(fm.get("success")) or None,
        "constraints": _as_list(fm.get("constraints")) or None,
        "touches": _as_list(fm.get("touches")) or None,
        "adr": fm.get("adr"),
        "started_at": sessions[0]["started_at"] if sessions else None,
        "completed_at": last if status == "done" else None,
    }
    if fm.get("waiting_on") and row["waiting_on"] is None:
        warns.append(f"waiting_on 枚举外的值已丢弃:{fm.get('waiting_on')}")
    for k in ("epic", "adr"):
        if row[k] is not None:
            row[k] = str(row[k]).strip() or None

    plan = CardPlan(task_id=tid, path=rel, row=row, events=events, sessions=sessions,
                    decisions=_decisions(body, card["text"], tid, owner or "unknown",
                                         rel, created),
                    refs=_refs(fm, card["path"], created), warnings=warns)
    # 边只登记原文,等 build() 拿到全量 known 再解析:实测 depends_on 值普遍带
    # 「(done · PR#2093)」这类手写快照注解(字段草案 §一③),按空格切会切出
    # main / GET / · 这种垃圾,并把真边一起丢掉。抽取统一走 _find_ids。
    for fkey, kind in EDGE_FIELDS.items():
        for raw in _as_list(fm.get(fkey)):
            plan.raw_edges.append(("out", kind, raw))
    for raw in _as_list(fm.get("blocks")):  # 反向:我挡着谁 = 谁依赖我
        plan.raw_edges.append(("in", "depends_on", raw))
    return plan


# ── 边:字段 + epic 依赖图 ────────────────────────────────────────

def _id_pattern(known: set[str]) -> Optional[re.Pattern]:
    """只认**已知卡 id** 的抽取器——字段值与正文共用同一套。
    不做形状通配:幻觉引用、快照注解里的 PR 号/分支名/中点一律不进图。"""
    if not known:
        return None
    return re.compile(r"(?<![A-Za-z0-9_-])(" +
                      "|".join(sorted(map(re.escape, known), key=len, reverse=True)) +
                      r")(?![A-Za-z0-9_-])")


def _find_ids(text: str, pat: Optional[re.Pattern], exclude: str) -> list[str]:
    if pat is None:
        return []
    return [i for i in dict.fromkeys(pat.findall(text)) if i != exclude]


def field_edges(plans: list[CardPlan], known: set[str]) -> tuple[list[tuple[str, str, str]],
                                                                 list[tuple[str, str]]]:
    """自发 depends_on / blocked_by / blocks 字段 → 边。
    返回 (边, 解析不出任何已知卡的原文清单) —— 后者进报告,不静默吞。"""
    pat = _id_pattern(known)
    out, unresolved = [], []
    for p in plans:
        for direction, kind, raw in p.raw_edges:
            ids = _find_ids(raw, pat, p.task_id)
            if not ids:
                unresolved.append((p.task_id, raw[:120]))
                continue
            for other in ids:
                out.append((p.task_id, other, kind) if direction == "out"
                           else (other, p.task_id, kind))
    return out, unresolved

def epic_edges(root: Path, known: set[str]) -> tuple[list[tuple[str, str, str]], list[str]]:
    """epic 地图 ``` 块里的 ASCII 依赖图 → depends_on 边(A → B 读作 B 依赖 A)。
    树枝续行(├└│)继承上一个「行首是卡 id」的父节点。启发式:全部边在报告里列出待人核。"""
    edges, notes = [], []
    epics = sorted((root / ".foreman" / "epics").glob("*.md"))
    for ep in epics:
        text = ep.read_text(encoding="utf-8")
        for fence in FENCE.findall(text):
            parent: Optional[str] = None
            for line in fence.splitlines():
                ids = [m.group(1) for m in re.finditer(
                    r"(?<![A-Za-z0-9_-])([A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+)(?![A-Za-z0-9_-])", line)]
                ids = [i for i in ids if i in known]
                if not ids:
                    continue
                head = line.lstrip()
                starts_with_id = head.startswith(ids[0])
                chain = ids
                if not starts_with_id and parent:
                    chain = [parent] + ids
                if starts_with_id:
                    parent = ids[0]
                if not ARROW.search(line) and len(chain) < 2:
                    continue
                for a, b in zip(chain, chain[1:]):
                    if a != b:
                        edges.append((b, a, "depends_on"))  # b 依赖 a
            notes.append(f"{ep.name}:累计 {len(edges)} 条")
    uniq = sorted(set(edges))
    return uniq, notes


# ── 报告 ──────────────────────────────────────────────────────────

def render_report(root: Path, files: list[Path], plans: list[CardPlan],
                  failures: list[Failure], edges: list[tuple[str, str, str]],
                  applied: Optional[dict], epic_notes: list[str],
                  review: Optional[dict] = None) -> str:
    n = len(plans)
    L = [f"# NAWABAN-IMPORT-001 对账报告 · {time.strftime('%Y-%m-%d %H:%M:%S')}", "",
         f"源 glob:`{root}/.foreman/tasks/**/*.md` → **{len(files)}** 个文件",
         f"解析成功 **{n}** · YAML/结构失败 **{len(failures)}**"
         f"(和 = {n + len(failures)},与 glob 一致:{n + len(failures) == len(files)})", ""]

    def cnt(attr: str) -> int:
        return sum(len(getattr(p, attr)) for p in plans)

    L += ["## 逐表行数(计划)", "",
          "| 表 | 行数 |", "|---|---|",
          f"| tasks | {n} |",
          f"| task_events | {cnt('events')} |",
          f"| task_decisions | {cnt('decisions')} |",
          f"| task_sessions | {cnt('sessions')} |",
          f"| task_refs | {cnt('refs')} |",
          f"| task_edges | {len(edges)} |", ""]

    filled = {k: sum(1 for p in plans if p.row.get(k) not in (None, "", []))
              for k in ("title", "status", "owner", "waiting_on", "epic",
                        "context", "now", "success", "constraints", "touches",
                        "adr", "started_at", "completed_at")}
    L += ["## 逐列覆盖率(15 列)", "", "| 列 | 有值 | 覆盖率 |", "|---|---|---|",
          f"| id | {n} | 100.0% |", f"| created_at | {n} | 100.0% |"]
    for k, v in filled.items():
        L.append(f"| {k} | {v} | {v / n * 100:.1f}% |" if n else f"| {k} | {v} | - |")
    L.append("")

    by_status: dict[str, int] = {}
    for p in plans:
        by_status[p.row["status"]] = by_status.get(p.row["status"], 0) + 1
    L += ["## status 分布", "", " · ".join(f"{k}={v}" for k, v in sorted(by_status.items())), ""]

    ekind: dict[str, int] = {}
    for p in plans:
        for e in p.events:
            ekind[e["kind"]] = ekind.get(e["kind"], 0) + 1
    dby: dict[str, int] = {}
    for p in plans:
        for d in p.decisions:
            key = "user" if d["decided_by"] == "user" else "agent:*"
            dby[key] = dby.get(key, 0) + 1
    kkind: dict[str, int] = {}
    for _, _, k in edges:
        kkind[k] = kkind.get(k, 0) + 1
    rkind: dict[str, int] = {}
    for p in plans:
        for r in p.refs:
            rkind[r["kind"]] = rkind.get(r["kind"], 0) + 1
    L += ["## 分类计数", "",
          f"- events.kind:{' · '.join(f'{k}={v}' for k, v in sorted(ekind.items()))}",
          f"- decisions.decided_by:{' · '.join(f'{k}={v}' for k, v in sorted(dby.items()))}"
          "(全部带 provenance,可回溯源卡行号)",
          f"- edges.kind:{' · '.join(f'{k}={v}' for k, v in sorted(kkind.items()))}",
          f"- refs.kind:{' · '.join(f'{k}={v}' for k, v in sorted(rkind.items()))}", ""]

    mtime = [p for p in plans if any("mtime" in w for w in p.warnings)]
    L += ["## 推断出来的数据(必须能被看见)", "",
          f"- created_at 退到文件 mtime 的卡:**{len(mtime)}**"
          f"{'(' + ', '.join(p.task_id for p in mtime[:12]) + ')' if mtime else ''}",
          f"- needs_retitle 标记:**{n}**(全量——旧标题制产物,一张都没经人话标题审核)",
          f"- epic 依赖图启发式解析:{' / '.join(epic_notes) if epic_notes else '无'}", ""]

    warned = [p for p in plans if p.warnings]
    L += [f"## 逐卡告警({len(warned)} 张)", ""]
    for p in warned:
        L.append(f"- `{p.task_id}` ({p.path})")
        for w in p.warnings:
            L.append(f"  - {w}")
    L.append("")

    L += [f"## 人工清单:解析失败 {len(failures)} 张(不静默跳过)", ""]
    for f in failures:
        L.append(f"- `{f.path}` — {f.reason}")
    L.append("")

    if applied is not None:
        L += ["## 真导入结果", "",
              f"- 新导入卡:**{applied['imported']}** · 幂等跳过(已存在):**{applied['skipped']}**",
              f"- 卡级失败(事务回滚):**{len(applied['errors'])}**",
              f"- 边写入:成功 **{applied['edges_ok']}** · 拒绝 **{len(applied['edges_bad'])}**"
              "(幻觉闸/环检测/端点是失败卡)", ""]
        for tid, err in applied["errors"]:
            L.append(f"  - ✗ `{tid}` — {err}")
        for (s, d, k), err in applied["edges_bad"][:40]:
            L.append(f"  - ✗ edge {s} -{k}→ {d} — {err}")
        if len(applied["edges_bad"]) > 40:
            L.append(f"  - …另有 {len(applied['edges_bad']) - 40} 条,见 --report JSON")
        L.append("")
    else:
        L += ["## 真导入结果", "", "_dry-run:未写库。加 `--apply` 执行。_", ""]
    if review is None:
        L += ["## 决策归属复核", "", "未设 TYPESAFE_API_KEY,跳过(归属照旧只认 USER_VERDICT)", ""]
    else:
        L += [f"## 决策归属复核:规则与语义判断相左 {len(review['rows'])} 条(只列不改,人核)", "",
              f"未拿到合法判分 {review['unjudged']} 条(服务失败/畸形响应,这些行没复核)", ""]
        for r in review["rows"]:
            L.append(f"- `{r['task_id']}` {r['file']}:{r['line']} · 规则={r['rule']} · 语义={r['model']}"
                     f"({r['p']:.2f})· {r['verdict'][:80]}")
        L.append("")
    return "\n".join(L)


# ── 主流程 ────────────────────────────────────────────────────────

def build(root: Path) -> tuple[list[Path], list[CardPlan], list[Failure],
                               list[tuple[str, str, str]], list[str]]:
    files = iter_cards(root)
    cards, failures = [], []
    for f in files:
        c, fail = parse_one(f, root)
        (cards.append(c) if c else failures.append(fail))
    seen: dict[str, str] = {}
    plans = []
    for c in cards:
        if c["task_id"] in seen:
            failures.append(Failure(str(c["path"].relative_to(root)),
                                    f"task_id 与 {seen[c['task_id']]} 重复"))
            continue
        seen[c["task_id"]] = str(c["path"].relative_to(root))
        plans.append(plan_card(c, root))
    known = set(seen)
    edges, unresolved = field_edges(plans, known)
    ee, epic_notes = epic_edges(root, known)
    edges += ee
    for tid, raw in unresolved:
        p = next(x for x in plans if x.task_id == tid)
        p.warnings.append(f"依赖字段解析不出任何已知卡(值多半是散文/已归档卡):{raw}")
    return files, plans, failures, sorted(set(edges)), epic_notes


def apply(dbpath: Path, plans: list[CardPlan],
          edges: list[tuple[str, str, str]]) -> dict:
    """两遍:先全部卡(边的幻觉闸要求两端已存在),再全部边。"""
    db.migrate_db(dbpath)
    res: dict[str, Any] = {"imported": 0, "skipped": 0, "errors": [],
                           "edges_ok": 0, "edges_bad": []}
    for p in plans:
        try:
            ok = db.import_task(dbpath, events=p.events, decisions=p.decisions,
                                sessions=p.sessions, refs=p.refs, **p.row)
            res["imported" if ok else "skipped"] += 1
        except Exception as e:  # 卡级隔离:一张烂卡不许拖垮整批(事务已回滚)
            res["errors"].append((p.task_id, f"{type(e).__name__}: {e}"))
    for src, dst, kind in edges:
        try:
            db.link_tasks(dbpath, src, dst, kind=kind, created_by="import")
            res["edges_ok"] += 1
        except Exception as e:
            res["edges_bad"].append(((src, dst, kind), f"{type(e).__name__}: {e}"))
    return res


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(prog="import_md", allow_abbrev=False,
                                 description="NAWABAN 380± 张 md 卡一次性导入器")
    ap.add_argument("--root", default=".", help="仓库根(含 .foreman/)")
    ap.add_argument("--db", help="目标库(默认 NAWABAN_DB env → 就近 .nawaban/nawaban.db)")
    ap.add_argument("--apply", action="store_true", help="真写库(缺省 dry-run)")
    ap.add_argument("--report", help="报告落盘路径(缺省打 stdout)")
    ap.add_argument("--json", help="机读明细落盘路径")
    a = ap.parse_args(argv)

    root = Path(a.root).expanduser().resolve()
    if not (root / ".foreman" / "tasks").is_dir():
        print(f"✗ {root} 下没有 .foreman/tasks/", file=sys.stderr)
        return 1
    files, plans, failures, edges, epic_notes = build(root)

    applied = None
    if a.apply:
        dbpath = Path(a.db).expanduser() if a.db else db.resolve_db()
        if not dbpath.exists():
            print(f"✗ 库不存在:{dbpath}(建库用 nawaban init)", file=sys.stderr)
            return 1
        applied = apply(dbpath, plans, edges)

    report = render_report(root, files, plans, failures, edges, applied, epic_notes,
                           verdict_review(plans))
    if a.report:
        Path(a.report).expanduser().write_text(report, encoding="utf-8")
        print(f"✓ 报告 → {a.report}")
    else:
        print(report)
    if a.json:
        Path(a.json).expanduser().write_text(json.dumps(
            {"plans": [{"task_id": p.task_id, "path": p.path, "row": p.row,
                        "events": len(p.events), "decisions": p.decisions,
                        "sessions": p.sessions, "refs": p.refs,
                        "warnings": p.warnings} for p in plans],
             "edges": edges,
             "failures": [{"path": f.path, "reason": f.reason} for f in failures]},
            ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"✓ 明细 → {a.json}")
    if applied and (applied["errors"] or applied["edges_bad"]):
        return 2  # 部分失败:退出码表态,别让 CI/workflow 拿到恒绿的 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
