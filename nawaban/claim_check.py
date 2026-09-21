#!/usr/bin/env python3
"""Read-only ownership diagnostics; findings never veto an existing claim.

report_conflicts owns path matching and presentation. The standalone command
retains --repo for legacy boards; --db selects an independent database without
assuming that its containing directory identifies the working tree.
"""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Sequence
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from nawaban.foreman_liveness import describe as liveness_describe  # noqa: E402
from nawaban.foreman_liveness import owner_liveness  # noqa: E402
from nawaban import db
from nawaban.guard import BoardUnreadable, enclosing_tree, touches_match  # noqa: E402

CLAIM_BLOCKING = ("claimed", "in_progress", "staging-verified")


def _blocking_cards(db_path: Path, *, owner: str) -> tuple[list[dict], list[str]]:
    """Include awaiting-acceptance ownership as well as active implementation."""
    import json
    import sqlite3
    try:
        with closing(sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)) as con:
            rows = con.execute(
                "SELECT id, owner, status, touches FROM tasks WHERE status IN (?,?,?)",
                CLAIM_BLOCKING,
            ).fetchall()
            own_ids = {r[0] for r in rows if r[1] == db._stored_session_owner(
                con, r[0], owner, owner.removeprefix("ac:"))}
    except sqlite3.Error as e:
        raise BoardUnreadable(str(e)) from e
    cards, problems, orphans = [], [], []
    for tid, owner, status, touches in rows:
        if not str(owner or "").strip():
            # A released task can still await acceptance, but no actor holds its
            # paths. Keep the unfinished work visible without treating it as a lock.
            orphans.append(f"{tid}({status})")
            continue
        try:
            tl = json.loads(touches) if touches else []
            assert isinstance(tl, list)
        except Exception:
            problems.append(f"{tid}: touches 非 JSON 数组")
            continue
        cards.append({"task_id": tid, "owner": owner, "status": status,
                      "mine": tid in own_ids,
                      "touches": [str(t).strip() for t in tl if str(t or "").strip()]})
    if orphans:
        print("ℹ️ 无主卡(release 过 · 不占锁):" + " · ".join(sorted(orphans)))
    return cards, problems


def report_conflicts(path: Path | str, files: Sequence[str], *, owner: str,
                     repo: Path | str | None = None) -> None:
    """Print ownership warnings from exactly path without writing to the board.

    Relative files are task touches, relative to repo or the current Git working
    tree root (cwd outside Git). Absolute files inside that root are normalized
    to the same names. Database placement never determines the working tree.
    Missing or unreadable databases and malformed touch rows produce diagnostics;
    conflicts are advisory and do not undo or reject a previously committed claim.
    Liveness is supporting evidence only; it never authorizes releasing touches.
    """
    db_path = Path(path).expanduser()
    if not db_path.is_file():
        print(f"nawaban: 无数据库 {db_path} · claim-check no-op")
        return
    if repo is None:
        cwd = Path.cwd()
        tree = enclosing_tree(cwd)
        repo = tree[0] if tree else cwd
    repo_resolved = Path(repo).resolve()
    candidates: list[str] = []
    for f in files:
        try:
            candidates.append(str((repo_resolved / f).resolve().relative_to(repo_resolved)))
        except ValueError:
            candidates.append(f.lstrip("./"))

    try:
        cards, broken = _blocking_cards(db_path, owner=owner)
    except BoardUnreadable as e:
        print(f"⚠️ nawaban.db 不可读({e})——占用未知,先修库。")
        return
    if broken:
        print("⚠️ 不可信锁行(占用判定不全,修一下):")
        print("\n".join(f"  ⚠️ {b}" for b in broken))

    conflicts: list[str] = []
    blockers: list[tuple[str, str]] = []
    for c in cards:
        if c["mine"]:
            continue
        for cand in candidates:
            for touch in c["touches"]:
                if touches_match(cand, touch):
                    conflicts.append(
                        f"  🔒 {cand}  被 owner『{c['owner']}』的 "
                        f"{c['task_id']}(touches: {touch})占用"
                    )
                    blockers.append((c["owner"], c["status"]))

    if conflicts:
        print(f"⚠️ 占用提示(你=『{owner}』)· 这些路径别窗 active 卡也在动,合 PR 时可能冲突:")
        print("\n".join(conflicts))
        # An absent window is evidence, not permission to discard unfinished work.
        table = owner_liveness()
        seen: set[str] = set()
        lines: list[str] = []
        for blocker_owner, status in blockers:
            if blocker_owner in seen:
                continue
            seen.add(blocker_owner)
            lines.append(f"  {blocker_owner}(卡 status={status}): {liveness_describe(blocker_owner, table)}")
        if lines:
            print("─ 占路者现在还在不在(herdr):")
            print("\n".join(lines))
        print("→ 知会对方或错开顺序;对方卡实质完结可 nawaban release 收窄(locks.md)。")
        if table is not None and any(
            o.startswith("ac:") and o not in table for o, _ in blockers
        ):
            print(
                "  ⚰️ 标『无活动窗口』的:窗口不在 ≠ 活已干完(WIP 可能还躺着)——"
                "仍要核对卡 status / PR 是否合并 / 工作区未提交改动,三条齐了再收窄。"
            )
        return
    print(f"✓ claim-check(你=『{owner}』)· 候选文件无别窗占用。")
    return


def main() -> int:
    """Parse legacy file arguments and report warnings; normal diagnostics exit 0.

    With no --db, the board remains the discovered board in <explicit repo or cwd>.
    With --db alone, task paths use the current working tree root. An explicit
    --repo preserves legacy cwd-relative file handling independently of --db.
    """
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--owner", default=os.environ.get("FOREMAN_OWNER") or "(unset)")
    ap.add_argument("--repo", help="文件所属仓库(旧版默认 cwd)")
    ap.add_argument("--db", help="显式板数据库;不从数据库位置推导仓库")
    args = ap.parse_args()
    repo = args.repo
    files = args.files
    if repo is not None or args.db is None:
        repo = Path(repo or Path.cwd()).resolve()
        # Legacy callers may pass cwd-relative files with a separate --repo.
        files = [str(Path(f).resolve()) if Path(f).resolve().is_relative_to(repo)
                 else f for f in files]
    path = Path(args.db).expanduser() if args.db else db.board_db(Path(repo))
    report_conflicts(path, files, owner=args.owner, repo=repo)
    return 0


if __name__ == "__main__":
    sys.exit(main())
