#!/usr/bin/env python3
"""编译闸:纯文本不是终态(NAWABAN-COMPILE-GATE-001)。

Claude Code **Stop hook** 入口。stdin 收 hook JSON,顶回 = stdout 返
`{"decision":"block","reason":...}`(2026-08-12 真机 spike 实证:块被挡下,reason 进模型)。

顶回条件(三条全满足):① 本 session 有未收尾的 claim ② 该卡本 session 有实质事件
(排除 claim 自带的 status_change)③ 顶回预算未耗尽(≤2)。

**极性 = fail-open**(与 foreman_guard 的 fail-closed 相反,依卡 constraint
「卡死 session 比漏一次编译更糟」):无库/无 claim/锁表/状态文件写不了/任何异常 → 放行。

激活(**属 CUTOVER 切换日清单,现在不装**):settings.json 的 Stop 加一条
`{"type":"command","command":"python3 nawaban/compile_gate.py"}`。
spike 发现 Stop **每轮**触发(不是 session 末),交互窗口(CLAUDE_CODE_ENTRYPOINT=cli)
建议不挂,只对 headless(sdk-cli)生效——交互窗口的收尾失守归巡检兜底。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from nawaban import db  # noqa: E402

BUDGET = 2          # 顶回上限;第 3 次放行 + 记违规事件
BUSY_MS = 200       # 撞锁就放行,绝不挂住收尾
GATE_AUTHOR = "nawaban-gate"   # 违规是闸判的,不是 worker 自首
VIOLATION_PREFIX = "⚠️ 编译闸违规"

CLI = f"python3 {Path(__file__).with_name('cli.py')}"


def _db_path(cwd: str | None) -> Path | None:
    if not cwd and not (os.environ.get("NAWABAN_DB") or os.environ.get("WORKOS_DB")):
        return None
    return db.resolve_db(cwd)


def _state_file(session_id: str) -> Path:
    # runtime 状态,不进 DB(编译闸=强化执法不新增存储)。TMPDIR 可被测试重定向。
    d = Path(tempfile.gettempdir()) / "nawaban-gate"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{session_id}.json"


def _record_violations(path: Path, tasks: list[str], sid: str) -> None:
    """违规留痕。走包内私有件而非 `db.add_event`:后者用 30s 默认 busy_timeout,
    库被并发写者(导入/guard)锁住时会把每一轮 Stop 挂死——正是本闸 constraint 要防的。"""
    body = f"{VIOLATION_PREFIX}:顶回 {BUDGET} 次仍未交三件套,已放行 session 收尾"
    con = db.connect(path, busy_ms=BUSY_MS)
    try:
        with db._txn(con):
            for t in tasks:
                db._event(con, t, "note", body, GATE_AUTHOR, sid)
    finally:
        con.close()


def _nudge_text(tasks: list[str], left: int) -> str:
    ids = " · ".join(tasks[:3]) + (f" 等 {len(tasks)} 张" if len(tasks) > 3 else "")
    return (
        f"⛔ 纯文本不是终态。{ids} 还挂在你名下,本次 session 有实质进展却没收尾。\n"
        f"收尾三件套一条命令原子交齐(缺一件整笔拒):\n"
        f"  {CLI} handoff <TASK_ID> --outcome completed|handed_off|blocked \\\n"
        f"    --summary \"本次一句收尾\" --now \"板上当前态一句(≤200)\" [--artifact 产出文件]\n"
        f"还在干活就说一句「继续」——本闸最多再拦 {left} 次,之后放行并记违规。"
    )


def check(payload: dict) -> str | None:
    """返回顶回文案;None = 放行。任何拿不准都放行(fail-open)。"""
    sid = payload.get("session_id")
    if not sid:
        return None
    path = _db_path(payload.get("cwd"))
    if path is None or not path.exists():
        return None

    offenders = [t for t, n in db.open_claims(path, session_id=sid, busy_ms=BUSY_MS) if n > 0]
    if not offenders:
        return None

    sf = _state_file(sid)
    state = {"nudges": 0, "flagged": False}
    try:
        state.update(json.loads(sf.read_text(encoding="utf-8")))
    except FileNotFoundError:
        pass

    if state["nudges"] >= BUDGET:
        if not state["flagged"]:
            # 先落盘再写库:写库失败(锁/坏库)最多丢一条违规记录(fail-open 本就允许),
            # 反过来则每一轮 Stop 都重试写入 = 把 session 挂死,正中 constraint 反面。
            state["flagged"] = True
            sf.write_text(json.dumps(state), encoding="utf-8")
            _record_violations(path, offenders, sid)
        return None

    state["nudges"] += 1
    sf.write_text(json.dumps(state), encoding="utf-8")   # 写不了 → 异常 → 放行
    return _nudge_text(offenders, BUDGET - state["nudges"])


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        reason = check(payload)
    except Exception:  # noqa: BLE001  fail-open:闸自己坏掉不许卡死 session
        return 0
    if reason:
        json.dump({"decision": "block", "reason": reason}, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
