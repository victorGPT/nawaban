"""main 分支 CI 是否红着(NAWABAN-REGRESSION-001 停线闸的输入)。

开窗 hook 在后台跑 ``python3 -m nawaban.main_ci --repo <目录>`` 写状态文件;
claim 停线闸和开窗横幅只读这个文件，网络调用不进任何热路径。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from datetime import datetime
from pathlib import Path

from nawaban import db, paths

# ponytail: 状态超过一天就当不知道(停线闸放行);开窗时最多 10 分钟查一次，见 hook。
MAX_AGE_S = 24 * 3600
# 红状态超过 5 分钟，claim 当场重查一次再决定拦不拦：修复合入后 main 转绿，缓存不能继续停线。
RECHECK_RED_S = 300
FAILED = ("failure", "timed_out", "startup_failure")
SETTLED = ("success",)  # cancelled / skipped / neutral 不算结论，继续往前看


def state_file(state_dir: Path, project: str) -> Path:
    return state_dir / "main-ci" / f"{project}.json"


def red_runs(runs: list[dict]) -> list[dict]:
    """``gh run list`` 结果(新→旧)→ 每个仍红着的 workflow 及其连续失败段的起点。

    起点取连续失败的最早一次：修复卡在第一次变红之后建，后面的红 run 不应再次停线。
    失败一直延续到列表末尾(没见到更早的成功)时起点未知，记 0:任何未完成修复卡都算数。
    """
    red: dict[str, dict] = {}
    settled: set[str] = set()
    for run in runs:
        name = run.get("workflowName") or ""
        if name in settled or run.get("status") != "completed":
            continue
        if run.get("conclusion") in SETTLED:
            settled.add(name)
        elif run.get("conclusion") in FAILED:
            entry = red.setdefault(name, {"workflow": name, "url": run["url"], "head_sha": run["headSha"]})
            entry["since"] = int(datetime.fromisoformat(run["createdAt"].replace("Z", "+00:00")).timestamp())
    for name, entry in red.items():
        if name not in settled:
            entry["since"] = 0
    return list(red.values())


def check(repo: Path) -> dict:
    try:
        out = subprocess.run(
            ["gh", "run", "list", "--branch", "main", "--limit", "30",
             "--json", "workflowName,status,conclusion,headSha,url,createdAt"],
            cwd=repo, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as e:
        return {"checked_at": int(time.time()), "error": f"{type(e).__name__}: {e}"}
    if out.returncode != 0:
        return {"checked_at": int(time.time()), "error": (out.stderr.strip() or "gh failed").splitlines()[0]}
    return {"checked_at": int(time.time()), "red": red_runs(json.loads(out.stdout))}


def read(state_dir: Path, project: str | None) -> dict | None:
    if not project:
        return None
    try:
        data = json.loads(state_file(state_dir, project).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if time.time() - data.get("checked_at", 0) <= MAX_AGE_S else None


def write(state_dir: Path, project: str, repo: Path) -> dict:
    data = {**check(repo), "repo": str(repo)}
    target = state_file(state_dir, project)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, target)
    return data


def red_since(state_dir: Path, project: str | None) -> dict | None:
    """停线闸的输入：本项目 main 红着 → {"since": 最早变红时刻, "url": 一条失败 run}。

    红状态已超过 RECHECK_RED_S 时先同步重查(只有红路径付网络开销);重查失败就不拦。
    """
    data = read(state_dir, project) or {}
    if data.get("red") and data.get("repo") and time.time() - data["checked_at"] > RECHECK_RED_S:
        data = write(state_dir, project, Path(data["repo"]))
    red = data.get("red") or []
    if not red:
        return None
    first = min(red, key=lambda r: r["since"])
    return {"since": first["since"], "url": first["url"]}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="记录 main 分支 CI 状态，供停线闸读取")
    ap.add_argument("--repo", required=True)
    ap.add_argument("--state-dir", type=Path, default=paths.state_dir())
    a = ap.parse_args(argv)
    project = db.board_project(a.repo)
    if project:
        write(a.state_dir, project, Path(a.repo).resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
