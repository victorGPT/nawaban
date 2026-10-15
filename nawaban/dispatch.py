"""Dispatch one card to one independent worker session, and tear that session down.

dispatch 只起会话并把会话编号写到卡的当前进展;认领由 worker 进场后自己做,
这样 task_sessions 记的是 worker 的会话。派发记录是一条 coord 事件(正文 JSON),
dismiss 凭它找回会话、窗格和工位。

在 Herdr 里派出的 worker 各占一个 tab,另有一个脱离派单命令的进程守着它的窗格
(`python3 -m nawaban.dispatch watch <db> <卡号>`):窗格在卡做完之前被关掉,
就在卡上记一笔,并以 worker 的名义写一封 turn 信,主控停着等信时会被叫醒。
"""

from __future__ import annotations

import json
import os
import socket
import sqlite3
import subprocess
import sys
import time
from contextlib import closing
from pathlib import Path

from nawaban import db

RUN = subprocess.run  # 测试在这里换成替身,不真起会话
SPAWN = subprocess.Popen  # 起关窗监听进程;测试同样换掉
CLI = Path(__file__).resolve().parent / "cli.py"
_RECORD = "dispatch "
_FINISHED = ("staging-verified", "done", "cancelled")
MAX_WORKERS = 4  # 同时运行的 worker 上限;环境变量 NAWABAN_MAX_WORKERS 可改
# 主控窗格的身份。herdr 命令省略目标时会落到调用者的窗格上,所以一律不传下去,目标都写明。
_CALLER = ("HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_SESSION")
_STARTED = ("--until", "working", "--until", "blocked")
_SOCKET = os.path.expanduser(os.environ.get("HERDR_SOCKET_PATH", "~/.config/herdr/herdr.sock"))


def _herdr_env() -> dict[str, str]:
    return {k: v for k, v in os.environ.items() if k not in _CALLER}


def _run(*cmd: str, cwd: Path | None = None) -> subprocess.CompletedProcess:
    env = _herdr_env() if cmd[0] == "herdr" else None
    try:
        return RUN(list(cmd), cwd=cwd, env=env, capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.SubprocessError) as exc:
        return subprocess.CompletedProcess(list(cmd), 127, "", str(exc))


def _connect(path: Path) -> sqlite3.Connection:
    con = db.connect(path)
    con.row_factory = sqlite3.Row
    return con


def _row(con: sqlite3.Connection, task_id: str) -> sqlite3.Row:
    row = con.execute("SELECT id,status,owner,project FROM tasks WHERE id=?",
                      (task_id,)).fetchone()
    if row is None:
        raise db.NawabanError(f"卡不存在:{task_id}")
    return row


def _blocker(con: sqlite3.Connection, row: sqlite3.Row) -> str | None:
    """为什么这张卡现在不能派;能派返回 None。前置卡判定与 claim 上游闸同一口径。"""
    if row["status"] in ("claimed", "in_progress"):
        return f"已被 {row['owner']} 认领"
    if row["status"] != "open":
        return f"不是待办状态(当前 {row['status']})"
    upstream = con.execute(
        "SELECT e.dst, t.status FROM task_edges e JOIN tasks t ON t.id=e.dst"
        " WHERE e.src=? AND e.kind='depends_on' AND t.status NOT IN ('done','cancelled')"
        " ORDER BY e.dst", (row["id"],)).fetchall()
    if upstream:
        return "前置卡未完成:" + "、".join(f"{u[0]}({u[1]})" for u in upstream)
    return None


def _repo_root() -> Path:
    found = _run("git", "rev-parse", "--path-format=absolute", "--git-common-dir")
    if found.returncode:
        raise db.NawabanError("派发要在目标仓库里执行:当前目录不是 git 仓库")
    return Path(found.stdout.strip()).parent


def _agents() -> list[dict] | None:
    """活着的会话;查不了(命令失败、没有输出、不是 JSON 列表)返回 None。"""
    got = _run("claude", "agents", "--json")
    try:
        listed = json.loads(got.stdout)
    except ValueError:
        return None
    return listed if not got.returncode and isinstance(listed, list) else None


def _session(name: str, *, tries: int = 1) -> dict | None:
    """按名字在活着的会话里找;刚起的会话登记有延迟,所以可以多看几次。"""
    for attempt in range(tries):
        if attempt:
            time.sleep(1)
        for entry in _agents() or []:
            if entry.get("name") == name:
                return entry
    return None


def _full(con: sqlite3.Connection, coming: int = 0) -> str | None:
    """同时运行的 worker 加上 coming 张马上要派的到了上限,就说出占着名额的卡;没到返回 None。

    运行中 = 派发了还没收工、会话还活着。没收工但会话已经没了的不算,
    否则一个没人收拾的旧派发会永远占着名额。整个任务库共用一个上限:占的是同一台机器。
    ponytail: 查名额和起会话之间没上锁,两条 dispatch 同时跑能各派一个、超出一个;
    主控是一条一条派的,真有多个主控同时派再加文件锁。
    """
    limit = int(os.environ.get("NAWABAN_MAX_WORKERS") or MAX_WORKERS)
    agents = _agents()
    if agents is None:
        # 查不到就不知道在跑几个:按满了算,不能因为查询失败把上限放开。
        return f"查不到哪些 worker 还活着(claude agents --json 没给出会话列表),按上限 {limit} 个已满处理"
    live = {entry.get("name") for entry in agents if isinstance(entry, dict)}
    running = [task_id for (task_id,) in con.execute(
        "SELECT task_id FROM task_events WHERE id IN ("
        " SELECT MAX(id) FROM task_events WHERE kind='coord'"
        " AND (body LIKE 'dispatch {%' OR body LIKE 'dismiss ·%') GROUP BY task_id)"
        " AND body LIKE 'dispatch {%' ORDER BY id") if task_id.lower() in live]
    if len(running) + coming < limit:
        return None
    return (f"同时运行的 worker 已到上限 {limit} 个(在跑:{'、'.join(running) or '无'}"
            + (f";本批先派的 {coming} 张" if coming else "") + "),收工一张再派")


def _trusted(root: Path) -> bool:
    """只用来决定走不走 Herdr:没信任的目录在窗格里会停在信任提示上。

    读不到就当没信任,改走后台会话;拒绝与否由 `claude --bg` 自己说了算。
    """
    try:
        projects = json.loads((Path.home() / ".claude.json").read_text(encoding="utf-8"))["projects"]
        return bool(projects[str(root)]["hasTrustDialogAccepted"])
    except (OSError, ValueError, KeyError, TypeError):
        return False


def _session_args(name: str) -> list[str]:
    return ["-w", name, "--name", name, "--permission-mode", "auto"]


def _herdr(root: Path, name: str, prompt: str) -> tuple[str, str] | None:
    """在主控所在工作区新开一个 tab 起 worker,返回 (窗格号, tab 号);任何一步失败都关掉 tab 并返回 None。

    一个 worker 一个 tab:在主控窗格上一次次对半切,切到第五六个窗格只剩几行高,
    herdr 认不出里面 agent 的状态,交给它的任务说明也会丢回车(herdr 0.9.4 实测)。
    """
    workspace = os.environ.get("HERDR_WORKSPACE_ID")
    made = _run("herdr", "tab", "create", *(("--workspace", workspace) if workspace else ()),
                "--cwd", str(root), "--label", name, "--no-focus")
    try:
        result = json.loads(made.stdout)["result"]
        pane, tab = result["root_pane"]["pane_id"], result["tab"]["tab_id"]
    except (ValueError, KeyError, TypeError):
        return None
    if made.returncode:
        return None
    started = _run("herdr", "agent", "start", name, "--kind", "claude", "--pane", pane,
                   "--", *_session_args(name))
    if started.returncode or not _submit(pane, prompt):
        _run("herdr", "tab", "close", tab)
        return None
    return pane, tab


def _error(done: subprocess.CompletedProcess) -> str:
    try:
        return json.loads(done.stdout or done.stderr)["error"]["code"]
    except (ValueError, KeyError, TypeError):
        return ""


def _submit(pane: str, prompt: str) -> bool:
    """交任务说明,看到 worker 开工才算交上。

    herdr 0.9.4 实测:文字进了输入框、回车丢了的事会发生,补按一下回车就开工。
    只补回车,文字绝不重打,否则输入框里是两份。机器忙时 herdr 看到开工慢,
    会误报没开工;这时多补的回车落在空输入框上,claude 不理会。
    agent_blocked 这类别的错误不补:回车会替 worker 答掉眼前的确认框。
    """
    sent = _run("herdr", "agent", "prompt", pane, prompt, "--wait", *_STARTED,
                "--timeout", "15000")
    for _ in range(3):
        if not sent.returncode or _error(sent) not in ("agent_prompt_stalled", "timeout"):
            break
        _run("herdr", "agent", "send-keys", pane, "enter")
        sent = _run("herdr", "agent", "wait", pane, *_STARTED, "--timeout", "5000")
    return not sent.returncode


def prompt(path: Path, task_id: str, msg: str, *, author: str) -> str:
    """把话直接交到 Herdr worker 的窗格,和交任务说明一样确认开工、只补回车。返回窗格号。

    给不是派它的会话用(主控窗口重开过):派它的会话回话走 notify --kind reply,
    那条由 worker 的 Stop 钩子送进去;两条都走,worker 就收到两遍。
    """
    with closing(_connect(path)) as con:
        event = _dispatched(con, task_id)
        live = event is not None and _current(con, task_id) == event["id"]
    if not live:
        raise db.NawabanError(f"不回话 {task_id}:卡上没有还作数的派发")
    record = json.loads(event["body"][len(_RECORD):])
    if record.get("backend") != "herdr" or not record.get("pane"):
        raise db.NawabanError(
            f"不回话 {task_id}:它是后台会话,不在 Herdr 窗格里;照 nawaban-director 技能用 claude --bg --resume 回话")
    if not _submit(record["pane"], msg):
        raise db.NawabanError(
            f"回话没交上 {task_id}:窗格 {record['pane']} 里的 worker 没开工"
            "(停在确认框上、窗格已关,或补了三次回车仍没动),去窗格看一眼")
    db.add_event(path, task_id, kind="coord", author=author, body="prompt · " + msg)
    return record["pane"]


def brief(path: Path, task_id: str, name: str) -> str:
    from nawaban import context_loader  # 它依赖 web 模块;CLI 其余动词没有 web 也要能跑
    nawaban = f"python3 {CLI} --db {path}"
    return f"""你是被派出的 worker,只做一张卡:{task_id}。
开工:先加载 nawaban:nawaban 技能,按它认领这张卡再 start。任务库是 {path},命令写成 {nawaban} <动词>。
你所在的目录已经是这张卡的独立工位(分支 worktree-{name}),直接在这里改;不要再建工位,不要改主树。
范围:只做这张卡的验收条目。不建新卡,不起别的 worker,不动别的卡,不合并 PR。卡的约束写了 PR 目标分支时,开 PR 前先把最新 main 和它的最新提交都合进本分支,PR 指向它。
没有人坐在这个窗口前,不要在这里等人回话。你每一轮停下时,最后一段话会自动送回派你的主控;主控的回话会直接出现在这个会话里,收到后接着干。所以停下前把结论、要主控决定的问题和你的建议写在最后一段话里。
实现选型、命名、测试写法自己定。要等人回答才能往下做,必须先用 {nawaban} notify {task_id} --kind blocked --msg "问题和你的建议" 报阻塞(要用户拍板的用 ask)再停下;没报阻塞就停下,一律当你交付了,主控会来 review 你的产出。做完用 notify --kind done 汇报,附 PR 链接和测试结果。
{_upstream(path, task_id)}
{context_loader.build_context(path, task_id)}"""


def _upstream(path: Path, task_id: str) -> str:
    """前置卡的产出:最近一份完成报告、PR、合并提交。没有前置卡返回空串。"""
    with closing(_connect(path)) as con:
        rows = con.execute(
            "SELECT t.id,t.status,t.title FROM task_edges e JOIN tasks t ON t.id=e.dst"
            " WHERE e.src=? AND e.kind='depends_on' ORDER BY t.id", (task_id,)).fetchall()
        parts = []
        for row in rows:
            done = con.execute("SELECT msg FROM letters WHERE task_id=? AND kind='done'"
                               " ORDER BY id DESC LIMIT 1", (row["id"],)).fetchone()
            refs = {kind: "、".join(v for (v,) in con.execute(
                "SELECT value FROM task_refs WHERE task_id=? AND kind=? ORDER BY created_at",
                (row["id"], kind))) or "(没有)" for kind in ("pr", "merge_sha")}
            report = done["msg"] if done else "(没有)"
            if len(report) > 800:
                report = report[:800] + f"…(全文:notifications --task {row['id']})"
            parts.append(f"· [{row['id']}] {row['title']} «{row['status']}»\n"
                         f"  完成报告:{report}\n"
                         f"  PR:{refs['pr']} · 合并提交:{refs['merge_sha']}")
    if not parts:
        return ""
    return "\n前置卡的产出(在它们的基础上做,别重做):\n" + "\n".join(parts) + "\n"


def dispatch(path: Path, task_id: str, *, author: str) -> str:
    """为一张待办卡起一个 worker 会话;不能派就抛出一句原因。返回会话编号。"""
    with closing(_connect(path)) as con:
        row = _row(con, task_id)
        reason = _blocker(con, row)
    if reason:
        raise db.NawabanError(f"不派 {task_id}:{reason}")
    root = _repo_root()
    if row["project"] and row["project"] != root.name:
        raise db.NawabanError(
            f"不派 {task_id}:它属于项目 {row['project']},当前仓库是 {root.name}")
    name = task_id.lower()
    if _session(name):
        raise db.NawabanError(f"不派 {task_id}:已经有一个叫 {name} 的会话在跑")
    with closing(_connect(path)) as con:
        full = _full(con)
        # 起会话之前的 ask 编号:worker 第一轮提没提 ask 按它判(hooks/worker_report.py)。
        asks = con.execute("SELECT COALESCE(MAX(id), 0) FROM asks").fetchone()[0]
    if full:
        # 没有自动出队:收工腾出名额后由主控再派,卡上记下为什么还没派。
        db.add_event(path, task_id, kind="coord", author=author, body="queued · " + full,
                     now=f"排队等派发:{full}"[:200])
        raise db.NawabanError(f"排队 {task_id}:{full}")
    prompt = brief(path, task_id, name)

    pane, tab, output = None, None, ""
    if os.environ.get("HERDR_ENV") == "1" and _trusted(root):
        pane, tab = _herdr(root, name, prompt) or (None, None)
        if pane is None and _session(name):
            # tab 没关掉、里面的会话还活着:再起后台会话就是两个 worker 做同一张卡。
            raise db.NawabanError(
                f"不派 {task_id}:Herdr 里的会话 {name} 起了一半没能关掉,请先手工关掉那个 tab")
    if pane is None:
        started = _run("claude", "--bg", *_session_args(name), prompt, cwd=root)
        if started.returncode:
            detail = (started.stderr or started.stdout).strip().splitlines()
            raise db.NawabanError(
                f"不派 {task_id}:会话没起来 —— {detail[0] if detail else '没有输出'}")
        output = started.stdout.strip()

    live = _session(name, tries=5) or {}
    session = live.get("sessionId") or "未查到"
    worktree = live.get("cwd") or str(root / ".claude" / "worktrees" / name)
    # director = 派它的会话:worker 每轮停下的话凭它送回来(hooks/worker_report.py)。
    record = {"backend": "herdr" if pane else "claude-bg", "session": live.get("sessionId"),
              "pane": pane, "tab": tab, "worktree": worktree, "root": str(root),
              "director": os.environ.get("CLAUDE_CODE_SESSION_ID"), "asks": asks}
    where = f"tab {tab} 窗格 {pane}" if pane else "后台"
    try:
        db.add_event(path, task_id, kind="coord", author=author,
                     body=_RECORD + json.dumps(record, ensure_ascii=False),
                     now=f"已派发({where})· 会话 {session} · 工位 {Path(worktree).name}"[:200])
    except (sqlite3.Error, db.NawabanError) as exc:
        # 记不进卡的 worker 没人能找到、没人能收工,所以停掉它。
        _stop(record)
        raise db.NawabanError(f"不派 {task_id}:会话起了但记不进卡,已停掉 —— {exc}") from exc
    if pane:
        with closing(_connect(path)) as con:
            _spawn_watch(path, task_id, _dispatched(con, task_id)["id"])
    if not record["session"]:
        raise db.NawabanError(
            f"{task_id} 的会话已经起了,但没查到它的编号;用 claude agents 确认后手工处理"
            + (f"(启动输出:{output[:200]})" if output else ""))
    return session


def _spawn_watch(path: Path, task_id: str, event_id: int) -> None:
    # 脱离派单命令的进程组:派单命令结束、主控会话关掉,它都还守着。
    # 它的工作目录是插件根,相对的 --db 到那里就指错了库。
    # 带上派发事件号:它只管这一次派发,起得晚了也不会去盯同一张卡后来派的 worker。
    SPAWN([sys.executable, "-m", "nawaban.dispatch", "watch", str(Path(path).resolve()), task_id,
           str(event_id)],
          cwd=CLI.parent.parent, env=_herdr_env(), start_new_session=True,
          stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _stop(record: dict) -> subprocess.CompletedProcess | None:
    if record.get("tab"):
        return _run("herdr", "tab", "close", record["tab"])
    if record["pane"]:
        return _run("herdr", "pane", "close", record["pane"])
    if record["session"]:
        return _run("claude", "stop", record["session"][:8])
    return None


def batch(path: Path, parent: str, *, author: str, dry_run: bool) -> list[str]:
    """按拆卡关系列出父卡的每张子卡:派出的、会派出的、因为什么不派的。"""
    with closing(_connect(path)) as con:
        _row(con, parent)
        children = [(row, _blocker(con, row)) for row in con.execute(
            "SELECT t.id,t.status,t.owner,t.project FROM task_edges e JOIN tasks t ON t.id=e.src"
            " WHERE e.dst=? AND e.kind='split_from' ORDER BY t.id", (parent,))]
    if not children:
        return [f"{parent} 没有拆出的子卡"]
    lines, coming = [], 0
    for row, reason in children:
        head = f"{row['id']} [{row['status']}] "
        if reason:
            lines.append(head + f"不派:{reason}")
        elif dry_run:
            with closing(_connect(path)) as con:
                full = _full(con, coming)
            lines.append(head + (f"会排队:{full}" if full else "会派出"))
            coming += not full
        else:
            try:
                lines.append(head + f"已派出 · 会话 {dispatch(path, row['id'], author=author)}")
            except db.NawabanError as exc:
                lines.append(head + str(exc))
    return lines


def dismiss(path: Path, task_id: str, *, author: str) -> list[str]:
    """收工:停会话或关窗格,工位干净才清理。返回逐项结果。"""
    with closing(_connect(path)) as con:
        row = _row(con, task_id)
        event = _dispatched(con, task_id)
        record = json.loads(event["body"][len(_RECORD):]) if event else {}
        settled = _settled(con, row, record)
    if not settled:
        raise db.NawabanError(
            f"不收工 {task_id}:卡还没完成也没交接(当前 {row['status']})")
    if event is None:
        raise db.NawabanError(f"不收工 {task_id}:卡上没有派发记录,不知道该关哪个会话")

    stopped = _stop(record)
    if stopped is None:
        raise db.NawabanError(f"不收工 {task_id}:派发记录里没有会话编号,请手工停掉会话")
    if stopped.returncode and _session(task_id.lower()):
        raise db.NawabanError(
            f"收工 {task_id} 失败:会话没停掉,工位未动 —— {(stopped.stderr or stopped.stdout).strip()}")
    what = f"窗格 {record['pane']}" if record["pane"] else f"会话 {record['session']}"
    lines = [what + (" 已经不在" if stopped.returncode else " 已关" if record["pane"] else " 已停")]

    worktree = Path(record["worktree"])
    if not worktree.is_dir():
        lines.append("工位已不存在")
    elif keep := _unsaved(worktree):
        lines.append(f"工位没清理:{keep} → {worktree}")
    else:
        git = ("git", "-C", record["root"])
        # 会话给自己的工位上了锁,停掉后锁还在;上面已确认会话停了、工位里没有会丢的东西。
        _run(*git, "worktree", "unlock", str(worktree))
        removed = _run(*git, "worktree", "remove", str(worktree))
        if not removed.returncode:
            # -d 只删已并入当前分支的分支,带着没合并提交的分支会留下。
            _run(*git, "branch", "-d", f"worktree-{task_id.lower()}")
        lines.append(f"工位没清理:{removed.stderr.strip()}" if removed.returncode
                     else f"工位已清理 {worktree}")
    db.add_event(path, task_id, kind="coord", author=author, body="dismiss · " + " · ".join(lines))
    return lines


def _settled(con: sqlite3.Connection, row: sqlite3.Row, record: dict) -> bool:
    """卡做完了,或这次派发的 worker 交接了:这时关掉 worker 是收工,不是出事。

    只看这次派发的会话:上一个 worker 交接后重派,新 worker 还没认领时它的窗格被关,照样要报。
    """
    leg = con.execute(
        "SELECT ended_at,outcome FROM task_sessions WHERE task_id=? AND session_id=?"
        " ORDER BY started_at DESC, rowid DESC LIMIT 1",
        (row["id"], record.get("session") or "")).fetchone()
    handed = bool(leg and leg["ended_at"] and leg["outcome"] in ("completed", "handed_off"))
    return row["status"] in _FINISHED or handed


def _dispatched(con: sqlite3.Connection, task_id: str) -> sqlite3.Row | None:
    return con.execute(
        "SELECT id,body,author,created_at FROM task_events WHERE task_id=? AND kind='coord'"
        " AND body LIKE ? ORDER BY id DESC LIMIT 1", (task_id, _RECORD + "{%")).fetchone()


def _current(con: sqlite3.Connection, task_id: str) -> int | None:
    """卡上还作数的那次派发的事件号;最近一条是收工记录就是 None(与 hooks/worker_report.py 同口径)。"""
    got = con.execute(
        "SELECT id, body LIKE 'dispatch {%' FROM task_events WHERE task_id=? AND kind='coord'"
        " AND (body LIKE 'dispatch {%' OR body LIKE 'dismiss ·%') ORDER BY id DESC LIMIT 1",
        (task_id,)).fetchone()
    return got[0] if got and got[1] else None


def _alive(pane: str) -> bool:
    """herdr 明说没这个窗格、或者整个 herdr 没在跑,才算没了;超时之类查不准的当它还在。"""
    got = _run("herdr", "pane", "get", pane)
    return not got.returncode or _error(got) not in ("pane_not_found", "server_not_running")


def _listen(pane: str) -> None:
    """订阅关闭事件,直到窗格没了或连接断了。关窗格、关 tab、关工作区各发各的事件,
    所以每来一个都回头查一次窗格,不看事件名。"""
    subscribe = {"id": "nawaban-watch", "method": "events.subscribe", "params": {"subscriptions": [
        {"type": "pane.closed"}, {"type": "tab.closed"}, {"type": "workspace.closed"}]}}
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.connect(_SOCKET)
            with sock.makefile("rw", encoding="utf-8") as stream:
                stream.write(json.dumps(subscribe) + "\n")
                stream.flush()
                stream.readline()  # 订阅确认;订上之前就关掉的窗格由下一句的 _alive 兜住
                while _alive(pane) and stream.readline():
                    pass
    except OSError:
        pass


def _wait_closed(pane: str) -> None:
    """等到窗格不在了才返回。"""
    # ponytail: herdr 一直报别的错时这里每 5 秒查一次、不会自己退出;真碰上再加次数上限。
    while True:
        while _alive(pane):
            _listen(pane)
            if _alive(pane):
                time.sleep(5)  # 连接断了而窗格还在:过一会儿重新订阅
        time.sleep(2)  # herdr 重启的间隙也会报没在跑:隔一会儿再看一次才算数
        if not _alive(pane):
            return


def watch(path: Path, task_id: str, event_id: int) -> None:
    """守着一次派发的窗格;它在卡做完或交接之前没了,就在卡上记一笔并告诉主控。

    只对这一次派发负责:它已被收工或被新的派发替换,就什么都不写。
    """
    with closing(_connect(path)) as con:
        event = con.execute("SELECT id,body,author,created_at FROM task_events WHERE id=?"
                            " AND task_id=? AND body LIKE ?",
                            (event_id, task_id, _RECORD + "{%")).fetchone()
        if event is None or _current(con, task_id) != event_id:
            return
    record = json.loads(event["body"][len(_RECORD):])
    _wait_closed(record["pane"])
    with closing(_connect(path)) as con:
        if _current(con, task_id) != event_id or _settled(con, _row(con, task_id), record):
            return
        # 主控只收派发之后那一秒起的信(hooks/worker_report.py),同一秒里关掉的窗格等到下一秒再写。
        while db._now() <= event["created_at"]:
            time.sleep(0.2)
        # 上面那次只是读;作数的复核和写入在同一把写锁里。dismiss、改派走 add_event 也要这把锁,
        # 插不进两步之间,旧窗格的告警就盖不掉新 worker 的当前进展。
        with db._txn(con):
            row = _row(con, task_id)
            if _current(con, task_id) != event_id or _settled(con, row, record):
                return
            msg = (f"worker 的窗格 {record['pane']} 被关掉了,会话 {(record.get('session') or '未知')[:8]}"
                   f" 已经不在;卡还是 {row['status']},没做完也没交接。工位 {record['worktree']} 原样留着。"
                   "要接着做,先把卡交回待办再重新派发,或者有人进工位接手。")
            db._event(con, task_id, "coord", "pane closed · " + msg, event["author"], None)
            con.execute("UPDATE tasks SET now=? WHERE id=?",
                        (f"worker 窗格 {record['pane']} 被关,卡没做完", task_id))
            if record.get("session"):
                # 以 worker 的名义写 turn 信:主控停着等的正是这种信。
                con.execute("INSERT INTO letters (task_id, kind, msg, session_id, created_at)"
                            " VALUES (?,'turn',?,?,?)", (task_id, msg, record["session"], db._now()))


def _unsaved(worktree: Path) -> str | None:
    """工位里还有会丢的东西就说出是什么;查不了也当有。"""
    status = _run("git", "-C", str(worktree), "status", "--porcelain")
    ahead = _run("git", "-C", str(worktree), "log", "--oneline", "HEAD", "--not", "--remotes")
    if status.returncode or ahead.returncode:
        return "查不了工位状态"
    if status.stdout.strip():
        return "还有没提交的改动"
    if ahead.stdout.strip():
        return "还有没推送的提交"
    return None


if __name__ == "__main__":
    # dispatch 起的关窗监听:python3 -m nawaban.dispatch watch <db> <卡号> <派发事件号>
    _, verb, db_path, card, event_id = sys.argv
    if verb == "watch":
        watch(Path(db_path), card, int(event_id))
