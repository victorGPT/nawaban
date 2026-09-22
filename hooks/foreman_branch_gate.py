#!/usr/bin/env python3
"""branch gate 判定体(BRANCH-GATE-001 · foreman branchgate hang regression 拆出)。

原先这段是 foreman_branch_gate.sh 里的 heredoc。bash 5.x 在 exec 子命令**之前**
把 heredoc 写进 pipe,而 macOS 的 pipe 初始容量只有 512 字节 —— 这段 3.6KB 的正文
写到 512 就永久阻塞(读端 python 还没起来),整个闸挂死。栈:heredoc_write → write。
/bin/bash 3.2 走临时文件所以看不出来,PATH 上的 Homebrew bash 5.3 必挂。
拆成独立文件 = 这类死锁不可能再发生,顺带这段逻辑可以被直接单测。

入参:argv[1] = PreToolUse 的 payload JSON 全文。exit 2 = 拦。
"""

import json, os, re, subprocess, sys

raw = sys.argv[1] if len(sys.argv) > 1 else ""
try:
    cmd = json.loads(raw).get("tool_input", {}).get("command", "")
except Exception:
    sys.exit(0)                      # 解析不了就别拦 —— 闸宁可漏,不可误伤
if not cmd or "git" not in cmd:
    sys.exit(0)
# Old name stays valid: "FOREMAN_…=1" is not a substring of "NAWABAN_…=1", so check both.
if "NAWABAN_ALLOW_BRANCH_SWITCH=1" in cmd or "FOREMAN_ALLOW_BRANCH_SWITCH=1" in cmd:
    sys.exit(0)

# 当前树是不是 worktree:worktree 的 --git-dir 是 .git/worktrees/<name>,主树两者相同。
proj = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()


def git(*args: str) -> str:
    try:
        return subprocess.run(
            ["git", "-C", proj, *args], capture_output=True, text=True, timeout=5
        ).stdout.strip()
    except Exception:
        return ""


gitdir, common = git("rev-parse", "--git-dir"), git("rev-parse", "--git-common-dir")
if gitdir and common and os.path.abspath(gitdir) != os.path.abspath(common):
    sys.exit(0)                      # 已在 worktree 里 · 放行

# 段 = 按 ;&|、&&、||、换行切开;正则**锚在段首**(foreman branch gate anchor regression):
# 引号/heredoc/卡标题里引用切分支原文时,段首是引号或别的词,不再误拦。
# ponytail: 已知天花板——heredoc 内某行**顶格**就是切分支命令时仍会误拦;真解析 shell 不值得。
_SEGMENT = re.compile(r"(?:^|[;&|\n]|&&|\|\|)\s*([^;&|\n]+)")
_PREFIX = r"^(?:\(\s*)*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:command\s+|sudo\s+|exec\s+)?"
_NEW = re.compile(_PREFIX + r"git\s+(?:-C\s+\S+\s+)?(?:checkout|switch)\b[^;&|\n]*\s-(?:b|B|c|C)\b")
_MOVE = re.compile(_PREFIX + r"git\s+(?:-C\s+\S+\s+)?(checkout|switch)\s+([^;&|\n]*)")

hits = []
for seg in (m.group(1).strip() for m in _SEGMENT.finditer(cmd)):
    if "worktree" in seg:            # git worktree add [-b] · 合规动作
        continue
    if _NEW.search(seg):
        hits.append(seg)
        continue
    m = _MOVE.search(seg)
    if not m:
        continue
    args = [a for a in m.group(2).split() if a]
    if "--" in args:                 # git checkout -- <path> · 恢复文件
        continue
    target = next((a for a in args if not a.startswith("-")), "")
    if not target:
        continue
    # 只有「确实是本地分支名」才算切分支 —— 否则 `git checkout somefile.py` 会被误拦。
    if subprocess.run(
        ["git", "-C", proj, "show-ref", "--verify", "--quiet", f"refs/heads/{target}"],
        capture_output=True,
        timeout=5,
    ).returncode == 0:
        hits.append(seg)

if not hits:
    sys.exit(0)

cur = git("rev-parse", "--abbrev-ref", "HEAD") or "?"
print("🚫 branch gate:共享主工作区禁止切/开分支(agent-foreman 铁律 · 被拦看 references/gates.md)", file=sys.stderr)
for h in hits:
    print(f"   拦下:{h}", file=sys.stderr)
print(
    f"   主树 cwd 是所有窗口共用的,切它会把别的窗口一起拽到新分支(当前 {cur})——\n"
    "   那些窗口不会察觉,下一次 Edit 就写在错的分支上。\n"
    "   ✅ 改用 worktree(隔离的,里面随便切):\n"
    "      git worktree add .claude/worktrees/<短名> -b <分支名>\n"
    "      # 已有分支:git worktree add .claude/worktrees/<短名> <分支名>\n"
    "      之后所有命令带 -C .claude/worktrees/<短名>,或直接在里面用绝对路径 Edit。\n"
    "   完事清理:git worktree remove .claude/worktrees/<短名>(已提交的都在共享 .git 里,不会丢)\n"
    "   仅当你是在把被切歪的主树**还原**回原分支时,加前缀:NAWABAN_ALLOW_BRANCH_SWITCH=1 <原命令>",
    file=sys.stderr,
)
sys.exit(2)
