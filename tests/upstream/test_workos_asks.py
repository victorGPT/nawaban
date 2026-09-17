#!/usr/bin/env python3
"""WORKOS-INBOX-SCHEMA-001 回归自检 · 零依赖(不需 pytest),风格同 test_workos_db.py。

跑法:python3 tests/upstream/test_workos_asks.py → 全绿 OK / 任一失败 exit 1。

覆盖(对照卡 success · 四类齐):
  happy    提 ask 挂多卡 → open_asks 返回 · ask_detail 带出卡的实时 status
  边界     evidence 空/纯空白 · question 空/超长 · kind 非枚举 · 不挂卡
  错误     关不存在的 ask · 重复关(并发第二个必须拿到明确报错)· closed_as 非枚举
  状态迁移 四种 closed_as 各关一次,关后 open_asks 一律不再返回(僵尸不换层住)
  完整性   closed_at 与 closed_as 必须成对(DDL CHECK)· 迁移幂等
"""

from __future__ import annotations

import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str((Path(__file__).resolve().parents[2])))

from nawaban import db  # noqa: E402

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


def mk(path: Path, tid: str) -> None:
    db.create_task(path, task_id=tid, title=f"{tid} 测试卡", context="asks 自检建卡")


def raise_one(path: Path, **kw) -> int:
    kw.setdefault("kind", "accept")
    kw.setdefault("question", "名单新增人员真的会自动进抽查池吗?")
    kw.setdefault("evidence", "staging 真实 Loki 近 3h 查询 · 逐条对照 success")
    kw.setdefault("raised_by", "ac:test")
    return db.raise_ask(path, **kw)


def expect_raises(fn, *, want: type[Exception] | tuple[type[Exception], ...]) -> None:
    try:
        fn()
    except want:
        return
    except Exception as e:  # noqa: BLE001
        raise AssertionError(f"抛了 {type(e).__name__} 而不是 {want}: {e}") from None
    raise AssertionError(f"没抛异常,应抛 {want}")


def main() -> int:  # noqa: C901, PLR0915
    tmp = Path(tempfile.mkdtemp(prefix="workos-asks-"))
    print(f"Inbox schema self-test · {tmp}\n")

    # ── happy ────────────────────────────────────────────────
    def t_raise_and_list():
        p = fresh(tmp)
        mk(p, "T-A-001")
        mk(p, "T-B-001")
        aid = raise_one(p, task_ids=["T-A-001", "T-B-001"])
        rows = db.open_asks(p)
        assert len(rows) == 1, rows
        r = rows[0]
        assert r["id"] == aid
        assert r["task_ids"] == ["T-A-001", "T-B-001"], r["task_ids"]
        assert r["hands_on"] is False
        assert r["stalled_days"] >= 0

    def t_one_ask_many_tasks():
        """不变量 I 的机器判据:一个 ask 挂多张卡,收件箱仍只有 1 条。"""
        p = fresh(tmp)
        for i in range(29):
            mk(p, f"T-P-{i:03d}")
        raise_one(p, kind="authorize", question="29 张已验完的要现在上线吗?",
                  evidence="17 张声明独立可发布 · 3 张挂 flag",
                  blast={"who": "全员", "what": "部署", "rollback": "flag"},
                  task_ids=[f"T-P-{i:03d}" for i in range(29)])
        rows = db.open_asks(p)
        assert len(rows) == 1, f"29 张卡应折成 1 条,实得 {len(rows)}"
        assert len(rows[0]["task_ids"]) == 29

    def t_detail_carries_live_status():
        p = fresh(tmp)
        mk(p, "T-A-001")
        aid = raise_one(p, task_ids=["T-A-001"], hands_on=True,
                        options=[{"option": "A", "consequence": "X"}])
        d = db.ask_detail(p, aid)
        assert d["hands_on"] is True
        assert d["options"] == [{"option": "A", "consequence": "X"}]
        assert d["tasks"][0]["status"] == "open", d["tasks"]

    def t_dedup_task_ids():
        p = fresh(tmp)
        mk(p, "T-A-001")
        aid = raise_one(p, task_ids=["T-A-001", "T-A-001"])
        assert db.ask_detail(p, aid)["tasks"].__len__() == 1

    # ── 边界:写侧材料闸 ────────────────────────────────────────
    def t_evidence_empty():
        p = fresh(tmp)
        mk(p, "T-A-001")
        expect_raises(lambda: raise_one(p, task_ids=["T-A-001"], evidence=""),
                      want=(db.NawabanError, sqlite3.IntegrityError))

    def t_evidence_blank():
        """纯空白也要拦 —— 否则写侧闸形同虚设。"""
        p = fresh(tmp)
        mk(p, "T-A-001")
        expect_raises(lambda: raise_one(p, task_ids=["T-A-001"], evidence="   \n  "),
                      want=(db.NawabanError, sqlite3.IntegrityError))

    def t_question_too_long():
        p = fresh(tmp)
        mk(p, "T-A-001")
        expect_raises(lambda: raise_one(p, task_ids=["T-A-001"], question="问" * 121),
                      want=sqlite3.IntegrityError)

    def t_question_empty():
        p = fresh(tmp)
        mk(p, "T-A-001")
        expect_raises(lambda: raise_one(p, task_ids=["T-A-001"], question=""),
                      want=(db.NawabanError, sqlite3.IntegrityError))

    def t_kind_enum():
        p = fresh(tmp)
        mk(p, "T-A-001")
        expect_raises(lambda: raise_one(p, task_ids=["T-A-001"], kind="ping"),
                      want=db.NawabanError)

    def t_no_task():
        p = fresh(tmp)
        expect_raises(lambda: raise_one(p, task_ids=[]), want=db.NawabanError)

    def t_ghost_task():
        """幻觉闸:挂一张不存在的卡当场炸。"""
        p = fresh(tmp)
        expect_raises(lambda: raise_one(p, task_ids=["T-NOPE-001"]), want=db.NawabanError)

    # ── 错误处理 ──────────────────────────────────────────────
    def t_close_missing():
        p = fresh(tmp)
        expect_raises(lambda: db.close_ask(p, 999, closed_as="answered"),
                      want=db.NawabanError)

    def t_close_twice():
        """并发:两个窗口同时答同一 ask,第二个必须拿明确报错而非静默覆盖。"""
        p = fresh(tmp)
        mk(p, "T-A-001")
        aid = raise_one(p, task_ids=["T-A-001"])
        db.close_ask(p, aid, closed_as="answered", answer="收下")
        expect_raises(lambda: db.close_ask(p, aid, closed_as="withdrawn"),
                      want=db.NawabanError)

    def t_closed_as_enum():
        p = fresh(tmp)
        mk(p, "T-A-001")
        aid = raise_one(p, task_ids=["T-A-001"])
        expect_raises(lambda: db.close_ask(p, aid, closed_as="whatever"),
                      want=db.NawabanError)

    # ── 状态迁移:四种关闭态 ────────────────────────────────────
    def t_all_four_closed_states():
        """少任何一种,那类 ask 就没人关 —— 僵尸从卡层原样搬到 ask 层。"""
        for state in db.ASK_CLOSED:
            p = fresh(tmp)
            mk(p, "T-A-001")
            aid = raise_one(p, task_ids=["T-A-001"])
            assert len(db.open_asks(p)) == 1
            db.close_ask(p, aid, closed_as=state)
            left = db.open_asks(p)
            assert left == [], f"closed_as={state} 后仍出现在收件箱:{left}"

    def t_closed_pair_check():
        """DDL 层:closed_at 与 closed_as 必须成对,裸写也绕不过。"""
        p = fresh(tmp)
        mk(p, "T-A-001")
        aid = raise_one(p, task_ids=["T-A-001"])
        con = sqlite3.connect(p)
        try:
            expect_raises(
                lambda: con.execute("UPDATE asks SET closed_at=1 WHERE id=?", (aid,)),
                want=sqlite3.IntegrityError)
            expect_raises(
                lambda: con.execute("UPDATE asks SET closed_as='answered' WHERE id=?", (aid,)),
                want=sqlite3.IntegrityError)
        finally:
            con.close()

    # ── 迁移 ─────────────────────────────────────────────────
    def t_migrate_idempotent():
        p = fresh(tmp)
        assert db.migrate_db(p) == [], "新库 init 后不该再有待迁移项"

    def t_migrate_old_db():
        """老库(无 asks 表)靠 migrate_db 补上,连跑两次幂等。"""
        p = tmp / "old.db"
        if p.exists():
            p.unlink()
        con = sqlite3.connect(p)
        con.executescript(db.SCHEMA_SQL)  # 只建老表,不含 asks
        con.close()
        added = db.migrate_db(p)
        assert set(added) >= {"asks", "ask_tasks"}, added
        assert db.migrate_db(p) == [], "第二次迁移应为空(幂等)"
        mk(p, "T-A-001")
        raise_one(p, task_ids=["T-A-001"])
        assert len(db.open_asks(p)) == 1

    def t_confidence_pairing():
        """置信度必须与理由成对 —— 光给分数是黑盒换黑盒(ADR-0209 原则 6)。"""
        p = fresh(tmp)
        mk(p, "T-A-001")
        expect_raises(lambda: raise_one(p, task_ids=["T-A-001"], confidence=0.9),
                      want=db.NawabanError)
        expect_raises(lambda: raise_one(p, task_ids=["T-A-001"], confidence=0.9,
                                        confidence_reason="  "), want=db.NawabanError)
        expect_raises(lambda: raise_one(p, task_ids=["T-A-001"], confidence=1.5,
                                        confidence_reason="r"), want=db.NawabanError)
        aid = raise_one(p, task_ids=["T-A-001"], confidence=0.85,
                        confidence_reason="staging 真机逐条对照 success 全过")
        row = db.open_asks(p)[0]
        assert row["confidence"] == 0.85
        assert "逐条对照" in row["confidence_reason"]

    def t_confidence_optional_for_legacy():
        """人手工提的与迁移来的老 ask 没有置信度 —— 读侧要降级不能炸。"""
        p = fresh(tmp)
        mk(p, "T-A-001")
        raise_one(p, task_ids=["T-A-001"])          # 不带 confidence
        row = db.open_asks(p)[0]
        assert row["confidence"] is None and row["confidence_reason"] is None
        assert db.ask_detail(p, row["id"])["question"]   # 详情也不炸

    def t_invisible_chars_are_not_material():
        """零宽空格穿过 DDL 的 trim(它只覆盖 ASCII 空白)—— 会落一条「材料非空但看不见」的 ask。

        判例 2026-08-15(codex 审出):evidence="\u200b" 时 SQLite trim 后 length=1,CHECK 放行。
        Python 的 str.strip() 同样不去零宽,所以两层一起漏。真正管所有入口的是 raise_ask。
        """
        p = fresh(tmp)
        mk(p, "T-A-001")
        bad_inputs = [
            "\u200b", "\u00a0", " \u200b \ufeff ", "\u202f\u2007",
            "\u2060", "\u2062",           # WORD JOINER / INVISIBLE TIMES(Cf,枚举漏过)
            "\u3164", "\u2800",           # HANGUL FILLER(Lo)/ BRAILLE BLANK(So)—— 类别不是空白
            "\u00ad",                     # SOFT HYPHEN
            "\U000e0001",                 # TAG 段(隐藏注入载荷的惯用手法)
        ]
        # 空格与零宽**交替**:链式 strip 每 pass 只剥一层,3 层以上就漏 —— 这条闸曾自己被绕过
        bad_inputs += [(" \u200b" * n) + " " for n in range(1, 8)]
        for bad in bad_inputs:
            expect_raises(lambda b=bad: raise_one(p, task_ids=["T-A-001"], evidence=b),
                          want=db.NawabanError)
        # 夹在真材料里的零宽字符不该误伤
        aid = raise_one(p, task_ids=["T-A-001"], evidence="\u200b真机实测 · 逐条对照\u200b")
        assert db.open_asks(p)[0]["id"] == aid

    def t_confidence_reason_without_score_rejected():
        """反向成对:只有理由没有分数时读侧按「没有置信度」渲染,这条理由永远见不到人。"""
        p = fresh(tmp)
        mk(p, "T-A-001")
        expect_raises(lambda: raise_one(p, task_ids=["T-A-001"],
                                        confidence_reason="材料齐但我没给分"),
                      want=db.NawabanError)

    cases = [
        ("happy · 提 ask 挂多卡并列出", t_raise_and_list),
        ("happy · 不变量 I:29 张卡折成 1 条", t_one_ask_many_tasks),
        ("happy · detail 带出卡的实时 status", t_detail_carries_live_status),
        ("happy · 重复 task_id 去重", t_dedup_task_ids),
        ("边界 · evidence 空被拒", t_evidence_empty),
        ("边界 · evidence 纯空白被拒", t_evidence_blank),
        ("边界 · question 超长被拒", t_question_too_long),
        ("边界 · question 空被拒", t_question_empty),
        ("边界 · kind 非枚举被拒", t_kind_enum),
        ("边界 · 不挂卡被拒", t_no_task),
        ("边界 · 幻觉卡被拒", t_ghost_task),
        ("错误 · 关不存在的 ask", t_close_missing),
        ("错误 · 重复关拿明确报错", t_close_twice),
        ("错误 · closed_as 非枚举被拒", t_closed_as_enum),
        ("迁移态 · 四种 closed_as 关后都不再返回", t_all_four_closed_states),
        ("完整性 · closed_at/closed_as 必须成对", t_closed_pair_check),
        ("迁移 · 新库幂等", t_migrate_idempotent),
        ("迁移 · 老库补表且幂等", t_migrate_old_db),
        ("置信度 · 必须与理由成对且在 0..1", t_confidence_pairing),
        ("置信度 · 老 ask 无值读侧不炸", t_confidence_optional_for_legacy),
        ("材料闸 · 零宽/不间断空格不算材料", t_invisible_chars_are_not_material),
        ("置信度 · 有理由无分数也拒(反向成对)", t_confidence_reason_without_score_rejected),
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
