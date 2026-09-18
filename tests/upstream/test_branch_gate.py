#!/usr/bin/env python3
"""foreman_branch_gate.sh 回归自检 · 零依赖(不需 pytest)。

建一个临时 git 仓库(含一条真分支 + 一个真文件)+ 一个真 worktree,构造 PreToolUse stdin JSON,
子进程真跑闸,断言 exit code。跑法:

    python3 tests/upstream/test_branch_gate.py   → 全绿输出 OK / 任一失败 exit 1

覆盖:建分支拦 · 切已有分支拦 · 恢复文件放行 · worktree 命令放行 · worktree 内放行 ·
     git branch(只建不切)放行 · 逃生门放行 · 复合命令里夹一条也拦。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

GATE = Path(__file__).resolve().parents[2] / "hooks/foreman_branch_gate.sh"
FAILED: list[str] = []


def sh(*args: str, cwd: Path) -> None:
    subprocess.run(args, cwd=cwd, capture_output=True, check=True)


def build_repo(root: Path) -> tuple[Path, Path]:
    """建主树(分支 main + feature/x + 文件 keep.py)与一个 worktree,返回两者路径。"""
    main = root / "repo"
    main.mkdir()
    sh("git", "init", "-q", "-b", "main", cwd=main)
    sh("git", "config", "user.email", "t@t", cwd=main)
    sh("git", "config", "user.name", "t", cwd=main)
    (main / "keep.py").write_text("x = 1\n")
    sh("git", "add", "-A", cwd=main)
    sh("git", "commit", "-qm", "init", cwd=main)
    sh("git", "branch", "feature/x", cwd=main)
    wt = root / "wt"
    sh("git", "worktree", "add", "-q", str(wt), "feature/x", cwd=main)
    return main, wt


def run_gate(cmd: str, cwd: Path) -> int:
    payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": cmd}})
    env = {**os.environ, "CLAUDE_PROJECT_DIR": str(cwd)}
    proc = subprocess.run(
        ["bash", str(GATE)], input=payload, capture_output=True, text=True, env=env, cwd=cwd
    )
    return proc.returncode


def case(name: str, cmd: str, cwd: Path, expect: int) -> None:
    got = run_gate(cmd, cwd)
    verdict = "拦" if got == 2 else "放行"
    want = "拦" if expect == 2 else "放行"
    if got != expect:
        FAILED.append(f"{name}: 期望{want} 实际{verdict} (exit={got}) · cmd={cmd!r}")
        print(f"  ✗ {name} —— 期望{want},实际{verdict}")
    else:
        print(f"  ✓ {name} ({verdict})")


def t_no_oversized_heredoc() -> None:
    """任何 hook 脚本都不许内联 >512 字节的 heredoc(foreman branchgate hang regression)。

    bash 5.x 在 exec 子命令**之前**把 heredoc 写进 pipe;macOS 的 pipe 初始容量是
    **512 字节**,超了就在 write() 上永久阻塞 —— 读端还没被 exec 出来。
    /bin/bash 3.2 走临时文件所以看不出来,PATH 上的 Homebrew bash 5.3 必挂。
    实测:本闸 3591 字节的 heredoc 让整个回归网瞎了(>120s 无输出),
    栈是 heredoc_write → write。修法是把正文拆成独立 .py,不是调大 timeout。
    本用例守的是「不许再有人把大段脚本塞回 heredoc」。
    """
    import re
    bad = []
    for f in sorted(Path(GATE).parent.glob("*.sh")):
        txt = f.read_text(encoding="utf-8", errors="replace")
        if not txt.startswith("#!/usr/bin/env bash") and not txt.startswith("#!/bin/bash"):
            continue  # sh/dash 走临时文件,不在此列
        for m in re.finditer(r"<<-?\s*'?([A-Za-z_]\w*)'?\s*$", txt, re.M):
            tail = txt[m.end():]
            end = re.search(r"^\s*" + m.group(1) + r"\s*$", tail, re.M)
            n = len((tail[:end.start()] if end else tail).encode())
            if n > 512:
                bad.append(f"{f.name}: heredoc {n} 字节 > 512(pipe 容量)")
    if bad:
        FAILED.append("超长 heredoc(bash 5.x 下会死锁):" + " · ".join(bad))
    else:
        print("  ✓ 无超长内联 heredoc(bash 5.x pipe 死锁类)")


def main() -> int:
    if not GATE.exists():
        print(f"闸不存在:{GATE}")
        return 1
    with tempfile.TemporaryDirectory() as tmp:
        main_tree, wt = build_repo(Path(tmp))

        print("主树 · 该拦的:")
        case("checkout -b 建新分支", "git checkout -b task/new", main_tree, 2)
        case("switch -c 建新分支", "git switch -c task/new", main_tree, 2)
        case("checkout 切已有分支", "git checkout feature/x", main_tree, 2)
        case("switch 切已有分支", "git switch feature/x", main_tree, 2)
        case(
            "复合命令里夹一条",
            "git fetch origin main -q && git checkout -b task/new origin/main",
            main_tree,
            2,
        )

        print("主树 · 该放行的:")
        case("checkout -- 恢复文件", "git checkout -- keep.py", main_tree, 0)
        case("checkout 非分支参数", "git checkout keep.py", main_tree, 0)
        case("worktree add -b(正是要引导的)", "git worktree add ../wt2 -b task/new", main_tree, 0)
        case("worktree add 已有分支", "git worktree add ../wt3 feature/x", main_tree, 0)
        case("git branch 只建不切", "git branch task/new", main_tree, 0)
        case("与 git 无关的命令", "uv run pytest -q", main_tree, 0)
        case("逃生门", "FOREMAN_ALLOW_BRANCH_SWITCH=1 git checkout feature/x", main_tree, 0)

        print("误伤回归 · 引用原文放行:")
        case("单引号字符串里引用", "echo '绝不 git checkout -b / 切分支'", main_tree, 0)
        case(
            "heredoc 行内引用",
            "python3 - <<'EOF'\nx=('# 绝不 git checkout -b 切分支',)\nEOF",
            main_tree,
            0,
        )
        case(
            "卡标题里引用",
            'python3 cli.py create X --title "引用「git checkout -b」原文不拦"',
            main_tree,
            0,
        )

        print("锚定后拦截面不缩 · 仍要拦的:")
        case("换行分隔的切分支", "echo hi\ngit checkout -b task/new", main_tree, 2)
        case("env 前缀的切分支", "GIT_PAGER=cat git switch -c task/new", main_tree, 2)
        case("subshell 里切分支", "(git checkout -b task/new)", main_tree, 2)

        print("worktree 内 · 全放行(隔离的,随便切):")
        case("worktree 内 checkout -b", "git checkout -b whatever", wt, 0)
        case("worktree 内切已有分支", "git checkout main", wt, 0)

    print("脚本形态回归:")
    t_no_oversized_heredoc()

    if FAILED:
        print(f"\n✗ {len(FAILED)} 条不符:")
        for f in FAILED:
            print("  -", f)
        return 1
    print("\nOK · 全绿")
    return 0


if __name__ == "__main__":
    sys.exit(main())
