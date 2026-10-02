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
SUCCESS and a head containing remote main, even without a board. No identity is
still a no-op; failed queries and empty checks deny. Queries are read-only;
compound commands must be split. Scripts/eval/API merges and direct pushes are
outside coverage. Post-preflight races still require server-side protection.

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
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from nawaban.owner_identity import owner_from_session  # noqa: E402
from nawaban import db  # noqa: E402

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


def _view_args(args: list[str]) -> list[str]:
    result = ["pr", "view"]
    value_flags = {"-A", "--author-email", "-b", "--body", "-F", "--body-file",
                   "--match-head-commit", "-t", "--subject"}
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


def _github(args: list[str], cwd: str) -> dict[str, Any]:
    # Two requests of at most three seconds fit the installed ten-second hook.
    try:
        proc = subprocess.run(["gh", *args], cwd=cwd, capture_output=True,
                              text=True, timeout=3)
    except (OSError, UnicodeError, subprocess.TimeoutExpired) as exc:
        raise Unverified(f"GitHub query unavailable: {type(exc).__name__}") from exc
    if proc.returncode:
        # Do not echo CLI stderr: it may include credentials or private URLs.
        raise Unverified(f"GitHub query failed (exit {proc.returncode})")
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


def judge_merge(command: str, cwd: str) -> tuple[int, str]:
    body = _strip_heredoc_bodies(command.replace("\\\n", ""))
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
        pr = _github(_view_args(args) + ["--json", "statusCheckRollup,headRefOid,url"], cwd)
        checks = pr["statusCheckRollup"]
        if not isinstance(checks, list) or not checks:
            raise Unverified("PR checks 为空，不能证明 CI 已绿；运行 gh pr checks <PR> --watch。")
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
        compare = _github(["api", "--hostname", url.netloc,
                           f"repos/{parts[0]}/{parts[1]}/compare/main...{head}"], cwd)
        main = compare["base_commit"]["sha"]
        if not main or compare["merge_base_commit"]["sha"] != main:
            raise Unverified("PR base 落后 main；运行 "
                             f"gh pr update-branch {shlex.quote(pr['url'])} "
                             "或 git fetch origin && git rebase origin/main，然后等待新 CI 全绿。")
    except (Unverified, KeyError, TypeError, AttributeError) as exc:
        return 2, f"🚫 merge gate: {exc}\n"
    return 0, ""


# Codex 的文件改动走 apply_patch:补丁头里的路径就是写入目标(新增/修改/删除/改名去向)
_PATCH_TARGET = re.compile(r"^[ \t]*\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+?)\s*$", re.M)  # Codex 先 trim 再认头;+行是正文


def judge(payload: dict) -> tuple[int, str]:
    """返回 (exit_code, stderr 消息)。0=放行(可带 WARN),2=BLOCK。"""
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
        # Bash 只报 BLOCK,不报 WARN:tripwire 有误报,别拿噪音淹掉真信号
        base = Path(payload.get("cwd") or os.getcwd())
        code, msg = judge_merge(tool_input.get("command") or "", str(base))
        if code == 2:
            return code, msg
        for t in _bash_write_targets(tool_input.get("command") or ""):
            # 相对路径按 payload cwd 落地 —— enclosing_tree 靠 parents 上溯,相对路径走不到树根
            code, msg = _judge_target(payload, owner, str(Path(t).expanduser())
                                      if Path(t).expanduser().is_absolute()
                                      else str(base / t))
            if code == 2:
                return code, msg
        return 0, ""
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
            "🚫 worktree gate:共享主工作区禁止写文件\n"
            f"   拦下:{tool} → {target_rel}\n"
            "   主树 cwd 是所有窗口共用的。写在这里的改动:\n"
            "     · 别的窗口 git pull 会被它堵死\n"
            "     · 没人知道它是谁的活,最后只能进 stash 堆\n"
            "     (2026-08-20 实测:主树积了 220 个文件 + 36 个 stash)\n"
            "   ✅ 开 worktree(隔离的,里面随便写):\n"
            "      git worktree add .claude/worktrees/<短名> -b <分支名>\n"
            "      之后用绝对路径 Edit 那棵树里的文件\n"
            "   真要写主树(极罕):touch .foreman/ALLOW_MAINTREE_EDIT(用完删掉)\n"
        )

    return 0, ""  # touches 锁退役(foreman simplify regression):占用只在 claim 时 WARN



def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    code, msg = judge(payload)
    if msg:
        sys.stderr.write(msg)
    return code


if __name__ == "__main__":
    sys.exit(main())
