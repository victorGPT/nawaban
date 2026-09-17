#!/usr/bin/env python3
"""NAWABAN-INBOX-MIGRATE-001 · 把当前队列映射成首批 ask。

**这是不变量 I 的考试**:收件箱条目数必须等于「人的决策数」,不是卡数。
一次 deploy 授权覆盖几十张卡 = 1 个 ask;IAM2 的 G1–G4 是一个切换决定的四道闸 = 1 个 ask。
若生成数接近卡数,说明粒度规则没落实 —— 脚本会以非 0 退出码拦住,此刻发现比上线后便宜。

用法:
    python3 migrate_asks.py            # dry-run:只报告将生成什么
    python3 migrate_asks.py --apply    # 写入 asks/ask_tasks
"""
from __future__ import annotations

import argparse
import sqlite3
import time
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nawaban import db  # noqa: E402

MAX_ASKS = 20  # 硬上限:超了说明粒度规则塌了,非 0 退出

# ── 合并规则:哪些卡属于**同一个**人的决策 ──────────────────────────
# 一次性迁移,分组由人工判读得出(见方案页 v3 §映射表),不是启发式猜的。
# 卡不在库里/已关掉 → 自动跳过,组内一张都不剩就整条不生成。
GROUPS = [
    {
        "kind": "authorize",
        "question": "IAM2 组织读开关能不能切 prod?",
        "blast": {"who": "全员组织归属读路径", "what": "读开关切换",
                  "rollback": "有 flag 可回滚"},
        "tasks": [
            "IAM2-PROD-CUTOVER-RECON-001",      # G1/G2 盘点
            "IAM2-OWNER-DIRECT-BACKFILL-001",   # G3 补权限
            "IAM2-ORG-READSWITCH-ADMISSION-001",# G4 判定
            "IAM2-ORG-STALE-CONCUR-CLEAN-001",  # 解开 G4
        ],
    },
]

# 不进收件箱:等的是一个自然事件,不是人的动作。
# 只报告不改状态 —— 改 waiting_on 没有 cli 动词,越界裸写 SQL 违反本卡 constraints。
DEFER = {
    "IAM2-MOVE-CAMPAIGN-PATHS-001": "真机留到下次真实组织调整时顺带验 —— 等事件,建议退回 observe",
}

# hands_on 启发式:卡的验收材料里明说要人去点。命中即标记,没命中不代表不用点。
HANDS_ON_HINTS = ("真机点按", "人真机", "亲自", "手工验", "人工点", "真人点")


def _md_archived(tasks_dir: Path, task_id: str) -> bool:
    """md 侧已归档 = 僵尸,不该出现在人的收件箱(RECON 卡负责关它们)。"""
    hits = list(tasks_dir.glob(f"*/*/{task_id}.md"))
    return bool(hits) and "/done/" in str(hits[0])


def _evidence(con: sqlite3.Connection, task_id: str) -> str:
    rows = con.execute(
        "SELECT value FROM task_refs WHERE task_id=? AND kind='acceptance_run'"
        " ORDER BY created_at DESC", (task_id,)).fetchall()
    return "\n".join(r[0] for r in rows).strip()


def _waiting_since(con: sqlite3.Connection, task_id: str) -> int:
    """这张卡从什么时候开始等人 —— ask.raised_at 要继承它。

    否则迁移来的 ask 全部 stalled_days=0,「按停滞排序」当场失效,
    收件箱会把最新的排最前 —— 正是初稿那道错闸的效果。
    锚点优先取「翻 staging-verified」那条事件,退化则取最后一条事件,再退化取建卡时间。
    """
    for sql in (
        "SELECT max(created_at) FROM task_events WHERE task_id=? AND kind='status_change'"
        " AND body LIKE '%staging-verified'",
        "SELECT max(created_at) FROM task_events WHERE task_id=?",
        "SELECT created_at FROM tasks WHERE id=?",
    ):
        v = con.execute(sql, (task_id,)).fetchone()
        if v and v[0]:
            return int(v[0])
    return 0


def build_plan(db_path: Path) -> tuple[list[dict], list[str], list[str]]:
    """返回 (计划生成的 ask, 跳过的僵尸, 建议退回的卡)。纯只读。"""
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    tasks_dir = db_path.parent / "tasks"
    try:
        alive = {r["id"]: r for r in con.execute(
            "SELECT id,title,status,waiting_on FROM tasks WHERE status!='done'")}
        grouped: set[str] = set()
        plan: list[dict] = []

        # ① 人工判读的合并组
        for g in GROUPS:
            ids = [t for t in g["tasks"] if t in alive and not _md_archived(tasks_dir, t)]
            if not ids:
                continue
            grouped.update(ids)
            ev = "\n".join(f"[{t}] {_evidence(con, t)}" for t in ids).strip()
            plan.append({"kind": g["kind"], "question": g["question"],
                         "evidence": ev or "(底卡无 acceptance_run)",
                         "blast": g.get("blast"), "options": g.get("options"),
                         "hands_on": False, "task_ids": ids,
                         "raised_at": min(_waiting_since(con, t) for t in ids)})

        # ② 独立的 decision 卡 → 各自一个 accept
        zombies, deferred = [], []
        for tid, row in sorted(alive.items()):
            if row["waiting_on"] != "decision" or tid in grouped:
                continue
            if _md_archived(tasks_dir, tid):
                zombies.append(tid)
                continue
            if tid in DEFER:
                deferred.append(tid)
                continue
            ev = _evidence(con, tid)
            q = (row["title"] or tid)[:105] + " —— 收下吗?"
            plan.append({"kind": "accept", "question": q,
                         "evidence": ev or "(无 acceptance_run)",
                         "blast": None, "options": None,
                         "hands_on": any(h in ev for h in HANDS_ON_HINTS),
                         "task_ids": [tid],
                         "raised_at": _waiting_since(con, tid)})

        # ③ 全部 prod 卡 → 一个 deploy authorize
        prod = [t for t, r in sorted(alive.items())
                if r["waiting_on"] == "prod" and not _md_archived(tasks_dir, t)]
        if prod:
            flags = {t: (con.execute("SELECT flag FROM tasks WHERE id=?", (t,)).fetchone()[0] or "")
                     for t in prod}
            free = [t for t, f in flags.items() if f and ("n/a" in f.lower() or "独立" in f)]
            unknown = [t for t, f in flags.items() if not f]
            gated = [t for t in prod if t not in free and t not in unknown]
            plan.append({
                "kind": "authorize",
                "question": f"{len(prod)} 张已验完的要现在上线吗?",
                "evidence": (f"{len(free)} 张 flag 声明独立可发布 · {len(gated)} 张受 flag 闸"
                             f"(部署≠生效,需另切开关):{', '.join(gated) or '无'} · "
                             f"{len(unknown)} 张 flag 未知,部署后需逐张回读"),
                "blast": {"who": "prod 全量", "what": "部署已验完的批次",
                          "rollback": "按各卡 flag;受闸的不随部署生效"},
                "options": None, "hands_on": False, "task_ids": prod,
                "raised_at": min(_waiting_since(con, t) for t in prod),
            })
        return plan, zombies, deferred
    finally:
        con.close()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="生成首批 ask(默认 dry-run)")
    ap.add_argument("--db")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args(argv)

    db_path = Path(a.db) if a.db else db.resolve_db()
    plan, zombies, deferred = build_plan(db_path)

    print(f"库 {db_path}\n")
    for i, p in enumerate(plan, 1):
        mark = " [要你亲自点]" if p["hands_on"] else ""
        print(f"{i:>2}. [{p['kind']}]{mark} {p['question']}")
        days = (int(time.time()) - p["raised_at"]) / 86400 if p.get("raised_at") else 0
        print(f"    停滞 {days:.1f}d · 挂 {len(p['task_ids'])} 张卡: "
              f"{', '.join(p['task_ids'][:3])}{' …' if len(p['task_ids']) > 3 else ''}")
    covered = sum(len(p["task_ids"]) for p in plan)
    print(f"\n生成 {len(plan)} 个 ask,覆盖 {covered} 张卡")
    if zombies:
        print(f"跳过僵尸(md 已归档,RECON 卡负责关){len(zombies)} 张:{', '.join(zombies)}")
    for t in deferred:
        print(f"不进收件箱:{t} —— {DEFER[t]}")

    # 不变量 I 的机器判据
    bad = [p for p in plan if p["kind"] == "authorize" and len(p["task_ids"]) < 2]
    if bad:
        print(f"\n✗ 不变量 I:authorize 类必须挂 >1 张卡,违规 {len(bad)} 条")
        return 1
    if len(plan) > MAX_ASKS:
        print(f"\n✗ 生成 {len(plan)} 个 ask 超上限 {MAX_ASKS} —— 粒度规则没落实,先改规则再迁移")
        return 1
    if not plan:
        print("\n无可生成的 ask(队列已空?)")
        return 0

    if not a.apply:
        print("\n(dry-run · --apply 写入)")
        return 0

    n = 0
    for p in plan:
        db.raise_ask(db_path, kind=p["kind"], question=p["question"],
                     evidence=p["evidence"], task_ids=p["task_ids"],
                     raised_by="migrate_asks", options=p["options"],
                     blast=p["blast"], hands_on=p["hands_on"],
                     raised_at=p.get("raised_at"))
        n += 1
    print(f"\n✓ 已写入 {n} 个 ask")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
