#!/usr/bin/env python3
"""done 闸覆盖度实测(NAWABAN-DONE-GATE-COVERAGE-001 · 2026-08-26)。

存在理由:2026-08-26 才发现 done 闸② 只咬 waiting_on='decision' 一条路,
prod/observe/external 三条历来放行 —— 闸挂了几个月,没人量过它实际覆盖多少。
同日另一条同构发现:PreToolUse 闸只 hook Edit/Write,Bash heredoc 全绕过。

**改任何闸之前先跑这个**:闸的名字不是它的覆盖面。

用法:python3 nawaban/gate_coverage.py [库路径]
"""
from __future__ import annotations

import sqlite3
import sys
import time
from pathlib import Path

NO_USER = ("NOT EXISTS (SELECT 1 FROM task_decisions d WHERE d.task_id=t.id"
           " AND d.decided_by='user' AND d.provenance IS NULL)")
HAS_DONE = ("EXISTS (SELECT 1 FROM task_events e1 WHERE e1.task_id=t.id"
            " AND e1.kind='status_change' AND e1.body LIKE '%→done%')")
HAS_VER = ("EXISTS (SELECT 1 FROM task_events e2 WHERE e2.task_id=t.id"
           " AND e2.kind='status_change' AND e2.body LIKE '%→staging-verified%')")
HAS_ACC = ("EXISTS (SELECT 1 FROM task_events e4 WHERE e4.task_id=t.id"
           " AND e4.kind='acceptance')")


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from nawaban import db  # noqa: E402

def main() -> int:
    p = Path(sys.argv[1]) if len(sys.argv) > 1 else db.resolve_db()
    if not p.is_file():
        print(f"✗ 库不存在:{p}", file=sys.stderr)
        return 1
    con = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    now = int(time.time())
    print(f"📏 done 闸覆盖度 · {p}\n")
    for days, label in ((7, "近 7 天"), (30, "近 30 天"), (0, "全量")):
        since = now - days * 86400 if days else 0
        tot = con.execute("SELECT count(*) FROM tasks t WHERE t.status='done'"
                          " AND t.completed_at>=?", (since,)).fetchone()[0]
        silent = con.execute(f"SELECT count(*) FROM tasks t WHERE t.status='done'"
                             f" AND t.completed_at>=? AND {NO_USER}", (since,)).fetchone()[0]
        pct = silent * 100 // max(tot, 1)
        print(f"  {label:<8} done {tot:>4} · 无运行时真人拍板 {silent:>4} ({pct}%)")

    # 分类:批量归档与 import 回放会主导总数,不分开看会把「两次清理」读成「天天在跑」。
    # 判别式是**转移合法性**,不是「有没有 →done 事件」——import 回放会连事件一起回放,
    # 其中含 claimed→done / in_progress→done 这类 _ADVANCE 里根本没有的转移。
    # 运行时路径必然先 →staging-verified 再 →done,以此分开(2026-08-28 实测纠正:
    # 早先按「有无 →done 事件」分,把 19 张 import 回放算进了运行时,168 实为 150)。
    print("\n  ── 无拍板归档的构成(全量)──")

    def cnt(cond: str) -> int:
        return con.execute(f"SELECT count(*) FROM tasks t WHERE t.status='done'"
                           f" AND {NO_USER} AND ({cond})").fetchone()[0]

    a = cnt(f"NOT {HAS_DONE}")
    b = cnt(f"{HAS_DONE} AND NOT {HAS_VER}")
    c_prose = cnt(f"{HAS_DONE} AND {HAS_VER} AND {HAS_ACC}")
    c_bare = cnt(f"{HAS_DONE} AND {HAS_VER} AND NOT {HAS_ACC}")
    print(f"    A 无 →done 事件(import 直落 · 整张状态写入):{a}")
    print(f"    B 有 →done 但无 →staging-verified(非法转移 = import 回放):{b}")
    print(f"    C 真运行时路径:{c_prose + c_bare}")
    print(f"        C1 留了 acceptance 正文:{c_prose}")
    print(f"        C2 只有 run 指针没正文:{c_bare}  ← done 闸③(2026-08-28)起不再新增")

    print("\n  ── 批量归档(同一分钟 ≥5 张 = 清理动作,不是逐张判断)──")
    rows = con.execute(
        f"""SELECT strftime('%Y-%m-%d %H:%M', t.completed_at,'unixepoch','localtime') AS m,
                   count(*) n
              FROM tasks t WHERE t.status='done' AND {NO_USER}
             GROUP BY m HAVING n>=5 ORDER BY n DESC LIMIT 8""").fetchall()
    if not rows:
        print("    (无)")
    for r in rows:
        print(f"    {r['m']}  {r['n']} 张")
    con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
