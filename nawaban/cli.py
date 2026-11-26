#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import re
import shlex
import sqlite3
import subprocess
import sys
import time
from collections import Counter
from contextlib import closing
from decimal import Decimal
from pathlib import Path

VERSION = 4
VERSIONS_MIGRATED_ON_OPEN = (1, 2, 3)
OKR_SCHEMA = """
CREATE TABLE IF NOT EXISTS kr_readings (
    repo        TEXT NOT NULL,
    kr          TEXT NOT NULL,
    value       TEXT NOT NULL,
    as_of       TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT '',
    measured_at TEXT NOT NULL,
    def_hash    TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS okr_accepts (
    repo        TEXT NOT NULL,
    objective   TEXT NOT NULL,
    accepted_at TEXT NOT NULL
);
"""
IMPACT_SCHEMA = """
CREATE TABLE IF NOT EXISTS kr_impacts (
    repo        TEXT NOT NULL,
    ticket      TEXT NOT NULL,
    objective   TEXT NOT NULL,
    kr          TEXT NOT NULL DEFAULT '',
    dir         TEXT NOT NULL CHECK (dir IN ('↑','↓','=')),
    before      TEXT,
    after       TEXT,
    basis       TEXT CHECK (basis IN ('实测','预计')),
    declared_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kr_impacts ON kr_impacts(repo, ticket);
"""
TABLES_ADDED_SINCE_VERSION_1_IDEMPOTENT = OKR_SCHEMA + IMPACT_SCHEMA
SCHEMA = OKR_SCHEMA + IMPACT_SCHEMA + """
CREATE TABLE tasks (
    id         TEXT PRIMARY KEY,
    project    TEXT,
    parent     TEXT REFERENCES tasks(id),
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
    session    TEXT,
    created_at INTEGER NOT NULL
);
CREATE TABLE blockers (
    task    TEXT NOT NULL REFERENCES tasks(id),
    blocker TEXT NOT NULL REFERENCES tasks(id),
    PRIMARY KEY (task, blocker)
);
CREATE TABLE events (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    task   TEXT NOT NULL REFERENCES tasks(id),
    at     INTEGER NOT NULL,
    author TEXT NOT NULL,
    kind   TEXT NOT NULL CHECK (kind IN ('note','status','decision','link')),
    body   TEXT NOT NULL
);
CREATE INDEX idx_tasks_parent ON tasks(parent);
CREATE INDEX idx_blockers_blocker ON blockers(blocker);
CREATE INDEX idx_events_task ON events(task, id);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
"""



GIT_TIMEOUT_SECONDS = 5
BOARD_WRITE_LOCK_WAIT_SECONDS = 30
BOARD_READ_LOCK_WAIT_SECONDS = 10
DAY_SECONDS = 24 * 3600
BACKUP_KEEP_DAYS = 14


class Refused(Exception):
    pass


def _repo_root(cur: Path) -> Path | None:
    try:
        r = subprocess.run(["git", "-C", str(cur), "rev-parse", "--git-common-dir"],
                           capture_output=True, text=True, timeout=GIT_TIMEOUT_SECONDS)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    return (cur / r.stdout.strip()).resolve().parent


def _main_checkout_then_cwd_and_ancestors(cwd: Path | None = None) -> list[Path]:
    cur = (cwd or Path.cwd()).resolve()
    repo = _repo_root(cur)
    return [*([repo] if repo else []), cur, *cur.parents]


def _board_root() -> Path | None:
    return next((r for r in _main_checkout_then_cwd_and_ancestors() if (r / ".nawaban").is_dir()), None)


def resolve_db(arg: str | None) -> Path:
    if arg:
        return Path(arg).expanduser()
    if os.environ.get("NAWABAN_DB"):
        return Path(os.environ["NAWABAN_DB"]).expanduser()
    return (_board_root() or _main_checkout_then_cwd_and_ancestors()[0]) / ".nawaban" / "nawaban.db"


def default_project(db: Path) -> str | None:
    root = _repo_root(Path.cwd().resolve())
    if root:
        return root.name
    return _repository_holding_the_board(db)


def _repository_holding_the_board(db: Path) -> str | None:
    d = db.absolute().parent
    return d.parent.name if d.name == ".nawaban" else None


def _connect(path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(str(path), timeout=BOARD_WRITE_LOCK_WAIT_SECONDS)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    return con


def _version(path: Path) -> int | None:
    try:
        con = sqlite3.connect(path.absolute().as_uri() + "?mode=ro", uri=True)
        try:
            v = con.execute("PRAGMA user_version").fetchone()[0]
            tables = con.execute("SELECT count(*) FROM sqlite_master").fetchone()[0]
        finally:
            con.close()
    except sqlite3.DatabaseError:
        return None
    return v if v in (*VERSIONS_MIGRATED_ON_OPEN, VERSION) or not tables else None


def _migrate(path: Path) -> None:
    con = _connect(path)
    con.isolation_level = None
    try:
        _migrate_once_under_one_write_lock(con, path)
    finally:
        con.close()


def _migrate_once_under_one_write_lock(con: sqlite3.Connection, path: Path) -> None:
    con.execute("BEGIN IMMEDIATE")
    if _another_process_migrated_first(con):
        con.execute("ROLLBACK")
        return
    backup(path)
    for stmt in filter(str.strip, TABLES_ADDED_SINCE_VERSION_1_IDEMPOTENT.split(";")):
        con.execute(stmt)
    if "def_hash" not in {c[1] for c in con.execute("PRAGMA table_info(kr_readings)")}:
        _rebuild_readings_without_the_unique_that_dropped_new_values(con)
    con.execute(f"PRAGMA user_version={VERSION}")
    con.execute("COMMIT")


def _rebuild_readings_without_the_unique_that_dropped_new_values(con: sqlite3.Connection) -> None:
    con.execute("ALTER TABLE kr_readings RENAME TO kr_readings_v3")
    con.execute(OKR_SCHEMA.split(";")[0])
    con.execute("INSERT INTO kr_readings (repo, kr, value, as_of, source, measured_at)"
                " SELECT repo, kr, value, as_of, source, measured_at FROM kr_readings_v3 ORDER BY rowid")
    con.execute("DROP TABLE kr_readings_v3")


def _another_process_migrated_first(con: sqlite3.Connection) -> bool:
    return con.execute("PRAGMA user_version").fetchone()[0] not in VERSIONS_MIGRATED_ON_OPEN


def init(path: Path) -> bool:
    if path.exists():
        v = _version(path)
        if v is None:
            raise Refused(f"不是新版看板:{path}")
        if v in VERSIONS_MIGRATED_ON_OPEN:
            _migrate(path)
        if v in (*VERSIONS_MIGRATED_ON_OPEN, VERSION):
            return False
    path.parent.mkdir(parents=True, exist_ok=True)
    con = _connect(path)
    try:
        con.execute("PRAGMA journal_mode=WAL")
        con.executescript(SCHEMA + f"PRAGMA user_version={VERSION};")
    finally:
        con.close()
    return True


def _check_board(path: Path) -> None:
    if not path.exists():
        raise Refused(f"看板不存在:{path}(建新板用 init)")
    v = _version(path)
    if v in VERSIONS_MIGRATED_ON_OPEN:
        _migrate(path)
    elif v != VERSION:
        raise Refused(f"不是新版看板:{path}")


def open_board(path: Path) -> sqlite3.Connection:
    _check_board(path)
    return _connect(path)


def open_readonly(path: Path | str) -> sqlite3.Connection:
    path = Path(path)
    _check_board(path)
    con = sqlite3.connect(path.absolute().as_uri() + "?mode=ro", uri=True, timeout=BOARD_READ_LOCK_WAIT_SECONDS)
    con.row_factory = sqlite3.Row
    return con


def _task(con: sqlite3.Connection, task_id: str) -> sqlite3.Row:
    row = con.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    if row is None:
        raise Refused(f"任务不存在:{task_id}")
    return row


def identity() -> str:
    who = (os.environ.get("CODEX_THREAD_ID") or os.environ.get("ANTIGRAVITY_CONVERSATION_ID")
           or os.environ.get("CLAUDE_CODE_SESSION_ID")
           or os.environ.get("NAWABAN_OWNER"))
    if not who:
        raise Refused("身份缺失:需 CODEX_THREAD_ID、ANTIGRAVITY_CONVERSATION_ID 或 CLAUDE_CODE_SESSION_ID 环境变量;都没有的环境请设 NAWABAN_OWNER")
    return who


def _when(ts: int) -> str:
    return _dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


def derived_status(t: sqlite3.Row) -> str:
    held_while_open = t["status"] == "open" and t["session"]
    return "in_progress" if held_while_open else t["status"]


def blocked_by(con, task_id: str) -> list[sqlite3.Row]:
    return con.execute("SELECT t.* FROM blockers b JOIN tasks t ON t.id=b.blocker WHERE b.task=?"
                       " ORDER BY t.id", (task_id,)).fetchall()


def dependents(con, task_id: str) -> list[sqlite3.Row]:
    return con.execute("SELECT t.* FROM blockers b JOIN tasks t ON t.id=b.task WHERE b.blocker=?"
                       " ORDER BY t.id", (task_id,)).fetchall()


def add_event(con, task_id: str, author: str, kind: str, body: str) -> None:
    con.execute("INSERT INTO events (task, at, author, kind, body) VALUES (?,?,?,?,?)",
                (task_id, int(time.time()), author, kind, body))



def _status_event(con, task_id: str, who: str, frm: str, to: str, note: str = "") -> None:
    add_event(con, task_id, who, "status", f"{frm}→{to}" + (f" · {note}" if note else ""))


def herdr_terminal() -> str | None:
    return os.environ.get("HC_TERMINAL_ID") if os.environ.get("CLAUDE_CODE_SESSION_ID") else None


_TERMINAL = re.compile(r" · terminal (\S+)$")


def held_terminal(con, task_id: str, session: str | None) -> str | None:
    if not session:
        return None
    latest_claim = con.execute("SELECT body FROM events WHERE task=? AND kind='status' AND author=?"
                               " AND body LIKE '%→in_progress%' ORDER BY id DESC LIMIT 1",
                               (task_id, session)).fetchone()
    m = _TERMINAL.search(latest_claim["body"]) if latest_claim else None
    return m.group(1) if m else None


def _add_blocker(con, task_id: str, blocker: str) -> None:
    _task(con, task_id)
    _task(con, blocker)
    if task_id == blocker:
        raise Refused(f"任务不能被自己挡住:{task_id}")
    if _blocker_already_waits_on(con, blocker, task_id):
        raise Refused(f"会成环:{blocker} 已经(间接)被 {task_id} 挡住")
    con.execute("INSERT OR IGNORE INTO blockers (task, blocker) VALUES (?,?)", (task_id, blocker))


def _blocker_already_waits_on(con, blocker: str, task_id: str) -> bool:
    return con.execute(
        "WITH RECURSIVE up(id) AS (SELECT ? UNION SELECT b.blocker FROM blockers b JOIN up ON b.task=up.id)"
        " SELECT 1 FROM up WHERE id=?", (blocker, task_id)).fetchone() is not None



def create(con, path: Path, a) -> str:
    if not re.fullmatch(r"\S+", a.id):
        raise Refused(f"任务 id 不能为空或含空白:{a.id!r}")
    body = Path(a.body_file).read_text(encoding="utf-8") if a.body_file else a.body
    parent = _task(con, a.parent) if a.parent else None
    project = a.project or (parent["project"] if parent else default_project(path))
    if con.execute("SELECT 1 FROM tasks WHERE id=?", (a.id,)).fetchone():
        raise Refused(f"任务已存在:{a.id}")
    try:
        with con:
            con.execute("INSERT INTO tasks (id, project, parent, title, body, created_at)"
                        " VALUES (?,?,?,?,?,?)",
                        (a.id, project, a.parent, a.title, body, int(time.time())))
            for blocker in a.blocked_by or ():
                _add_blocker(con, a.id, blocker)
    except sqlite3.IntegrityError:
        raise Refused(f"任务已存在:{a.id}") from None
    return f"✓ create {a.id} · 项目 {project or '-'}"


def block(con, a) -> str:
    with con:
        _add_blocker(con, a.id, a.blocker)
    return f"✓ block {a.id} · 被挡:{a.blocker}"


def claim(con, a) -> str:
    t = _task(con, a.id)
    who = identity()
    holder = t["session"]
    _refuse_another_holders_task_without_take(a, holder, who)
    if a.release:
        return _release(con, a, t, holder, who)
    _refuse_claiming_a_closed_task(a, t)
    here = herdr_terminal()
    if _holder_claims_again_from_the_same_terminal(con, a.id, holder, who, here):
        return f"✓ {a.id} 已在本窗口 {who} 手上"
    note = " · ".join(filter(None, [f"接手自 {holder}" if holder and holder != who else "",
                                     f"terminal {here}" if here else ""]))
    with con:
        con.execute("UPDATE tasks SET session=? WHERE id=?", (who, a.id))
        _status_event(con, a.id, who, derived_status(t), "in_progress", note)
    return f"✓ claim {a.id} · 窗口 {who}" + (f" · terminal {here}" if here else "")


def _refuse_another_holders_task_without_take(a, holder: str | None, who: str) -> None:
    if holder and holder != who and not a.take:
        raise Refused(f"{a.id} 在窗口 {holder} 手上;确要接手加 --take")


def _release(con, a, t: sqlite3.Row, holder: str | None, who: str) -> str:
    if not holder:
        return f"✓ {a.id} 本就没人认领"
    with con:
        con.execute("UPDATE tasks SET session=NULL WHERE id=?", (a.id,))
        _status_event(con, a.id, who, derived_status(t), t["status"],
                      "" if holder == who else f"释放 {holder} 的认领")
    return f"✓ release {a.id}"


def _refuse_claiming_a_closed_task(a, t: sqlite3.Row) -> None:
    if t["status"] != "open":
        raise Refused(f"{a.id} 已是 {t['status']},不能认领;要重做先 close --reopen")


def _holder_claims_again_from_the_same_terminal(con, task_id: str, holder: str | None, who: str,
                                                here: str | None) -> bool:
    return holder == who and (not here or here == held_terminal(con, task_id, who))


def close(con, a) -> str:
    t = _task(con, a.id)
    who = identity()
    to = "done" if a.done else "cancelled" if a.cancelled else "open"
    if t["status"] == to:
        return f"✓ {a.id} 已是 {to}"
    with con:
        _set_status_returning_task_to_frontier(con, a.id, to)
        _status_event(con, a.id, who, derived_status(t), to)
    return f"✓ close {a.id} → {to}"


def _set_status_returning_task_to_frontier(con, task_id: str, to: str) -> None:
    con.execute("UPDATE tasks SET status=?, session=NULL WHERE id=?", (to, task_id))


def card(a) -> None:
    if a.kind == "impact":
        _check_impact_card(a)
        return
    if a.o:
        raise Refused("--o 只给 impact")
    if a.body is None:
        raise Refused("--body 必填(impact 除外)")
    a.kr = _the_one_kr(a)
    if a.kind != "ask":
        _tag_decision_with_its_kr(a)
        return
    card_text = "\n".join([f"决策事项：{a.body}", f"关联 KR：{a.kr or ''}", f"背景：{a.context or ''}",
                           "备选方案：", *(f"- {o}" for o in a.option or []), f"建议：{a.rec or ''}"])
    gaps = _decision_card_gaps(*_decision_card_parts(card_text))
    if gaps:
        raise Refused("待决策项未就绪(不满足就绪标准,缺 " + "、".join(gaps) + ";- / none / 无 / 待定 这类占位算缺)：--option 写成 方案｜代价｜单向门 或 双向门")
    a.body = card_text


def _check_impact_card(a) -> None:
    if a.body or a.context or a.option or a.rec or a.by:
        raise Refused("impact 只收 --o 和 --kr")
    if not a.o:
        raise Refused("impact 要 --o \"<O 名>\"(纯基础设施写 --o 无)")


def _the_one_kr(a) -> str | None:
    if a.kr and len(a.kr) > 1:
        raise Refused("--kr 只有 impact 可重复")
    kr = a.kr[0] if a.kr else None
    if kr and a.kind not in ("ask", "decision"):
        raise Refused("--kr 只给 ask(DR)和 decision")
    return kr


def _tag_decision_with_its_kr(a) -> None:
    if a.context or a.option or a.rec:
        raise Refused("--context / --option / --rec 只给 ask(DR)")
    if a.kr:
        a.body = f"[{a.kr}] {a.body}"


MIN_DECISION_OPTIONS = 2


def event(con, a) -> str:
    _task(con, a.id)
    author = "user" if a.by else identity()
    with con:
        add_event(con, a.id, author, a.kind, a.body)
    return f"✓ event {a.id} · {a.kind}"


_IMPACT = re.compile(r"(.+)=([↑↓=])(?:\s+(-?\d+(?:\.\d+)?%?)\s*→\s*(-?\d+(?:\.\d+)?%?)\s+(实测|预计))?\s*")
IMPACT_FORMAT = "<KR 名>=↑|↓|=[ 前→后 实测|预计]"


def _here() -> tuple[Path, str]:
    r = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    checkout = Path(r.stdout.strip()) if r.returncode == 0 else Path.cwd().resolve()
    key_under_main_checkout = str(_repo_root(checkout) or checkout)
    return checkout, key_under_main_checkout


NO_OBJECTIVE = "无"


def _moves_nothing(o: str) -> tuple:
    return (o, "", "=", None, None, None)


def _impact_rows(top: Path, o: str, krs: list[str]) -> list[tuple]:
    if o == NO_OBJECTIVE:
        if krs:
            raise Refused("--o 无 不带 --kr")
        return [_moves_nothing(NO_OBJECTIVE)]
    obj = next((x for x in _okr_defs(top) if x.get("name") == o), None)
    if obj is None:
        raise Refused(f"{OKR_FILE} 里没有这个 O:{o}")
    names = [k["name"] for k in obj.get("kr", [])]
    rows = [_impact_row(o, names, spec) for spec in krs]
    return rows or [_moves_nothing(o)]


def _impact_row(o: str, names: list[str], spec: str) -> tuple:
    m = _IMPACT.fullmatch(spec)
    if not m:
        raise Refused(f"--kr 格式是 {IMPACT_FORMAT}(数字前→后):{spec}")
    name, d, before, after, basis = m.groups()
    if name not in names:
        raise Refused(f"{o} 下没有这个 KR:{name}(有:{'、'.join(names)})")
    if d != "=" and not basis:
        raise Refused(f"↑↓ 要带数字和依据:{name}={d} 前→后 实测|预计")
    return (o, name, d, before, after, basis)


def impact(con, a, gh_root: Path | None = None) -> str:
    who = identity()
    top, repo = _here()
    rows = _impact_rows(top, a.o, a.kr or [])
    if gh_root is None:
        _task(con, a.id)
    text = f"O {a.o}" + "".join(f" · {k}" for k in a.kr or [])
    now = _sortable_timestamp(_dt.datetime.now())
    with con:
        con.executemany("INSERT INTO kr_impacts VALUES (?,?,?,?,?,?,?,?,?)", [(repo, a.id, *r, now) for r in rows])
        _announce_before_commit_so_a_failed_post_rolls_back(con, a, who, text, gh_root)
        if gh_root is not None and _repo_the_board_syncs(gh_root):
            _write_on_the_board_first(["github-impact"], json.dumps(
                [dict(zip(("objective", "kr", "dir", "before", "after", "basis"), r), repo=repo, ticket=a.id, declared_at=now) for r in rows],
                ensure_ascii=False))
    return f"✓ event {a.id} · impact"


def _announce_before_commit_so_a_failed_post_rolls_back(con, a, who: str, text: str, gh_root: Path | None) -> None:
    if gh_root is None:
        add_event(con, a.id, who, "note", f"impact: {text}")
    else:
        gh_post(gh_root, _GH_ISSUE.fullmatch(a.id).group(1), "impact", text)


def _declared(path: Path, repo: str, tickets: list[str]) -> list[str]:
    if not path.exists():
        return list(tickets)
    with closing(open_readonly(path)) as con:
        return [t for t in tickets if not con.execute(
            "SELECT 1 FROM kr_impacts WHERE repo=? AND ticket=?", (repo, t)).fetchone()]


def _how_to_declare(ticket: str) -> str:
    return (f"  nawaban event {shlex.quote(ticket)} --kind impact --o \"<O 名>\" --kr \"{IMPACT_FORMAT}\""
            f"(--kr 可重复;纯基础设施写 --o 无)")



def impact_lock(path: Path, ticket: str) -> None:
    top, repo = _here()
    if (top / OKR_FILE).is_file() and _declared(path, repo, [ticket]):
        raise Refused(f"{ticket} 没有 KR 影响声明,不能 close --done。先补:\n{_how_to_declare(ticket)}")



_MERGE_IN_COMMAND_POSITION = re.compile(r"(?:^|[;&|(\n])\s*(?:\w+=(?:\$\([^)]*\)|\S*)\s+)*"
                                        r"(?:gh\s+pr\s+merge|(?:(?:ba|z)?sh\s+)?(?:\S*/)?scripts/merge\.sh)(?=[\s;&|)]|$)")
_GH_VALUE_FLAGS = {"-R", "--repo", "-b", "--body", "-F", "--body-file", "-t", "--subject", "-A",
                   "--author-email", "--match-head-commit"}
_END_OF_SIMPLE_COMMAND = re.compile(r"[;&|\n)]|$")


def _blank_quoted_strings_keeping_length(cmd: str) -> str:
    return re.sub(r"'[^']*'|\"(?:\\.|[^\"\\])*\"", lambda q: "'" + "x" * (len(q.group(0)) - 2) + "'", cmd)


def merge_gate(cmd: str, path: Path) -> str | None:
    flat = _blank_quoted_strings_keeping_length(cmd)
    merges = list(_MERGE_IN_COMMAND_POSITION.finditer(flat))
    if not merges:
        return None
    top_of_session_cwd, repo = _here()
    if not (top_of_session_cwd / OKR_FILE).is_file():
        return None
    for m in merges:
        stop = _END_OF_SIMPLE_COMMAND.search(flat[m.end():]).start()
        if why := _merge_gate_one(m.group(0), cmd[m.end():m.end() + stop], top_of_session_cwd, repo, path):
            return why
    return None


def _merge_gate_one(merge: str, rest: str, top: Path, repo: str, path: Path) -> str | None:
    sel, gh_repo = _pr_selector_and_repo(rest)
    if sel is None and "merge.sh" in merge:
        return "scripts/merge.sh 没写 PR 号,核不了 KR 影响声明"
    try:
        pr = _gh_json(top, "pr", "view", *([sel] if sel else []), *(["--repo", gh_repo] if gh_repo else []),
                      "--json", "number,title,body,headRefName,closingIssuesReferences")
    except (Refused, ValueError) as e:
        return f"查不到这个 PR 的关联票,核不了 KR 影响声明:{e}"
    tickets = _linked_tickets(pr, path, repo)
    if not tickets:
        return (f"PR #{pr.get('number')} 查不到关联票(closingIssuesReferences、正文 Refs #N、看板票号都没有),"
                f"核不了 KR 影响声明。在 PR 正文写 Closes #N 或 Refs #N")
    missing = _declared(path, repo, tickets)
    if missing:
        return (f"PR #{pr.get('number')} 的关联票没有 KR 影响声明({'、'.join(missing)};看板 {path}),先补再合并:\n"
                + "\n".join(_how_to_declare(t) for t in missing))
    return None


def _pr_selector_and_repo(rest: str) -> tuple[str | None, str | None]:
    try:
        args = shlex.split(rest)
    except ValueError:
        args = []
    sel, gh_repo, it = None, None, iter(args)
    for t in it:
        if t in _GH_VALUE_FLAGS:
            v = next(it, None)
            gh_repo = v if t in ("-R", "--repo") else gh_repo
        elif not t.startswith("-") and sel is None:
            sel = t
    return sel, gh_repo


def _linked_tickets(pr: dict, path: Path, repo: str) -> list[str]:
    tickets = [f"#{i['number']}" for i in pr.get("closingIssuesReferences") or []]
    tickets += [f"#{n}" for n in re.findall(r"\bRefs?\s+#(\d+)", pr.get("body") or "", re.I)]
    if path.exists():
        tickets += _board_tickets_named_in_title_body_or_branch(pr, path, repo)
    return list(dict.fromkeys(tickets))


def _board_tickets_named_in_title_body_or_branch(pr: dict, path: Path, repo: str) -> list[str]:
    text = " ".join(str(pr.get(k) or "") for k in ("title", "body", "headRefName"))
    with closing(open_readonly(path)) as con:
        return [r["id"] for r in con.execute("SELECT id FROM tasks WHERE status='open' AND project=?",
                                             (Path(repo).name,))
                if re.search(rf"(?<![\w-]){re.escape(r['id'])}(?![\w-])", text, re.I)]


SHOWN_EVENTS = 20


def show(con, a, limit: int = SHOWN_EVENTS) -> str:
    t = _task(con, a.id)
    events = con.execute("SELECT * FROM events WHERE task=? ORDER BY id DESC", (a.id,)).fetchall()
    head = [f"状态 {derived_status(t)}", f"项目 {t['project'] or '-'}"]
    if t["parent"]:
        head.append(f"父任务 {t['parent']}")
    if t["session"]:
        head.append(f"窗口 {t['session']}")
    head.append(f"建于 {_when(t['created_at'])}")
    lines = [f"[{t['id']}] {t['title']}", "  " + " · ".join(head)]
    note = _progress_only_while_open(t, events)
    if note:
        lines.append(f"  当前进展:{note['body']}")
    for label, rows in (("被挡", blocked_by(con, a.id)), ("下游任务", dependents(con, a.id))):
        if rows:
            lines.append(f"  {label}:" + " · ".join(f"{r['id']} {derived_status(r)}" for r in rows))
    lines += ["", t["body"], ""]
    lines.append(f"最近事件(最新在前 · 共 {len(events)} 条):")
    lines += [f"  [{_when(e['at'])} · {e['kind']} · {e['author']}] {e['body']}" for e in events[:limit]]
    return "\n".join(lines)


def _progress_only_while_open(t: sqlite3.Row, events: list) -> sqlite3.Row | None:
    if t["status"] != "open":
        return None
    return next((e for e in events if e["kind"] == "note"), None)


def list_tasks(con, a) -> str:
    sql, args = "SELECT * FROM tasks WHERE 1=1", []
    if a.project:
        sql += " AND project=?"
        args.append(a.project)
    if a.parent:
        _task(con, a.parent)
        sql += " AND parent=?"
        args.append(a.parent)
    if a.frontier:
        sql += (" AND status='open' AND session IS NULL AND NOT EXISTS (SELECT 1 FROM blockers b"
                " JOIN tasks x ON x.id=b.blocker WHERE b.task=tasks.id AND x.status='open')")
    rows = con.execute(sql + " ORDER BY created_at, id", args).fetchall()
    return "\n".join(f"{t['id']}  {derived_status(t)}  {t['project'] or '-'}  {t['title']}" for t in rows)



def backup(path: Path, keep_days: int = BACKUP_KEEP_DAYS) -> Path:
    bdir = path.parent / "backups"
    bdir.mkdir(parents=True, exist_ok=True)
    dest_path = bdir / f"nawaban-{_dt.datetime.now():%Y%m%d-%H%M%S}.db"
    src, dest = sqlite3.connect(str(path)), sqlite3.connect(str(dest_path))
    try:
        src.backup(dest)
    finally:
        dest.close()
        src.close()
    cutoff = time.time() - keep_days * DAY_SECONDS
    for old in bdir.glob("nawaban-*.db"):
        if old.stat().st_mtime < cutoff:
            old.unlink()
    return dest_path


COLUMNS = ("open", "in_progress", "done")
DONE_LIMIT = 12
DONE_RECENT = DAY_SECONDS
DECISIONS_RECENT = 2 * DAY_SECONDS



def _ref(r: sqlite3.Row) -> dict:
    return {"id": r["id"], "title": r["title"], "status": derived_status(r)}


def _event(r: sqlite3.Row) -> dict:
    return {"kind": r["kind"], "body": r["body"], "author": r["author"], "at": r["at"]}


def _triage_notes(con) -> list[sqlite3.Row]:
    return con.execute(
        "SELECT e.task, NULLIF(t.project,'') AS project, e.body FROM events e JOIN tasks t ON t.id=e.task"
        " WHERE t.status='open' AND e.id=(SELECT MAX(id) FROM events"
        " WHERE task=e.task AND kind='note' AND ltrim(body) LIKE 'triage:%')").fetchall()


def projects_data(path: Path | str) -> dict:
    with closing(open_readonly(path)) as con:
        rows = con.execute(
            "SELECT NULLIF(project,'') AS name, SUM(status='open') AS open, count(*) AS total"
            " FROM tasks GROUP BY name ORDER BY name IS NULL, name").fetchall()
        waiting = Counter(r["project"] for r in _triage_notes(con) if waiting_question(r["body"]) is not None)
        return {"projects": [dict(r) | {"waiting": waiting[r["name"]]} for r in rows]}


_NEEDS_INFO = re.compile(r"triage:\s*needs-info[\s—–:：-]*(?:等你\s*[:：])?\s*")


def waiting_question(triage_note: str | None) -> str | None:
    m = _NEEDS_INFO.match(triage_note.strip()) if triage_note else None
    return triage_note.strip()[m.end():] if m else None


_VERDICT = re.compile(r"^\s*(?:\[[^\]\n]*\]\s*)?(?:决定|Decision|Verdict)\s*[:：]\s*(.*)$", re.M)



def _verdict(body: str) -> str:
    m = _VERDICT.search(body)
    return m.group(1).strip() if m else _first_line(body)


def _first_line(body: str) -> str:
    return body.strip().split("\n", 1)[0]


_BOARD_ROWS = ("SELECT t.*, MAX(COALESCE(e.at, t.created_at)) AS active_at,"
               " (SELECT count(*) FROM blockers b JOIN tasks x ON x.id=b.blocker"
               "  WHERE b.task=t.id AND x.status='open') AS open_blockers,"
               " (SELECT at FROM events WHERE task=t.id AND kind='status' AND body LIKE '%→in_progress%'"
               "  ORDER BY id LIMIT 1) AS claimed_at,"
               " (SELECT author FROM events WHERE task=t.id AND kind='status' AND body LIKE '%→in_progress%'"
               "  ORDER BY id DESC LIMIT 1) AS last_claimer,"
               " (SELECT at FROM events WHERE task=t.id AND kind='status' AND body LIKE '%→done%'"
               "  ORDER BY id DESC LIMIT 1) AS done_at,"
               " (SELECT status='open' FROM tasks p WHERE p.id=t.parent) AS parent_open"
               " FROM tasks t LEFT JOIN events e ON e.task=t.id WHERE t.status!='cancelled'")


def board_data(path: Path | str, project: str | None = None) -> dict:
    sql, args = _BOARD_ROWS, {}
    if project is not None:
        sql += " AND COALESCE(t.project,'')=:project"
        args["project"] = project
    with closing(open_readonly(path)) as con:
        rows = con.execute(sql + " GROUP BY t.id ORDER BY active_at DESC, t.id", args).fetchall()
        open_task_facts = {
            "progress": _current_progress_of_open_tasks(con),
            "decision": _latest_decision_of_open_tasks(con),
            "triage": {r["task"]: r["body"] for r in _triage_notes(con)},
            "blocked_by": _open_blockers_by_task(con),
        }
        leaders = _leaders_by_latest_dispatch_note(con)
        decided = _decisions_within_window(con, project, args)
        terminals = {r["id"]: held_terminal(con, r["id"], r["session"])
                     for r in rows if r["status"] == "open" and r["session"]}
    columns = {key: [] for key in COLUMNS}
    recent = time.time() - DONE_RECENT
    for r in rows:
        status = derived_status(r)
        if _done_past_the_column_limit(status, columns, r, recent):
            continue
        columns[status].append(_board_task(r, status, terminals, leaders, open_task_facts))
    return {"columns": [{"key": k, "tasks": v} for k, v in columns.items()], "decisions": decided}


def _current_progress_of_open_tasks(con) -> dict:
    return {r["task"]: {"body": r["body"], "at": r["at"]} for r in con.execute(
        "SELECT e.task, e.body, e.at FROM events e JOIN tasks t ON t.id=e.task"
        " WHERE t.status='open' AND e.id=(SELECT MAX(id) FROM events"
        " WHERE task=e.task AND kind='note' AND ltrim(body) NOT LIKE 'coord:%' AND ltrim(body) NOT LIKE 'impact:%')")}


def _leaders_by_latest_dispatch_note(con) -> dict:
    return {r["task"]: r["author"] for r in con.execute(
        "SELECT e.task, e.author FROM events e WHERE e.id=(SELECT MAX(id) FROM events"
        " WHERE task=e.task AND kind='note'"
        " AND (ltrim(body) LIKE 'dispatch:%' OR ltrim(body) LIKE 'coord: dispatch%'))")}


def _latest_decision_of_open_tasks(con) -> dict:
    return {r["task"]: {"at": r["at"], "verdict": _verdict(r["body"])} for r in con.execute(
        "SELECT e.task, e.body, e.at FROM events e JOIN tasks t ON t.id=e.task"
        " WHERE t.status='open' AND e.id=(SELECT MAX(id) FROM events"
        " WHERE task=e.task AND kind='decision')")}


def _decisions_within_window(con, project: str | None, args: dict) -> list[dict]:
    return [{"task": r["task"], "at": r["at"], "verdict": _verdict(r["body"]), "owner": r["author"] == "user"}
            for r in con.execute(
        "SELECT e.* FROM events e JOIN tasks t ON t.id=e.task WHERE e.kind='decision' AND e.at>=:since"
        " AND t.status!='cancelled'" + (" AND COALESCE(t.project,'')=:project" if project is not None else "")
        + " ORDER BY e.at DESC, e.id DESC", args | {"since": time.time() - DECISIONS_RECENT})]


def _open_blockers_by_task(con) -> dict[str, list[str]]:
    blockers: dict[str, list[str]] = {}
    for r in con.execute("SELECT b.task, b.blocker FROM blockers b JOIN tasks x ON x.id=b.blocker"
                         " WHERE x.status='open' ORDER BY b.blocker"):
        blockers.setdefault(r["task"], []).append(r["blocker"])
    return blockers


def _done_past_the_column_limit(status: str, columns: dict, r: sqlite3.Row, recent: float) -> bool:
    ticked_under_open_spec = r["parent_open"]
    done_recently = (r["done_at"] or 0) >= recent
    return (status == "done" and len(columns["done"]) >= DONE_LIMIT
            and not ticked_under_open_spec and not done_recently)


def _board_task(r: sqlite3.Row, status: str, terminals: dict, leaders: dict, open_task_facts: dict) -> dict:
    task = {
        "id": r["id"], "title": r["title"], "status": status, "project": r["project"],
        "parent": r["parent"], "session": r["session"], "created_at": r["created_at"],
        "active_at": r["active_at"], "open_blockers": r["open_blockers"],
        "terminal": terminals.get(r["id"]), "leader": leaders.get(r["id"], r["session"] or r["last_claimer"]),
        "claimed_at": r["claimed_at"]}
    if r["status"] == "open":
        task["progress"] = open_task_facts["progress"].get(r["id"])
        task["blocked_by"] = open_task_facts["blocked_by"].get(r["id"], [])
        task["waiting"] = waiting_question(open_task_facts["triage"].get(r["id"]))
        task["decision"] = open_task_facts["decision"].get(r["id"])
    if status == "done":
        task["done_at"] = r["done_at"]
    return task



GH_RECENT = 2 * DAY_SECONDS
PENDING_NOTES = 3
GH_TIMEOUT_SECONDS = 30
GH_ISSUE_LIST_LIMIT = "1000"
_GH_FIELDS = "number,url,title,state,stateReason,closedAt,createdAt,updatedAt,labels,body,comments,parent,assignees"
_GH_PARENT_SUFFIX_IN_TITLE = re.compile(r"[(（]#(\d+)-[A-Za-z]+[)）]")
_GH_PARENT_BODY = re.compile(r"(?:属于|Part of|Parent:)\s*#(\d+)")
_GH_PREFIX_HEADING_BOLD_WORD_WHO_COLON = r"\s*(?:#{{1,6}}\s*)?\**{}\**\s*([（(][^）)\n]*[）)])?\**\s*[：:]\**\s*"
_GH_CLAIM_TERMINAL = re.compile(r"\bhc (t\w+)")
_GH_NEXT_STEP_SENTENCE = re.compile(r"(?:下一步|\bNext)[：:]\s*(.+?)(?=\s*/\s*(?:卡点|Blockers)\s*[：:]|[。\n]|$)")


def github_root(cwd: Path | None = None) -> Path | None:
    root = _repo_root((cwd or Path.cwd()).resolve())
    try:
        lines = (root / "docs" / "agents" / "issue-tracker.md").read_text().splitlines() if root else []
    except OSError:
        return None
    first_heading = next((ln for ln in lines if ln.startswith("#")), "")
    return root if "GitHub" in first_heading else None


_GITHUB_ACCOUNT_DECLARATION = re.compile(r"^github-account:[ \t]*([A-Za-z0-9-]+)[ \t]*\r?$", re.M)
_FENCED_OR_COMMENTED_EXAMPLE = re.compile(r"^ {0,3}(`{3,}|~{3,})[\s\S]*?(?:^ {0,3}\1|\Z)|<!--[\s\S]*?(?:-->|\Z)", re.M)
_GITHUB_OWNER_IN_REMOTE = re.compile(r"github\.com[:/]([^/]+)/")


def github_account(root: Path) -> str | None:
    """The repository's declared account, else this machine's account for its origin owner; None leaves gh as it is (a teammate without the map)."""
    try:
        tracker = (root / "docs" / "agents" / "issue-tracker.md").read_text()
    except OSError:
        tracker = ""
    if m := _GITHUB_ACCOUNT_DECLARATION.search(_FENCED_OR_COMMENTED_EXAMPLE.sub("", tracker)):
        return m.group(1)
    remote = subprocess.run(["git", "-C", str(root), "remote", "get-url", "origin"], capture_output=True, text=True).stdout
    owner = _GITHUB_OWNER_IN_REMOTE.search(remote)
    try:
        accounts = json.loads((Path.home() / ".nawaban" / "github-accounts.json").read_text())
    except FileNotFoundError:
        return None
    return next((a for o, a in accounts.items() if owner and o.lower() == owner.group(1).lower() and isinstance(a, str)), None)


def _env_writing_as(root: Path, account: str) -> dict:
    r = _run_gh(root, "auth", "token", "--user", account)
    if r.returncode != 0 or not r.stdout.strip():
        raise Refused(f"本机 gh 没登录 {root} 要用的账号 {account}：先跑 gh auth login，登录 {account}")
    return os.environ | {"GH_TOKEN": r.stdout.strip()}


def _gh(root: Path, *args: str) -> str:
    account = github_account(root)
    r = _run_gh(root, *args, env=_env_writing_as(root, account)) if account else _run_gh(root, *args)
    if r.returncode != 0 and not account and "Could not resolve to a Repository" in r.stderr:
        r = _retry_as_an_inactive_login(root, args) or r
    if r.returncode != 0:
        raise Refused(f"gh 失败:{r.stderr.strip()}")
    return r.stdout


def _run_gh(root: Path, *args: str, env: dict | None = None,
            timeout: int = GH_TIMEOUT_SECONDS) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(["gh", *args], cwd=root, capture_output=True, text=True, timeout=timeout, env=env)
    except (OSError, subprocess.SubprocessError) as e:
        raise Refused(f"gh 不可用:{e}") from e


def _retry_as_an_inactive_login(root: Path, args: tuple[str, ...]) -> subprocess.CompletedProcess | None:
    for login in _inactive_gh_logins_sessions_may_have_switched_from(root):
        env = os.environ | {"GH_TOKEN": _run_gh(root, "auth", "token", "--user", login).stdout.strip()}
        if (retry := _run_gh(root, *args, env=env)).returncode == 0:
            return retry
    return None


def _inactive_gh_logins_sessions_may_have_switched_from(root: Path) -> list[str]:
    import json
    r = _run_gh(root, "auth", "status", "--json", "hosts")
    try:
        return [a["login"] for a in json.loads(r.stdout)["hosts"]["github.com"] if not a.get("active")]
    except (ValueError, KeyError, TypeError):
        return []


def _gh_json(root: Path, *args: str):
    import json
    return json.loads(_gh(root, *args))


def _gh_issues(root: Path) -> list[dict]:
    since = _dt.datetime.fromtimestamp(time.time() - GH_RECENT, _dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return [i for state in (["--state", "open"], ["--state", "closed", "--search", f"closed:>={since}"])
            for i in _gh_json(root, "issue", "list", *state, "--limit", GH_ISSUE_LIST_LIMIT, "--json", _GH_FIELDS)]



OKR_FILE = "docs/agents/okr.toml"
MEASURE_TIMEOUT = 60
MEASURE_ERROR_WIDTH = 120
UNREADABLE_LINE_WIDTH = 60
UNDATED_AS_OF_WIDTH = 30
_TARGET = re.compile(r"(>=|<=|>|<|==)\s*(-?\d+(?:\.\d+)?)")
_READING = re.compile(r"(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s+(\S.*)")
_MEETS_ON_DECIMAL = {">=": lambda a, b: a >= b, "<=": lambda a, b: a <= b, ">": lambda a, b: a > b,
                     "<": lambda a, b: a < b, "==": lambda a, b: a == b}


_ERROR_HEADER_LINE = re.compile(r"\s*[\w.]*(?:Error|Exception)(?:\s*\[[^\]]*\])?:")


def _measure(root: Path, cmd: str) -> tuple[Decimal, str] | str:
    try:
        r = subprocess.run(cmd, shell=True, cwd=root, capture_output=True, text=True,
                           errors="replace", timeout=MEASURE_TIMEOUT)
    except subprocess.TimeoutExpired:
        return f"超时（{MEASURE_TIMEOUT}s）"
    if r.returncode != 0:
        return f"退出码 {r.returncode}：" + _error_header_before_runtime_footer(r.stderr)[:MEASURE_ERROR_WIDTH]
    if "\ufffd" in r.stdout:
        return "输出不是 UTF-8"
    last = (r.stdout.strip().splitlines() or [""])[-1].strip()
    m = _READING.fullmatch(last)
    return (Decimal(m.group(1)), m.group(2)) if m else f"最后一行不是「数值 截至」：{last[:UNREADABLE_LINE_WIDTH]!r}"


def _error_header_before_runtime_footer(stderr: str) -> str:
    err = stderr.strip().splitlines() or [""]
    return next((l for l in err if _ERROR_HEADER_LINE.match(l)), err[-1]).strip()


def _stale(as_of: str, max_days: int) -> str:
    try:
        if not re.match(r"\d{4}-\d\d-\d\d", as_of):
            raise ValueError
        day = _dt.date.fromisoformat(as_of[:10])
    except ValueError:
        return f"测量失败：设了 max_age_days，截至要以 YYYY-MM-DD 开头：{as_of[:UNDATED_AS_OF_WIDTH]!r}"
    old = (_dt.date.today() - day).days
    return f"测量过期：截至 {day}，已 {old} 天，超过 {max_days} 天" if old > max_days else ""


def _okr_defs(root: Path) -> list[dict]:
    objectives = _parse_okr_file(root)
    for o in objectives:
        for kr in o.get("kr", []):
            _refuse_whole_file_for_a_malformed_kr(o, kr)
    return objectives


def _parse_okr_file(root: Path) -> list:
    import tomllib
    path = root / OKR_FILE
    if not path.is_file():
        raise Refused(f"没有 {OKR_FILE}:KR 定义写在仓库里,O 由决策者定、KR 由决策者点头")
    try:
        objectives = tomllib.loads(path.read_text(encoding="utf-8")).get("objective", [])
    except ValueError as e:
        raise Refused(f"{OKR_FILE} 不是合法的 UTF-8 TOML:{e}")
    if not _objectives_hold_kr_tables(objectives):
        raise Refused(f"{OKR_FILE} 要写成 [[objective]] 下挂 [[objective.kr]]")
    return objectives


def _objectives_hold_kr_tables(objectives) -> bool:
    return isinstance(objectives, list) and all(
        isinstance(o, dict) and isinstance(o.get("kr", []), list) and all(isinstance(k, dict) for k in o.get("kr", []))
        for o in objectives)


def _refuse_whole_file_for_a_malformed_kr(o: dict, kr: dict) -> None:
    if not isinstance(kr.get("name"), str) or not kr["name"]:
        raise Refused(f"{OKR_FILE}:{o.get('name')} 下有一条 KR 没写 name")
    inputs = kr.get("inputs", [])
    if not isinstance(inputs, list) or not all(isinstance(i, str) and i and "\0" not in i for i in inputs):
        raise Refused(f"{OKR_FILE}:{o.get('name')} / {kr['name']} 的 inputs 要写成非空字符串的数组")
    if any(GLOB_SYNTAX_THE_TWO_CLIS_READ_APART.search(i) or {".", ".."} & set(i.split("/")) for i in inputs):
        raise Refused(f"{OKR_FILE}:{o.get('name')} / {kr['name']} 的 inputs 只认 *、?、** 通配，不收 {{}}[]()!\\，也不收 . 和 .. 段")
    if not all(isinstance(kr.get(k, ""), str) and "\0" not in kr.get(k, "") for k in ("measure", "unit", "wait")):
        raise Refused(f"{OKR_FILE}:{o.get('name')} / {kr['name']} 的 measure、unit、wait 要写成字符串")
    age = kr.get("max_age_days", 0)
    if isinstance(age, bool) or not isinstance(age, int) or age < 0:
        raise Refused(f"{OKR_FILE}:{o.get('name')} / {kr['name']} 的 max_age_days 要写成非负整数")
    if not isinstance(kr.get("target"), str) or not _TARGET.fullmatch(kr["target"].strip()):
        raise Refused(f"{OKR_FILE}:{o.get('name')} / {kr.get('name')} 的 target 要写成「>= 95」这样")


_AS_OF = re.compile(r"(\d{4}-\d\d-\d\d\S*)\s*(.*)")


def okr_run(root: Path) -> tuple[str, list[tuple[str, str, str, str, str]], dict[str, bool]]:
    objectives = _okr_defs(root)
    out, readings, full = [_okr_heading(root)], [], {}
    for o in objectives:
        rows, met = [], 0
        for kr in o.get("kr", []):
            row, ok, reading = _measure_kr(root, kr)
            rows.append(row)
            met += ok
            if reading:
                readings.append(reading)
        out += [f"O {o.get('name')} · {met}/{len(rows)} 达标", *rows]
        full[o.get("name")] = bool(rows) and met == len(rows)
    return "\n".join(out), readings, full


def _okr_heading(root: Path) -> str:
    git = lambda *a: subprocess.run(["git", *a], cwd=root, capture_output=True, text=True).stdout.strip()
    head = git("log", "-1", "--format=%h %cs", "--", OKR_FILE) or "未提交"
    dirty = "（有未提交改动）" if git("status", "--porcelain", "--", OKR_FILE) else ""
    return f"OKR · 定义 {OKR_FILE} @ {head}{dirty}"


def _measure_kr(root: Path, kr: dict) -> tuple[str, bool, tuple | None]:
    op, goal = _TARGET.fullmatch(kr["target"].strip()).groups()
    unit, want = kr.get("unit", ""), f"{op} {goal}{kr.get('unit', '')}"
    got = _measure(root, kr["measure"]) if kr.get("measure") else None
    reading = _kept_reading_or_failure(root, kr, got)
    if got is None:
        return f"  {kr['name']}  未测 / 目标 {want}", False, reading
    if isinstance(got, str):
        return f"  {kr['name']}  量不了 / 目标 {want} · 测量失败：{got}", False, reading
    line = lambda rag: _okr_line(kr["name"], got[0], unit, want, op, Decimal(goal), rag, got[1])
    if kr.get("max_age_days") is not None and (stale := _stale(got[1], kr["max_age_days"])):
        return f"{line('黄')}  {stale}", False, reading
    ok = _MEETS_ON_DECIMAL[op](got[0], Decimal(goal))
    return line("绿" if ok else "红"), ok, reading


_UNITS_COUNTED_IN_POINTS = {"%", "百分点", "个百分点"}
_ISO_DAY = re.compile(r"\d{4}-(\d\d-\d\d)")


def _variance_in_the_targets_direction(op: str, value: Decimal, goal: Decimal) -> Decimal:
    if op == "==":
        return -abs(value - goal)
    return goal - value if op in ("<=", "<") else value - goal


def _okr_line(name: str, value: Decimal, unit: str, want: str, op: str, goal: Decimal, rag: str, as_of: str) -> str:
    shown_unit = "点" if unit in _UNITS_COUNTED_IN_POINTS else unit
    variance = f"{_variance_in_the_targets_direction(op, value, goal):+.1f}" + (f" {shown_unit}" if shown_unit else "")
    day = _ISO_DAY.match(as_of)
    return f"  {name}  {value:.1f}{unit} / 目标 {want} · 偏差 {variance} · {rag} · 截至 {day.group(1) if day else as_of}"


def _kept_reading_or_failure(root: Path, kr: dict, got) -> tuple | None:
    if isinstance(got, str):
        return (kr["name"], FAILED, "", got, def_hash(root, kr))
    if isinstance(got, tuple) and (d := _AS_OF.fullmatch(got[1])):
        return (kr["name"], str(got[0]), d.group(1), d.group(2), def_hash(root, kr))
    return None


FAILED = ""
DEF_HASH_LENGTH = 16
KR_FIELDS_IN_DEF_HASH = ("inputs", "max_age_days", "measure", "name", "target", "unit", "wait")
_WILDCARD = re.compile(r"[*?]")
GLOB_SYNTAX_THE_TWO_CLIS_READ_APART = re.compile(r"[{}\[\]()!\\]")
MEASURE_CODE_SUFFIXES = (".ts", ".mts", ".js", ".mjs", ".cjs", ".py", ".sh")
_SHELL_SEPARATORS = re.compile(r"[\s'\"`;|&<>()=]+")


def def_hash(root: Path, kr: dict) -> str:
    entry = json.dumps({k: kr[k] for k in KR_FIELDS_IN_DEF_HASH if k in kr}, ensure_ascii=False, separators=(",", ":"))
    h = hashlib.sha256(entry.encode())
    for name in _repo_files_named_in(root, kr.get("measure", "")):
        h.update(b"\0" + name.encode() + b"\0" + hashlib.sha256((root / name).read_bytes()).hexdigest().encode())
    for pattern in kr.get("inputs", []):
        digests = sorted(hashlib.sha256(p.read_bytes()).hexdigest() for p in _input_files(root, pattern))
        h.update(b"\0" + pattern.encode() + b"\0" + ",".join(digests).encode())
    return h.hexdigest()[:DEF_HASH_LENGTH]


def _input_files(root: Path, pattern: str) -> list[Path]:
    expanded = str(Path.home()) + pattern[1:] if pattern == "~" or pattern.startswith("~/") else pattern
    start = "/" if os.path.isabs(expanded) else str(root)
    found = _files_matching(start, [s for s in expanded.split("/") if s])
    return [Path(p) for p in dict.fromkeys(os.path.realpath(p) for p in found)]


def _files_matching(at: str, segments: list[str]) -> list[str]:
    if not segments:
        return [at] if os.path.isfile(at) else []
    segment, rest = segments[0], segments[1:]
    if segment == "**":
        found = _files_matching(at, rest)
        for name in _entries(at):
            child = os.path.join(at, name)
            if not name.startswith(".") and os.path.isdir(child) and not os.path.islink(child):
                found += _files_matching(child, segments)
        return found
    if not _WILDCARD.search(segment):
        return _files_matching(os.path.join(at, segment), rest)
    whole = re.compile("".join("[^/]*" if c == "*" else "[^/]" if c == "?" else re.escape(c) for c in segment))
    return [f for name in _entries(at) if (segment.startswith(".") or not name.startswith(".")) and whole.fullmatch(name)
            for f in _files_matching(os.path.join(at, name), rest)]


def _entries(at: str) -> list[str]:
    try:
        return os.listdir(at)
    except OSError:
        return []


def _repo_files_named_in(root: Path, cmd: str) -> list[str]:
    named = []
    for word in filter(None, _SHELL_SEPARATORS.split(cmd)):
        p = Path(word)
        inside = not p.is_absolute() and ".." not in p.parts
        if inside and p.suffix in MEASURE_CODE_SUFFIXES and word not in named and (root / word).is_file():
            named.append(word)
    return named


def _sortable_timestamp(t: _dt.datetime) -> str:
    return t.isoformat(timespec="microseconds")


ACCEPT_STRICTLY_AFTER_READINGS = _dt.timedelta(microseconds=1)


def okr_record(con, repo: Path, readings: list, accept: str | None, full: dict[str, bool]) -> str:
    now = _dt.datetime.now()
    n = _keep_readings_before_judging_accept(con, repo, readings, now)
    if accept is not None and not full.get(accept):
        why = f"没有这个 O:{accept}" if accept not in full else f"{accept} 还没全 ✓,不收 accept"
        raise Refused(f"{why}(读数新记 {n} 条)")
    if accept is not None:
        with con:
            con.execute("INSERT INTO okr_accepts VALUES (?, ?, ?)",
                        (str(repo), accept, _sortable_timestamp(now + ACCEPT_STRICTLY_AFTER_READINGS)))
    return f"读数新记 {n} 条" + (f" · ✓ accept {accept}" if accept is not None else "")


def _keep_readings_before_judging_accept(con, repo: Path, readings: list, now: _dt.datetime) -> int:
    kept = 0
    with con:
        for k, v, as_of, src, h in readings:
            latest = con.execute("SELECT value, as_of, source, def_hash FROM kr_readings WHERE repo=? AND kr=?"
                                 " ORDER BY measured_at DESC, rowid DESC LIMIT 1", (str(repo), k)).fetchone()
            if latest is not None and tuple(latest) == (v, as_of, src, h):
                continue
            con.execute("INSERT INTO kr_readings (repo, kr, value, as_of, source, measured_at, def_hash)"
                        " VALUES (?, ?, ?, ?, ?, ?, ?)", (str(repo), k, v, as_of, src, _sortable_timestamp(now), h))
            kept += v != FAILED
    return kept


def _closer(op: str, goal: Decimal, prev: Decimal, cur: Decimal) -> str:
    dist = {">=": lambda v: -v, ">": lambda v: -v, "<=": lambda v: v, "<": lambda v: v}.get(op, lambda v: abs(v - goal))
    return "closer" if dist(cur) < dist(prev) else "away" if dist(cur) > dist(prev) else "flat"


def _latest_as_of_per_round(readings: list) -> dict:
    return {r["measured_at"]: r for r in readings}


def _impacts(op: str, goal: Decimal, readings: list, declared: list) -> tuple[list, list]:
    rounds = _latest_as_of_per_round(readings)
    times = sorted(rounds)
    last = times[-1] if times else ""
    pending = [{"ticket": i["ticket"], "dir": i["dir"], "before": i["before"], "after": i["after"],
                "basis": i["basis"], "at": i["declared_at"]} for i in declared if i["declared_at"] >= last]
    if len(times) < 2:
        return pending, []
    prev = times[-2]
    moved = _closer(op, goal, Decimal(rounds[prev]["value"]), Decimal(rounds[last]["value"]))
    judged_by_their_first_round = [i for i in declared if prev <= i["declared_at"] < last]
    off = {i["ticket"]: i["dir"] for i in judged_by_their_first_round if _declaration_contradicted(i["dir"], moved)}
    return pending, [{"ticket": t, "dir": d} for t, d in off.items()]


def _declaration_contradicted(declared_dir: str, moved: str) -> bool:
    if declared_dir == "↑":
        return moved != "closer"
    return declared_dir == "=" and moved == "away"



def impact_text(data: dict) -> str:
    out = []
    for o in data["objectives"]:
        n = o["impacts"]
        if any(n.values()):
            out.append(f"O {o['name']} · 声明 ↑{n['↑']} ↓{n['↓']} ={n['=']}")
        out += [f"  预期不符 {k['name']}：" + "、".join(f"{m['ticket']} 声明 {m['dir']}" for m in k["mismatch"])
                for k in o["krs"] if k["mismatch"]]
    return "\n".join(out)


MISSED_ROUNDS_TO_FLAG = 5
ROUNDS_WITHOUT_PROGRESS_TO_FLAG = 2
RECENT_READINGS_SHOWN = 3


def okr_data(path: Path | str, repo: Path) -> dict:
    objectives = _okr_defs(repo)
    rows, accepts, declared = _stored_okr_rows(path, repo)
    by_kr: dict[str, list] = {}
    for r in rows:
        by_kr.setdefault(r["kr"], []).append(r)
    head = subprocess.run(["git", "log", "-1", "--format=%h", "--", OKR_FILE], cwd=repo,
                          capture_output=True, text=True).stdout.strip()
    out = {"repo": str(repo), "def_commit": head or None,
           "last_measured_at": max((r["measured_at"] for r in rows), default=None), "met": 0, "total": 0,
           "objectives": [], "attention": []}
    for o in objectives:
        objective = _objective_view(o, by_kr, accepts, declared, out["attention"])
        out["objectives"].append(objective)
        out["met"] += objective["met"]
        out["total"] += objective["total"]
    return out


def _stored_okr_rows(path: Path | str, repo: Path) -> tuple[list, dict, dict[tuple, list]]:
    with closing(open_readonly(path)) as con:
        rows = con.execute("SELECT kr, value, as_of, source, measured_at, def_hash FROM kr_readings WHERE repo=?"
                           " ORDER BY measured_at, as_of, rowid", (str(repo),)).fetchall()
        accepts = dict(con.execute("SELECT objective, max(accepted_at) FROM okr_accepts WHERE repo=?"
                                   " GROUP BY objective", (str(repo),)).fetchall())
        declared: dict[tuple, list] = {}
        for i in con.execute("SELECT ticket, objective, kr, dir, before, after, basis, declared_at FROM kr_impacts"
                             " WHERE repo=? AND kr != '' ORDER BY declared_at", (str(repo),)):
            declared.setdefault((i["objective"], i["kr"]), []).append(i)
    return rows, accepts, declared


def _objective_view(o: dict, by_kr: dict, accepts: dict, declared: dict, attention: list) -> dict:
    name, krs, late_miss, counts = o.get("name"), [], False, {"↑": 0, "↓": 0, "=": 0}
    for kr in o.get("kr", []):
        view, missed_after_accept = _kr_view(name, kr, by_kr.get(kr["name"], []), accepts,
                                             declared.get((name, kr["name"]), []), attention)
        late_miss |= missed_after_accept
        for i in view["impacts"]:
            counts[i["dir"]] += 1
        krs.append(view)
    met = sum(k["status"] == "met" for k in krs)
    pending = bool(krs) and met == len(krs) and (name not in accepts or late_miss)
    if pending:
        attention.append({"kind": "accept", "objective": name, "kr": None,
                          "text": f"{name} 全 ✓，待你验收（nawaban okr --accept）"})
    return {"name": name, "met": met, "total": len(krs), "accept_pending": pending, "impacts": counts, "krs": krs}


def _kr_view(name: str, kr: dict, kept: list, accepts: dict, declared: list, attention: list) -> tuple[dict, bool]:
    op, goal = _TARGET.fullmatch(kr["target"].strip()).groups()
    g = Decimal(goal)
    ok = lambda r: _MEETS_ON_DECIMAL[op](Decimal(r["value"]), g)
    rounds, rs, version = _rounds_and_current_series(kept)
    failure = kept[-1]["source"] if kept and kept[-1]["value"] == FAILED else None
    missed = _missed_rounds_since_last_met(rs, ok)
    last = rs[-1] if rs else None
    status = "unmeasurable" if failure is not None else _kr_status(kr, last, missed)
    trends = [_closer(op, g, Decimal(a["value"]), Decimal(b["value"])) for a, b in zip(rs, rs[1:])]
    missed_after_accept = name in accepts and any(r["measured_at"] > accepts[name] and not ok(r) for r in rounds)
    pending, mismatch = _impacts(op, g, rs, declared)
    recent = rs[-RECENT_READINGS_SHOWN:]
    view = {"name": kr["name"], "target": f"{op} {goal}", "target_op": op, "target_value": float(goal), "unit": kr.get("unit", ""), "status": status,
            "value": last and float(last["value"]), "as_of": last and last["as_of"],
            "source": last and last["source"],
            "history": [{"value": float(r["value"]), "as_of": r["as_of"]} for r in recent],
            "trend": trends[-1] if trends else None, "missed_rounds": missed, "wait": kr.get("wait"),
            "impacts": pending, "mismatch": mismatch, "failure": failure,
            "series": {"version": version, "since": rs[0]["measured_at"][:10], "def_hash": rs[0]["def_hash"]} if rs else None}
    attention += _kr_attention(name, kr, op, goal, status, missed, trends, "、".join(r["value"] for r in recent))
    return view, missed_after_accept


def _rounds_and_current_series(kept: list) -> tuple[list, list, int]:
    starts = [i for i, r in enumerate(kept) if i == 0 or kept[i - 1]["def_hash"] != r["def_hash"]]
    current = kept[starts[-1]:] if starts else []
    return _rounds(kept), _rounds(current), len(starts)


def _rounds(kept: list) -> list:
    readings = [r for r in kept if r["value"] != FAILED]
    same = lambda a, b: (a["value"], a["as_of"], a["source"], a["def_hash"]) == (b["value"], b["as_of"], b["source"], b["def_hash"])
    return [r for i, r in enumerate(readings) if i == 0 or not same(readings[i - 1], r)]


def _missed_rounds_since_last_met(rs: list, ok) -> int:
    missed = 0
    for r in reversed(rs):
        if ok(r):
            break
        missed += 1
    return missed


def _kr_status(kr: dict, last, missed: int) -> str:
    if last is None:
        return "untested"
    if kr.get("max_age_days") is not None and _stale(last["as_of"], kr["max_age_days"]):
        return "stale"
    return "missed" if missed else "met"


def _kr_attention(name: str, kr: dict, op: str, goal: str, status: str, missed: int, trends: list,
                  seen: str) -> list[dict]:
    out = []
    if missed >= MISSED_ROUNDS_TO_FLAG:
        out.append({"kind": "five", "objective": name, "kr": kr["name"],
                    "text": f"连续 {missed} 轮未达标（{op} {goal}），最近三次 {seen}"})
    elif status == "missed" and _no_progress_for_the_last_rounds(trends):
        out.append({"kind": "stuck", "objective": name, "kr": kr["name"],
                    "text": f"两轮没往目标走（{op} {goal}），最近三次 {seen}"})
    if kr.get("wait") and not kr.get("measure"):
        out.append({"kind": "wait", "objective": name, "kr": kr["name"], "text": kr["wait"]})
    return out


def _no_progress_for_the_last_rounds(trends: list) -> bool:
    n = ROUNDS_WITHOUT_PROGRESS_TO_FLAG
    return len(trends) >= n and "closer" not in trends[-n:]



GH_WORDS = {"claim": "认领", "release": "交还", "note": "进展", "decision": "决定", "link": "PR", "ask": "待决", "resolve": "已决",
            "impact": "影响"}
_TRAILING_ONE_LINE_MARKER = re.compile(r"\n*<!-- nawaban (\{[^\n]*\}) -->\s*\Z")
_GH_ISSUE = re.compile(r"#(\d+)")
HC_TIMEOUT_SECONDS = 3
BOARD_WRITE_TIMEOUT_SECONDS = 30


def marker(ev: dict) -> str:
    import json
    every_dash_escaped = json.dumps(ev, ensure_ascii=False).replace("-", "\\u002d")
    return "<!-- nawaban " + every_dash_escaped + " -->"


def read_marker(comment: str) -> dict | None:
    import json
    m = _TRAILING_ONE_LINE_MARKER.search(comment)
    try:
        return json.loads(m.group(1)) if m else None
    except ValueError:
        return None


def gh_post(root: Path, number: str, kind: str, body: str, kr: str | None = None, by: str | None = None) -> None:
    import uuid
    ev = {"v": 1, "uid": str(uuid.uuid4()), "kind": kind, "author": identity(),
          "terminal": herdr_terminal(), "at": int(time.time()), "body": body}
    if kr:
        ev["kr"] = kr
    if by:
        ev["by"] = by
    text = f"{GH_WORDS[kind]}：{body}\n\n{marker(ev)}"
    pushed_by_the_board = _repo_the_board_pushes(root)
    if pushed_by_the_board:
        _write_on_the_board_first(["github-reply", pushed_by_the_board, number], text)
    else:
        _gh(root, "issue", "comment", number, "--body", text)


def _repo_the_board_syncs(root: Path) -> str | None:
    try:
        config = json.loads((_board_dir() / "github-sync.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return next((repo for repo, channel in (config.get("repos") or {}).items() if channel == root.name), None)


def _repo_the_board_pushes(root: Path) -> str | None:
    import json
    try:
        config = json.loads((_board_dir() / "github-sync.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    repos = config.get("repos") or {}
    return next((repo for repo in config.get("push") or [] if repos.get(repo) == root.name), None)


def _write_on_the_board_first(hook: list[str], text: str = "") -> None:
    try:
        r = subprocess.run(["node", str(_PLUGIN / "board" / "src" / "cli.ts"), "hook", *hook],
                           input=text, capture_output=True, text=True, timeout=BOARD_WRITE_TIMEOUT_SECONDS)
    except (OSError, subprocess.SubprocessError) as e:
        raise Refused(f"板写不进:{e}")
    if r.returncode != 0:
        raise Refused(f"板写不进:{(r.stderr or r.stdout).strip()}")


def _role(terminal: str) -> str | None:
    import json
    try:
        r = subprocess.run(["hc", "get", terminal, "--json"], capture_output=True, text=True, timeout=HC_TIMEOUT_SECONDS)
        return (json.loads(r.stdout).get("labels") or {}).get("role") if r.returncode == 0 else None
    except (ValueError, AttributeError, OSError, subprocess.SubprocessError):
        return None


def _orchestrator_here() -> bool:
    t = os.environ.get("HC_TERMINAL_ID")
    if t:
        return _role(t) == "orchestrator"
    no_claude_session_so_a_person_at_a_shell = not os.environ.get("CLAUDE_CODE_SESSION_ID")
    return no_claude_session_so_a_person_at_a_shell


def repo_orchestrator(root: Path) -> str | None:
    import json
    me = os.environ.get("HC_TERMINAL_ID")
    if me and _role(me) == "orchestrator":
        return me
    try:
        ts = json.loads(subprocess.run(["hc", "ls", "--json"], capture_output=True, text=True).stdout)["terminals"]
    except (ValueError, KeyError, TypeError):
        return None
    return next((t["address"] for t in ts if _live_orchestrator_in(t, root)), None)


def _live_orchestrator_in(t: dict, root: Path) -> bool:
    cwd = t.get("cwd")
    return (t.get("state") == "live" and bool(cwd) and _repo_root(Path(cwd)) == root
            and _role(t["address"]) == "orchestrator")


WORKER_NAME = re.compile(r"[a-z0-9_-]{1,32}")
WORKER_TITLE_TASK_CHARS = 24
_CONVENTIONAL_PREFIX = re.compile(r"\s*[a-z]+(?:\(([^)]*)\))?!?:\s*", re.I)


def worker_title(ticket_title: str, tag: str) -> str:
    prefix = _CONVENTIONAL_PREFIX.match(ticket_title)
    scope = (prefix.group(1) or "").strip() if prefix else ""
    task = ticket_title[prefix.end() if prefix else 0:].strip()
    if len(task) > WORKER_TITLE_TASK_CHARS:
        task = task[:WORKER_TITLE_TASK_CHARS] + "…"
    return f"{f'【{scope}】' if scope else ''}{task} {tag}"


def _refuse_unidentified() -> None:
    identity()


def dispatch(root: Path, a, con: sqlite3.Connection | None = None) -> str:
    n, title = None, None
    if a.id:
        _refuse_unidentified()
        n, ticket_title = _refuse_unless_ticket_open(root, a, con)
        title = worker_title(ticket_title, f"#{n}" if n else a.id)
    orch = repo_orchestrator(root)
    if not orch:
        raise Refused("没有活着的编排者(role=orchestrator)可收回报")
    name = a.name or (f"w-{n}" if n else a.id.lower())
    if not WORKER_NAME.fullmatch(name):
        raise Refused(f"--name 只能 1-32 个 a-z 0-9 - _:{name}")
    wt, branch = root.parent / f"{root.name}-{name}", f"wt/{name}"
    _add_worktree_off_origin_main(root, wt, branch)
    who = a.id or name
    addr = _start_worker_or_remove_its_worktree(root, a, con, name, title or name, wt, branch,
                                                _worker_brief(a, n, name, wt, branch, orch, who))
    if a.id:
        _record_dispatch_on_the_ticket(root, a, con, n, name, addr, wt, orch)
    return f"✓ dispatch {who} → hc {addr} · {wt}"


def _refuse_unless_ticket_open(root: Path, a, con: sqlite3.Connection | None) -> tuple[str | None, str]:
    if con is not None:
        task = _task(con, a.id)
        if task["status"] != "open":
            raise Refused(f"{a.id} 不是开着的任务")
        return None, task["title"]
    m = _GH_ISSUE.fullmatch(a.id)
    if not m:
        raise Refused(f"GitHub 记账的仓库只接 #N:{a.id}")
    n = m.group(1)
    issue = _gh_json(root, "issue", "view", n, "--json", "state,title")
    if issue.get("state") != "OPEN":
        raise Refused(f"{a.id} 不是开着的 issue")
    return n, issue.get("title") or ""


def _add_worktree_off_origin_main(root: Path, wt: Path, branch: str) -> None:
    for cmd in (["fetch", "-q", "origin", "main"], ["worktree", "add", "-q", "-b", branch, str(wt), "origin/main"]):
        r = subprocess.run(["git", "-C", str(root), *cmd], capture_output=True, text=True)
        if r.returncode != 0:
            raise Refused(f"git {cmd[0]} 失败:{r.stderr.strip()}")


def _worker_brief(a, n: str | None, name: str, wt: Path, branch: str, orch: str, who: str) -> str:
    ticket = (f"Issue：{a.id}（认领、进展用 nawaban 命令记，见 docs/agents/issue-tracker.md）" if n else
              f"任务：{a.id}（nawaban show {a.id} 看全文；认领、进展、关闭用 nawaban 命令记）" if a.id else f"任务：{name}")
    return "\n".join([
        f"/pstack:poteto-mode {ticket}",
        f"worktree：{wt}（分支 {branch}，已从 origin/main 拉好；只在这里改，PR 合并或作废后 git worktree remove）",
        a.brief,
        f"验收：{a.accept}",
        "完成或受阻：只发一行，照抄其一，PR 号填上；结论、实测输出、卡在哪、要谁做什么都写在票上：",
        f'  hc send {orch} "回报：{who} 完成 PR #<号>"',
        f'  hc send {orch} "回报：{who} 受阻，详情在票上"',
        "只发这一行：中途进展、阶段结果记在票上的「进展」里，不发给编排者（每条消息都会叫醒它，留在它的上下文里）。",
    ])


def _start_worker_or_remove_its_worktree(root: Path, a, con, name: str, title: str, wt: Path, branch: str,
                                         brief: str) -> str:
    import json
    r = subprocess.run(["hc", "run", "--bg", "--outlive-parent", "--json", "--name", name, "--cwd", str(wt),
                        *_board_the_worker_must_reach(con), "claude", "-n", title, "--model", a.model, brief],
                       capture_output=True, text=True)
    try:
        return json.loads(r.stdout)["address"]
    except (ValueError, KeyError, TypeError):
        subprocess.run(["git", "-C", str(root), "worktree", "remove", "--force", str(wt)], capture_output=True)
        subprocess.run(["git", "-C", str(root), "branch", "-D", branch], capture_output=True)
        raise Refused(f"hc run 失败,worktree 已删:{(r.stderr or r.stdout).strip()}")


def _board_the_worker_must_reach(con: sqlite3.Connection | None) -> list[str]:
    if con is None:
        return []
    return ["env", f"NAWABAN_DB={con.execute('PRAGMA database_list').fetchone()[2]}"]


def _record_dispatch_on_the_ticket(root: Path, a, con, n: str | None, name: str, addr: str, wt: Path,
                                   orch: str) -> None:
    panel_names_the_orchestrator_by = f"dispatch: {name} · " if con is not None else ""
    note = panel_names_the_orchestrator_by + f"派给 hc {addr}（worktree {wt}，回报给 {orch}）\n验收：{a.accept}"
    try:
        if con is not None:
            add_event(con, a.id, identity(), "note", note)
            con.commit()
        else:
            gh_post(root, n, "note", note)
    except (Refused, OSError, sqlite3.Error) as e:
        raise Refused(f"已派给 hc {addr}（{wt}），但记票失败:{e}\n补记:nawaban event {shlex.quote(a.id)} --kind note --body {shlex.quote(note)}")


RETIRE_GH_TIMEOUT_SECONDS = 8
RETIRE_BOARD_TIMEOUT_SECONDS = 10
RETIRE_CHECKS_START_WITHIN_SECONDS = 15
_COMMAND_SEPARATORS = ";&|()<>\n"
_ASSIGNMENT = re.compile(r"\w+=")
_WORDS_BEFORE_A_COMMAND = {"then", "do", "else", "elif", "if", "while", "until", "!", "time", "exec", "command", "{"}
_DISPATCHED_TO = re.compile(r"派给 hc (\S+?)（")


def retiring_terminals(command: str) -> list[str]:
    lex = shlex.shlex(command.replace("\\\n", " "), posix=True, punctuation_chars=_COMMAND_SEPARATORS)
    lex.whitespace, lex.whitespace_split = " \t\r", True
    try:
        tokens = list(lex)
    except ValueError:
        return []
    named, start = [], 0
    for i, tok in enumerate(tokens + [";"]):
        if set(tok) <= set(_COMMAND_SEPARATORS):
            words = tokens[start:i]
            while words and (_ASSIGNMENT.match(words[0]) or words[0] in _WORDS_BEFORE_A_COMMAND):
                words.pop(0)
            if words[:1] == ["hc"] and words[1:2] in (["kill"], ["rm"]):
                named += [w for w in words[2:] if not w.startswith("-") and not re.search(r"[$`*]", w)]
            start = i + 1
    return named


def retire_refusal(command: str, cwd: Path) -> tuple[str | None, str | None]:
    held, unread = [], []
    started = time.monotonic()
    for t in retiring_terminals(command):
        if time.monotonic() - started > RETIRE_CHECKS_START_WITHIN_SECONDS:
            unread.append(f"{t}:来不及查")
            continue
        term = _terminal_or_none(t)
        if not term:
            continue
        addr = term["address"]
        start = Path(term.get("cwd") or cwd)
        try:
            held += [(addr, k) for k in _tickets_held_from(addr, start if start.is_dir() else cwd)]
        except (Refused, OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError) as e:
            unread.append(f"{addr}:{e}")
    warning = f"没查清终端名下的票,放行(只凭确证才拦):{'; '.join(unread)}" if unread else None
    return (_retire_refusal_text(held) if held else None), warning


def _terminal_or_none(t: str) -> dict | None:
    import json
    try:
        r = subprocess.run(["hc", "get", t, "--json"], capture_output=True, text=True, timeout=HC_TIMEOUT_SECONDS)
        term = json.loads(r.stdout) if r.returncode == 0 else None
    except (ValueError, OSError, subprocess.SubprocessError):
        return None
    return term if isinstance(term, dict) and term.get("address") else None


def _tickets_held_from(addr: str, where: Path) -> list[str]:
    if root := github_root(where):
        return _issues_held_from(root, addr)
    root = _repo_root(where.resolve())
    via = os.environ.get("NAWABAN_CLI") or ("board" if root and root.name in moved_projects() else "old")
    return _board_tasks_held_from(addr) if root and via == "board" else []


def _issues_held_from(root: Path, addr: str) -> list[str]:
    import json
    r = _run_gh(root, "issue", "list", "--state", "open", "--search", f"{addr} in:comments", "--limit", GH_ISSUE_LIST_LIMIT,
                "--json", "number,assignees,comments", timeout=RETIRE_GH_TIMEOUT_SECONDS)
    if r.returncode != 0:
        raise Refused(f"gh 失败:{r.stderr.strip()}")
    return [f"#{i['number']}" for i in json.loads(r.stdout)
            if i["assignees"] and _last_terminal_named_on(i["comments"]) == addr]


def _last_terminal_named_on(comments: list[dict]) -> str | None:
    named = None
    for c in comments:
        ev = read_marker(c["body"]) or {}
        if ev.get("kind") == "claim" and ev.get("terminal"):
            named = ev["terminal"]
        elif ev.get("kind") == "note" and (m := _DISPATCHED_TO.match(str(ev.get("body", "")))):
            named = m.group(1)
    return named


def _board_tasks_held_from(addr: str) -> list[str]:
    import json
    r = subprocess.run(["node", str(_PLUGIN / "board" / "src" / "cli.ts"), "list", "--json"],
                       capture_output=True, text=True, timeout=RETIRE_BOARD_TIMEOUT_SECONDS)
    if r.returncode != 0:
        raise Refused(f"板读不到:{r.stderr.strip()}")
    now = _dt.datetime.now(_dt.timezone.utc)
    return [t["labels"].get("key") or f"#{t['id']}" for t in json.loads(r.stdout)["tasks"]
            if t["task"].get("state") == "claimed" and t["labels"].get("terminal") == addr
            and _dt.datetime.fromisoformat(t["task"]["claim"]["until"].replace("Z", "+00:00")) > now]


def _retire_refusal_text(held: list[tuple[str, str]]) -> str:
    lines = [f"终端 {addr} 还拿着 {key}(开着、在它名下)" for addr, key in held]
    return "\n".join(lines + [
        "收 worker 前,票要么关、要么交还,由 worker 自己做(hc send <终端> 让它做;GitHub 的票你也能直接做):",
        "  做完:nawaban event <ID> --kind link --body \"pr:<url>\" 后 nawaban close <ID> --done",
        "  没做完:nawaban event <ID> --kind note --body \"已完成：… / 下一步：… / 卡点：…\" 后 nawaban claim <ID> --release",
        "本地板上 worker 已不动了:等它的认领租约过期(最多 1h)再收。",
    ])


def gh_write(root: Path, a) -> str:
    n = _GH_ISSUE.fullmatch(a.id).group(1)
    who_before_any_remote_write = identity()
    if a.verb == "claim":
        return _gh_claim(root, a, n, who_before_any_remote_write)
    if a.verb == "close":
        return _gh_close(root, a, n)
    if a.kind == "resolve" and not _orchestrator_here():
        raise Refused("已决(决策记录)只由编排者记：决策者的拍板转给编排者，或决策者在 Herdr 外的终端自己记")
    if a.kind == "ask":
        _refuse_a_second_pending_ask(root, a, n)
    gh_post(root, n, a.kind, a.body, a.kr, a.by)
    return f"✓ event {a.id} · {a.kind}"


def _gh_claim(root: Path, a, n: str, who: str) -> str:
    if not _repo_the_board_pushes(root):
        _gh(root, "issue", "edit", n, "--remove-assignee" if a.release else "--add-assignee", "@me")
    if a.release:
        gh_post(root, n, "release", who)
        _forget_the_claim_here(root, n)
        return f"✓ release {a.id}"
    here = herdr_terminal()
    gh_post(root, n, "claim", who + (f"（hc {here}）" if here else ""))
    _record_the_claim_here(root, n, who)
    return f"✓ claim {a.id}" + (f" · terminal {here}" if here else "")


def _gh_close(root: Path, a, n: str) -> str:
    pushed_by_the_board = _repo_the_board_pushes(root)
    if pushed_by_the_board:
        _write_on_the_board_first(["github-state", pushed_by_the_board, n, "open" if a.reopen else "completed" if a.done else "not_planned"])
        if not a.reopen:
            _forget_the_claim_here(root, n)
    elif a.reopen:
        _gh(root, "issue", "reopen", n)
    else:
        _gh(root, "issue", "close", n, "--reason", "completed" if a.done else "not planned")
        _forget_the_claim_here(root, n)
    return f"✓ close {a.id} → {'open' if a.reopen else 'done' if a.done else 'cancelled'}"


MILESTONES = ("started", "edited", "committed", "pr", "review", "reported")


def _board_dir() -> Path:
    return Path(os.environ.get("NAWABAN_BOARD_DIR") or Path.home() / ".nawaban" / "board").expanduser()


def _issue_file(folder: str, root: Path, n: str) -> Path:
    return _board_dir() / folder / f"{root.name}#{n}.json"


def _record_the_claim_here(root: Path, n: str, who: str) -> None:
    import json
    claim = _issue_file("github-claims", root, n)
    claim.parent.mkdir(parents=True, exist_ok=True)
    _issue_file("progress", root, n).unlink(missing_ok=True)
    claim.write_text(json.dumps({"session": who, "claimedAt": time.time()}))


def _forget_the_claim_here(root: Path, n: str) -> None:
    for folder in ("github-claims", "progress"):
        _issue_file(folder, root, n).unlink(missing_ok=True)


def _live_of(root: Path, n: int, claimant: str) -> dict | None:
    import json
    try:
        claim = json.loads(_issue_file("github-claims", root, str(n)).read_text())
        live = json.loads(_issue_file("progress", root, str(n)).read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(claim, dict) or claim.get("session") != claimant.split("（", 1)[0].strip():
        return None
    ok = isinstance(live, dict) and live.get("milestone") in MILESTONES and isinstance(live.get("at"), (int, float))
    return {"milestone": live["milestone"], "at": live["at"]} if ok else None


def _refuse_a_second_pending_ask(root: Path, a, n: str) -> None:
    issue = _gh_json(root, "issue", "view", n, "--json", "body,createdAt,comments")
    if _issue_pending(issue):
        raise Refused(f"{a.id} 已有待决,一个 issue 只放一件;先记已决(决策记录),或开子 issue")


def _marked(c: dict) -> dict | None:
    ev = read_marker(c["body"])
    ok = isinstance(ev, dict) and isinstance(ev.get("body"), str) and GH_WORDS.get(str(ev.get("kind")))
    return ev if ok else None


def _canonical(c: dict) -> dict:
    ev = _marked(c)
    if ev:
        return {**c, "body": f"{GH_WORDS[ev['kind']]}：{ev['body']}"}
    visible_text_of_a_malformed_marker = _TRAILING_ONE_LINE_MARKER.sub("", c["body"])
    return {**c, "body": visible_text_of_a_malformed_marker}


def _at(iso: str) -> int:
    return int(_dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())


def _prefixed(comments: list[dict], word: str) -> list[tuple[str, int]]:
    out = []
    for c in comments:
        m = re.match(_GH_PREFIX_HEADING_BOLD_WORD_WHO_COLON.format(word), c["body"])
        if m:
            out.append(((m.group(1) or "") + c["body"][m.end():].strip(), _at(c["createdAt"])))
    return out


def _ask_of(c: dict, line: int, brief: str) -> str:
    import hashlib
    return f"{c['createdAt']}:{line}:{hashlib.sha256(brief.encode()).hexdigest()[:12]}"


def _issue_pending(i: dict) -> dict | None:
    i = {**i, "comments": [_canonical(c) for c in i["comments"]]}
    found = _latest_unresolved_ask_line(i)
    if not found:
        return None
    c, k = found
    lines = c["body"].splitlines()
    notes = _prefixed([{**x, "body": "\n".join(lines[:k])} if x is c else x for x in i["comments"]], "进展")
    brief, at = "\n".join(lines[k:]), _at(c["createdAt"])
    return {"brief": brief, "at": at, "ask": _ask_of(c, k, brief),
            "progress": [{"body": b, "at": t} for b, t in notes[-PENDING_NOTES:]],
            "card": _decision_card(brief), "talk": _talk_in_a_window(brief),
            "ruled_after": _owner_ruled_since([b for b, t in notes if t > at], _owner_names())}


_OLD_CARD_FIELD = re.compile(r"^\s*【(Decision|Objective / KR|Context|Options|Recommendation)】(.*)")
_DR_FIELD = re.compile(r"^\s*(决策事项|关联\s*KR|背景|备选方案|建议)\s*[:：](.*)")
_ENGLISH_DR_FIELD = re.compile(r"^\s*(BLUF|KR|Context|Options|Recommendation)\s*[:：](.*)")
_CARD_FIELD_SYNTAXES = (_OLD_CARD_FIELD, _DR_FIELD, _ENGLISH_DR_FIELD)
_CARD_OPTION_LINE = re.compile(r"^\s*[-*]\s+(.*)")
_CARD_OPTION_LETTER = re.compile(r"^([A-Z])\s*[：:]\s*")
_CARD_OPTION_NOTE = "｜"
_CARD_FIELD_KEYS = {"Decision": "decision", "BLUF": "decision", "决策事项": "decision", "Objective / KR": "kr", "KR": "kr",
                    "Context": "context", "背景": "context", "Recommendation": "rec", "建议": "rec", "备选方案": "Options"}


_PENDING_HEADING = re.compile(_GH_PREFIX_HEADING_BOLD_WORD_WHO_COLON.format("(?:待决|需要你定)"))
_WORDS_THAT_SAY_NOTHING = frozenset({"", "-", "--", "—", "——", "无", "暂无", "待定", "未定", "略", "none", "n/a", "null", "tbd", "todo", "?", "？", "...", "…"})
_SPACES_A_PLACEHOLDER_MAY_CARRY = r"[ \t\n\r\f\v\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+"
_CARD_PARTS_THAT_MUST_SAY_SOMETHING = (("decision", "决策事项(--body)"), ("context", "背景(--context)"),
                                       ("rec", "建议(--rec)"))


def _decision_card_parts(brief: str) -> tuple[dict, list[dict]]:
    fields, options, current = {}, [], None
    lines = re.split(r"\r?\n", _PENDING_HEADING.sub("", brief, count=1))
    one_syntax_per_card = next((s for ln in lines for s in _CARD_FIELD_SYNTAXES if s.match(ln)), _DR_FIELD)
    for ln in lines:
        o = _CARD_OPTION_LINE.match(ln) if current == "Options" else None
        m = None if o else one_syntax_per_card.match(ln)
        if o:
            options.append(_card_option(o.group(1).strip(), len(options)))
        elif m:
            name = re.sub(r"关联\s*KR", "KR", m.group(1))
            current = _CARD_FIELD_KEYS.get(name, name)
            if current != "Options":
                fields[current] = m.group(2).strip()
        elif current in fields:
            fields[current] = "\n".join(filter(None, [fields[current], ln.strip()]))
    return fields, options


def _decision_card_gaps(fields: dict, options: list[dict]) -> list[str]:
    gaps = [name for key, name in _CARD_PARTS_THAT_MUST_SAY_SOMETHING if _says_nothing(fields.get(key))]
    if not (fields.get("kr") or "").strip():
        gaps.append("关联 KR(--kr)")
    if len(options) < MIN_DECISION_OPTIONS:
        gaps.append(f"备选方案(至少 {MIN_DECISION_OPTIONS} 个)")
    gaps += [f"{o['key']} 的{'方案' if _says_nothing(o['text']) else '代价(｜后)'}" for o in options
             if _says_nothing(o["text"]) or _says_nothing(_trade_off_of(o))]
    return gaps


def _says_nothing(part: str | None) -> bool:
    return re.sub(_SPACES_A_PLACEHOLDER_MAY_CARRY, "", part or "").lower() in _WORDS_THAT_SAY_NOTHING


def _trade_off_of(option: dict) -> str:
    return option["note"].partition(_CARD_OPTION_NOTE)[0].strip()


def _decision_card(brief: str) -> dict | None:
    fields, options = _decision_card_parts(brief)
    return None if _decision_card_gaps(fields, options) else {**fields, "options": options}


def _card_option(line: str, position: int) -> dict:
    lettered = _CARD_OPTION_LETTER.match(line)
    text, _, note = line[lettered.end() if lettered else 0:].partition(_CARD_OPTION_NOTE)
    return {"key": lettered.group(1) if lettered else f"第 {position + 1} 项", "text": text.strip(), "note": note.strip()}


_GO_TO_A_WINDOW = re.compile(r"[去到在]\s*([\w.-]+?)\s*窗口")
_TALK_IN_A_WINDOW = "窗口盘问"


def _talk_in_a_window(brief: str) -> dict | None:
    named = _GO_TO_A_WINDOW.search(brief)
    if not named and _TALK_IN_A_WINDOW not in brief:
        return None
    return {"window": named.group(1) if named else None}


_OWNER_SAID_GO = "回「行」"


def _owner_ruled_since(notes: list[str], names: list[str]) -> bool:
    asking = _asking_for_a_ruling(names)
    return any(w in asking.sub("", n) for n in notes for w in ["拍板", _OWNER_SAID_GO, *names])


def _latest_unresolved_ask_line(i: dict) -> tuple[dict, int] | None:
    found = None
    body_raised_at_creation = {"body": i.get("body") or "", "createdAt": i["createdAt"]}
    for c in [body_raised_at_creation, *i["comments"]]:
        for k, ln in enumerate(c["body"].splitlines()):
            if _prefixed([{"body": ln, "createdAt": c["createdAt"]}], "(?:待决|需要你定)"):
                found = (c, k)
            elif _prefixed([{"body": ln, "createdAt": c["createdAt"]}], "已决"):
                found = None
    return found



def _owner_names() -> list[str]:
    return [n.strip() for n in os.environ.get("NAWABAN_OWNER_NAMES", "").split(",") if n.strip()]


def _asking_for_a_ruling(names: list[str]) -> re.Pattern:
    owner_or_short_name = [*map(re.escape, names), r"\w{1,4}?"]
    return re.compile(r"[等待]\s*(?:%s)?\s*拍板" % "|".join(owner_or_short_name))


def _parent_of(i: dict) -> int | None:
    if i.get("parent"):
        return i["parent"]["number"]
    m = _GH_PARENT_SUFFIX_IN_TITLE.search(i["title"]) or _GH_PARENT_BODY.search(i.get("body") or "")
    return int(m.group(1)) if m else None


def github_board_data(root: Path) -> dict:
    names = _owner_names()
    asking = _asking_for_a_ruling(names)
    since = time.time() - DECISIONS_RECENT
    tasks, recent = [], []
    for i in _gh_issues(root):
        if i.get("stateReason") == "NOT_PLANNED":
            continue
        cs = [_canonical(c) for c in i["comments"]]
        decided = _recent_decisions_of_issue(i, cs, 0, names, asking)
        recent += [d for d in decided if d["at"] >= since]
        ruling = max((d for d in decided if d["owner"]), key=lambda d: d["at"], default=None)
        tasks.append(_issue_task(root, i, cs, ruling))
    columns: dict[str, list] = {key: [] for key in COLUMNS}
    for t in sorted(tasks, key=lambda t: -t["active_at"]):
        columns[t["status"]].append(t)
    return {"tracker": "github", "columns": [{"key": k, "tasks": v} for k, v in columns.items()],
            "decisions": sorted(recent, key=lambda d: -d["at"])}


def _recent_decisions_of_issue(i: dict, cs: list[dict], since: float, names: list[str],
                               asking: re.Pattern) -> list[dict]:
    task = f"#{i['number']}"
    decided = [{"task": task, "at": t, "verdict": _verdict(body), "owner": _owners_call(raw, body, names, asking)}
               for raw, c in zip(i["comments"], cs) for body, t in _prefixed([c], "决定") if t >= since]
    resolved_by_the_owner = [{"task": task, "at": t, "verdict": _verdict(body), "owner": True}
                             for body, t in _prefixed(cs, "已决") if t >= since]
    return decided + resolved_by_the_owner


def _owners_call(raw: dict, body: str, names: list[str], asking: re.Pattern) -> bool:
    ev = _marked(raw) or {}
    if "by" in ev:
        return ev["by"] == "user"
    return any(w in asking.sub("", body) for w in ["拍板", *names])


def _claims_not_handed_back(cs: list[dict]) -> list[tuple[str, int]]:
    claims = _prefixed(cs, "认领")
    latest_in_comment_order = [w for c in cs for w in ("认领", "交还") if _prefixed([c], w)][-1:]
    return [] if latest_in_comment_order == ["交还"] else claims


def _issue_task(root: Path, i: dict, cs: list[dict], ruling: dict | None = None) -> dict:
    claims = _claims_not_handed_back(cs)
    notes, decisions = _prefixed(cs, "进展"), _prefixed(cs, "决定")
    assignees = [a["login"] for a in i.get("assignees") or []]
    status = "done" if i["state"] == "CLOSED" else "in_progress" if assignees else "open"
    parent = _parent_of(i)
    terminal = _GH_CLAIM_TERMINAL.search(claims[-1][0]) if claims else None
    claimant = claims[-1][0].split("\n", 1)[0] if claims else ", ".join(assignees)
    task = {
        "id": f"#{i['number']}", "title": i["title"], "status": status, "project": root.name,
        "parent": f"#{parent}" if parent else None,
        "session": claimant if status == "in_progress" else None,
        "created_at": _at(i["createdAt"]),
        "active_at": max([_at(i["updatedAt"])] + [_at(c["createdAt"]) for c in cs]),
        "open_blockers": 0, "terminal": terminal.group(1) if terminal else None, "leader": None,
        "claimed_at": claims[0][1] if claims else None, "url": i.get("url")}
    if status == "done":
        task["done_at"] = _at(i["closedAt"])
    else:
        task["progress"] = {"body": notes[-1][0], "at": notes[-1][1]} if notes else None
        task["blocked_by"] = []
        task["waiting"] = None
        task["decision"] = {"at": decisions[-1][1], "verdict": _verdict(decisions[-1][0])} if decisions else None
        task["pending"] = _issue_pending(i)
        task["ruling"] = {"at": ruling["at"], "verdict": ruling["verdict"]} if ruling else None
        task["live"] = _live_of(root, i["number"], claimant) if status == "in_progress" else None
    return task


_GH_EVENT_KINDS = {"进展": "note", "决定": "decision", "PR": "link", "待决": "ask", "已决": "resolve"}


def _issue_event(raw: dict, c: dict, names: list[str], asking: re.Pattern) -> dict | None:
    for word, kind in _GH_EVENT_KINDS.items():
        if said := _prefixed([c], word):
            ev = _marked(raw) or {}
            owner = kind == "resolve" or kind == "decision" and _owners_call(raw, said[0][0], names, asking)
            body = f"pr:{said[0][0]}" if kind == "link" else said[0][0]
            return {"kind": "decision" if kind == "resolve" else kind, "body": body,
                    "author": "user" if owner else ev.get("author") or (raw.get("author") or {}).get("login", ""),
                    "at": said[0][1]}
    return None


def github_task_detail(root: Path, task_id: str) -> dict:
    if not (m := _GH_ISSUE.fullmatch(task_id)):
        raise Refused(f"任务不存在:{task_id}")
    i = _gh_json(root, "issue", "view", m.group(1), "--json", _GH_FIELDS)
    cs = [_canonical(c) for c in i["comments"]]
    task = _issue_task(root, i, cs)
    names = _owner_names()
    events = [e for raw, c in zip(reversed(i["comments"]), reversed(cs))
              if (e := _issue_event(raw, c, names, _asking_for_a_ruling(names)))]
    parent = i.get("parent")
    return {
        "id": task["id"], "title": i["title"], "body": i.get("body") or "",
        "status": "cancelled" if i.get("stateReason") == "NOT_PLANNED" else task["status"],
        "project": root.name, "session": task["session"], "created_at": task["created_at"],
        "parent": {"id": f"#{parent['number']}", "title": parent.get("title", ""),
                   "status": "done" if parent.get("state") == "CLOSED" else "open"} if parent else None,
        "children": [], "blocked_by": [], "dependents": [],
        "latest_note": next((e for e in events if e["kind"] == "note"), None),
        "decisions": [e for e in events if e["kind"] == "decision"],
        "links": [e for e in events if e["kind"] == "link"],
        "events": events,
        "pending": task.get("pending"),
    }


def task_detail(path: Path | str, task_id: str) -> dict:
    with closing(open_readonly(path)) as con:
        t = con.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if t is None:
            raise Refused(f"任务不存在:{task_id}")
        events = [_event(r) for r in con.execute(
            "SELECT * FROM events WHERE task=? ORDER BY id DESC", (task_id,))]
        parent = con.execute("SELECT * FROM tasks WHERE id=?", (t["parent"],)).fetchone()
        children = con.execute("SELECT * FROM tasks WHERE parent=? ORDER BY id", (task_id,))
        return {
            "id": t["id"], "title": t["title"], "body": t["body"], "status": derived_status(t),
            "project": t["project"], "session": t["session"], "created_at": t["created_at"],
            "parent": _ref(parent) if parent else None,
            "children": [_ref(r) for r in children],
            "blocked_by": [_ref(r) for r in blocked_by(con, task_id)],
            "dependents": [_ref(r) for r in dependents(con, task_id)],
            "latest_note": next((e for e in events if e["kind"] == "note"), None),
            "decisions": [e for e in events if e["kind"] == "decision"],
            "links": [e for e in events if e["kind"] == "link"],
            "events": events,
        }



def any_board(path: Path, project: str | None) -> tuple[dict, str]:
    gh = github_root()
    if not gh:
        return board_data(path, project), project or "看板"
    return _read_github_refreshing_the_inbox(gh), gh.name


def _read_github_refreshing_the_inbox(gh: Path) -> dict:
    started = time.time()
    data = github_board_data(gh)
    inbox_save(gh, data, started)
    return data


INBOX_STALE = 300
INBOX_REFRESH_AT_MOST_EVERY_SECONDS = 60
INBOX_CACHE_NAME_HEX_DIGITS = 16


def _inbox_file(name: str) -> Path:
    return Path.home() / ".nawaban" / "inbox" / name


def _inbox_cache(root: Path) -> Path:
    import hashlib
    return _inbox_file(hashlib.sha1(str(root).encode()).hexdigest()[:INBOX_CACHE_NAME_HEX_DIGITS] + ".json")


def _replace_json_atomically(p: Path, obj) -> None:
    import json
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f"{p.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False))
    os.replace(tmp, p)


def inbox_save(root: Path, data: dict, started: float) -> None:
    p = _inbox_cache(root)
    try:
        _compare_and_write_under_lock(p, data, started)
    except OSError:
        return


def _compare_and_write_under_lock(p: Path, data: dict, started: float) -> None:
    import fcntl
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p.with_suffix(".lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if _cache_is_newer_than(p, started):
            return
        _replace_json_atomically(p, {"at": started, "items": [{"id": t["id"], "title": t["title"]} for t in _pending(data)]})


def _cache_is_newer_than(p: Path, started: float) -> bool:
    import json
    try:
        return json.loads(p.read_text())["at"] > started
    except (OSError, ValueError, KeyError, TypeError):
        return False


def inbox_refresh_later(root: Path) -> None:
    mark = _inbox_cache(root).with_suffix(".refreshing")
    if _refresh_started_within_the_interval(mark):
        return
    mark.parent.mkdir(parents=True, exist_ok=True)
    mark.touch()
    subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "index"], cwd=root, start_new_session=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _refresh_started_within_the_interval(mark: Path) -> bool:
    try:
        return time.time() - mark.stat().st_mtime < INBOX_REFRESH_AT_MOST_EVERY_SECONDS
    except OSError:
        return False


def inbox_items(path: Path) -> tuple[list[dict], float | None]:
    if root := github_root():
        return _github_inbox_from_cache(root)
    if not path.exists():
        return [], None
    project = default_project(path)
    with closing(open_readonly(path)) as con:
        rows = [r for r in _triage_notes(con)
                if waiting_question(r["body"]) is not None and (project is None or r["project"] == project)]
        return [{"id": r["task"], "title": _task(con, r["task"])["title"]} for r in rows], None


def _github_inbox_from_cache(root: Path) -> tuple[list[dict], float | None]:
    import json
    try:
        c = json.loads(_inbox_cache(root).read_text())
    except (OSError, ValueError):
        c = None
    age = time.time() - c["at"] if c else None
    if age is None or age > INBOX_STALE:
        inbox_refresh_later(root)
    return (c["items"], age) if c else ([], None)


INBOX_TITLE_WIDTH = 24
INBOX_LINE_WIDTH = 90


def inbox_line(path: Path, session: str) -> str | None:
    import json
    items, age = inbox_items(path)
    seen_file = _inbox_file(f"seen-{re.sub(r'[^\w-]', '_', session)}.json")
    try:
        seen = set(json.loads(seen_file.read_text()))
    except (OSError, ValueError, TypeError):
        seen = None
    ids = [i["id"] for i in items]
    _replace_json_atomically(seen_file, ids)
    if not items:
        return None
    stale = f" · {int(age // 60)} 分钟前" if age is not None and age > INBOX_STALE else ""
    if seen == set(ids):
        return f"待决 {len(items)} 件（无变化）{stale}"
    unseen_else_all_that_is_left = [i for i in items if i["id"] not in (seen or ())] or items
    listed = _short(" · ".join(f"{i['id']} {_short(i['title'], INBOX_TITLE_WIDTH)}" for i in unseen_else_all_that_is_left),
                    INBOX_LINE_WIDTH)
    return f"待决 {len(items)} 件：{listed}{stale}｜说「同步」看待决"


def json_out(path: Path, a) -> int:
    import json
    if a.what == "db":
        print(json.dumps({"db": str(path.resolve())}, ensure_ascii=False))
        return 0
    try:
        out = _json_view(path, a)
    except Refused as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        return 1
    print(json.dumps(out, ensure_ascii=False))
    return 0


def _json_view(path: Path, a) -> dict:
    if a.what == "projects":
        return projects_data(path)
    if a.what == "board":
        return any_board(path, a.project)[0]
    if a.what == "okr":
        if not (repo := _repo_root(Path(a.repo or ".").resolve())):
            raise Refused("json okr 要在 git 仓库里跑,或给 --repo")
        return okr_data(path, repo)
    if root := github_root():
        return github_task_detail(root, a.id)
    return task_detail(path, a.id)



STALE = DAY_SECONDS
CLOSED_COUNT_WINDOW = 2 * DAY_SECONDS
_BOOKKEEPING_LABEL_NOTE = re.compile(r"\s*(?:triage|wayfinder|impact):")
_MENTION = re.compile(r"(?<![\w.])@([\w-]+)")
_NEXT_SPLIT = re.compile(r"[，,]?\s*(?:/\s*)?(?:下一步|\bNext)[：:]")
_DONE_LABEL = re.compile(r"^\s*(?:已完成|Done)[：:]\s*")
PENDING_TITLE_WIDTH = 200
TITLE_WIDTH = 34
PARENT_TITLE_WIDTH = 16
IDLE_TITLE_WIDTH = 40
PROGRESS_WIDTH = 70
NEXT_STEP_WIDTH = 90
VERDICT_WIDTH = 80
OWN_VERDICT_WIDTH = 70


def _ago(now: float, at: int) -> str:
    m = int(now - at) // 60
    return f"{m} 分钟" if m < 60 else f"{m // 60} 小时" if m < 48 * 60 else f"{m // 1440} 天"


_LINK_UP_TO_WHITESPACE_OR_CJK = r"https?://[^\s\u3000-\u303f\uff00-\uffef\u4e00-\u9fff]+"


def _short(text: str, n: int) -> str:
    text = re.sub(r"\s+", " ", re.sub(r"\*\*|`", "", re.sub(_LINK_UP_TO_WHITESPACE_OR_CJK, "(链接)", text))).strip()
    return text if len(text) <= n else text[:n] + "…"


def _pending(data: dict) -> list[dict]:
    return sorted((t for c in data["columns"] for t in c["tasks"] if t.get("pending")),
                  key=lambda t: (t["pending"]["at"], int(t["id"][1:])))



def _stamp(at: int) -> str:
    return f"{_dt.datetime.fromtimestamp(at):%m-%d %H:%M}"


def brief_text(data: dict) -> str:
    if data.get("tracker") != "github":
        raise Refused("brief 只用于 GitHub 记账的仓库(docs/agents/issue-tracker.md 写明 GitHub)")
    pending = _pending(data)
    out = [f"## 待决 {len(pending)}"]
    for t in pending:
        p = t["pending"]
        out += ["", f"### {t['id']} {t['title']} · {_stamp(p['at'])} 提出", t["url"], "原文：", p["brief"],
                "近期进展：" + ("" if p["progress"] else "没有")]
        out += [f"- {_stamp(n['at'])} " + " ".join(n["body"].split()) for n in p["progress"]]
    return "\n".join(out)


class _Index:
    def __init__(self, data: dict, now: float):
        self.now = now
        self.github = data.get("tracker") == "github"
        self.tasks = [t for c in data["columns"] for t in c["tasks"]]
        self.by_id = {t["id"]: t for t in self.tasks}

    def progress(self, t: dict) -> dict | None:
        p = t.get("progress")
        return p if p and not _BOOKKEEPING_LABEL_NOTE.match(p["body"]) else None

    def waits_on_you(self, t: dict) -> bool:
        pending_replaces_needs_info_on_github = self.github
        return t.get("waiting") is not None and not pending_replaces_needs_info_on_github

    def state(self, t: dict) -> str:
        if self.waits_on_you(t):
            return "等你"
        if self.progress(t) or t["claimed_at"] or t["session"]:
            return "停滞" if self.now - t["active_at"] > STALE else "进行中"
        return "待办"

    def belongs(self, t: dict) -> str:
        if not t["parent"]:
            return ""
        parent_listed_while_open_or_recently_closed = self.by_id.get(t["parent"])
        p = parent_listed_while_open_or_recently_closed
        return f" · 属于 {t['parent']}" + (f" {_short(re.sub(r'^\w+:\s*', '', p['title']), PARENT_TITLE_WIDTH)}" if p else "")

    def task_lines(self, k: str, t: dict) -> list[str]:
        p, d = self.progress(t), t.get("decision")
        if k == "停滞":
            out = [f"- {t['id']} {_short(t['title'], TITLE_WIDTH)}{self.belongs(t)}"
                   f"（{_ago(self.now, t['active_at'])}没动静 · 停在：{_stalled_on(p)}）"]
        else:
            out = [f"- {t['id']} {_short(t['title'], TITLE_WIDTH)}{self.belongs(t)}"]
        if p:
            out.append(f"  进展 {_ago(self.now, p['at'])}前：{_short(_DONE_LABEL.sub("", _NEXT_SPLIT.split(p['body'])[0]), PROGRESS_WIDTH)}")
        nxt = _GH_NEXT_STEP_SENTENCE.search(p["body"]) if p else None
        if t.get("waiting") and not self.github:
            if t["waiting"] != "等你":
                out.append(f"  下一步：{_short(t['waiting'], NEXT_STEP_WIDTH)}")
        elif nxt and not _decided_after_progress(d, p):
            out.append(f"  下一步：{_short(nxt.group(1), NEXT_STEP_WIDTH)}")
        elif d:
            out.append(f"  最近决定 {_ago(self.now, d['at'])}前：{_short(d['verdict'], VERDICT_WIDTH)}")
        return out


def _stalled_on(p: dict | None) -> str:
    mention = _MENTION.search(p["body"]) if p else None
    return f"@{mention.group(1)}" if mention else "没写"


def _decided_after_progress(d: dict | None, p: dict) -> bool:
    return bool(d and d["at"] > p["at"])


def index_text(data: dict, name: str) -> str:
    now = time.time()
    ix = _Index(data, now)
    live = [t for t in ix.tasks if t["status"] != "done"]
    groups = {k: sorted((t for t in live if ix.state(t) == k), key=lambda t: t["active_at"])
              for k in (("停滞", "进行中") if ix.github else ("等你", "停滞", "进行中"))}
    moving = {t["parent"] for g in groups.values() for t in g}
    idle = sorted((t for t in live if ix.state(t) == "待办" and t["id"] not in moving), key=lambda t: -t["created_at"])
    out = [f"{name} 进行中的事 · {_stamp(now)} 生成",
           " · ".join(f"{k} {len(g)}" for k, g in groups.items()) + f" · 待办 {len(idle)}", ""]
    if ix.github:
        pending = _pending(data)
        out += [f"## 待决 {len(pending)}", *(f"- {t['id']} {_short(t['title'], PENDING_TITLE_WIDTH)}" for t in pending), ""]
    for k, g in groups.items():
        if g:
            out += [f"## {k}", *(line for t in g for line in ix.task_lines(k, t)), ""]
    out += _owner_decision_lines(now, data.get("decisions", []))
    out += ["", f"## 待办 {len(idle)}（开着，从没认领也没写进展）"]
    out += [f"- {t['id']} {_short(t['title'], IDLE_TITLE_WIDTH)}{ix.belongs(t)}" for t in idle]
    closed_among_listed = sum(1 for t in ix.tasks if t["status"] == "done" and now - (t["done_at"] or 0) < CLOSED_COUNT_WINDOW)
    return "\n".join(out + ["", f"48 小时内关了 {closed_among_listed} 个。"])


def _owner_decision_lines(now: float, decided: list[dict]) -> list[str]:
    own = [d for d in decided if d["owner"]]
    return [f"## 48 小时内你的决策记录 {len(own)}（agent 自己定的另有 {len(decided) - len(own)} 条，在各任务里）",
            *(f"- {_ago(now, d['at'])}前 {d['task']} {_short(d['verdict'], OWN_VERDICT_WIDTH)}" for d in own)]



_PLUGIN = Path(__file__).resolve().parents[1]
_MOVED_FILE = _PLUGIN / "herdr" / "mods" / "nawaban-board" / "logic.js"
_MOVED = re.compile(r"^export const BOARD_PROJECTS = new Set\((\[[^\]\n]*\])?\);$", re.M)


def moved_projects() -> set[str]:
    import json
    try:
        m = _MOVED.search(_MOVED_FILE.read_text(encoding="utf-8"))
    except OSError:
        m = None
    if not m:
        raise Refused(f"读不到 {_MOVED_FILE} 里的 BOARD_PROJECTS,不知道哪些项目已迁到 Board,不写")
    return set(json.loads(m.group(1) or "[]"))


_FLAGS_THE_BOARD_TAKES_AS_POSITIONALS = {"event": ("--kind", "--body"), "create": ("--body",)}


def board_words(argv: list[str]) -> list[str]:
    if not argv or argv[0] not in _FLAGS_THE_BOARD_TAKES_AS_POSITIONALS:
        return argv
    moved = dict.fromkeys(_FLAGS_THE_BOARD_TAKES_AS_POSITIONALS[argv[0]])
    positionals, rest = [], []
    words = iter(argv[1:])
    for word in words:
        if not word.startswith("--"):
            positionals.append(word)
            continue
        name, inline, value = word.partition("=")
        value = value if inline else next(words, "")
        if name in moved:
            moved[name] = value
        elif value.startswith("-"):
            rest.append(f"{name}={value}")
        else:
            rest += [name, value]
    body = moved.pop("--body")
    head = [argv[0], *positionals, *moved.values()]
    if body is None:
        return head + rest
    return [*head, *rest, "--", body] if body.startswith("-") else [*head, body, *rest]


def refuse_moved(project: str | None, argv: list[str]) -> None:
    if project and project in moved_projects():
        raise Refused(f"项目 {project} 已迁到 Board:nawaban {shlex.join(board_words(argv))}"
                      f"(nawaban 即 node {_PLUGIN / 'board' / 'src' / 'cli.ts'});旧库对它只读")


def _write_project(path: Path, a) -> str | None:
    with closing(open_board(path)) as con:
        if a.verb == "create":
            return a.project or (_task(con, a.parent)["project"] if a.parent else default_project(path))
        return _task(con, a.id)["project"]



def _parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="nawaban", allow_abbrev=False)
    ap.add_argument("--db", help="看板文件(默认 NAWABAN_DB,再找最近的 .nawaban/nawaban.db)")
    sub = ap.add_subparsers(dest="verb", required=True)
    sub.add_parser("init", help="建空看板")
    p = sub.add_parser("create", help="建任务")
    p.add_argument("id")
    p.add_argument("--title", required=True)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--body")
    g.add_argument("--body-file")
    p.add_argument("--parent")
    p.add_argument("--project")
    p.add_argument("--blocked-by", action="append", metavar="ID", help="可重复")
    p = sub.add_parser("block", help="记被挡:id 被 blocker 挡住,blocker 关闭前不可开工")
    p.add_argument("id")
    p.add_argument("blocker")
    p = sub.add_parser("claim", help="认领;--release 交还")
    p.add_argument("id")
    p.add_argument("--take", action="store_true", help="接手别的窗口手上的任务")
    p.add_argument("--release", action="store_true")
    p = sub.add_parser("close", help="关闭或重开")
    p.add_argument("id")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--done", action="store_true")
    g.add_argument("--cancelled", action="store_true")
    g.add_argument("--reopen", action="store_true")
    p = sub.add_parser("event", help="记事件:note(进展同步)/ decision(决策记录)/ link / impact(KR 影响声明);GitHub 记账的仓库另有 ask(待决策项)/ resolve(已决,决策记录)")
    p.add_argument("id")
    p.add_argument("--kind", required=True, choices=("note", "decision", "link", "ask", "resolve", "impact"))
    p.add_argument("--body", help="impact 以外必填")
    p.add_argument("--by", choices=("user",), help="user = 用户拍板")
    p.add_argument("--kr", action="append", help="挂哪个 Objective / KR;ask 必填,decision 可选;impact 写 " + IMPACT_FORMAT + ",可重复")
    p.add_argument("--o", help="impact:O 名,纯基础设施写 无")
    p.add_argument("--context", help="ask:只写影响这次决策的事实")
    p.add_argument("--option", action="append", help="ask:每个备选方案一次,写 方案｜代价｜单向门 或 双向门;至少两个")
    p.add_argument("--rec", help="ask:建议(选哪个方案、为什么)")
    p = sub.add_parser("show", help="看一个任务")
    p.add_argument("id")
    p = sub.add_parser("list", help="列任务")
    p.add_argument("--project")
    p.add_argument("--parent")
    p.add_argument("--frontier", action="store_true", help="只列可开工:未关闭、没人认领、前置都已关闭")
    p = sub.add_parser("dispatch", help="派 worker(worktree + hc run,回报给编排者),终端号与验收记到票上")
    p.add_argument("id", nargs="?", help="任务号;GitHub 记账的仓库是 #N;不带时只派活不记票(如每晚复盘)")
    p.add_argument("--name", help="终端与 worktree 名,默认 w-<N> 或小写任务号")
    p.add_argument("--brief", required=True, help="目标、范围等派活说明正文")
    p.add_argument("--accept", required=True, help="验收:可检查的完成标准")
    p.add_argument("--model", default="opus")
    sub.add_parser("backup", help="备份到 <看板目录>/backups/ · 保留 14 天")
    p = sub.add_parser("json", help="看板的 JSON(projects、board、task;db:看板文件的真实路径)")
    p.add_argument("what", choices=("projects", "board", "task", "db", "okr"))
    p.add_argument("id", nargs="?", default="", help="task:任务 id")
    p.add_argument("--project", help="board:只看这个项目")
    p.add_argument("--repo", help="okr:仓库路径,默认当前目录所在的仓库")
    sub.add_parser("brief", help="GitHub 记账的仓库:每件待决的原文、所在 issue、该 issue 最近的进展")
    p = sub.add_parser("index", help="等你 / 停滞 / 进行中 / 待办的 md 索引(读 json board 同一份数据,只打到 stdout)")
    p.add_argument("--project", help="只看这个项目")
    p = sub.add_parser("okr", help=f"各 O 的 KR 现值对目标:跑 {OKR_FILE} 里每条 KR 的测量,读数记进看板")
    p.add_argument("--accept", metavar="O", help="该 O 当前全 ✓ 时记一次验收")
    return ap


WRITE_VERBS = ("create", "block", "claim", "close", "event")


def _words_to_rerun_on_the_board(argv: list[str]) -> list[str]:
    return [w for i, w in enumerate(argv) if w != "--db" and not w.startswith("--db=") and (i == 0 or argv[i - 1] != "--db")]


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    a = _parser().parse_args(argv)
    path = resolve_db(a.db)
    words = _words_to_rerun_on_the_board(argv)
    try:
        if a.verb in _STANDALONE_VERBS:
            return _STANDALONE_VERBS[a.verb](path, a, words)
        if a.verb in WRITE_VERBS and not _github_issue_write(a):
            refuse_moved(_write_project(path, a), words)
        if a.verb == "close" and a.done:
            impact_lock(path, a.id)
        if a.verb in ("claim", "close", "event") and _GH_ISSUE.fullmatch(a.id) and (root := github_root()):
            return _write_github_issue(path, a, root)
        if getattr(a, "kind", None) in ("ask", "resolve"):
            raise Refused("ask / resolve 只用于 GitHub 记账的仓库(#N)")
        out = _on_the_local_board(path, a)
    except (Refused, OSError) as e:
        print(f"✗ {e}", file=sys.stderr)
        return 1
    if out:
        print(out)
    return 0


def _github_issue_write(a) -> bool:
    return bool(a.verb != "create" and _GH_ISSUE.fullmatch(a.id) and github_root())


def _init_verb(path: Path, a, words: list[str]) -> int:
    print(f"✓ init → {path}" if init(path) else f"✓ 看板已存在:{path}")
    return 0


def _json_verb(path: Path, a, words: list[str]) -> int:
    return json_out(path, a)


def _okr_verb(path: Path, a, words: list[str]) -> int:
    r = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    if r.returncode != 0:
        raise Refused("okr 要在 git 仓库里跑")
    top = Path(r.stdout.strip())
    repo = _repo_root(top) or top
    refuse_moved(repo.name, words)
    text, readings, full = okr_run(top)
    print(text)
    if _print_only_without_a_board(path, a):
        print(f"(没有看板 {path},读数没记)", file=sys.stderr)
        return 0
    con = open_board(path)
    try:
        print(okr_record(con, repo, readings, a.accept, full))
    finally:
        con.close()
    if text := impact_text(okr_data(path, repo)):
        print(text)
    return 0


def _print_only_without_a_board(path: Path, a) -> bool:
    return not path.exists() and a.accept is None


def _index_verb(path: Path, a, words: list[str]) -> int:
    print(index_text(*any_board(path, a.project)))
    return 0


def _brief_verb(path: Path, a, words: list[str]) -> int:
    print(brief_text(any_board(path, None)[0]))
    return 0


def _dispatch_verb(path: Path, a, words: list[str]) -> int:
    if not (a.id or a.name):
        raise Refused("不带任务号时要给 --name")
    if root := github_root():
        print(dispatch(root, a))
        return 0
    if not (root := _repo_root(Path.cwd().resolve())):
        raise Refused("dispatch 要在 worker 改的 git 仓库里跑")
    con = open_board(path)
    try:
        if a.id:
            refuse_moved(_task(con, a.id)["project"], words)
        print(dispatch(root, a, con))
    finally:
        con.close()
    return 0


_STANDALONE_VERBS = {"init": _init_verb, "json": _json_verb, "okr": _okr_verb, "index": _index_verb,
                     "brief": _brief_verb, "dispatch": _dispatch_verb}


def _write_github_issue(path: Path, a, root: Path) -> int:
    if a.verb == "event":
        card(a)
        if a.kind == "impact":
            with closing(open_board(path)) as con:
                print(impact(con, a, root))
            return 0
    print(gh_write(root, a))
    if a.verb == "event" and a.kind in ("ask", "resolve"):
        _refresh_inbox_now_for_this_turns_stop_hook(root)
    return 0


def _refresh_inbox_now_for_this_turns_stop_hook(root: Path) -> None:
    try:
        started = time.time()
        inbox_save(root, github_board_data(root), started)
    except (Refused, ValueError, KeyError, TypeError):
        return


def _on_the_local_board(path: Path, a) -> str:
    con = open_board(path)
    try:
        if a.verb == "backup":
            return f"✓ backup → {backup(path)}"
        if a.verb == "event":
            card(a)
            return impact(con, a) if a.kind == "impact" else event(con, a)
        return _LOCAL_VERBS[a.verb](con, path, a)
    finally:
        con.close()


_LOCAL_VERBS = {
    "create": lambda con, path, a: create(con, path, a),
    "block": lambda con, path, a: block(con, a),
    "claim": lambda con, path, a: claim(con, a),
    "close": lambda con, path, a: close(con, a),
    "show": lambda con, path, a: show(con, a),
    "list": lambda con, path, a: list_tasks(con, a),
}


if __name__ == "__main__":
    sys.exit(main())
