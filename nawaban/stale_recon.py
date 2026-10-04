#!/usr/bin/env python3
"""NAWABAN STALE 对账器(NAWABAN-GUARD-001)· 从「提醒人」升级为「自动改」。

md 版 foreman_stale_check.py 只打印提醒;本对账器对每张 active 卡(open/claimed/in_progress)
的 refs kind='pr' 对照 gh 的 merged PR:
  1. 自动写 refs:merge_sha(gh mergeCommit)——写过即对账痕迹,天然幂等。
  2. coord 事件留痕(仅首次发现该 merge 时写,dispatcher 署名)。
  3. 推卡状态:in_progress 且已有 acceptance_run 证据 → transition 到 staging-verified
     (waiting_on=decision,进拍板队列;status_change 事件由 advance_task 自动落)。
     无 acceptance_run 证据 → **不推**(验收闸语义原样平移 · no_fabrication:
     对账器绝不代造验收证据),报告缺什么,补上证据后重跑即推。
  4. open/claimed 卡带 merged PR = 异常形态,只报告不动(人裁定)。

PR ref 值契约(与 NAWABAN-IMPORT-001 的跨卡约定):refs kind='pr' 的 value 含 PR 号数字
即可("2385" / "#2385" / URL 均认,digits 提取)。merge_sha 的 value = merge commit SHA。

写入一律走 nawaban.db 模块函数(add_ref/add_event/advance_task)= cli 九动词同层,无手写
mutation SQL。作者身份从环境链取(NAWABAN_OWNER → session-id),cron 等无身份环境署名
'reconciler'(系统角色,明示非人非 worker)。

用法:python3 nawaban/stale_recon.py [--repo PATH] [--write]
**默认 dry-run,真写须显式 --write**(总监裁定 2026-08-12:真库 CUTOVER 前 import-only,
只有导入器写——裁定机制化为默认关,不靠纪律;CUTOVER 后 cron 接入时带 --write)。
退出码:gh 失败=1 · 其余=0(报告本身不是错误)。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from nawaban.owner_identity import owner_from_session  # noqa: E402
from nawaban import db  # noqa: E402

_ANSI = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")
_ENV = dict(os.environ, NO_COLOR="1", GH_PAGER="cat", CLICOLOR="0")
ACTIVE = ("open", "claimed", "in_progress")


def fetch_merged(repo_dir: Path) -> dict[int, str] | None:
    """gh 拉 merged PR → {number: merge_sha}。失败返回 None(调用方响亮退出,不静默)。"""
    r = subprocess.run(
        ["gh", "pr", "list", "--state", "merged", "--json", "number,mergeCommit",
         "--limit", "500"],
        capture_output=True, text=True, env=_ENV, cwd=repo_dir,
    )
    out = _ANSI.sub("", r.stdout).strip()
    if r.returncode != 0:
        print(f"⚠️ gh pr list 失败(试 gh auth switch): {_ANSI.sub('', r.stderr).strip()[:120]}",
              file=sys.stderr)
        return None
    merged: dict[int, str] = {}
    for p in json.loads(out) if out else []:
        sha = str((p.get("mergeCommit") or {}).get("oid") or "")
        merged[int(p["number"])] = sha or f"pr-{p['number']}-merged"
    return merged


def _pr_numbers(value: str) -> set[int]:
    return {int(x) for x in re.findall(r"\d+", value)}


def reconcile(path: Path, merged: dict[int, str], *, author: str,
              session_id: str | None, dry_run: bool = False) -> dict:
    """对账一轮。返回报告 dict(advanced/recorded/needs_evidence/anomalies)。"""
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    con.row_factory = sqlite3.Row
    tasks = con.execute(
        "SELECT id, status FROM tasks WHERE status IN (?,?,?)", ACTIVE).fetchall()
    report = {"advanced": [], "recorded": [], "needs_evidence": [], "anomalies": []}
    for t in tasks:
        tid, status = t["id"], t["status"]
        refs = con.execute(
            "SELECT kind, value FROM task_refs WHERE task_id=?", (tid,)).fetchall()
        pr_nums = {n for r in refs if r["kind"] == "pr" for n in _pr_numbers(r["value"])}
        merged_here = sorted(n for n in pr_nums if n in merged)
        if not merged_here:
            continue
        have_shas = {r["value"] for r in refs if r["kind"] == "merge_sha"}
        has_acceptance = any(r["kind"] == "acceptance_run" for r in refs)
        new = [(n, merged[n]) for n in merged_here if merged[n] not in have_shas]

        if new and not dry_run:
            for n, sha in new:
                db.add_ref(path, tid, kind="merge_sha", value=sha,
                           note=f"PR#{n} merged · 对账器")
            body = (f"对账:{' '.join(f'PR#{n}' for n, _ in new)} 已 merged,"
                    f"卡时为 {status}" + ("" if has_acceptance else " · 缺 acceptance_run 证据"))
            db.add_event(path, tid, kind="coord", body=body,
                         author=author, session_id=session_id)
        if new:
            report["recorded"].append((tid, [n for n, _ in new]))

        if status == "in_progress":
            if has_acceptance:
                if not dry_run:
                    # 推卡到 decision 前先把问题提进收件箱(NAWABAN-DECISION-ASK-GATE-001):
                    # 对账器是「无 ask 的 decision 卡」在生产里的主要铸造点 —— 它替 agent
                    # 把卡翻成等人拍板,而人从没被问过,卡就此永久沉底(实测 46 张里 28 张)。
                    # evidence 取卡上真实的 acceptance_run 值,不是「PR 已合并」这种写侧信号。
                    if not _open_ask(con, tid):
                        acc = next(r["value"] for r in refs
                                   if r["kind"] == "acceptance_run")
                        db.raise_ask(
                            path, kind="accept",
                            question=f"{tid}:验收证据已在,收下吗?",
                            evidence=f"acceptance_run:{acc}",
                            task_ids=[tid], raised_by=author)
                    db.advance_task(path, tid, to="staging-verified",
                                    waiting_on="decision",
                                    owner=author, session_id=session_id or "recon")
                report["advanced"].append(tid)
            else:
                report["needs_evidence"].append((tid, merged_here))
        else:  # open/claimed 带 merged PR:异常形态,人裁定
            report["anomalies"].append((tid, status, merged_here))
    con.close()
    return report


def _open_ask(con, tid: str) -> bool:
    """这张卡此刻挂着未关的 ask 吗(幂等:重跑不重复提问)。"""
    return con.execute(
        "SELECT 1 FROM ask_tasks t JOIN asks a ON a.id=t.ask_id"
        " WHERE t.task_id=? AND a.closed_at IS NULL LIMIT 1", (tid,)).fetchone() is not None


def print_report(report: dict, dry_run: bool) -> None:
    tag = "(dry-run · 未写)" if dry_run else ""
    if not any(report.values()):
        print("✅ 无 STALE:active 卡引用的 PR 都还没 merged(或已对账)")
        return
    if report["recorded"]:
        print(f"📌 对账落痕{tag}({len(report['recorded'])})· 写 merge_sha ref + coord 事件:")
        for tid, nums in report["recorded"]:
            print(f"  · {tid} ← {', '.join(f'#{n}' for n in nums)}")
    if report["advanced"]:
        print(f"⬆️ 自动推状态{tag}({len(report['advanced'])})· in_progress→staging-verified"
              "(waiting_on=decision · 进拍板队列):")
        for tid in report["advanced"]:
            print(f"  · {tid}")
    if report["needs_evidence"]:
        print(f"🟡 缺验收证据({len(report['needs_evidence'])})· PR 已 merged 但无 acceptance_run"
              " ref,不代推(验收闸)——补 `nawaban ref --kind acceptance_run` 后重跑即推:")
        for tid, nums in report["needs_evidence"]:
            print(f"  · {tid}({', '.join(f'#{n}' for n in nums)} 已 merged)")
    if report["anomalies"]:
        print(f"🟠 异常形态({len(report['anomalies'])})· 未开工态却有 merged PR,人裁定:")
        for tid, status, nums in report["anomalies"]:
            print(f"  · {tid}(status={status} · {', '.join(f'#{n}' for n in nums)})")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    ap.add_argument("--write", action="store_true",
                    help="真写(缺省 dry-run;CUTOVER 前真库 import-only,别开)")
    args = ap.parse_args()
    dry_run = not args.write
    repo = Path(args.repo).resolve()
    path = db.resolve_db(repo)
    if not path.is_file():
        print(f"(无 .nawaban/nawaban.db · 该仓未切新板) {repo}")
        return 0
    merged = fetch_merged(repo)
    if merged is None:
        return 1
    sid = os.environ.get("CLAUDE_CODE_SESSION_ID")
    author = (db.owner_from_env()
              or (owner_from_session(sid) if sid else None) or "reconciler")
    report = reconcile(path, merged, author=author, session_id=sid, dry_run=dry_run)
    print_report(report, dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
