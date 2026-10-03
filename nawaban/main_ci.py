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
FAILED = ("failure", "timed_out", "startup_failure")
SETTLED = ("success",)  # cancelled / skipped / neutral 不算结论，继续往前看


def state_file(state_dir: Path, project: str) -> Path:
    return state_dir / "main-ci" / f"{project}.json"


def red_runs(runs: list[dict]) -> list[dict]:
    """``gh run list`` 结果(新→旧)→ 每个仍红着的 workflow 及其连续失败段的起点。

    起点取连续失败的最早一次：修复卡在第一次变红之后建，后面的红 run 不应再次停线。
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


def red_since(state_dir: Path, project: str | None) -> dict | None:
    """停线闸的输入：本项目 main 红着 → {"since": 最早变红时刻, "url": 一条失败 run}。"""
    red = (read(state_dir, project) or {}).get("red") or []
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
    if not project:
        return 0
    target = state_file(a.state_dir, project)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".tmp")
    tmp.write_text(json.dumps(check(Path(a.repo)), ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
