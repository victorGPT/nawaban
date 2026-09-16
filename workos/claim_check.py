#!/usr/bin/env python3
"""WORKOS 版 claim-check(WORKOS-GUARD-001)· claim 前查 workos.db 报文件占用冲突。

claimed/in_progress/staging-verified 算占用 · 自己的卡不算 · herdr 存活探测附注。
FOREMAN-SIMPLIFY-004 起只 WARN 不拒:一 pane 一 worktree 后同文件并改在 PR merge 时暴露,
这里只把「谁也在动这些路径」摆出来;`workos claim` 会自动跑一次。

用法:
    claim_check.py <file_or_dir> [...] [--owner NAME] [--repo PATH]
- --owner 缺省取 env FOREMAN_OWNER(没有则当 "(unset)" · 仍报所有占用)。
- --repo  缺省取 cwd · 查 <repo>/.foreman/workos.db。
退出码:永远 0;有占用 / 锁表不可信只打 WARN。
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from foreman_liveness import describe as liveness_describe  # noqa: E402
from foreman_liveness import owner_liveness  # noqa: E402
from workos.guard import BoardUnreadable, touches_match  # noqa: E402

CLAIM_BLOCKING = ("claimed", "in_progress", "staging-verified")


def _blocking_cards(db_path: Path) -> tuple[list[dict], list[str]]:
    """同 guard.load_locked_cards,但含 staging-verified(claim 视角的占用面)。"""
    import json
    import sqlite3
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
        rows = con.execute(
            "SELECT id, owner, status, touches FROM tasks WHERE status IN (?,?,?)",
            CLAIM_BLOCKING,
        ).fetchall()
        con.close()
    except sqlite3.Error as e:
        raise BoardUnreadable(str(e)) from e
    cards, problems, orphans = [], [], []
    for tid, owner, status, touches in rows:
        if not str(owner or "").strip():
            # 无主 = 跑过 `handoff --release`(db.py 那句 `SET owner=NULL`)—— 显式表达
            # 「我放手了」。文件锁的语义是「有人正在改这些文件」,owner 为空时那句话不成立,
            # 所以不占锁,任何状态都一样。
            #
            # 从前一律判「不许匿名」→ 一张 release 过的卡就让**所有窗口** fail-closed,
            # 而它自己被状态机锁死:claim 要 open 态、advance 得 in_progress→staging-verified
            # →done 逐级走、翻 staging-verified 还要先 ref 一条 acceptance_run ——
            # 没有任何合法动词救得回来(2026-08-14 实撞两次:先 staging-verified 后 in_progress)。
            # 真正该 fail-closed 的是下面那种「行本身坏了」(touches 不是 JSON 数组)。
            orphans.append(f"{tid}({status})")
            continue
        try:
            tl = json.loads(touches) if touches else []
            assert isinstance(tl, list)
        except Exception:
            problems.append(f"{tid}: touches 非 JSON 数组")
            continue
        cards.append({"task_id": tid, "owner": owner, "status": status,
                      "touches": [str(t).strip() for t in tl if str(t or "").strip()]})
    if orphans:
        # 不阻塞,但要看得见:无主又没归档的卡是真实的技术债(活没干完、没人管)。
        print("ℹ️ 无主卡(release 过 · 不占锁):" + " · ".join(sorted(orphans)))
    return cards, problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--owner", default=os.environ.get("FOREMAN_OWNER") or "(unset)")
    ap.add_argument("--repo", default=os.getcwd())
    args = ap.parse_args()

    db_path = Path(args.repo) / ".foreman" / "workos.db"
    if not db_path.is_file():
        print("foreman: 无 .foreman/workos.db(该仓未切新板)· claim-check no-op")
        return 0

    candidates: list[str] = []
    repo_resolved = Path(args.repo).resolve()
    for f in args.files:
        try:
            candidates.append(str(Path(f).resolve().relative_to(repo_resolved)))
        except ValueError:
            candidates.append(f.lstrip("./"))

    try:
        cards, broken = _blocking_cards(db_path)
    except BoardUnreadable as e:
        print(f"⚠️ workos.db 不可读({e})——占用未知,先修库。")
        return 0
    if broken:
        print("⚠️ 不可信锁行(占用判定不全,修一下):")
        print("\n".join(f"  ⚠️ {b}" for b in broken))

    conflicts: list[str] = []
    blockers: list[tuple[str, str]] = []  # (owner, 卡 status)
    for c in cards:
        if c["owner"] == args.owner:
            continue  # 自己的卡不算冲突
        for cand in candidates:
            for touch in c["touches"]:
                if touches_match(cand, touch):
                    conflicts.append(
                        f"  🔒 {cand}  被 owner『{c['owner']}』的 "
                        f"{c['task_id']}(touches: {touch})占用"
                    )
                    blockers.append((c["owner"], c["status"]))

    if conflicts:
        print(f"⚠️ 占用提示(你=『{args.owner}』)· 这些路径别窗 active 卡也在动,合 PR 时可能冲突:")
        print("\n".join(conflicts))
        # 占路 owner 存活是新增证据,不替代收窄协议判定(foreman_liveness 契约)
        table = owner_liveness()
        seen: set[str] = set()
        lines: list[str] = []
        for owner, status in blockers:
            if owner in seen:
                continue
            seen.add(owner)
            lines.append(f"  {owner}(卡 status={status}): {liveness_describe(owner, table)}")
        if lines:
            print("─ 占路者现在还在不在(herdr):")
            print("\n".join(lines))
        print("→ 知会对方或错开顺序;对方卡实质完结可 workos release 收窄(locks.md)。")
        if table is not None and any(
            o.startswith("ac:") and o not in table for o, _ in blockers
        ):
            print(
                "  ⚰️ 标『无活动窗口』的:窗口不在 ≠ 活已干完(WIP 可能还躺着)——"
                "仍要核对卡 status / PR 是否合并 / 工作区未提交改动,三条齐了再收窄。"
            )
        return 0
    print(f"✓ claim-check(你=『{args.owner}』)· 候选文件无别窗占用。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
