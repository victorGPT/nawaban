#!/usr/bin/env python3
"""triage_apply 自检 · 零依赖。跑法:python3 tests/upstream/test_triage_apply.py

守两件事:
  ① **判重**——巡检是定期跑的,同一件事第二次跑还提就会把人的队列灌满(队列灌满 =
     人开始不看队列 = 整套机制失效)。
  ② **dry-run 真的不写**——默认不写是这个脚本唯一的安全前提,它必须被机器守住。
"""

from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str((Path(__file__).resolve().parents[2])))

from nawaban import db, triage_apply  # noqa: E402

FAILED: list[str] = []


def case(name: str, fn) -> None:
    try:
        fn()
        print(f"  ✓ {name}")
    except Exception as e:  # noqa: BLE001
        FAILED.append(name)
        print(f"  ✗ {name}: {type(e).__name__}: {e}")


def _setup(tmp: Path) -> tuple[Path, Path]:
    p = tmp / "workos.db"
    if p.exists():
        p.unlink()
    db.init_db(p)
    for tid in ("T-A-001", "T-B-001"):
        db.create_task(p, task_id=tid, title=f"{tid} 卡", context="triage_apply 自检")
    # 底卡从 20 天前就在等(建卡与事件都拨老)—— 新 ask 必须继承这个起点,不能落 0d
    old = int(time.time()) - 20 * 86400
    con = sqlite3.connect(p)
    with con:
        con.execute("UPDATE tasks SET created_at=?", (old,))
        con.execute("UPDATE task_events SET created_at=?", (old,))
    con.close()
    payload = {
        "proposals": [{
            "kind": "accept", "question": "名单新增的人真的会自动进池吗?",
            "evidence": "staging 真机实测 · 逐条对照 success",
            "task_ids": ["T-A-001", "T-B-001"], "hands_on": False,
            "confidence": 0.8, "confidence_reason": "读侧正向证据齐 · success 能逐条对",
        }],
        "closures": [], "summary": "提了 1 条", "stats": {},
    }
    j = tmp / "t.json"
    j.write_text(json.dumps(payload, ensure_ascii=False))
    return p, j


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="triage-apply-"))
    print(f"triage_apply 自检 · {tmp}\n")

    def t_dry_run_writes_nothing():
        p, j = _setup(tmp)
        triage_apply.main([str(j), "--db", str(p)])
        assert db.open_asks(p) == [], "dry-run 不许写 —— 这是脚本唯一的安全前提"

    def t_apply_writes_with_confidence():
        p, j = _setup(tmp)
        triage_apply.main([str(j), "--db", str(p), "--apply"])
        rows = db.open_asks(p)
        assert len(rows) == 1, rows
        assert rows[0]["confidence"] == 0.8
        assert "读侧" in rows[0]["confidence_reason"]
        assert sorted(rows[0]["task_ids"]) == ["T-A-001", "T-B-001"]

    def t_second_run_is_idempotent():
        """定期跑的东西不去重,人的队列会被同一件事灌满。"""
        p, j = _setup(tmp)
        triage_apply.main([str(j), "--db", str(p), "--apply"])
        triage_apply.main([str(j), "--db", str(p), "--apply"])
        assert len(db.open_asks(p)) == 1, "同问题同卡组不许重复入队"

    def t_inherits_waiting_start():
        """新 ask 落 0d = 往人的队列里写假状态 · 「按停滞排序」当场失效。"""
        p, j = _setup(tmp)
        triage_apply.main([str(j), "--db", str(p), "--apply"])
        d = db.open_asks(p)[0]["stalled_days"]
        assert d > 15, f"底卡等了 20 天,ask 却显示 {d}d —— 停滞起点没继承"

    def t_closure_state_follows_data():
        """底卡没 done 就不能记 task_closed —— 两种关闭态统计意义不同,按数据判不按理由判。"""
        p, j = _setup(tmp)
        triage_apply.main([str(j), "--db", str(p), "--apply"])
        aid = db.open_asks(p)[0]["id"]
        j.write_text(json.dumps({
            "proposals": [],
            "closures": [{"ask_id": aid, "reason": "两张底卡都已 done"}],
        }, ensure_ascii=False))
        triage_apply.main([str(j), "--db", str(p), "--apply"])
        assert db.open_asks(p) == []
        assert db.ask_detail(p, aid)["closed_as"] == "withdrawn", "底卡还没 done"

        # 底卡全 done 之后同样的清理才该记成 task_closed
        p2, j2 = _setup(tmp)
        triage_apply.main([str(j2), "--db", str(p2), "--apply"])
        aid2 = db.open_asks(p2)[0]["id"]
        con = sqlite3.connect(p2)
        with con:
            con.execute("UPDATE tasks SET status='done'")
        con.close()
        j2.write_text(json.dumps({"proposals": [],
                                  "closures": [{"ask_id": aid2, "reason": "底卡都 done 了"}]},
                                 ensure_ascii=False))
        triage_apply.main([str(j2), "--db", str(p2), "--apply"])
        assert db.ask_detail(p2, aid2)["closed_as"] == "task_closed"

    def t_one_failure_does_not_kill_the_batch():
        """人已经在板上关掉其中一个 ask 后再跑 --apply:那条跳过并报告,其余照常处理。

        判例 2026-08-15(codex 审出):close_ask 对已关的 ask 会抛,而循环里每条是独立事务
        —— 未捕获就是「前面几条已经真写入、后面一条都不处理」的半批状态。
        """
        p, j = _setup(tmp)
        triage_apply.main([str(j), "--db", str(p), "--apply"])
        aid = db.open_asks(p)[0]["id"]
        db.close_ask(p, aid, closed_as="answered", answer="人在板上先答了")

        db.create_task(p, task_id="T-C-001", title="另一张卡", context="批处理自检")
        j.write_text(json.dumps({
            "proposals": [{
                "kind": "accept", "question": "这条该照常提进去",
                "evidence": "staging 真机实测 · 逐条对照 success",
                "task_ids": ["T-C-001"], "confidence": 0.7,
                "confidence_reason": "材料齐",
            }],
            "closures": [{"ask_id": aid, "reason": "底卡都办完了"}],   # 已经被人关掉了
        }, ensure_ascii=False))
        rc = triage_apply.main([str(j), "--db", str(p), "--apply"])
        assert rc == 1, "有条目失败时退出码要表态,不能恒 0"
        left = db.open_asks(p)
        assert len(left) == 1 and left[0]["question"] == "这条该照常提进去", \
            f"关闭失败把后面的新提也带崩了:{left}"

    for name, fn in (("dry-run 一个字节都不写", t_dry_run_writes_nothing),
                     ("落库带上置信度与理由", t_apply_writes_with_confidence),
                     ("复跑幂等(同问题同卡组不重复入队)", t_second_run_is_idempotent),
                     ("新 ask 继承底卡的等待起点(不落 0d)", t_inherits_waiting_start),
                     ("关闭态按底卡数据判(withdrawn vs task_closed)", t_closure_state_follows_data),
                     ("单条失败不拖垮整批(退出码表态)", t_one_failure_does_not_kill_the_batch)):
        case(name, fn)

    total = 6
    print(f"\n{'FAILED: ' + ', '.join(FAILED) if FAILED else 'OK'} · "
          f"{total - len(FAILED)}/{total}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
