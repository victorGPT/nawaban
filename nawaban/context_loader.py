#!/usr/bin/env python3
"""NAWABAN-CONTEXT-LOADER-001 · 冷启动装载器(agent 视图)。

跑法:
    python3 nawaban/context_loader.py <task-id>
    ... --budget 8192 --events 10 --db <path>

定位:同一份数据的**两个投影**之一(字段草案 §五)——人视图是板(board_view.py),
本模块是 agent 视图。读侧只读(`mode=ro`),一个字节都不写库。

反陈旧:
  · 所有历史条目渲染相对年龄("18h ago")而非裸时间戳 —— 裸时间戳不会让 LLM 去想
    「这还新鲜吗」,相对年龄会。
  · 头部免责:这是时点快照不是实况,拿它当现状之前先回源复核。
  · 超预算不静默丢:旧条目折叠成计数行,截断留可见标记。

导入期一手知识(NAWABAN-IMPORT-001 同窗施工,写进呈现层免得下一个 agent 踩):
  · 标题:395 张全部产于旧标题制,带 needs_retitle 事件 → 标出来,别把它当人话标题信。
  · now:144/395 张为空(旧 notes >200 字全文进 context)→ 空态明说去 context 找,别当没上下文。
  · decisions:带 provenance 的是历史回放(归属由文本推断,可能误标),无 provenance 的才是
    运行时拍板 —— 这个区别就是 done 闸② 的判据,呈现层必须让 agent 看见。
  · 14 张卡 YAML 炸没进库(全在 done/)→ 查无此卡时报出「是那 14 张之一」,不报成「不存在」。
"""

from __future__ import annotations

import argparse
import math
import re
import sys
import time
from pathlib import Path
from typing import Optional

FOREMAN = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(FOREMAN))

from nawaban import board_view, db  # noqa: E402

BUDGET = 8192          # Context output budget.
EVENTS = 24            # 取回的事件条数上限(实际展示由字节预算决定)
DECISIONS = 12
LENS_K = 5             # 检索区 top-k
# G1(eval NAWABAN-HANDOFF-EVAL-001):事件区底额。修前事件只拿到 7.8% 预算,
# 「下一步正确」维度 A14:B6 崩塌。事件流是每次接手都变的部分,必须先分。
EVENT_SHARE = 0.50     # 事件区最低预算占比
EVENT_FLOOR = 900      # 小预算下的绝对底额(B)
RULE = "─" * 60


# ── 呈现原语 ──────────────────────────────────────────────────────

def ago(ts: Optional[int], *, now: Optional[int] = None) -> str:
    if not ts:
        return "?"
    s = max(0, (now if now is not None else int(time.time())) - ts)
    if s < 3600:
        return f"{s // 60}m ago"
    if s < 86400:
        return f"{s // 3600}h ago"
    return f"{s // 86400}d ago"


def clip(s: str, limit: int) -> str:
    s = (s or "").strip()
    if len(s) <= limit:
        return s
    return s[:limit - 30] + f"… [truncated, {len(s) - limit + 30} chars omitted]"


def _bullets(lines: list[str], indent: str = "  ") -> list[str]:
    return [f"{indent}· {ln}" for ln in lines]


# ── 分区(每区一个函数,返回行列表;弹性区可被预算折叠)──────────────

def _head(d: dict, now_ts: int) -> list[str]:
    L = [RULE,
         "NAWABAN 冷启动装载 · 时点快照,不是实况。",
         "所有年龄相对**此刻**;拿任何一条当现状之前,先回源复核(代码/PR/prod 自己说了算)。",
         RULE, ""]
    wait = f" · 等{d['waiting_on']}" if d.get("waiting_on") else ""
    L.append(f"[{d['id']}] {d['title']}")
    L.append(f"  状态 {d['status']}{wait} · owner {d.get('owner') or '(无主)'}"
             f" · 建于 {ago(d.get('created_at'), now=now_ts)}"
             + (f" · 开工 {ago(d['started_at'], now=now_ts)}" if d.get("started_at") else "")
             + (f" · 完成 {ago(d['completed_at'], now=now_ts)}" if d.get("completed_at") else ""))
    meta = [f"epic {clip(str(d['epic']), 90)}"] if d.get("epic") else []
    if meta:
        L.append("  " + " · ".join(meta))
    return L


def _state(d: dict, ev: list[dict], now_ts: int) -> list[str]:
    """G2:now 为空(144/395 张导入卡)时,用最近一条 handoff/status_change 顶替该位。

    eval 实测:now 区只占 1.5% 预算且多为占位「(空)」,而它本该是「现在到哪一步」的第一载体。
    顶替时**标明出处**——那是一条事件,不是有人写下的当前态,不能伪装成 now。
    """
    L = ["", "## 当前态"]
    now, context = (d.get("now") or "").strip(), (d.get("context") or "").strip()
    if now:
        L.append(f"  {clip(now, 200)}")
    else:
        latest = next((e for e in ev if e["kind"] in ("handoff", "status_change")), None)
        if latest:
            L.append(f"  (now 未写 · 以最近一条 {latest['kind']} 事件顶替 ·"
                     f" {ago(latest['created_at'], now=now_ts)})")
            L.append(f"  {clip(latest['body'], 300)}")
        else:
            L.append("  (空,且无可顶替的事件 —— 接手后第一件事就是写回当前态)")
    return L


def _context(d: dict, *, fold: bool = False) -> list[str]:
    """建卡缘由 —— write-once,**最不变**的一段,所以它让位给判据而不是反过来。

    判例(2026-08-12):它原本长在 `_state` 里被当成硬区,小预算下把验收判据挤出了输出。
    导入产物:notes ≤200 的卡 context 与 now 逐字相同(251/395),同文不重复打。
    """
    context = (d.get("context") or "").strip()
    if not context or context == (d.get("now") or "").strip():
        return []
    if fold:
        return ["", "## 缘由(节选 · 全文 --budget 16384)", f"  {clip(context, 150)}"]
    return ["", "## 缘由(建卡时的叙事 · write-once)", f"  {clip(context, 900)}"]


def _success(d: dict) -> list[str]:
    """验收判据 —— eval 实测本区是 B 视图唯一胜过 md 的维度(15:14),硬区,永不折叠。"""
    if not d.get("success"):
        return []
    return ["", "## 验收判据 success(改它必须走 decide --set-success)"] + \
        _bullets([clip(s, 200) for s in d["success"]])


def _constraints(d: dict, *, fold: bool = False) -> list[str]:
    if not d.get("constraints"):
        return []
    if fold:
        return ["", f"## 约束 constraints({len(d['constraints'])} 条 · 已折叠,"
                    "动手写码前展开:--budget 16384)"]
    return ["", "## 约束 constraints"] + _bullets([clip(s, 200) for s in d["constraints"]])


def _touches(d: dict, *, fold: bool = False) -> list[str]:
    if not d.get("touches"):
        return []
    if fold:
        return ["", f"## touches({len(d['touches'])} 个文件 · 已折叠 · guard 仍照防)"]
    return ["", "## touches(guard 据此防撞)"] + _bullets([str(t) for t in d["touches"]])


def _sysnotes(has_retitle: bool) -> list[str]:
    """G3:系统标注与内容面分离。

    eval 实测:`⚠ 旧标题制产物` 印在标题旁,被失忆接手者当成**这张卡的一个坑**写进答案。
    它是装载器对数据来源的注解,不是任务事实 → 挪到页脚 + `[系统]` 前缀显式划界。
    """
    if not has_retitle:
        return []
    return ["", "[系统] 本卡标题产于旧标题制(needs_retitle),未经「做完后人能看见什么变化」"
                "审核 —— 这是数据来源注解,不是本卡的任务内容或风险。"]


def _decisions(rows: list[dict], now_ts: int, limit: int) -> list[str]:
    if not rows:
        return []
    L = ["", f"## 对齐决策({len(rows)} 条 · 含被否项 —— 别重走已否决的路)"]
    for r in rows[:limit]:
        # imported=True ⟺ provenance 有值 = 历史导入(归属由旧卡文本推断,可能误标);
        # False = 经 decide() 落的运行时拍板(闸② 只认这一类)
        src = "历史导入·归属推断" if r.get("imported") else "运行时拍板"
        L.append(f"  [{r['decided_by']} · {src} · {ago(r['created_at'], now=now_ts)}]"
                 + (f" {r['adr']}" if r.get("adr") else ""))
        L.append(f"    {clip(r['verdict'], 300)}")
        for rej in (r.get("rejected") or []):
            if isinstance(rej, dict):
                L.append(f"    ✗ 否:{clip(str(rej.get('option', '')), 80)}"
                         f" —— {clip(str(rej.get('reason', '')), 140)}")
    if len(rows) > limit:
        L.append(f"  …另有 {len(rows) - limit} 条更早的决策(未展开)")
    return L


def _edges(d: dict) -> list[str]:
    out, inn = d.get("edges_out") or [], d.get("edges_in") or []
    if not (out or inn):
        return []
    L = ["", "## 关系(对端状态为**实时** JOIN,不是写卡时的手写快照)"]
    for e in out:
        w = f"·等{e['other_waiting_on']}" if e.get("other_waiting_on") else ""
        L.append(f"  →{e['kind']}→ [{e['other']}] {clip(e.get('other_title') or '', 44)}"
                 f"  «{e['other_status']}{w}»")
    for e in inn:
        w = f"·等{e['other_waiting_on']}" if e.get("other_waiting_on") else ""
        L.append(f"  ←{e['kind']}← [{e['other']}] {clip(e.get('other_title') or '', 44)}"
                 f"  «{e['other_status']}{w}»")
    return L


def _attempts(rows: list[dict], now_ts: int) -> list[str]:
    if not rows:
        return []
    L = ["", f"## 此前尝试({len(rows)} 次 · 一行一次)"]
    for s in rows:
        tail = (f"收 {ago(s['ended_at'], now=now_ts)} · {s.get('outcome') or '?'}"
                if s.get("ended_at") else "**在飞**(未收尾)")
        L.append(f"  {s['owner']} · 起 {ago(s['started_at'], now=now_ts)} · {tail}")
        if s.get("summary"):
            L.append(f"    {clip(s['summary'], 220)}")
    return L


def _events(rows: list[dict], now_ts: int, task_id: str, *, total: int = -1,
            limit: int = 999, byte_budget: int = 10 ** 9) -> list[str]:
    """G1:事件区按**字节底额**装,不再是「剩多少给多少」。

    eval 根因:静态字段(约束+验收+边+决策)吃掉 66% 预算,事件只剩 7.8% →
    三张卡实际 20取2 / 19取2 / 11取1,接手者漏掉整段阶段进展,给出方向性错误的下一步。
    静态字段几乎不变(最不需要每次重读),事件流才是每次接手都变的部分 —— 优先级反了。

    G4:截断提示是**祈使句**,告诉接手者「先去取」,不是一句可以扫过去的 "omitted N"。
    """
    if not rows:
        return []

    # 单条事件的字数配额也不能写死(判例 2026-08-12:写死 400 字,把含「路由仍 404」的
    # 657 字事件从中间腰斩 —— 与 G1 同型的错误,只是尺度更小)。
    # 按**新近度**分配:最新几条给足(它们承载「现在到哪一步」),越旧配额越省。
    # 统一配额会逼出「全都腰斩」或「只剩两条」的二选一,分层配额两头都不牺牲。
    def cap_for(i: int) -> int:
        return 1400 if i < 2 else (700 if i < 5 else 300)

    total = len(rows) if total < 0 else total
    head = f"## 最近事件(倒序 · 共 {total} 条)"
    L, used, shown = ["", head], len(head.encode()) + 1, 0
    for i, e in enumerate(rows[:limit]):
        # 第一条也必须按剩余预算裁:否则小预算下一条 1400 字的事件就把 success 挤出去了
        # (判例 2026-08-12:G1 改完后 budget=1200 的用例当场红——修 A 区别把 B 区压垮)。
        room = max(60, (byte_budget - used - 90) // 3)   # CJK 按 3 字节/字保守折算
        blk = [f"  [{e['kind']} · {e['author']} · {ago(e['created_at'], now=now_ts)}]",
               f"    {clip(e['body'], min(cap_for(i), room))}"]
        cost = sum(len(x.encode()) + 1 for x in blk)
        if shown and used + cost > byte_budget:
            break
        L += blk
        used += cost
        shown += 1
    left = total - shown
    if left:
        L.append(f"  ⚠ 还有 {left} 条更早事件未展开。判断「现在到哪一步 / 下一步做什么」前,"
                 f"**先取全**:nawaban context {task_id} --events {total} --budget 24000")
    return L


def _refs(rows: list[dict], d: dict) -> list[str]:
    if not (rows or d.get("adr")):
        return []
    L = ["", "## 指针"]
    if d.get("adr"):
        L.append(f"  adr: {d['adr']}")
    by: dict[str, list[str]] = {}
    for r in rows:
        by.setdefault(r["kind"], []).append(r["value"])
    for kind, vals in sorted(by.items()):
        shown = vals[:6]
        more = f" …+{len(vals) - 6}" if len(vals) > 6 else ""
        L.append(f"  {kind}: " + " ".join(clip(v, 90) for v in shown) + more)
    return L


# ── 检索透镜(RAG 位 · 2026-08-12 用户拍板选 B:纯标准库 TF-IDF top-k)──────
#
# 为什么不是 embedding:本机无 numpy / 无本地模型;仓库那条 embedding 路径是产品侧的
# OpenRouter(联网 + key + 成本),给个人本地系统引入它会毁掉离线可用性。检索层定位是
# 「线索非证据」(字段草案 §六),线索质量对召回方式不敏感 → 词法足够。
# 接口 (related) 与向量后端同形,将来有本地向量源原地换实现即可。
#
# ponytail: 不落缓存表 —— 全量重算实测 66ms(395 卡 / 6.7 万 token),
# 「惰性计算落表」那条约束是为昂贵 embedding 写的;真慢了再加表。
# 语料边界(红线):只吃本板 title+context+decisions+handoff;可移植教训归 nmem,两边零重叠。

_WORD = re.compile(r"[a-z0-9_][a-z0-9_\-.]*")
_CJK = re.compile(r"[一-鿿]+")


def _tokens(s: str) -> list[str]:
    """中文无空格 → CJK 走字符二元组(无词典、零依赖),ASCII 走标识符切分。"""
    s = (s or "").lower()
    out = _WORD.findall(s)
    for run in _CJK.findall(s):
        out += [run[i:i + 2] for i in range(len(run) - 1)] or [run]
    return out


def _corpus(path: Path | str) -> dict[str, list[str]]:
    con = board_view._ro(path)
    try:
        docs: dict[str, list[str]] = {}
        for r in con.execute("SELECT id, title, COALESCE(context,'') FROM tasks"):
            docs[r[0]] = [r[1], r[2]]
        for r in con.execute("SELECT task_id, verdict FROM task_decisions"):
            docs.setdefault(r[0], []).append(r[1])
        for r in con.execute("SELECT task_id, body FROM task_events WHERE kind='handoff'"):
            docs.setdefault(r[0], []).append(r[1])
        return {k: _tokens(" ".join(v)) for k, v in docs.items()}
    finally:
        con.close()


def related(path: Path | str, task_id: str, *, k: int = 5,
            exclude: Optional[set[str]] = None) -> list[dict]:
    """top-k 相关卡。返回 [{id,title,status,score}],与向量后端同形。"""
    docs = _corpus(path)
    if task_id not in docs:
        return []
    n = len(docs)
    df: dict[str, int] = {}
    for toks in docs.values():
        for t in set(toks):
            df[t] = df.get(t, 0) + 1

    def vec(toks: list[str]) -> dict[str, float]:
        tf: dict[str, int] = {}
        for t in toks:
            tf[t] = tf.get(t, 0) + 1
        v = {t: (1 + math.log(c)) * math.log(n / df[t]) for t, c in tf.items() if df.get(t)}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        return {t: x / norm for t, x in v.items()}

    q = vec(docs[task_id])
    skip = (exclude or set()) | {task_id}
    scored = []
    for tid, toks in docs.items():
        if tid in skip:
            continue
        d = vec(toks)
        s = sum(w * d[t] for t, w in q.items() if t in d)
        if s > 0:
            scored.append((s, tid))
    scored.sort(reverse=True)
    con = board_view._ro(path)
    try:
        out = []
        for s, tid in scored[:k]:
            r = con.execute("SELECT title,status,waiting_on FROM tasks WHERE id=?",
                            (tid,)).fetchone()
            out.append({"id": tid, "title": r["title"], "status": r["status"],
                        "waiting_on": r["waiting_on"], "score": round(s, 3)})
        return out
    finally:
        con.close()


def _lens(rows: list[dict]) -> list[str]:
    if not rows:
        return []
    L = ["", "## 相关线索(检索召回 · **线索不是证据**)",
         "  下面这些卡词面相近,可能相关也可能纯属撞词。要采信任何一条,先自己去读它、",
         "  并把结论落回本卡 decisions/events —— 检索结果本身永远不算证据。"]
    for r in rows:
        w = f"·等{r['waiting_on']}" if r.get("waiting_on") else ""
        L.append(f"  ~{r['score']} [{r['id']}] {clip(r['title'], 44)} «{r['status']}{w}»")
    return L


# ── 组装 + 预算 ───────────────────────────────────────────────────

def _fetch_events(path: Path | str, task_id: str, want: int) -> tuple[list[dict], int]:
    """自己取事件 + **真实总数**,不用 board_view.task_detail 的那份。

    判例(2026-08-12,与 provenance 同族):`board_view.EVENT_LIMIT=20` 是按人视图抽屉设的,
    复用它 → PI 卡库里 33 条只拿到 20,而我的表头写「共 20 条」、G4 祈使句叫人 `--events 20`
    —— **两处都在撒谎,且不报错**。凡是要对外承诺数量的地方,数字必须自己数。
    """
    con = board_view._ro(path)
    try:
        total = con.execute("SELECT count(*) FROM task_events WHERE task_id=?",
                            (task_id,)).fetchone()[0]
        rows = [{"kind": r["kind"], "body": r["body"], "author": r["author"],
                 "session_id": r["session_id"], "created_at": r["created_at"]}
                for r in con.execute(
                    "SELECT * FROM task_events WHERE task_id=?"
                    " ORDER BY created_at DESC, id DESC LIMIT ?", (task_id, want))]
        return rows, total
    finally:
        con.close()


def _mark_provenance(path: Path | str, d: dict) -> None:
    """board_view.task_detail 不返回 provenance 列(人视图不需要),但 agent 视图必须区分
    「历史回放·归属由旧卡文本推断」与「运行时真拍板」—— 这正是 done 闸② 的判据。
    少了它会把 314 条导入行全标成运行时拍板,**恰好标反**。自己补一次只读查询。"""
    ids = [r["id"] for r in d.get("decisions") or []]
    if not ids:
        return
    con = board_view._ro(path)
    try:
        has = {r[0] for r in con.execute(
            "SELECT id FROM task_decisions WHERE provenance IS NOT NULL AND id IN"
            f" ({','.join('?' * len(ids))})", ids)}
    finally:
        con.close()
    for r in d["decisions"]:
        r["imported"] = r["id"] in has


def build_context(path: Path | str, task_id: str, *, budget: int = BUDGET,
                  events: int = EVENTS, lens_k: int = LENS_K,
                  now_ts: Optional[int] = None) -> str:
    d = board_view.task_detail(path, task_id)
    _mark_provenance(path, d)
    now_ts = now_ts if now_ts is not None else int(time.time())
    ev, ev_total = _fetch_events(path, task_id, max(events, EVENTS) * 4)
    has_retitle = any(e["body"].startswith("needs_retitle") for e in ev)
    # needs_retitle 是导入期的元数据,已在标题旁提示,不再占事件位
    n_before = len(ev)
    ev = [e for e in ev if not e["body"].startswith("needs_retitle")]
    ev_total -= n_before - len(ev)

    # 已经作为结构化边出现的卡不再进检索区——那是确定的事实,重复一遍纯浪费预算
    linked = {e["other"] for e in (d.get("edges_out") or []) + (d.get("edges_in") or [])}
    lens = _lens(related(path, task_id, k=lens_k, exclude=linked)) if lens_k else []

    def size(lines: list[str]) -> int:
        return sum(len(x.encode()) + 1 for x in lines)

    # ① 三个硬区先占位:卡头 / 当前态 / 系统页脚 —— 它们小且不可缺
    head = _head(d, now_ts)
    state = _state(d, ev, now_ts)
    foot = _sysnotes(has_retitle)
    core = size(head) + size(state) + size(foot)

    # ② 事件**先分**底额(G1 的单点):至少 EVENT_SHARE,且给 success 留出余量
    succ = _success(d)
    ev_budget = max(int(budget * EVENT_SHARE), EVENT_FLOOR)
    ev_budget = min(ev_budget, max(0, budget - core - size(succ) - 120))
    ev_lines = _events(ev, now_ts, task_id, total=ev_total, limit=events,
                       byte_budget=ev_budget)

    out = head + state + ev_lines + succ
    used = size(out) + size(foot)

    # ③ 其余按「每次接手会不会变」排序贪心填充:变的排前面,不变的可折叠
    rest: list[tuple[list[str], list[str]]] = [
        (_context(d), _context(d, fold=True)),
        (_decisions(d.get("decisions") or [], now_ts, DECISIONS),
         _decisions(d.get("decisions") or [], now_ts, 3)),
        (_attempts(d.get("sessions") or [], now_ts), []),
        (_edges(d), []),
        (_constraints(d), _constraints(d, fold=True)),
        (_touches(d), _touches(d, fold=True)),
        (_refs(d.get("refs") or [], d), []),
        (lens, []),
    ]
    for full, folded in rest:
        for cand in (full, folded):
            if cand and used + size(cand) <= budget:
                out += cand
                used += size(cand)
                break

    text = "\n".join(out + foot)
    if len(text.encode()) <= budget:
        return text
    # 硬区本身就超预算(病态输入):可见截断,不静默丢
    keep = max(0, budget - 80)
    return ("\n".join(out + foot).encode()[:keep].decode(errors="ignore")
            + f"\n… [truncated to {budget}B budget · 全文见板 / 源卡]")


def _not_found_hint(root: Path, task_id: str) -> str:
    """查无此卡时别只说「不存在」——它很可能是 14 张 YAML 炸、没进库的旧卡之一。"""
    hits = list((root / ".foreman" / "tasks").rglob(f"{task_id}.md")) if root else []
    if hits:
        return (f"✗ 卡不在库里,但源 md 存在:{hits[0]}\n"
                "  → 这是 NAWABAN-IMPORT-001 人工清单里 YAML 解析失败的 14 张之一"
                "(全在 done/),导入时按契约不静默跳过、也未入库。\n"
                "  → 要它进板:先修 md 的 YAML,再 import_md.py --apply(幂等,只补新卡)。")
    return f"✗ 卡不存在:{task_id}"


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(prog="context_loader", allow_abbrev=False,
                                 description="NAWABAN 冷启动装载器(agent 视图)")
    ap.add_argument("task_id")
    ap.add_argument("--db")
    ap.add_argument("--budget", type=int, default=BUDGET)
    ap.add_argument("--events", type=int, default=EVENTS)
    ap.add_argument("--lens", type=int, default=LENS_K, help="检索 top-k(0=关)")
    a = ap.parse_args(argv)

    path = Path(a.db).expanduser() if a.db else db.resolve_db()
    if not path.exists():
        print(f"✗ 库不存在:{path}", file=sys.stderr)
        return 1
    try:
        print(build_context(path, a.task_id, budget=a.budget, events=a.events,
                            lens_k=a.lens))
    except db.NawabanError:
        root = path.parent.parent if path.parent.name in (".nawaban", ".foreman") else Path.cwd()
        print(_not_found_hint(root, a.task_id), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
