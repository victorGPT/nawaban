"""Bash tripwire 冒烟:heredoc 写仓内要拦,数据里的 > 不能误拦。"""
import importlib.util, json, os, subprocess, sys, tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "g", Path(__file__).resolve().parents[2] / "nawaban/guard.py")
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)

# 提取器单测(不碰库)
T = g._bash_write_targets
assert T("cat > src/x.py <<'EOF'\nif a > b: pass\nEOF\n") == ["src/x.py"], T("cat > src/x.py <<'EOF'\nif a > b: pass\nEOF\n")
assert T('echo "a > b" | grep x') == [], T('echo "a > b" | grep x')
assert T("ls -l 2>&1 >/dev/null") == []
assert T("printf x | tee -a docs/y.md") == ["docs/y.md"]
assert T("sed -i '' -e s/a/b/ src/z.py") == ["src/z.py"], T("sed -i '' -e s/a/b/ src/z.py")
assert T('echo hi > "$SP/t"') == []
assert T("grep '>' README.md") == []

# 端到端:真 git 仓 + 真 workos.db,主树写入必须 BLOCK
root = Path(tempfile.mkdtemp())
repo = root / "repo"; repo.mkdir()
subprocess.run(["git", "init", "-q", str(repo)], check=True)
(repo / ".foreman").mkdir()
cli = str(Path(__file__).resolve().parents[2] / "nawaban/cli.py")
db = str(repo / ".foreman/workos.db")
env = {**os.environ, "NAWABAN_OWNER": "ac:test", "CLAUDE_CODE_SESSION_ID": "deadbeef"}
subprocess.run([sys.executable, cli, "--db", db, "init"], check=True, env=env, capture_output=True)

def judge(cmd):
    os.environ["NAWABAN_OWNER"] = "ac:test"
    return g.judge({"tool_name": "Bash", "cwd": str(repo), "tool_input": {"command": cmd}})

code, msg = judge("cat > src/x.py <<'EOF'\nif a > b: pass\nEOF")
assert code == 2 and "worktree gate" in msg, (code, msg)
assert judge("cat > %s/out.txt <<'EOF'\nhi\nEOF" % root)[0] == 0      # 仓外
assert judge('echo "a > b"')[0] == 0
assert judge("grep '>' README.md")[0] == 0
assert judge("ls -l > /dev/null")[0] == 0
# Write 老路径不回归
assert g.judge({"tool_name": "Write", "cwd": str(repo),
                "tool_input": {"file_path": str(repo / "src/x.py")}})[0] == 2
print("tripwire OK")

# cd 之后的相对路径按切过去的目录算,不按会话目录算
subprocess.run(["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@example.invalid",
                "commit", "-q", "--allow-empty", "-m", "init"], check=True)
wt = repo / ".claude/worktrees/t"
subprocess.run(["git", "-C", str(repo), "worktree", "add", "-q", str(wt), "-b", "t"], check=True)
assert judge("cd .claude/worktrees/t && echo x >> NOTES.md")[0] == 0           # 写在工位里
assert judge('cd "%s" && echo x >> NOTES.md' % wt)[0] == 0                       # 带引号的绝对路径
assert judge("cd .claude/worktrees/t && printf x | tee NOTES.md")[0] == 0
assert judge("git worktree add .claude/worktrees/n -b n && cd .claude/worktrees/n && echo x > f")[0] == 0  # 工位还没建
assert judge("cd .claude/worktrees/t && cd %s && echo x >> NOTES.md" % repo)[0] == 2   # 又切回主树
assert judge("cd src && echo x > y.py")[0] == 2                                   # 主树子目录
assert judge("cd .claude/worktrees/t && echo x > %s/NOTES.md" % repo)[0] == 2      # 绝对路径指回主树
assert judge("mkdir new && cd new && echo x > f")[0] == 2                         # 新目录仍在主树
assert judge("echo x 2>&1 >> NOTES.md")[0] == 2
assert judge("cd .claude/worktrees/t && cd sub 2>/dev/null; true")[0] == 0
# 拿不准目录就按会话目录判(修复前的行为):只有「cd 字面目录 && 写」才换基准
for unsure in (
    'cd "$WT" && echo x > f',
    "cd /tmp > NOTES.md",                                   # cd 自己的重定向先于切目录
    "echo \\;cd /tmp; echo x > NOTES.md",                   # 转义分号不是命令边界
    "cd /__missing__ ; echo x > f",                         # cd 失败后仍在主树
    "false && cd /tmp; echo x > NOTES.md",                  # cd 被短路跳过
    "cd .claude/worktrees/t; echo x > NOTES.md",            # 分号不保证 cd 成功
    "cd -P . && echo x > NOTES.md",
    "cd .claude/worktrees/t && cd - && echo x > NOTES.md",
    "cd .claude/worktrees/t && pushd %s && echo x > f" % repo,
    'cd "%s"/src && echo x > NOTES.md' % repo,              # 引号只包住半个参数
    "echo x > f; cd ~__no_such_user__",                     # 不能让 hook 崩掉
    "cd .claude/worktrees/t && cd .. && echo x > f",        # 走出工位
    "cd .claude/worktrees/t && echo x > ../../../NOTES.md",
    "(cd .claude/worktrees/t) && echo x > NOTES.md",        # 子 shell 里的 cd 不外泄
    "cd .claude/worktrees/t && builtin cd %s && echo x > f" % repo,
    "git worktree add .claude/worktrees/m -b m; cd .claude/worktrees/m && echo x > f",
):
    assert judge(unsure)[0] == 2, unsure
print("tripwire cd OK")
