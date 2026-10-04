#!/usr/bin/env python3
"""workos wrapup skill regression 自检 · 零依赖(不需 pytest)。

跑法:python3 tests/upstream/test_workos_wrapup.py → 全绿 OK / 任一失败 exit 1。
两个动词都走**真 CLI 进程**(身份从 env),这才是它们被真实使用的形态。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

FOREMAN = (Path(__file__).resolve().parents[2])  # 本文件所在树,worktree 里也测自己
sys.path.insert(0, str(FOREMAN))
from nawaban import db  # noqa: E402

CLI = FOREMAN / "nawaban" / "cli.py"
FAILED: list[str] = []
SID = "wrapup-sess-0001"


def case(name: str, fn) -> None:
    try:
        fn()
        print(f"  ✓ {name}")
    except Exception as e:  # noqa: BLE001
        FAILED.append(name)
        print(f"  ✗ {name}: {type(e).__name__}: {e}")


def cli(db_path: Path, *args: str, sid: str | None = SID) -> subprocess.CompletedProcess:
    env = {**os.environ, "NAWABAN_DB": str(db_path), "NAWABAN_OWNER": "ac:tester"}
    env.pop("CLAUDE_CODE_SESSION_ID", None)
    if sid:
        env["CLAUDE_CODE_SESSION_ID"] = sid
    return subprocess.run([sys.executable, str(CLI), *args],
                          capture_output=True, text=True, env=env)


def board(tmp: Path, *cards: str) -> Path:
    p = tmp / "workos.db"
    if p.exists():
        p.unlink()
    db.init_db(p)
    for c in cards:
        db.create_task(p, task_id=c, title=f"{c} 的人话标题:做完能看见变化", context="测试")
    return p


def main() -> int:  # noqa: C901, PLR0915
    tmp = Path(tempfile.mkdtemp(prefix="workos-wrapup-test-"))
    print(f"[wrapup/scope 自检] tmp={tmp}")

    # ── 1 · 无未收尾卡 → 明确说没有(不是空输出让人猜)──────────────
    def t_wrapup_empty():
        p = board(tmp, "T-W-001")
        r = cli(p, "wrapup")
        assert r.returncode == 0, r.stderr
        assert "无未收尾" in r.stdout, r.stdout

    # ── 2 · 一窗持两卡 → 两张都列出,且给全补齐要件 ────────────────
    def t_wrapup_lists_two():
        p = board(tmp, "T-W-001", "T-W-002")
        for c in ("T-W-001", "T-W-002"):
            cli(p, "claim", c)
            cli(p, "start", c)
            cli(p, "event", c, "--kind", "note", "--body", "干了活")
        r = cli(p, "wrapup")
        assert r.returncode == 0, r.stderr
        assert "2 张卡未收尾" in r.stdout, r.stdout
        for c in ("T-W-001", "T-W-002"):
            assert c in r.stdout, f"{c} 没列出"
        # constraint:不绕 handoff 的 now 必填与保存闸 —— 模板必须带 --now,并提示 --artifact
        assert "--now" in r.stdout and "--outcome" in r.stdout and "--summary" in r.stdout
        assert "--artifact" in r.stdout, "保存闸提示缺失"
        assert "刚刚" in r.stdout or "ago" in r.stdout, "缺相对年龄(反陈旧呈现)"

    # ── 3 · 状态迁移:收尾一张后清单只剩一张 ──────────────────────
    def t_wrapup_shrinks_after_handoff():
        p = board(tmp, "T-W-001", "T-W-002")
        for c in ("T-W-001", "T-W-002"):
            cli(p, "claim", c)
            cli(p, "event", c, "--kind", "note", "--body", "干了活")
        # handoff 闸:completed 须先翻牌;本用例只测清单收缩,用 handed_off
        r = cli(p, "handoff", "T-W-001", "--outcome", "handed_off",
                "--summary", "收工", "--now", "已收尾")
        assert r.returncode == 0, r.stderr
        r = cli(p, "wrapup")
        assert "1 张卡未收尾" in r.stdout and "T-W-002" in r.stdout, r.stdout
        assert "T-W-001 ·" not in r.stdout, "已收尾的卡不该再出现在清单里"

    # ── 4 · 身份铁律:没有 session 身份就不许列 ────────────────────
    def t_wrapup_needs_identity():
        p = board(tmp, "T-W-001")
        r = cli(p, "wrapup", sid=None)
        assert r.returncode == 1 and "身份" in r.stderr, (r.returncode, r.stderr)

    # ── 5 · scope:追加成功 + 原子留痕 ─────────────────────────────
    def t_scope_appends_and_traces():
        p = board(tmp, "T-W-001")
        db.create_task(p, task_id="T-W-003", title="带初始 touches 的卡", context="测试",
                       touches=["a.py"])
        r = cli(p, "scope", "T-W-003", "--add", "b.py", "--add", "c.py",
                "--reason", "施工发现必须同时改 b/c")
        assert r.returncode == 0, r.stderr
        con = db.connect(p)
        t = json.loads(con.execute("SELECT touches FROM tasks WHERE id='T-W-003'").fetchone()[0])
        ev = con.execute("SELECT kind,body,author FROM task_events WHERE task_id='T-W-003'"
                         " AND kind='coord'").fetchall()
        con.close()
        assert t == ["a.py", "b.py", "c.py"], f"append 语义破了:{t}"
        assert len(ev) == 1, f"必须恰好一条 scope+ 留痕,实得 {len(ev)}"
        assert "b.py" in ev[0][1] and "施工发现" in ev[0][1], "留痕未记路径与理由"

    # ── 6 · scope 边界:空操作与空理由都拒 ────────────────────────
    def t_scope_rejects_noop_and_blank_reason():
        p = board(tmp, "T-W-001")
        db.create_task(p, task_id="T-W-004", title="边界卡", context="测试", touches=["a.py"])
        r = cli(p, "scope", "T-W-004", "--add", "a.py", "--reason", "重复加")
        assert r.returncode == 1 and "已在 touches" in r.stderr, r.stderr
        r = cli(p, "scope", "T-W-004", "--add", "z.py", "--reason", "   ")
        assert r.returncode == 1 and "理由" in r.stderr, r.stderr
        con = db.connect(p)
        n = con.execute("SELECT count(*) FROM task_events WHERE task_id='T-W-004'").fetchone()[0]
        t = json.loads(con.execute("SELECT touches FROM tasks WHERE id='T-W-004'").fetchone()[0])
        con.close()
        assert n == 0 and t == ["a.py"], "被拒的扩界不许留下任何痕迹或半改(原子)"

    # ── 7 · scope:空 touches 的卡也能扩(首次声明)────────────────
    def t_scope_from_empty():
        p = board(tmp, "T-W-005")
        r = cli(p, "scope", "T-W-005", "--add", "x.py", "--reason", "首次声明防撞面")
        assert r.returncode == 0, r.stderr
        con = db.connect(p)
        t = json.loads(con.execute("SELECT touches FROM tasks WHERE id='T-W-005'").fetchone()[0])
        con.close()
        assert t == ["x.py"], t

    # ── 8 · scope:幻觉闸 —— 不存在的卡当场拒 ──────────────────────
    def t_scope_ghost_card():
        p = board(tmp, "T-W-001")
        r = cli(p, "scope", "T-GHOST-999", "--add", "x.py", "--reason", "扩个不存在的卡")
        assert r.returncode == 1 and "不存在" in r.stderr, r.stderr

    for name, fn in [
        ("wrapup:无未收尾卡时明确说没有", t_wrapup_empty),
        ("wrapup:一窗两卡全列出+补齐要件齐(--now/--artifact/相对年龄)", t_wrapup_lists_two),
        ("wrapup:收尾一张后清单收缩", t_wrapup_shrinks_after_handoff),
        ("wrapup:身份铁律(无 session 不许列)", t_wrapup_needs_identity),
        ("scope:append 语义 + 原子 coord 留痕", t_scope_appends_and_traces),
        ("scope:空操作/空理由都拒且零写入", t_scope_rejects_noop_and_blank_reason),
        ("scope:空 touches 首次声明", t_scope_from_empty),
        ("scope:幻觉闸(卡不存在当场拒)", t_scope_ghost_card),
    ]:
        case(name, fn)

    if FAILED:
        print(f"\n✗ {len(FAILED)} 条失败:{FAILED}")
        return 1
    print("\n✓ wrapup/scope 自检全绿")
    return 0


if __name__ == "__main__":
    sys.exit(main())
