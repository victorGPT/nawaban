#!/usr/bin/env python3
"""NAWABAN 重写版 PreToolUse guard(NAWABAN-GUARD-001)· 查 nawaban.db,不读 md 卡。

✅ 已激活(2026-08-13 切换日):~/.claude/settings.json PreToolUse 已指向本文件,
md 版 foreman_guard.py 自此退役未接线。注意:无 nawaban.db 的仓本 guard no-op ——
仍走 md 轨的其他仓从切换日起零 guard 保护(NAWABAN-RETIRE-001 摸底 2026-08-29)。

判定面(foreman simplify regression 起只剩 worktree 闸;touches 占用降为 claim 时 WARN,见 claim_check.py):
- 验收闸 / done 闸:已迁入库层 db.advance_task(翻 verified 须 waiting_on+acceptance_run;
  done 须 user 拍板行)——新世界卡不是文件,md 版的「卡写闸/验收闸拦 Edit 写卡」失去对象,
  语义原样活在写入工具里(test_nawaban_db.py t_status_gates 覆盖)。
- strict uncovered / WARN 快速修口子:同 md 版。

- nawaban.db 不存在 → no-op(该仓未切换到新板;md 卡仓不受伤)。

merge gate pr checks regression: identified Bash `gh pr merge` calls require all checks
SUCCESS and a head containing remote main (a behind PR passes when the PR and main
do not both add migrations, and main's new commits all carry a skip-CI marker or
touch none of the PR's files), even without a board. No identity is
still a no-op; failed queries deny. Empty checks deny unless neither the PR's base
branch nor the PR head has a workflow that runs on PRs and a task's passing review
is locked (NAWABAN-NOCI-GATE-001). The behind check compares the head with main,
not the base branch, on purpose: a PR into an integration branch is also checked
against the latest main. While a workflow triggered by `push` on main has its latest
settled run failed (cancelled/skipped/neutral runs are passed over; scheduled,
workflow_run and manual runs do not count), merges are frozen except fix PRs: a title
starting with `Revert` or a `main-fix` label. Queries are read-only;
compound commands must be split. Scripts/eval/API merges and direct pushes are
outside coverage. Post-preflight races still require server-side protection.

review gate (NAWABAN-REVIEW-GATE-001): when the board has an unfinished task whose
`pr` ref is this PR's full URL (bare numbers do not count), the task's latest review must
pass on the PR head commit and the merge
must carry `--match-head-commit <that commit>`, which GitHub enforces server side.

身份铁律:owner 只从环境来(NAWABAN_OWNER → tmux → session-id),与 md 版同链。
本文件对库只读(mode=ro URI),物理上写不了。
"""

from __future__ import annotations

import fnmatch
import io
import json
import os
import re
import shlex
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from nawaban.owner_identity import owner_from_session  # noqa: E402
from nawaban import db, main_ci  # noqa: E402

LOCKED = ("claimed", "in_progress")


# ── touches 语义(从 foreman_card.touches_match 逐字拷贝:解耦将死的 md 栈,不引 yaml)──

def touches_match(target_rel: str, touch: str) -> bool:
    """touches 语义:目录尾 / = 前缀匹配 · 含 *? = fnmatch · 其余精确(或其子路径)。"""
    touch = touch.strip().lstrip("./")
    target_rel = target_rel.lstrip("./")
    if not touch:
        return False
    if "*" in touch or "?" in touch:
        return fnmatch.fnmatch(target_rel, touch)
    if touch.endswith("/"):
        return target_rel.startswith(touch)
    return target_rel == touch or target_rel.startswith(touch.rstrip("/") + "/")


# ── 目标文件落在哪棵树上(WORKTREE-GATE-001 · 2026-08-20)──────────────

def enclosing_tree(path: Path) -> tuple[Path, Path] | None:
    """返回 (目标所在树的根, 该仓主 worktree 的根);不在任何 git 树里 → None。

    **不跑 git 子进程** —— 本函数在每一次 Edit/Write 上都要过,`git rev-parse` 一次
    ~10ms,会顶破模块 docstring 里那条 ≤10ms 判据。纯 stat 就能分辨:
      `.git` 是**目录** = 主 worktree · 是**文件**(内容 `gitdir: …/.git/worktrees/<名>`) = linked worktree。

    两个返回值都要:
      · 树根 → 算 target_rel(claim 的 touches 是相对各自树根的)
      · 主树根 → 找 `.foreman/`。`.foreman/` 是全局 gitignore 的,**worktree 里根本没有这个目录**;
        原来按 cwd 找库,于是 worktree 会话一律读不到板 = claim 锁在 worktree 里完全失效
        (2026-08-20 实测:同一个被别窗锁着的文件,cwd=主树 exit 2、cwd=worktree exit 0)。
    """
    p = path if path.is_dir() else path.parent
    for d in (p, *p.parents):
        g = d / ".git"
        if g.is_dir():
            return d, d
        if not g.is_file():
            continue
        try:
            line = g.read_text(encoding="utf-8", errors="replace").strip()
        except OSError:
            return None
        if not line.startswith("gitdir:"):
            return d, d          # 形状不认得(submodule 等)· 当它自成一树
        gitdir = Path(line.split(":", 1)[1].strip())
        if not gitdir.is_absolute():
            gitdir = (d / gitdir)
        for anc in gitdir.parents:
            if anc.name == ".git":
                return d, anc.parent
        return d, d
    return None


# ── 身份链(与 md 版 foreman_guard 同语义)─────────────────────────

def _infer_owner_from_tmux() -> str | None:
    if not os.environ.get("TMUX"):
        return None
    try:
        import subprocess
        pane = os.environ.get("TMUX_PANE")
        cmd = ["tmux", "display-message", *(["-t", pane] if pane else []), "-p", "#S:#W"]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=2)
        if result.returncode != 0:
            return None
        sanitized = re.sub(r"[^a-zA-Z0-9_/:.-]", "", result.stdout.strip())[:50]
        if not re.search(r"[a-zA-Z0-9]", sanitized):
            return None  # 全中文窗名剥成纯分隔符 → 视为失败(2026-08-01 实锤)
        return sanitized or None
    except Exception:
        return None


def resolve_owner(payload_sid: str | None = None) -> str | None:
    # Codex 不给 hook 进程 session env,只在 stdin payload 里带 session_id
    sid = os.environ.get("CLAUDE_CODE_SESSION_ID") or payload_sid or ""
    return (
        db.owner_from_env()
        or _infer_owner_from_tmux()
        or (owner_from_session(sid) if sid else None)
    )


# ── 锁表读取(只读连接 · fail-closed)────────────────────────────

class BoardUnreadable(Exception):
    """库打不开/查询炸——锁表不可信信号。"""


def load_locked_cards(db_path: Path) -> tuple[list[dict], list[str]]:
    """返回 (可信锁卡列表, 不可信行描述列表)。行级问题(匿名/touches 坏)进 problems。"""
    try:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error as e:
        raise BoardUnreadable(f"打不开:{e}") from e
    try:
        rows = con.execute(
            "SELECT id, owner, status, epic, touches"
            " FROM tasks WHERE status IN (?,?)", LOCKED,
        ).fetchall()
    except sqlite3.Error as e:
        raise BoardUnreadable(f"查询失败:{e}") from e
    finally:
        con.close()

    cards: list[dict] = []
    problems: list[str] = []
    for tid, owner, status, epic, touches in rows:
        if not str(owner or "").strip():
            problems.append(f"{tid}: owner 缺失({status} 卡不许匿名)")
            continue
        try:
            tl = json.loads(touches) if touches else []
            assert isinstance(tl, list)
        except Exception:
            problems.append(f"{tid}: touches 非 JSON 数组『{str(touches)[:60]}』")
            continue
        cards.append({
            "task_id": tid, "owner": owner, "status": status, "epic": epic,
            "touches": [str(t).strip() for t in tl if str(t or "").strip()],
        })
    return cards, problems


# ── 判定主体(in-process 可测 · ≤10ms 判据对本函数)──────────────

# ── Bash 写目标提取(BASH-TRIPWIRE · 2026-08-26)──────────────────────
# 闸只 hook Write/Edit,Bash heredoc 整条绕过 —— 而"优先用 Bash 写文件"的指令
# 恰恰把最守规矩的 agent 推过去了。任意 shell 静态判定不可能,这里只做 tripwire:
# ponytail: regex 拦常见写法(重定向 / tee / sed -i),拦不住任意 shell(eval、
# 变量拼路径、python -c 写文件)。要真封死得上 sandbox/文件系统层,不在这里建。

_HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1")
_REDIR = re.compile(r"(?<![0-9&])>>?\s*([^\s|&;<>()]+)")
_TEE = re.compile(r"\btee\b(?:\s+-\S+)*\s+([^\s|&;<>()]+)")


def _strip_heredoc_bodies(cmd: str) -> str:
    """Exclude heredoc data from both Bash tripwires."""
    out: list[str] = []
    lines = cmd.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        m = _HEREDOC.search(line)
        i += 1
        if m:
            # Quoted/commented << text is not a redirection; keep later commands.
            lexer = shlex.shlex(line, posix=False, punctuation_chars="<")
            lexer.whitespace_split = True
            try:
                tokens = list(lexer)
            except ValueError:
                continue
            if "<<" not in tokens:
                continue
            tail = tokens[tokens.index("<<") + 1:]
            if not tail:
                continue
            delim = tail[0].removeprefix("-").strip("'\"")
            if not delim and len(tail) > 1:
                delim = tail[1].strip("'\"")
            while i < len(lines) and lines[i].strip() != delim:
                i += 1
            i += 1
    return "\n".join(out)


def _strip_shell_noise(cmd: str) -> str:
    """去掉 heredoc 正文与引号包裹段:里面的 > 是数据不是重定向(误拦比漏拦更贵)。"""
    return re.sub(r"'[^']*'|\"[^\"]*\"", " ", _strip_heredoc_bodies(cmd))


def _bash_write_targets(cmd: str) -> list[str]:
    body = _strip_shell_noise(cmd)
    cands = _REDIR.findall(body) + _TEE.findall(body)
    for seg in re.split(r"[\n;|&]+", body):
        toks = seg.split()
        if "sed" in toks and any(t.startswith("-i") for t in toks) and toks[-1:]:
            cands.append(toks[-1])
    out: list[str] = []
    for c in cands:
        c = c.strip()
        # $ = 未展开变量(解析不出真路径)· - = 选项 · /dev/ 与纯数字 fd = 非文件
        if not c or c.isdigit() or c.startswith(("-", "$", "/dev/")) or "$" in c:
            continue
        if c not in out:
            out.append(c)
    return out


class Unverified(Exception):
    """The external command or GitHub response cannot establish merge safety."""


def _merge_args(segment: list[str]) -> list[str] | None:
    tokens = segment[:]
    while tokens and (
        tokens[0] in {"env", "command", "exec", "rtk", "proxy"}
        or re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*=.*", tokens[0])
    ):
        tokens.pop(0)
    if not tokens or Path(tokens.pop(0)).name != "gh":
        return None
    repo_args = []
    for expected in ("pr", "merge"):
        while tokens and (tokens[0] in {"-R", "--repo"}
                          or tokens[0].startswith(("--repo=", "-R"))):
            flag = tokens.pop(0)
            repo_args.append(flag)
            if flag in {"-R", "--repo"} and tokens:
                repo_args.append(tokens.pop(0))
        if not tokens or tokens.pop(0) != expected:
            return None
    return repo_args + tokens


_VALUE_FLAGS = {"-A", "--author-email", "-b", "--body", "-F", "--body-file",
                "--match-head-commit", "-t", "--subject"}


def _view_args(args: list[str]) -> list[str]:
    result = ["pr", "view"]
    value_flags = _VALUE_FLAGS
    switches = {"--admin", "--auto", "--disable-auto", "-d", "--delete-branch",
                "-m", "--merge", "-r", "--rebase", "-s", "--squash"}
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in {"-R", "--repo"} | value_flags:
            if i + 1 == len(args):
                raise Unverified(f"missing value for {arg}")
            if arg in {"-R", "--repo"}:
                result.extend(args[i:i + 2])
            i += 2
            continue
        if arg.startswith(("--repo=", "-R")):
            result.append(arg)
        elif arg in switches or arg.partition("=")[0] in value_flags:
            pass
        elif arg.startswith("-"):
            raise Unverified(f"unsupported merge option: {arg}")
        else:
            result.append(arg)
        i += 1
    return result


def _match_head(args: list[str]) -> str | None:
    """--match-head-commit 的值;别的选项的值(如 --body 正文)跳过,不当成选项。"""
    lock, i = None, 0
    while i < len(args):
        arg = args[i]
        if arg in _VALUE_FLAGS:
            if arg == "--match-head-commit" and i + 1 < len(args):
                lock = args[i + 1]
            i += 2
            continue
        if arg.startswith("--match-head-commit="):
            lock = arg.partition("=")[2]
        i += 1
    return lock


def _board_file(cwd: str) -> Path | None:
    """合并时用的看板:NAWABAN_DB,否则 cwd 所在仓库的主树或 cwd 祖先里的看板。
    只做 stat,不起 git 子进程 —— 两次 gh 查询已经占掉 hook 10 秒预算的大半。"""
    env = os.environ.get("NAWABAN_DB")
    if env:
        board = Path(env).expanduser()
        return board if board.is_file() else None
    here = Path(cwd)
    tree = enclosing_tree(here)
    for root in (*((tree[1],) if tree else ()), here, *here.parents):
        if (board := db.board_db(root)).is_file():
            return board
    return None


def _review_gate(cwd: str, url: str, head: str, lock: str | None,
                 timeout: float = 5) -> bool:
    """登记了这个 PR 的卡:最新 review 必须通过、审的就是 PR head,且合并锁定在这个提交。

    没有看板 / 没有未结束的卡登记这个 PR → 不管(只剩 CI 闸),返回 False。看板在但读不了 → 拦。
    返回 True 表示有卡登记了这个 PR,且 review 闸全部通过。
    """
    board = _board_file(cwd)
    if board is None:
        return False
    try:
        con = sqlite3.connect(f"file:{board}?mode=ro", uri=True, timeout=timeout)
        try:
            rows = db.latest_reviews_for_pr(con, url)
        finally:
            con.close()
    except sqlite3.Error as exc:
        raise Unverified(f"看板读不了,无法确认 review 结论:{exc}") from exc
    redo = f"nawaban review <ID> --commit {head} --findings <问题列表.json>"
    for task, sha, passed in rows:
        if sha is None:
            raise Unverified(f"{task} 登记了这个 PR,但卡上没有 review 结论;审完记:{redo}")
        if not passed:
            raise Unverified(f"{task} 最近一次 review(@{sha[:12]})不过;修完重新 review:{redo}")
        if sha != head:
            raise Unverified(f"{task} 审过的是 {sha[:12]},PR head 现在是 {head[:12]}:"
                             f"review 之后又推了新提交,重新 review:{redo}")
    if rows and lock != head:
        raise Unverified("合并没有锁定到审过的提交;运行 gh pr merge <PR> -R <OWNER/REPO> "
                         f"--match-head-commit {head}")
    return bool(rows)


# 这些事件不会在 PR head 提交上产生 checks;别的事件一律当会产生(fail closed)。
_OFF_PR_EVENTS = {"workflow_dispatch", "schedule", "repository_dispatch", "workflow_call",
                  "release", "workflow_run"}
_WORKFLOWS_QUERY = """query($o:String!,$r:String!,$main:String!,$head:String!){repository(owner:$o,name:$r){
main:object(expression:$main){...W} head:object(expression:$head){...W}}}
fragment W on GitObject{... on Tree{entries{name object{... on Blob{text}}}}}"""


# 普通名字,可带一对成对的引号;引号只去这一对,名字里的引号字符过不了这条
_PLAIN_NAME = re.compile(r"""(["']?)([A-Za-z0-9_./-]+)\1""")


def _yaml_items(value: str) -> list[str] | None:
    """`a` 或同一行闭合的 `[a, b]` → 名字列表。跨行、转义、通配等读不准的写法 → None。"""
    value = value.strip()
    if value.startswith("["):
        if not value.endswith("]"):
            return None
        value = value[1:-1]
    names = [_PLAIN_NAME.fullmatch(v.strip()) for v in value.split(",") if v.strip()]
    return [m.group(2) for m in names] if all(names) else None


def _spans_lines(text: str) -> bool:
    """有没有引号串或流式 [..] {..} 跨行。续行可以顶格写成 `on: ...`,逐行读会被它骗。

    ponytail: 块标量正文也按同样规则扫,里面不成对的引号会多拦一次(fail closed)。
    """
    quote, depth = None, 0
    for line in text.splitlines():
        if quote or depth:
            return True
        prev, i = " ", 0
        while i < len(line):
            c = line[i]
            if quote == '"':
                if c == "\\":
                    i += 1
                elif c == '"':
                    quote = None
            elif quote == "'":
                if c == "'" and line[i + 1:i + 2] == "'":
                    i += 1
                elif c == "'":
                    quote = None
            elif c == "#" and prev.isspace():
                break
            elif c in "\"'" and prev in " \t:-[{,":
                quote = c
            elif c in "[{" and prev in " \t:-[{,":
                depth += 1
            elif c in "]}" and depth:
                depth -= 1
            prev, i = c, i + 1
    return bool(quote or depth)


def _runs_on_pr(text: str | None, branch: str) -> bool:
    """这份 workflow 会不会在 PR head 上跑出 checks。读不懂一律算会。

    ponytail: 只认 `on:` 的常见写法,不引 yaml(它是可选依赖);锚点、多文档等写法都按「会」拦。
    """
    if text is None or _spans_lines(text):
        return True
    lines = [line for raw in text.splitlines()
             if (line := re.sub(r"(^|\s)#.*", "", raw).rstrip())]
    if any(line.startswith("---") for line in lines[1:]):  # 多文档:只认第一份不可靠
        return True
    start = next((i for i, line in enumerate(lines)
                  if re.fullmatch(r"""["']?on["']?\s*:.*""", line)), None)
    if start is None:
        return True
    inline = lines[start].partition(":")[2]
    if inline.strip():  # on: push / on: [push, workflow_dispatch]:内联写法没有分支过滤
        events = _yaml_items(inline)
        return events is None or any(e not in _OFF_PR_EVENTS for e in events)
    block = []
    for line in lines[start + 1:]:
        if not line[0].isspace():
            break
        block.append(line)
    if not block:
        return True
    indent = len(block[0]) - len(block[0].lstrip())
    for i, line in enumerate(block):
        if len(line) - len(line.lstrip()) != indent:
            continue
        event, _, rest = line.strip().removeprefix("- ").partition(":")
        event = event.strip().strip("'\"")
        if event in _OFF_PR_EVENTS:
            continue
        if event != "push" or rest.strip():
            return True
        body = []
        for child in block[i + 1:]:
            if (depth := len(child) - len(child.lstrip())) <= indent:
                break
            body.append((depth, child.strip()))
        # 只认 push 的直接子键;更深处(如块标量里)写的 branches: 不算
        branches = next((j for j, (depth, c) in enumerate(body)
                         if depth == body[0][0] and c.startswith("branches:")), None)
        if branches is None:  # 不限分支的 push 也会在 PR 分支上跑
            return True
        patterns = _yaml_items(body[branches][1].partition(":")[2])
        for _, c in body[branches + 1:]:
            if not c.startswith("-") or patterns is None:
                break
            # `-` 后不是空格(如 tab)读不准,当读不懂
            items = _yaml_items(c[2:]) if c.startswith("- ") else None
            patterns = None if items is None else patterns + items
        # 通配和转义过不了 _yaml_items,只剩普通分支名可比
        if not patterns or branch in patterns:
            return True
    return False


def _has_pr_ci(host: str, owner: str, repo: str, base: str, head: str, branch: str, cwd: str,
               account: str | None, env: dict[str, str] | None, deadline: float) -> bool:
    """PR 的 base 分支或 head 上有没有会在 PR 上跑的 workflow(两边都看:PR 可能删掉 base 上的 CI)。"""
    data = _github(["api", "graphql", "--hostname", host, "-f", f"query={_WORKFLOWS_QUERY}",
                    "-f", f"o={owner}", "-f", f"r={repo}", "-f", f"main={base}:.github/workflows",
                    "-f", f"head={head}:.github/workflows"], cwd, account, env, deadline)
    trees = data["data"]["repository"]
    return any(_runs_on_pr(entry["object"] and entry["object"].get("text"), branch)
               for tree in (trees["main"], trees["head"]) if tree
               for entry in tree["entries"] if entry["name"].endswith((".yml", ".yaml")))


# 唯一放行的前缀:这一条合并用指定账号,不切全局 gh 账号;闸用同一账号查询。
_ACCOUNT_PREFIX = re.compile(r"\A[ \t]*GH_TOKEN=\$\(gh auth token --user ([A-Za-z0-9-]+)\)[ \t]+")
_ACCOUNT_HINT = ("这个仓库要用别的 gh 账号的话,单独运行:GH_TOKEN=$(gh auth token --user <账号>) "
                 "gh pr merge <PR> -R <OWNER/REPO> --match-head-commit <SHA>")


# GitHub Actions 认的跳过标记;只认这些,只改 docs 的提交不算(docs 可能被测试读)。
_SKIP_CI = re.compile(r"\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]")
_MIGRATION = re.compile(r"(?:^|/)migrations/")
# hook 超时 10 秒,超时不拦 = 命令照跑;整次判定限 8 秒,留 2 秒给进程启动。每次子调用只用剩余时间。
_BUDGET = 8.0


def _left(deadline: float, cap: float) -> float:
    left = deadline - time.monotonic()
    if left <= 0.05:
        raise Unverified(f"GitHub 查询用完了 hook 时限(总 {_BUDGET:g} 秒),不能确认;稍后重试合并。")
    return min(cap, left)


def _account_env(account: str, deadline: float) -> dict[str, str]:
    try:
        proc = subprocess.run(["gh", "auth", "token", "--user", account],
                              capture_output=True, text=True, timeout=_left(deadline, 2))
    except (OSError, UnicodeError, subprocess.TimeoutExpired) as exc:
        raise Unverified(f"取不到 gh 账号 {account} 的 token:{type(exc).__name__}") from exc
    token = proc.stdout.strip()
    if proc.returncode or not token:
        raise Unverified(f"本机 gh 没有登录账号 {account}(gh auth token --user {account} 失败)")
    return {**os.environ, "GH_TOKEN": token}


def _active_account(deadline: float) -> str:
    try:
        proc = subprocess.run(["gh", "auth", "status", "--active", "--json", "hosts",
                               "--jq", ".hosts[][].login"],
                              capture_output=True, text=True, timeout=_left(deadline, 2))
        login = proc.stdout.split()[0] if not proc.returncode and proc.stdout.split() else ""
    except (OSError, UnicodeError, subprocess.TimeoutExpired, Unverified):
        login = ""
    return f"gh 当前活跃账号 {login}" if login else "gh 当前活跃账号(名字没查到)"


def _github(args: list[str], cwd: str, account: str | None,
            env: dict[str, str] | None, deadline: float) -> dict[str, Any]:
    timeout = _left(deadline, 3)
    try:
        proc = subprocess.run(["gh", *args], cwd=cwd, capture_output=True,
                              text=True, timeout=timeout, env=env)
        failure = None if not proc.returncode else f"failed (exit {proc.returncode})"
    except (OSError, UnicodeError, subprocess.TimeoutExpired) as exc:
        failure = f"unavailable: {type(exc).__name__}"
    if failure:
        # Do not echo CLI stderr: it may include credentials or private URLs.
        who = (f"gh 账号 {account}" if account
               else _active_account(deadline) + "\n" + _ACCOUNT_HINT)
        raise Unverified(f"GitHub query {failure} · 查询用的是 {who}")
    try:
        value = json.loads(proc.stdout)
    except ValueError as exc:
        raise Unverified("GitHub returned invalid JSON") from exc
    if not isinstance(value, dict):
        raise Unverified("GitHub returned an unexpected response")
    return value


class _ShellInput:
    def __init__(self, value: str) -> None:
        self.stream = io.StringIO(value)

    def read(self, size: int = -1) -> str:
        return self.stream.read(size)

    def close(self) -> None:
        self.stream.close()

    def readline(self, size: int = -1) -> str:
        # shlex discards comments using readline; keep the statement separator.
        line = self.stream.readline(size)
        if line.endswith("\n"):
            self.stream.seek(self.stream.tell() - 1)
            return line[:-1]
        return line


_NO_CHECKS = "PR checks 为空，不能证明 CI 已绿；运行 gh pr checks <PR> --watch。"


def judge_merge(command: str, cwd: str, deadline: float | None = None) -> tuple[int, str]:
    deadline = time.monotonic() + _BUDGET if deadline is None else deadline
    body = _strip_heredoc_bodies(command.replace("\\\n", ""))
    account = (m := _ACCOUNT_PREFIX.match(body)) and m.group(1)
    body = body[m.end():] if m else body
    lexer = shlex.shlex(_ShellInput(body), posix=True, punctuation_chars=";&|()\n")
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    parse_failed = False
    try:
        segments: list[list[str]] = [[]]
        for token in lexer:
            if token and all(c in ";&|()\n" for c in token):
                segments.append([])
            else:
                segments[-1].append(token)
    except ValueError:
        # Bash can execute earlier lines before a later line has a syntax error.
        parse_failed = True
    segments = [segment for segment in segments if segment]
    merges = [args for segment in segments if (args := _merge_args(segment)) is not None]
    if not merges:
        return 0, ""
    retry = "请单独运行 gh pr merge <PR> -R <OWNER/REPO>，保持当前 cwd 和环境不变。"
    try:
        if parse_failed or len(segments) != 1:
            raise Unverified(retry)
        prefix = segments[0][:next(i for i, token in enumerate(segments[0])
                                   if Path(token).name == "gh")]
        if any("=" in token or token == "env" for token in prefix):
            raise Unverified(retry)
        args = merges[0]
        if any("$" in arg or "`" in arg for arg in args):
            raise Unverified(retry)
        env = _account_env(account, deadline) if account else None
        pr = _github(_view_args(args) + ["--json", "statusCheckRollup,headRefOid,headRefName,"
                                         "baseRefName,url,changedFiles,title,labels"],
                     cwd, account, env, deadline)
        checks = pr["statusCheckRollup"]
        if not isinstance(checks, list):
            raise Unverified(_NO_CHECKS)
        failed = []
        for check in checks:
            state = check.get("conclusion") if check.get("status") == "COMPLETED" else check.get("state")
            if state not in ("SUCCESS", "SKIPPED"):
                failed.append(f"{check.get('name') or check.get('context') or '?'}: "
                              f"{state or check.get('status') or 'UNKNOWN'}")
        if failed:
            raise Unverified("checks 未全部 success: " + "; ".join(failed)
                             + "\n运行 gh pr checks <PR> --watch；修复失败项后再合并。")
        url = urlsplit(pr["url"])
        parts = url.path.strip("/").split("/")
        head = pr["headRefOid"]
        if len(parts) != 4 or parts[2] != "pull" or not re.fullmatch(r"[0-9a-f]{40}", head):
            raise Unverified("GitHub PR identity is incomplete")
        fix_pr = (str(pr.get("title") or "").startswith("Revert")
                  or any(isinstance(label, dict) and label.get("name") == "main-fix"
                         for label in pr.get("labels") or []))
        if not fix_pr:
            _main_red(url.netloc, parts[0], parts[1], cwd, account, env, deadline)
        # head...main: commits = main 上 PR 没有的提交(PR 落后的那些)。
        compare = _github(["api", "--hostname", url.netloc,
                           f"repos/{parts[0]}/{parts[1]}/compare/{head}...main"],
                          cwd, account, env, deadline)

        def pr_files() -> Any:
            _left(deadline, 3)  # 时限用完就不发这最后一个请求
            # REST 的 files 带改名前的 previous_filename;GraphQL 的没有。一页最多 100 个。
            return _github(["api", "--hostname", url.netloc, "--jq", "{files: .}",
                            f"repos/{parts[0]}/{parts[1]}/pulls/{parts[3]}/files?per_page=100"],
                           cwd, account, env, deadline)["files"]

        note = _behind_note(pr, compare, pr_files)
        reviewed = _review_gate(cwd, pr["url"], head, _match_head(args), _left(deadline, 5))
        # checks 为空:只有仓库根本没有会在 PR 上跑的 workflow、且卡上 review 已过并锁定提交时才放行
        if not checks and not reviewed:
            raise Unverified(_NO_CHECKS + "仓库没有在 PR 上跑的 workflow 时,把 PR 链接登记到卡上"
                             "并 review 通过,合并锁定审过的提交即可。")
        if not checks and _has_pr_ci(url.netloc, parts[0], parts[1], pr["baseRefName"], head,
                                     pr["headRefName"], cwd, account, env, deadline):
            raise Unverified(_NO_CHECKS + "仓库有会在 PR 上跑的 workflow,等它们跑完。")
    except (Unverified, KeyError, TypeError, AttributeError) as exc:
        return 2, f"🚫 merge gate: {exc}\n"
    return 0, note


def _main_red(host: str, owner: str, repo: str, cwd: str, account: str | None,
              env: dict[str, str] | None, deadline: float) -> None:
    """main 上 push 触发的 workflow 有红的 → raise,冻结合并(修复 PR 由调用方放行,不走这里)。"""
    # --event push 在服务端过滤:部署后验证这类 workflow_run 能占满最近 50 条,本地再筛会看不见红。
    data = _github(["run", "list", "-R", f"{host}/{owner}/{repo}", "--branch", "main",
                    "--event", "push", "--limit", "50", "--json",
                    "workflowName,status,conclusion,headSha,url,createdAt,event",
                    "--jq", "{runs: .}"], cwd, account, env, deadline)
    runs = data.get("runs")
    shape = "main CI 查询结果形状不对，不能确认 main 是否红着；稍后重试合并。"
    if not isinstance(runs, list) or not all(isinstance(run, dict) for run in runs):
        raise Unverified(shape)
    try:
        # 只认 push 触发的:定时拨测、部署后验证(workflow_run)、手动触发的失败不冻结合并。
        red = main_ci.red_runs([run for run in runs if run.get("event") == "push"])
    except (KeyError, TypeError, ValueError, AttributeError) as exc:
        raise Unverified(shape) from exc
    if red:
        raise Unverified("main 红着，冻结合并(修复 PR 除外):\n"
                         + "".join(f"  {r['workflow']}: {r['url']}\n" for r in red)
                         + "放行办法：修复 PR 的标题以 Revert 开头，或给它打 main-fix 标签;"
                         "或在 main 上重跑失败的 workflow,转绿后再合并。")


def _behind_note(pr: dict[str, Any], compare: dict[str, Any], pr_files: Callable[[], Any]) -> str:
    """PR 落后 main 时判能否不同步就合：能则返回放行说明，不能则 raise。"""
    behind = compare["commits"]
    if behind == [] and compare["ahead_by"] == 0:
        return ""
    update = (f"运行 gh pr update-branch {shlex.quote(pr['url'])} "
              "或 git fetch origin && git rebase origin/main，然后等待新 CI 全绿。")
    incomplete = "拿不到 main 新增提交或两边改动文件的完整清单，按落后处理；" + update
    main_files = compare["files"]
    # compare 最多回 250 个提交、300 个文件。
    if (not isinstance(compare["ahead_by"], int) or not isinstance(behind, list)
            or len(behind) != compare["ahead_by"]
            or not isinstance(main_files, list) or len(main_files) >= 300):
        raise Unverified(incomplete)
    mine = pr_files()
    if not isinstance(mine, list) or len(mine) != pr["changedFiles"]:
        raise Unverified(incomplete)
    # 两边各加一个迁移文件，名字不同也会撞编号或 alembic head。
    if _adds_migration(main_files) and _adds_migration(mine):
        raise Unverified("PR 和 main 都新增了 migrations 下的文件；" + update)
    # 落后的全是 CI 自己会跳过的提交时，同步后 CI 结论不变。
    if all(_SKIP_CI.search(c["commit"]["message"]) for c in behind):
        return f"merge gate: PR 落后 main 的 {len(behind)} 个提交都带跳过 CI 标记，放行。\n"
    if overlap := sorted(_paths(main_files) & _paths(mine)):
        raise Unverified(f"PR base 落后 main，且 main 新增提交也改了 {', '.join(overlap[:5])}；" + update)
    return (f"merge gate: PR 落后 main {len(behind)} 个提交，但两边改的文件没有重叠，放行；"
            "合并后由 main CI 兜底，main 变红就停线修。\n")


def _paths(files: list[dict[str, Any]]) -> set[str]:
    # 改名的两头都算：一边改名，另一边改旧名的文件，也是同一个文件。
    return {f["filename"] for f in files} | {f["previous_filename"] for f in files if f.get("previous_filename")}


def _adds_migration(files: list[dict[str, Any]]) -> bool:
    # 复制或改名进 migrations/ 的文件，在迁移图里也是新节点。
    return any(f["status"] in ("added", "copied", "renamed") and _MIGRATION.search(f["filename"])
               for f in files)


# Codex 的文件改动走 apply_patch:补丁头里的路径就是写入目标(新增/修改/删除/改名去向)
_PATCH_TARGET = re.compile(r"^[ \t]*\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)\s*$", re.M)  # Codex 先 trim 再认头;+行是正文


def judge(payload: dict, deadline: float | None = None) -> tuple[int, str]:
    """返回 (exit_code, stderr 消息)。0=放行(可带 WARN),2=BLOCK。deadline 见 _BUDGET。"""
    owner = resolve_owner(payload.get("session_id"))
    if not owner:
        return 0, ""  # 非 foreman 会话
    tool_input = payload.get("tool_input") or {}
    target = tool_input.get("file_path")
    if not target and payload.get("tool_name") == "apply_patch":
        base = Path(payload.get("cwd") or os.getcwd())
        for t in _PATCH_TARGET.findall(tool_input.get("command") or ""):
            p = Path(t)  # apply_patch 不展开 ~:~/x 就是 <cwd>/~/x
            code, msg = _judge_target(payload, owner, str(p if p.is_absolute() else base / p))
            if code == 2:
                return code, msg
        return 0, ""
    if not target:
        if payload.get("tool_name") != "Bash":
            return 0, ""
        # Bash 只报 BLOCK,不报 WARN:tripwire 有误报,别拿噪音淹掉真信号;唯一例外是合并闸的放行理由
        base = Path(payload.get("cwd") or os.getcwd())
        code, note = judge_merge(tool_input.get("command") or "", str(base), deadline)
        if code == 2:
            return code, note
        for t in _bash_write_targets(tool_input.get("command") or ""):
            # 相对路径按 payload cwd 落地 —— enclosing_tree 靠 parents 上溯,相对路径走不到树根
            code, msg = _judge_target(payload, owner, str(Path(t).expanduser())
                                      if Path(t).expanduser().is_absolute()
                                      else str(base / t))
            if code == 2:
                return code, msg
        return 0, note
    return _judge_target(payload, owner, target)


def _judge_target(payload: dict, owner: str, target: str) -> tuple[int, str]:
    cwd = Path(payload.get("cwd") or os.getcwd())
    # 树根按**目标文件**认,不按 cwd —— cwd 在 worktree 而 Edit 写主树(反之亦然)都是真实走法。
    tree = enclosing_tree(Path(target))
    tree_root, main_root, in_git = (*tree, True) if tree else (cwd, cwd, False)
    db_path = db.board_db(main_root)
    if not db_path.is_file():
        return 0, ""  # 该仓未切换到新板(见模块 docstring:删库失明残余挂 CUTOVER 清单)
    try:
        target_rel = str(Path(target).resolve().relative_to(tree_root.resolve()))
    except ValueError:
        return 0, ""  # 仓库外文件 · 不管

    # ── worktree 闸:共享主工作区禁止写文件(WORKTREE-GATE-001)──────────────
    # 只在**确认是主 worktree** 时上闸;非 git 目录(含单测夹具)一律不判,保持老行为。
    if (
        in_git
        and tree_root == main_root
        and not target_rel.startswith((".nawaban/", ".foreman/"))
        and not (main_root / ".foreman" / "ALLOW_MAINTREE_EDIT").exists()
    ):
        tool = payload.get("tool_name") or "Edit"
        return 2, (
            f"🚫 worktree gate:{tool} → {target_rel} 在共享主工作区,"
            "其他窗口也在用这棵树,未提交的改动会堵住它们的 git pull\n"
            "   在本卡 worktree 里改:git worktree add .claude/worktrees/<短名> -b <分支名>\n"
            + ("   已经在 worktree 里?这道闸不跟命令里的 cd,相对路径一律按会话目录算:"
               "把写入目标换成 worktree 内的绝对路径\n" if tool == "Bash" else "")
            + "   确需写主树:touch .foreman/ALLOW_MAINTREE_EDIT(用完删掉)\n"
        )

    return 0, ""  # touches 锁退役(foreman simplify regression):占用只在 claim 时 WARN



def main() -> int:
    deadline = time.monotonic() + _BUDGET  # 从进程入口算,resolve_owner 的 tmux 调用也算在内
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    code, msg = judge(payload, deadline)
    if code == 0 and msg and payload.get("tool_name") == "Bash":
        # 放行的合并要让 agent 看见理由；exit 0 的 stderr 只进日志。
        json.dump({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                          "additionalContext": msg}}, sys.stdout)
    elif msg:
        sys.stderr.write(msg)
    return code


if __name__ == "__main__":
    sys.exit(main())
