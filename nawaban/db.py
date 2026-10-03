#!/usr/bin/env python3
"""NAWABAN 机制层:SQLite schema + 全部写入操作(NAWABAN-SCHEMA-001)。

契约来源:.foreman/artifacts/看板字段设计-v1草案-2026-08-12.md(19 列 6 表 · 四类来源 · 写入规则)。
分层:本模块 = 机制(显式参数,不读环境);cli.py = 政策(身份只从环境解析,不收参数)。
append-only 是物理的(触发器),不是纪律的。
"""

from __future__ import annotations

import contextlib
import datetime as _dt
import json
import os
import re
import sqlite3
import subprocess
import unicodedata
import time
from pathlib import Path
from typing import Any, Iterator, Optional, Sequence


class NawabanError(Exception):
    """业务规则拒绝(区别于 sqlite3.IntegrityError = DDL 层拒绝)。"""


STATUSES = ("open", "claimed", "in_progress", "staging-verified", "done", "cancelled")
# 终态:活儿不再往前走的两种结局。done = 验收过;cancelled = 前提消失,这活不做了。
# 分开是因为语义不可互换 —— 给过期卡编一条 acceptance 塞进 done 就是造假证据。
TERMINAL = ("done", "cancelled")
WAITING = ("decision", "prod", "observe", "external")
# regresses:修复卡 → 被后来的改动弄坏的 done 卡。回退是关系不是状态：卡保持 done,看板派生红标。
EDGE_KINDS = ("depends_on", "split_from", "supersedes", "regresses")
EVENT_KINDS = ("note", "coord", "handoff", "status_change", "acceptance", "verify")
SESSION_OUTCOMES = ("completed", "handed_off", "blocked", "abandoned")
REF_KINDS = ("pr", "merge_sha", "issue", "commit", "acceptance_run", "artifact")

# Shared activity aggregate for queries joining task_events as e. Match the
# historical remodule format so append-only audit notes need no migration.
LAST_ACTIVITY_SQL = (
    "MAX(CASE WHEN e.kind = 'note' AND e.body LIKE '模块 % → %'"
    " THEN NULL ELSE e.created_at END)"
)

# ── 人侧收件箱(NAWABAN-INBOX)─────────────────────────────────────
# ask = 一次待办的**人类动作**,不是一张卡。三个动词穷尽了人的介入形态
# (实测:对账后 14 张「等拍板」全部落进 authorize/accept,decide 0 张;
#  全库 357 行决策记录里带被否项的只有 13 行)。ask 的生命周期在人回答
# 那一刻结束 —— 这正是它能被清空、而 tasks 的过滤视图永远清不空的原因。
ASK_KINDS = ("decide", "authorize", "accept")
# decided_by='user' 的合法来源。inbox = 人在收件箱里回答(cli answer 设),
# 与 chat(agent 转述)分开记,审计时能区分「人自己点的」和「agent 替人转述的」。
DECISION_CHANNELS = ("tg", "chat", "inbox")
# 关闭态必须齐全:只有 answered 的话,「卡被别的路径关掉」「问题过期」
# 「agent 撤回」这三类 ask 没人关 —— 僵尸会从卡层原样搬到 ask 层。
ASK_CLOSED = ("answered", "withdrawn", "task_closed", "expired")

_q = lambda vals: ",".join(f"'{v}'" for v in vals)  # noqa: E731  # DDL 枚举内联

ASKS_SQL = f"""
CREATE TABLE IF NOT EXISTS asks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL CHECK (kind IN ({_q(ASK_KINDS)})),
    question    TEXT NOT NULL CHECK (length(question) BETWEEN 1 AND 120),
    -- trim(X) 默认只去空格,不去换行/制表/回车 —— 只写 trim(evidence) 的话
    -- 一个换行就能绕过写侧材料闸。字符集必须显式给全。
    evidence    TEXT NOT NULL
                CHECK (length(trim(evidence, char(32)||char(9)||char(10)||char(13))) > 0),
    options     TEXT,
    blast       TEXT,
    hands_on    INTEGER NOT NULL DEFAULT 0 CHECK (hands_on IN (0,1)),
    raised_at   INTEGER NOT NULL,
    raised_by   TEXT NOT NULL,
    closed_at   INTEGER,
    closed_as   TEXT CHECK (closed_as IS NULL OR closed_as IN ({_q(ASK_CLOSED)})),
    answer      TEXT,
    decision_id INTEGER REFERENCES task_decisions(id),
    -- agent 对「这件事确实需要人介入」的把握。0..1,必须配一句理由 ——
    -- **理由才是可审计的那部分**,分数只是排序用的把手(ADR-0209 原则 6)。
    -- 可空:人手工提的 ask 与迁移来的老 ask 都没有,读侧要降级不能炸。
    confidence  REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    confidence_reason TEXT
      CHECK (confidence IS NULL OR (confidence_reason IS NOT NULL
                                    AND length(trim(confidence_reason)) > 0)),
    CHECK ((closed_at IS NULL) = (closed_as IS NULL))
);

CREATE TABLE IF NOT EXISTS ask_tasks (
    ask_id  INTEGER NOT NULL REFERENCES asks(id),
    task_id TEXT    NOT NULL REFERENCES tasks(id),
    PRIMARY KEY (ask_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_asks_open      ON asks(closed_at, raised_at);
CREATE INDEX IF NOT EXISTS idx_ask_tasks_task ON ask_tasks(task_id);
"""

# 信件 = worker→总监的单向汇报(NAWABAN-LETTERS-DB-001 · 2026-08-29 用户拍板迁库)。
# 与 asks 表语义不重叠:asks 是人侧拍板队列(开→关),信件是留言(读/未读)。
# kind 不设 CHECK:约束在 add_letter 写侧(md 导入的历史值不受限,provenance 可辨)。
LETTERS_SQL = """
CREATE TABLE IF NOT EXISTS letters (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    kind       TEXT NOT NULL,
    msg        TEXT NOT NULL,
    links      TEXT,
    session_id TEXT,
    created_at INTEGER NOT NULL,
    read_at    INTEGER,
    provenance TEXT
);
CREATE INDEX IF NOT EXISTS idx_letters_unread ON letters(read_at, created_at);
CREATE INDEX IF NOT EXISTS idx_letters_task   ON letters(task_id, created_at);
"""

LETTER_KINDS = ("done", "blocked", "stage", "claim")

SCHEMA_SQL = f"""
CREATE TABLE IF NOT EXISTS tasks (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL CHECK (length(title) <= 80),
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ({_q(STATUSES)})),
    waiting_on   TEXT CHECK (waiting_on IS NULL OR waiting_on IN ({_q(WAITING)})),
    owner        TEXT,
    epic         TEXT,
    project      TEXT,
    context      TEXT,
    now          TEXT CHECK (now IS NULL OR length(now) <= 200),
    success      TEXT,
    constraints_ TEXT,
    touches      TEXT,
    adr          TEXT,
    created_at   INTEGER NOT NULL,
    started_at   INTEGER,
    completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS task_edges (
    src        TEXT NOT NULL REFERENCES tasks(id),
    dst        TEXT NOT NULL REFERENCES tasks(id),
    kind       TEXT NOT NULL CHECK (kind IN ({_q(EDGE_KINDS)})),
    note       TEXT,
    created_at INTEGER NOT NULL,
    created_by TEXT,
    PRIMARY KEY (src, dst, kind)
);

CREATE TABLE IF NOT EXISTS task_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL REFERENCES tasks(id),
    session_id TEXT,
    author     TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ({_q(EVENT_KINDS)})),
    body       TEXT NOT NULL CHECK (length(body) <= 2048),
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_decisions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL REFERENCES tasks(id),
    question   TEXT NOT NULL,
    verdict    TEXT NOT NULL,
    rejected   TEXT,
    decided_by TEXT NOT NULL CHECK (decided_by = 'user' OR decided_by = 'advisor'
                                    OR decided_by LIKE 'agent:%'),
    adr        TEXT,
    supersedes INTEGER REFERENCES task_decisions(id),
    created_at INTEGER NOT NULL,
    provenance TEXT   -- JSON 存根 source/file/line/raw:decided_by 来源(消费者=误标可回溯可纠)
);

CREATE TABLE IF NOT EXISTS task_sessions (
    task_id    TEXT NOT NULL REFERENCES tasks(id),
    owner      TEXT NOT NULL,
    session_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER,
    outcome    TEXT CHECK (outcome IS NULL OR outcome IN ({_q(SESSION_OUTCOMES)})),
    summary    TEXT,
    note       TEXT,
    PRIMARY KEY (task_id, session_id)
);

CREATE TABLE IF NOT EXISTS task_refs (
    task_id    TEXT NOT NULL REFERENCES tasks(id),
    kind       TEXT NOT NULL CHECK (kind IN ({_q(REF_KINDS)})),
    value      TEXT NOT NULL,
    note       TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, kind, value)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_owner    ON tasks(owner, status);
CREATE INDEX IF NOT EXISTS idx_edges_dst      ON task_edges(dst);
CREATE INDEX IF NOT EXISTS idx_events_task    ON task_events(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_decisions_task ON task_decisions(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_refs_task      ON task_refs(task_id, kind);

-- 物理 append-only:events / decisions 永不 UPDATE/DELETE
CREATE TRIGGER IF NOT EXISTS task_events_no_update BEFORE UPDATE ON task_events
BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS task_events_no_delete BEFORE DELETE ON task_events
BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS task_decisions_no_update BEFORE UPDATE ON task_decisions
BEGIN SELECT RAISE(ABORT, 'task_decisions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS task_decisions_no_delete BEFORE DELETE ON task_decisions
BEGIN SELECT RAISE(ABORT, 'task_decisions is append-only'); END;
"""

# 状态机:合法转移 → (需要闸)。open→claimed 只走 claim_task,claimed→in_progress 只走 start_task。
_ADVANCE = {
    ("in_progress", "staging-verified"),
    ("in_progress", "done"),               # 直通:CI 绿合并即归档(foreman simplify regression)
    ("staging-verified", "done"),
    ("staging-verified", "in_progress"),  # 驳回返工
    ("done", "in_progress"),               # 打回(NAWABAN-ACCEPT-SELFEVIDENT-001 · reopen_task 专用)
}


# ── 连接 ──────────────────────────────────────────────────────────

def connect(path: Path | str, *, busy_ms: int = 30000) -> sqlite3.Connection:
    con = sqlite3.connect(str(path), timeout=busy_ms / 1000)
    con.isolation_level = None  # autocommit;多语句原子性走显式 BEGIN IMMEDIATE
    # busy_timeout 先设:下面两条 PRAGMA 自己也会撞锁,编译闸(fail-open · ms 级预算)
    # 不能被 30s 默认值挂住——卡死 session 比漏一次编译更糟。
    con.execute(f"PRAGMA busy_timeout={int(busy_ms)}")
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA journal_mode=WAL")
    return con


def init_db(path: Path | str) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    con = connect(path)
    try:
        con.executescript(SCHEMA_SQL)
        con.executescript(ASKS_SQL)
        con.executescript(LETTERS_SQL)
        from nawaban.captures import SCHEMA_SQL as CAPTURES_SQL
        con.executescript(CAPTURES_SQL)
    finally:
        con.close()


def migrate_db(path: Path | str) -> list[str]:
    """Upgrade the board schema and return labels of applied changes.

    Legacy tasks.origin is renamed to context in one serialized ALTER TABLE.

    Adds missing decision provenance, ask fields/tables, and letters; drops retired
    task columns and rebuilds the tasks / task_edges tables when their CHECK lacks
    cancelled / regresses. This is not an additive-only or whole-call atomic
    migration: earlier changes can remain committed on failure. Each rebuild alone
    is transactional and checks row counts and foreign keys before commit.

    Each change detects its existing state, so reruns skip completed work and an
    up-to-date schema returns []. Unknown CHECK text raises NawabanError
    instead of guessing a rebuild. Dropping columns requires SQLite 3.35 or later.
    """
    added = []
    con = connect(path)
    try:
        from nawaban.captures import SCHEMA_SQL as CAPTURES_SQL
        if not con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='captures'").fetchone():
            con.executescript(CAPTURES_SQL)
            added.append("captures")
        # Serialize the schema check and rename across concurrent CLI starts.
        with _txn(con):
            columns = {r[1] for r in con.execute("PRAGMA table_info(tasks)")}
            if "origin" in columns:
                con.execute("ALTER TABLE tasks RENAME COLUMN origin TO context")
                added.append("tasks.origin→context")
        tcols = {r[1] for r in con.execute("PRAGMA table_info(tasks)")}
        for col in ("grill", "design", "capability", "flag"):
            if col in tcols:
                con.execute(f"ALTER TABLE tasks DROP COLUMN {col}")
                added.append(f"tasks.-{col}")
        cols = {r[1] for r in con.execute("PRAGMA table_info(task_decisions)")}
        if "provenance" not in cols:
            con.execute("ALTER TABLE task_decisions ADD COLUMN provenance TEXT")
            added.append("task_decisions.provenance")
        have = {r[0] for r in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('asks','ask_tasks')")}
        if len(have) < 2:
            con.executescript(ASKS_SQL)
            added += [t for t in ("asks", "ask_tasks") if t not in have]
        else:
            # Legacy added columns rely on raise_ask for confidence validation.
            cols = {r[1] for r in con.execute("PRAGMA table_info(asks)")}
            for col, typ in (("confidence", "REAL"), ("confidence_reason", "TEXT")):
                if col not in cols:
                    con.execute(f"ALTER TABLE asks ADD COLUMN {col} {typ}")
                    added.append(f"asks.{col}")
        if "project" not in tcols:
            con.execute("ALTER TABLE tasks ADD COLUMN project TEXT")
            added.append("tasks.project")
        if not con.execute("SELECT 1 FROM sqlite_master WHERE type='table'"
                           " AND name='letters'").fetchone():
            con.executescript(LETTERS_SQL)
            added.append("letters")
        if _rebuild_check(con, "tasks", "status", STATUSES, (
                "CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)",
                "CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner, status)")):
            added.append("tasks.status:+cancelled")
        if _rebuild_check(con, "task_edges", "kind", EDGE_KINDS, (
                "CREATE INDEX IF NOT EXISTS idx_edges_dst ON task_edges(dst)",)):
            added.append("task_edges.kind:+regresses")
    finally:
        con.close()
    return added


def _rebuild_check(con: sqlite3.Connection, table: str, column: str,
                   values: tuple[str, ...], indexes: tuple[str, ...]) -> bool:
    """Rebuild ``table`` when its ``column`` CHECK lacks the newest value.

    SQLite cannot alter a CHECK constraint in place. The new CHECK lists exactly
    ``values``: a row holding a retired value fails the copy and rolls back
    instead of being kept or dropped silently.
    """
    ddl = con.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
                      (table,)).fetchone()
    if not ddl or f"'{values[-1]}'" in ddl[0]:
        return False
    check = re.compile(rf"CHECK \({column} IN \([^)]*\)\)")
    if len(check.findall(ddl[0])) != 1:
        raise NawabanError(f"{table} 重建:CHECK 文本没匹配上,拒绝盲改 DDL")
    new_ddl = re.sub(rf"^CREATE TABLE (IF NOT EXISTS )?{table}\b", f"CREATE TABLE {table}_new", ddl[0])
    new_ddl = check.sub(f"CHECK ({column} IN ({_q(values)}))", new_ddl)
    con.execute("PRAGMA foreign_keys=OFF")
    try:
        con.execute("BEGIN IMMEDIATE")
        cols = ",".join(r[1] for r in con.execute(f"PRAGMA table_info({table})"))
        con.execute(new_ddl)
        con.execute(f"INSERT INTO {table}_new({cols}) SELECT {cols} FROM {table}")
        n_old = con.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
        n_new = con.execute(f"SELECT count(*) FROM {table}_new").fetchone()[0]
        if n_old != n_new:
            raise NawabanError(f"{table} 重建:行数不符 {n_old}→{n_new},回滚")
        con.execute(f"DROP TABLE {table}")
        con.execute(f"ALTER TABLE {table}_new RENAME TO {table}")
        for sql in indexes:
            con.execute(sql)
        bad = con.execute("PRAGMA foreign_key_check").fetchall()
        if bad:
            raise NawabanError(f"{table} 重建:外键校验失败 {bad[:3]},回滚")
        con.execute("COMMIT")
        return True
    except BaseException:
        con.execute("ROLLBACK")
        raise
    finally:
        con.execute("PRAGMA foreign_keys=ON")


def board_db(root: Path, *, for_init: bool = False) -> Path:
    """Reuse an existing board for reads and initialization; new boards use nawaban."""
    primary = root / ".nawaban" / "nawaban.db"
    legacy = root / ".foreman" / "workos.db"  # Legacy database fallback.
    if not primary.exists() and legacy.exists():
        return legacy
    return primary


def _board_roots(cwd: Path | str | None = None) -> list[Path]:
    """Search the shared Git root first, then the working directory's ancestors."""
    cur = Path(cwd or Path.cwd()).resolve()
    roots = []
    try:
        common = subprocess.run(["git", "-C", str(cur), "rev-parse", "--git-common-dir"],
                                capture_output=True, text=True, timeout=5)
        if common.returncode == 0:
            roots.append((cur / common.stdout.strip()).resolve().parent)
    except (OSError, subprocess.SubprocessError):
        pass
    return [*roots, cur, *cur.parents]


def foreman_dir(cwd: Path | str | None = None) -> Optional[Path]:
    """Locate the board directory, including legacy boards in a shared checkout."""
    for root in _board_roots(cwd):
        selected = board_db(root)
        if selected.parent.is_dir():
            return selected.parent
        if (root / ".foreman").is_dir():
            return root / ".foreman"
    return None


def project_of(board_dir: Path) -> Optional[str]:
    """项目名 = 板目录所在仓库的目录名。"""
    return board_dir.parent.name if board_dir.name in (".nawaban", ".foreman") else None


def board_project(cwd: Path | str | None = None) -> Optional[str]:
    fd = foreman_dir(cwd)
    return project_of(fd) if fd else None


def owner_from_env() -> str | None:
    return os.environ.get("NAWABAN_OWNER")


def resolve_db(cwd: Path | str | None = None, *, for_init: bool = False) -> Path:
    """Explicit environment, shared board, ancestor board, then a new local board."""
    env = os.environ.get("NAWABAN_DB")
    if env:
        return Path(env).expanduser()
    roots = _board_roots(cwd)
    for root in roots:
        selected = board_db(root)
        if selected.exists() or (root / ".nawaban").is_dir() or (root / ".foreman").is_dir():
            return board_db(root, for_init=for_init)
    return board_db(roots[0], for_init=for_init)


@contextlib.contextmanager
def _txn(con: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    con.execute("BEGIN IMMEDIATE")
    try:
        yield con
        con.execute("COMMIT")
    except BaseException:
        con.execute("ROLLBACK")
        raise


def _now() -> int:
    return int(time.time())


def _jd(v: Any) -> Optional[str]:
    return None if v is None else json.dumps(v, ensure_ascii=False)


def _j(s: Optional[str]) -> Any:
    """JSON 列反序列化。存量脏值(非 JSON 文本)原样返回,不炸读侧。"""
    if not s:
        return None
    try:
        return json.loads(s)
    except (ValueError, TypeError):
        return s


def _task_row(con: sqlite3.Connection, task_id: str) -> sqlite3.Row:
    con.row_factory = sqlite3.Row
    row = con.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    if row is None:
        raise NawabanError(f"卡不存在:{task_id}")
    return row


def _event(con: sqlite3.Connection, task_id: str, kind: str, body: str,
           author: str, session_id: Optional[str]) -> None:
    # 超长拒写(CHECK ≤2048):长内容是文档不是事件——落 md 进 artifacts + ref 指针,不静默截断
    con.execute(
        "INSERT INTO task_events (task_id, session_id, author, kind, body, created_at)"
        " VALUES (?,?,?,?,?,?)",
        (task_id, session_id, author, kind, body, _now()),
    )


# ── 9 动词 ────────────────────────────────────────────────────────

def create_task(path: Path | str, *, task_id: str, title: str,
                context: Optional[str] = None,
                success: Optional[Sequence[str]] = None,
                constraints: Optional[Sequence[str]] = None,
                touches: Optional[Sequence[str]] = None,
                epic: Optional[str] = None, adr: Optional[str] = None,
                split_from: Optional[str] = None,
                project: Optional[str] = None) -> None:
    """Create an open, unowned task, optionally with a split-from lineage edge.

    The task and edge commit together. A supplied parent must exist; its epic and
    project are each inherited only when None. Empty content sequences are stored as NULL.
    Task IDs must contain non-whitespace text but are stored without trimming;
    readability policy belongs to task_content. Duplicate IDs raise a SQLite error,
    so this operation does not silently treat retries as successful creation.
    """
    if not task_id.strip():
        raise NawabanError("task_id 不得为空")
    con = connect(path)
    try:
        with _txn(con):
            if split_from:
                parent = _task_row(con, split_from)
                if epic is None:
                    epic = parent["epic"]
                if project is None:
                    project = parent["project"]
            con.execute(
                "INSERT INTO tasks (id, title, status, context, success, constraints_,"
                " touches, epic, adr, created_at, project)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (task_id, title, "open", context, _jd(list(success) if success else None),
                 _jd(list(constraints) if constraints else None),
                 _jd(list(touches) if touches else None),
                 epic, adr, _now(), project),
            )
            if split_from:
                con.execute(
                    "INSERT OR IGNORE INTO task_edges(src,dst,kind,note,created_at,created_by)"
                    " VALUES(?,?,'split_from',?,?,?)",
                    (task_id, split_from, "拆卡来源", _now(), None))
    finally:
        con.close()


def claim_task(path: Path | str, task_id: str, *, owner: str, session_id: str,
               override: Optional[str] = None, main_red: Optional[dict] = None) -> bool:
    """CAS:恰一胜。胜者原子拿到 owner + session 履历行 + status_change 事件。

    claim 上游闸(board revamp wf claimgate regression · 2026-08-29 用户拍板):
    上游 depends_on 未 done 就接卡 = 在半成品上开工。只挡 depends_on
    (split_from/supersedes 不挡);override 带理由强闯,理由落 coord 事件可审计。

    停线闸(NAWABAN-REGRESSION-001 · 2026-10-03 用户拍板):``main_red`` 是本卡项目
    main CI 连续变红的起点 {"since": epoch, "url": str}。红了以后本项目还没有未完成的
    regresses 修复卡，就不许接新活;同一个 override 强闯。
    """
    con = connect(path)
    try:
        with _txn(con):
            stop_line = bool(main_red) and con.execute(
                "SELECT 1 FROM task_edges e JOIN tasks s ON s.id=e.src"
                " WHERE e.kind='regresses' AND e.created_at>=?"
                " AND s.status NOT IN ('done','cancelled')"
                " AND COALESCE(s.project,'')=COALESCE((SELECT project FROM tasks WHERE id=?),'')"
                " LIMIT 1", (main_red["since"], task_id)).fetchone() is None
            if stop_line and not (override or "").strip():
                raise NawabanError(
                    f"claim 停线闸:本项目 main CI 红了({main_red['url']}),还没有回退修复卡。\n"
                    "  先找被弄坏的卡:nawaban blame <失败的文件>\n"
                    "  再建修复卡并连上:nawaban link <修复卡> <被弄坏的卡> --kind regresses --note \"哪次合并\"\n"
                    f'  确要强闯:nawaban claim {task_id} --override "理由"')
            blockers = con.execute(
                "SELECT e.dst, t.status FROM task_edges e JOIN tasks t ON t.id=e.dst"
                           # cancelled 上游 = 依赖解除:卡被判前提消失,指向它的 depends_on 同样失效,
            # 再挡下游就是拿一个已经不存在的活当阻塞源(TERMINAL 而非仅 done)。
 " WHERE e.src=? AND e.kind='depends_on' AND t.status NOT IN ('done','cancelled')"
                " ORDER BY e.dst",
                (task_id,)).fetchall()
            if blockers and not (override or "").strip():
                raise NawabanError(
                    "claim 上游闸:这张卡的 depends_on 上游还没 done ——\n"
                    + "\n".join(f"   ⏸ {r[0]}({r[1]})" for r in blockers)
                    + f'\n  先做上游;确要强闯:nawaban claim {task_id} --override "理由"')
            cur = con.execute(
                "UPDATE tasks SET owner=?, status='claimed'"
                " WHERE id=? AND owner IS NULL AND status='open'",
                (owner, task_id),
            )
            if cur.rowcount != 1:
                raise _ClaimLost()
            # Preserve the complete previous attempt before reopening its session row.
            previous = con.execute(
                "SELECT owner, started_at, ended_at, outcome, summary FROM task_sessions"
                " WHERE task_id=? AND session_id=?",
                (task_id, session_id),
            ).fetchone()
            if previous is not None:
                con.execute(
                    "UPDATE task_sessions SET note=COALESCE(note || char(10), '') || ?"
                    " WHERE task_id=? AND session_id=?",
                    ("Resumed attempt: " + json.dumps(dict(zip(
                        ("owner", "started_at", "ended_at", "outcome", "summary"), previous,
                    )), ensure_ascii=False), task_id, session_id),
                )
            con.execute(
                "INSERT INTO task_sessions (task_id, owner, session_id, started_at)"
                " VALUES (?,?,?,?)"
                " ON CONFLICT(task_id, session_id) DO UPDATE SET owner=excluded.owner,"
                " started_at=excluded.started_at,"
                " ended_at=NULL, outcome=NULL, summary=NULL",
                (task_id, owner, session_id, _now()),
            )
            _event(con, task_id, "status_change", "open→claimed", owner, session_id)
            if blockers:
                _event(con, task_id, "coord",
                       "claim 越上游闸:未 done 上游 "
                       + "、".join(r[0] for r in blockers)
                       + f" · 理由:{override.strip()}", owner, session_id)
            if stop_line:
                _event(con, task_id, "coord",
                       f"claim 越停线闸:main CI 红({main_red['url']}) · 理由:{override.strip()}",
                       owner, session_id)
        return True
    except _ClaimLost:
        return False
    finally:
        con.close()


class _ClaimLost(Exception):
    pass


def task_project(path: Path | str, task_id: str) -> Optional[str]:
    """卡的所属项目(claim 停线闸按项目找 main CI 状态)。"""
    con = connect(path)
    try:
        return _task_row(con, task_id)["project"]
    finally:
        con.close()


def merged_tasks(path: Path | str) -> list[sqlite3.Row]:
    """所有 merge_sha 指针及其卡(blame 用 git 历史反查卡)。"""
    con = connect(path)
    con.row_factory = sqlite3.Row
    try:
        return con.execute(
            "SELECT r.value AS sha, t.id, t.title, t.status FROM task_refs r"
            " JOIN tasks t ON t.id=r.task_id WHERE r.kind='merge_sha'").fetchall()
    finally:
        con.close()


def task_touches(path: Path | str, task_id: str) -> Optional[str]:
    """卡的 touches 原始 JSON 文本(claim 后占用 WARN 用)。"""
    con = connect(path)
    try:
        return _task_row(con, task_id)["touches"]
    finally:
        con.close()


def task_success(path: Path | str, task_id: str) -> Optional[str]:
    """卡的 success 原始 JSON 文本(claim 后错位 WARN 用)。"""
    con = connect(path)
    try:
        return _task_row(con, task_id)["success"]
    finally:
        con.close()


def _kin(con: sqlite3.Connection, task_id: str) -> dict:
    row = _task_row(con, task_id)

    blocked_by = []
    depths = {task_id: 0}
    queue = [task_id]
    while queue:
        current = queue.pop(0)
        depth = depths[current] + 1
        if depth > 8:
            continue
        upstream = con.execute(
            "SELECT t.id,t.title,t.status FROM task_edges e"
            " JOIN tasks t ON t.id=e.dst"
            " WHERE e.src=? AND e.kind='depends_on'"
            " AND t.status NOT IN ('done','cancelled') ORDER BY t.id",
            (current,),
        ).fetchall()
        for task in upstream:
            if task[0] in depths:
                continue
            depths[task[0]] = depth
            blocked_by.append({
                "id": task[0], "title": task[1], "status": task[2], "depth": depth,
            })
            queue.append(task[0])
    blocked_by.sort(key=lambda task: (task["depth"], task["id"]))

    unblocks = []
    downstream = con.execute(
        "SELECT t.id,t.title,t.status FROM task_edges e"
        " JOIN tasks t ON t.id=e.src"
        " WHERE e.dst=? AND e.kind='depends_on'"
        " AND t.status NOT IN ('done','cancelled') ORDER BY t.id",
        (task_id,),
    ).fetchall()
    for task in downstream:
        others = con.execute(
            "SELECT count(*) FROM task_edges e JOIN tasks t ON t.id=e.dst"
            " WHERE e.src=? AND e.kind='depends_on' AND e.dst<>?"
            " AND t.status NOT IN ('done','cancelled')",
            (task[0], task_id),
        ).fetchone()[0]
        unblocks.append({
            "id": task[0], "title": task[1], "status": task[2],
            "others_waiting": others,
        })

    def edge_ids(*, src: str | None = None, dst: str | None = None, kind: str) -> list[str]:
        column, value, result = ("src", src, "dst") if src is not None else ("dst", dst, "src")
        return [r[0] for r in con.execute(
            f"SELECT {result} FROM task_edges WHERE {column}=? AND kind=? ORDER BY {result}",
            (value, kind),
        )]

    parents = edge_ids(src=task_id, kind="split_from")
    decision = con.execute(
        "SELECT id,verdict,supersedes FROM task_decisions WHERE task_id=?"
        " ORDER BY created_at DESC,id DESC LIMIT 1",
        (task_id,),
    ).fetchone()
    latest_decision = None
    if decision:
        latest_decision = decision[1][:80]
        if decision[2] is not None:
            latest_decision += f" · 修订自 #{decision[0]} ← #{decision[2]}"

    return {
        "blocked_by": blocked_by,
        "stuck_at": blocked_by[-1]["id"] if blocked_by else None,
        "regressed_by": open_regressions(con).get(task_id, []),
        "unblocks": unblocks,
        "lineage": {
            "split_from": parents[0] if parents else None,
            "split_out": edge_ids(dst=task_id, kind="split_from"),
            "supersedes": edge_ids(src=task_id, kind="supersedes"),
            "superseded_by": edge_ids(dst=task_id, kind="supersedes"),
            "latest_decision": latest_decision,
        },
        "epic": row["epic"],
    }


def open_regressions(con: sqlite3.Connection) -> dict[str, list[str]]:
    """done 卡 → 还没完成的修复卡。派生值：修复卡一完成，红标自己消失。"""
    out: dict[str, list[str]] = {}
    for dst, src in con.execute(
        "SELECT e.dst, e.src FROM task_edges e"
        " JOIN tasks s ON s.id=e.src JOIN tasks d ON d.id=e.dst"
        " WHERE e.kind='regresses' AND d.status='done'"
        " AND s.status NOT IN ('done','cancelled') ORDER BY e.dst, e.src"):
        out.setdefault(dst, []).append(src)
    return out


def kin(path: Path | str, task_id: str) -> dict:
    """Return active dependencies, downstream tasks, and lineage for one task."""
    con = connect(path)
    try:
        return _kin(con, task_id)
    finally:
        con.close()


def _check_now(now: str) -> str:
    now = now.strip()
    if not now:
        raise NawabanError("now 不得为空:板上当前态一句(到哪了 / 下一步)≤200")
    if len(now) > 200:
        raise NawabanError(f"now 超长 {len(now)}/200:一句话,细节进 event body")
    return now


def _stored_session_owner(con: sqlite3.Connection, task_id: str,
                          owner: str, session_id: str) -> str:
    """Resume a legacy card only through its exact, still-open session history.

    Write callers must use their transaction; read-only diagnostics can use it
    without mutation. Stored identities and exact owner CAS remain unchanged.
    """
    from nawaban.owner_identity import is_legacy_owner, session_owners

    current, legacy = session_owners(session_id)
    if owner != current or not is_legacy_owner(legacy):
        return owner
    hit = con.execute(
        "SELECT 1 FROM tasks t JOIN task_sessions s ON s.task_id=t.id"
        " WHERE t.id=? AND t.owner=? AND s.owner=t.owner"
        " AND s.session_id=? AND s.ended_at IS NULL",
        (task_id, legacy, session_id),
    ).fetchone()
    return legacy if hit else owner


def start_task(path: Path | str, task_id: str, *, owner: str, session_id: str,
               now: Optional[str] = None) -> None:
    """claimed→in_progress。CLI 层 --now 必填(2026-09-07 字段合同):开工那一刻板面就该
    有进展,否则 3/3 in_progress 卡 now 为空(实测)—— 空不是「没进展」,是没给写入口。
    库层可选:测试夹具直连不受闸。"""
    now = _check_now(now) if now is not None else None
    con = connect(path)
    try:
        with _txn(con):
            stored_owner = _stored_session_owner(con, task_id, owner, session_id)
            cur = con.execute(
                "UPDATE tasks SET status='in_progress', started_at=COALESCE(started_at,?),"
                " now=COALESCE(?, now) WHERE id=? AND status='claimed' AND owner=?",
                (_now(), now, task_id, stored_owner),
            )
            if cur.rowcount != 1:
                raise NawabanError(f"start 被拒:{task_id} 不在 claimed 态或 owner 不符")
            _event(con, task_id, "status_change", "claimed→in_progress", owner, session_id)
    finally:
        con.close()


def advance_task(path: Path | str, task_id: str, *, to: str,
                 waiting_on: Optional[str] = None,
                 owner: str, session_id: str) -> None:
    con = connect(path)
    try:
        with _txn(con):
            row = _task_row(con, task_id)
            frm = row["status"]
            if (frm, to) not in _ADVANCE:
                raise NawabanError(f"非法转移:{frm}→{to}")
            if frm == "done":
                raise NawabanError("done 的卡只能经 reopen_task 打回(须带理由),不走 transition")
            if to == "staging-verified":
                # staging-verified 是可选路径(foreman simplify regression):有用户可见行为、
                # 要真机验收或等人的卡才走;纯内部改动 CI 绿合并直接 done。
                if waiting_on not in WAITING:
                    raise NawabanError(
                        "翻 verified 必带 waiting_on ∈ decision/prod/observe/external(验收闸);"
                        "不需要验收的卡合并后直接 transition --to done")
                n = con.execute(
                    "SELECT count(*) FROM task_refs WHERE task_id=? AND kind='acceptance_run'",
                    (task_id,),
                ).fetchone()[0]
                if n == 0:
                    raise NawabanError("翻 verified 前先 ref 一条 acceptance_run 证据指针(验收闸)")
                # 入口闸(NAWABAN-DECISION-ASK-GATE-001 · 2026-08-24):waiting_on='decision'
                # 的卡,done 闸②只认经 ask→answer 通道落的运行时拍板行。若此刻不挂一条
                # 未关的 ask,这张卡就等一个**永远不会被问出口的问题** —— 人从没在收件箱
                # 见过它,拍板行永不出现,卡永久沉底。实测:46 张 decision 卡里 28 张
                # 从没提过 ask(占 61%),全靠人工翻库才发现。出口设死闸而入口不设,
                # 沉底是必然而非偶然。
                if waiting_on == "decision":
                    m = con.execute(
                        "SELECT count(*) FROM ask_tasks t JOIN asks a ON a.id=t.ask_id"
                        " WHERE t.task_id=? AND a.closed_at IS NULL",
                        (task_id,),
                    ).fetchone()[0]
                    if m == 0:
                        raise NawabanError(
                            "decision 闸:翻 verified 且等人拍板,必须先有一条未关的 ask —— "
                            "否则人永远不会在收件箱里见到这张卡。\n"
                            "  先提问再翻牌:nawaban ask --kind decide --task " + task_id +
                            ' --question "..." --evidence "..." --option "选项|后果" --option "..."')
                con.execute(
                    "UPDATE tasks SET status=?, waiting_on=? WHERE id=?",
                    (to, waiting_on, task_id),
                )
            elif to == "done":
                if frm == "in_progress":
                    # 直通 done(foreman simplify regression):CI 绿是合并前提,不另证;
                    # 只要一条 merge_sha 指针 —— 冷启动要知道 done 指向哪次合并。
                    n = con.execute(
                        "SELECT count(*) FROM task_refs WHERE task_id=? AND kind='merge_sha'",
                        (task_id,),
                    ).fetchone()[0]
                    if n == 0:
                        raise NawabanError(
                            "done 闸:直通归档须先 ref 一条 merge_sha —— "
                            f"nawaban ref {task_id} --kind merge_sha --value <sha>")
                else:
                    n = con.execute(
                        "SELECT count(*) FROM task_refs WHERE task_id=? AND kind='acceptance_run'",
                        (task_id,),
                    ).fetchone()[0]
                    if n == 0:
                        raise NawabanError("done 闸:无 acceptance_run 证据不得归档")
                    # done 闸②(no_fabrication 咬合):等拍板的卡必须有一次**真实的、当下的**拍板动作,
                    # 否则 agent 可静默自批。统一律(NAWABAN-COMPILE-GATE-001 · 2026-08-12 三方对齐):
                    #   ① 只认**运行时**拍板行 —— `provenance IS NULL` ⟺ 经 decide() 落的行;
                    #      import_task 每行必带 provenance,**历史回放的拍板行永不满足本闸**。
                    #      (原 `COALESCE(锚点,0)` 让无锚点卡退化成「任何历史 user 行都算数」= fail-open 到底。)
                    #   ② 有锚点时再加时间约束:须**严格晚于**锚点秒。`>` 而非 `>=` —— created_at 是
                    #      秒级整数,同秒先后不可分辨,分不清就不认;同秒恰是 agent 机器速度自批的特征。
                    # 为什么①要覆盖有锚点分支(阿搬 2026-08-12 提,采纳):否则该分支是裸时间比对,
                    # 「导入行挡得住」只是粒度巧合(转写锚点是完整 ISO、导入决策行落午夜),
                    # 巧合成立不是结构成立;且 decided_by 本就是从旧卡文本**推断**来的(provenance
                    # 存在的理由就是「推断会错、误标可纠」),拿推断值当 done 的凭据正是要防的事。
                    # 代价:历史卡未来 done 一律须现落一条真人拍板 —— 正是本闸要的。
                    if row["waiting_on"] == "decision":
                        ts = con.execute(
                            "SELECT max(created_at) FROM task_events WHERE task_id=?"
                            " AND kind='status_change' AND body LIKE '%→staging-verified%'",
                            (task_id,),
                        ).fetchone()[0]
                        sql = ("SELECT count(*) FROM task_decisions WHERE task_id=?"
                               " AND decided_by='user' AND provenance IS NULL")
                        params: tuple = (task_id,)
                        if ts is not None:
                            sql += " AND created_at>?"
                            params += (ts,)
                        if con.execute(sql, params).fetchone()[0] == 0:
                            raise NawabanError(
                                "done 闸②:须有一条**运行时**真人拍板行"
                                + ("(且须晚于翻 staging-verified 的时刻)" if ts is not None
                                   else "(本卡无 →staging-verified 锚点事件)")
                                + ";历史导入的 user 行一律不算数 —— decide --by user · 经拍板通道")
                con.execute(
                    "UPDATE tasks SET status='done', waiting_on=NULL, completed_at=? WHERE id=?",
                    (_now(), task_id),
                )
            else:  # staging-verified → in_progress 返工
                con.execute(
                    "UPDATE tasks SET status='in_progress', waiting_on=NULL WHERE id=?",
                    (task_id,),
                )
            _event(con, task_id, "status_change", f"{frm}→{to}", owner, session_id)
    finally:
        con.close()


def reopen_task(path: Path | str, task_id: str, *, reason: str,
                owner: str, session_id: str) -> None:
    """打回已归档的卡(NAWABAN-ACCEPT-SELFEVIDENT-001)。

    自证型验收让 agent 能自批归档,这条就是它的对价:人(或任何人)看到 digest 里
    不该归档的那张,一条命令把它推回 in_progress。打回是**安全方向**——不设身份闸,
    只强制留理由与留痕。没有它,自证 lane 就是把验收闸删了。
    """
    if not reason or not reason.strip():
        raise NawabanError("打回必须带理由(--reason):不写理由的打回,接手的人不知道要改什么")
    con = connect(path)
    try:
        with _txn(con):
            row = _task_row(con, task_id)
            if row["status"] not in TERMINAL:
                raise NawabanError(
                    f"只有终态(done/cancelled)的卡能打回,{task_id} 现在是 {row['status']}")
            # 作废的卡打回 open 而非 in_progress:它从没被人做过,回去仍是「可认领」。
            back = "open" if row["status"] == "cancelled" else "in_progress"
            con.execute(
                f"UPDATE tasks SET status='{back}', waiting_on=NULL, completed_at=NULL"
                " WHERE id=?", (task_id,))
            _event(con, task_id, "status_change",
                   f"{row['status']}→{back}·打回:{reason.strip()}", owner, session_id)
    finally:
        con.close()


def cancel_task(path: Path | str, task_id: str, *, reason: str,
                owner: str, session_id: str, supersedes: Optional[str] = None) -> None:
    """作废一张前提已消失的卡(NAWABAN-CANCEL-001 · 2026-08-30 用户拍板)。

    为什么不复用 done:done 的语义是**验收过**,库层三道闸都在为它把关。给一张
    「需求本身没了」的卡编一条 acceptance_run 塞进 done,是拿假证据换一个干净的板 ——
    正是那三道闸要防的事。cancelled 是第二种终态:活儿不做了,且说得出为什么。

    只从 open 起跳。claimed/in_progress 的卡先 release 回 open 再作废 —— 有人正在上面
    干活时,作废该是那个人的决定,不是旁人一条命令。
    `--supersedes` 挂一条 supersedes 边,指向真正接手这件事的卡(可选:多数过期卡无接手者)。
    反悔走 reopen(cancelled→open,理由必填)。
    """
    if not reason or not reason.strip():
        raise NawabanError(
            "作废必须带理由(--reason):板上少一张卡是小事,"
            "「为什么这活不做了」丢了才是下一个 agent 重走死路的原因")
    con = connect(path)
    try:
        with _txn(con):
            row = _task_row(con, task_id)
            if row["status"] != "open":
                raise NawabanError(
                    f"只有 open 的卡能作废,{task_id} 现在是 {row['status']}"
                    + ("(有人正在做:先 nawaban release 或让 owner 自己决定)"
                       if row["status"] in ("claimed", "in_progress") else ""))
            if supersedes:
                _task_row(con, supersedes)  # 幻觉闸:接手卡必须真实存在
                con.execute(
                    "INSERT OR IGNORE INTO task_edges(src,dst,kind,note,created_at,created_by)"
                    " VALUES(?,?,'supersedes',?,?,?)",
                    (supersedes, task_id, "作废接手", _now(), owner))
            con.execute(
                "UPDATE tasks SET status='cancelled', waiting_on=NULL, completed_at=?"
                " WHERE id=?", (_now(), task_id))
            _event(con, task_id, "status_change",
                   f"open→cancelled·作废:{reason.strip()}"
                   + (f"(由 {supersedes} 接手)" if supersedes else ""),
                   owner, session_id)
    finally:
        con.close()


def add_event(path: Path | str, task_id: str, *, kind: str, body: str,
              author: str, session_id: Optional[str] = None,
              now: Optional[str] = None) -> None:
    """记事件;带 now 时顺手刷新板面当前态(留痕就是这条事件本身)。

    now 不再只有 handoff 能写(NAWABAN-CARD-POLISH-001 ①):收尾后 / 中途都能刷,
    不要求活的 session leg。
    """
    if kind not in ("note", "coord", "acceptance", "verify"):
        raise NawabanError(f"event 动词只收 note/coord/acceptance/verify,{kind} 走各自专属工具")
    if now is not None:
        now = _check_now(now)
    con = connect(path)
    try:
        _task_row(con, task_id)
        with _txn(con):
            _event(con, task_id, kind, body, author, session_id)
            if now is not None:
                con.execute("UPDATE tasks SET now=? WHERE id=?", (now, task_id))
    finally:
        con.close()


META_FIELDS = ("epic", "project")


def retitle(path: Path | str, task_id: str, *, title: str, author: str,
            session_id: Optional[str] = None) -> str:
    """改标题(带留痕:旧标题进 note 事件,可回溯)。返回旧标题。

    人话标题闸在 cli 层(_title_gate),这里只管写 —— import_md / 测试夹具直连 db 不受闸。
    """
    title = title.strip()
    if not title:
        raise NawabanError("title 不得为空")
    con = connect(path)
    try:
        with _txn(con):
            old = _task_row(con, task_id)["title"]
            if old == title:
                raise NawabanError(f"title 没变:{task_id}")
            con.execute("UPDATE tasks SET title=? WHERE id=?", (title, task_id))
            _event(con, task_id, "note", f"retitle:旧标题 «{old}»", author, session_id)
    finally:
        con.close()
    return old


def remodule(path: Path | str, task_ids: list[str], *, epic: str, reason: str,
             author: str, session_id: Optional[str] = None) -> tuple[int, int]:
    """Rename modules atomically with audit notes; return changed/skipped counts."""
    epic = epic.strip()
    if not epic:
        raise NawabanError("模块名不能为空")
    if len(epic) > 20:
        raise NawabanError("模块名最多 20 个字符")
    if any(char in epic for char in "·(（"):
        raise NawabanError("模块名不能包含 ·、(、（，这些字符会触发模块折叠")
    if epic.lower().startswith(("n/a", "无档")):
        raise NawabanError("模块名不能以 n/a 或 无档 开头，这些前缀会被视为未归组")
    if not reason.strip():
        raise NawabanError("改模块的理由不能为空(--reason)")
    changed = skipped = 0
    con = connect(path)
    try:
        with _txn(con):
            for task_id in task_ids:
                old = _task_row(con, task_id)["epic"]
                if old == epic:
                    skipped += 1
                    continue
                con.execute("UPDATE tasks SET epic=? WHERE id=?", (epic, task_id))
                _event(con, task_id, "note", f"模块 {old or '(空)'} → {epic} · {reason}",
                       author, session_id)
                changed += 1
    finally:
        con.close()
    return changed, skipped


def set_meta(path: Path | str, task_id: str, *, fields: dict, author: str,
             session_id: Optional[str] = None) -> None:
    """Fill empty epic/project fields with an audit event.

    语义只补空不改写:已有值要改,走 decide 留痕后再人工判断,别在这里悄悄覆盖。
    """
    bad = [k for k in fields if k not in META_FIELDS]
    if bad:
        raise NawabanError(f"meta 只收 {META_FIELDS},不认:{bad}")
    fields = {k: v.strip() for k, v in fields.items() if v and v.strip()}
    if not fields:
        raise NawabanError("meta 没给任何值:--set-epic / --set-project")
    con = connect(path)
    try:
        with _txn(con):
            row = _task_row(con, task_id)
            # epic 的 'n/a' 视同空:它是「没归组」的旧写法
            taken = [k for k in fields
                     if str(row[k] or "").strip()
                     and not (k == "epic" and str(row[k]).strip().lower() == "n/a")]
            if taken:
                raise NawabanError(
                    f"meta 只补空不改写:{taken} 已有值(现值 "
                    + " · ".join(f"{k}={row[k]!r}" for k in taken)
                    + ")。要改走 decide 留痕。")
            con.execute(
                f"UPDATE tasks SET {', '.join(k + '=?' for k in fields)} WHERE id=?",
                (*fields.values(), task_id),
            )
            _event(con, task_id, "note",
                   "meta 补填:" + " · ".join(f"{k}={v}" for k, v in fields.items()),
                   author, session_id)
    finally:
        con.close()


def handoff(path: Path | str, task_id: str, *, owner: str, session_id: str,
            outcome: str, summary: str, now: Optional[str] = None,
            body: Optional[str] = None, artifacts: Optional[Sequence[str]] = None,
            release: bool = False) -> None:
    """收尾三件套原子:sessions 收行 + handoff 事件 + tasks.now。含 artifact 保存闸。

    now 必填(NAWABAN-COMPILE-GATE-001):schema 无 now 的更新时间戳,「now 未动」无法 diff,
    要 diff 就得新增存储——违背「编译闸=强化执法不新增存储」。改为在唯一写 now 的入口硬性要求,
    三件套才是真原子(缺一件 = 整笔拒,不落半套)。
    """
    if outcome not in SESSION_OUTCOMES:
        raise NawabanError(f"outcome 必须 ∈ {SESSION_OUTCOMES}")
    if now is None or not now.strip():
        raise NawabanError("收尾三件套缺 now:--now 必填(板上当前态一句 ≤200)")
    missing = [a for a in (artifacts or []) if not Path(a).expanduser().is_file()]
    if missing:
        raise NawabanError(f"保存闸:声明的 artifact 不存在,拒绝收尾 → {missing}")
    con = connect(path)
    try:
        with _txn(con):
            stored_owner = _stored_session_owner(con, task_id, owner, session_id)
            # handoff 闸(BOARD-REVAMP · 2026-08-29):completed 但卡还没翻牌 = 下一步断链。
            # 窗口一消失 reclaim 把卡退 open,收件箱点收下撞「非法转移 open→done」——
            # 一天撞出 4 例(DAGVIEW×2 / FOREMAN-SKILL-SLIM / HOUSEKEEP)。活真完了先 transition;
            # 没到那步就如实用 handed_off/blocked,别叫 completed。
            if outcome == "completed":
                st = _task_row(con, task_id)["status"]
                if st not in ("staging-verified", "done"):
                    raise NawabanError(
                        f"handoff 闸:outcome=completed 但卡还在 {st} —— 先翻牌再收尾:\n"
                        "  合并即归档:nawaban ref … --kind merge_sha && transition --to done\n"
                        "  等人验:nawaban ask --kind accept … && transition --to staging-verified --waiting-on decision\n"
                        "  活没到那步:outcome 用 handed_off/blocked 如实收尾")
            cur = con.execute(
                "UPDATE task_sessions SET ended_at=?, outcome=?, summary=?"
                " WHERE task_id=? AND session_id=? AND ended_at IS NULL",
                (_now(), outcome, summary, task_id, session_id),
            )
            if cur.rowcount != 1:
                raise NawabanError(f"无未收尾的 session 履历({task_id} × {session_id}):先 claim/start")
            _event(con, task_id, "handoff", body or summary, owner, session_id)
            con.execute("UPDATE tasks SET now=? WHERE id=?", (now, task_id))
            for a in artifacts or []:
                con.execute(
                    "INSERT OR IGNORE INTO task_refs (task_id, kind, value, created_at)"
                    " VALUES (?,?,?,?)",
                    (task_id, "artifact", str(Path(a).expanduser()), _now()),
                )
            if release:
                # 释放 owner 的同时必须把锁定态一起降回 open(WORKTREE-GATE-001 · 2026-08-20)。
                # 不变量:**claimed/in_progress ⇒ owner 非空**。原来只清 owner 不动 status,
                # 造出「匿名 + in_progress」的行 —— 那正是 guard.load_locked_cards 判为
                # 「不可信锁行」的形状,一行就让整块板 fail-closed、所有窗口的 Edit 全被拦。
                # (判例 pr sweep stale regression:活其实干完了,--release 之后板子哑火,
                #  因为 worktree 读不到板才一直没人发现。)
                # 降到 open 而不是拒绝 --release:--release 的语义就是「放出来给人接力」,
                # 无主可接 = open,这是唯一自洽的状态。
                con.execute(
                    "UPDATE tasks SET owner=NULL,"
                    " status=CASE WHEN status IN ('claimed','in_progress') THEN 'open'"
                    " ELSE status END"
                    " WHERE id=? AND owner=?",
                    (task_id, stored_owner),
                )
    finally:
        con.close()


def reclaim_task(path: Path | str, task_id: str, *, expected_owner: Optional[str],
                 reason: str, actor: str = "reclaim") -> bool:
    """把窗口已经不在的卡放回可认领。返回 False = 没写(期间被别人动过)。

    **CAS 带上判据所依据的那个快照值**(`owner IS ?`,不是 `= ?`):决定"该回收"是在
    库外面算的(读转录 mtime、比时间戳),算完到写进去之间隔着一段没握锁的时间。这期间
    那张卡可能已经被回收并被**另一个窗口重新 claim** —— 用旧快照去写就会把活人正在干的
    卡踢成无主,而板上还显示它可被认领。用 `IS` 而不是 `=` 是因为 owner 可空,
    `owner = NULL` 在 SQL 里恒不匹配。

    状态必须跟着 owner 一起退:只清 owner 会造出「匿名 + in_progress」的行,那是
    guard 判为「不可信锁行」的形状,一行就让整块板 fail-closed(判例 pr sweep stale regression)。
    """
    con = connect(path)
    try:
        with _txn(con):
            cur = con.execute(
                "UPDATE tasks SET owner=NULL,"
                " status=CASE WHEN status IN ('claimed','in_progress') THEN 'open'"
                " ELSE status END"
                " WHERE id=? AND owner IS ?",
                (task_id, expected_owner),
            )
            if cur.rowcount == 0:
                return False
            _event(con, task_id, "coord",
                   f"自动回收:原 owner {expected_owner or '(无)'} 的窗口已不在 —— {reason}。"
                   "卡已退回 open 可被重新 claim;这不算失败,活干到哪看上面的事件与 handoff。",
                   actor, None)
        return True
    finally:
        con.close()


def decide(path: Path | str, task_id: str, *, question: str, verdict: str,
           rejected: Optional[Sequence[dict]] = None, decided_by: str,
           adr: Optional[str] = None, supersedes: Optional[int] = None,
           set_success: Optional[Sequence[str]] = None) -> None:
    """决策落痕。规则①:success 只能经本函数修改(原子:decision 行 + success 更新)。

    no_fabrication:decided_by='user' 只能由拍板通道产生——tg(TG daemon 自动设)、
    chat(对话转述:agent 须显式设 env 并在 verdict 带用户原话,留下有意为之的痕迹)、
    inbox(人在收件箱里回答一个 ask · NAWABAN-INBOX-WRITE-001,由 cli answer 设)。
    agent 不得凭空代填。
    """
    if decided_by == "user" and os.environ.get("NAWABAN_DECISION_CHANNEL") not in DECISION_CHANNELS:
        raise NawabanError(
            "decided_by=user 只能经拍板通道:TG 回写(tg)、对话转述(chat,verdict 须带用户原话)"
            "或收件箱回答(inbox)")
    con = connect(path)
    try:
        _task_row(con, task_id)
        with _txn(con):
            con.execute(
                "INSERT INTO task_decisions (task_id, question, verdict, rejected,"
                " decided_by, adr, supersedes, created_at) VALUES (?,?,?,?,?,?,?,?)",
                (task_id, question, verdict, _jd(list(rejected) if rejected else None),
                 decided_by, adr, supersedes, _now()),
            )
            if set_success is not None:
                con.execute("UPDATE tasks SET success=? WHERE id=?",
                            (_jd(list(set_success)), task_id))
    finally:
        con.close()


def add_letter(path: Path | str, task_id: str, *, kind: str, msg: str,
               links: Optional[str] = None, session_id: Optional[str] = None) -> int:
    """写一封信(NAWABAN-LETTERS-DB-001)。写侧闸:卡必须存在,kind 限四态,msg 非空。"""
    if kind not in LETTER_KINDS:
        raise NawabanError(f"letter kind 只收 {LETTER_KINDS},不认:{kind}")
    if not (msg or "").strip():
        raise NawabanError("letter 必须有 msg(一句人话汇报)")
    con = connect(path)
    try:
        with _txn(con):
            _task_row(con, task_id)  # 幻觉闸:卡不存在当场拒
            cur = con.execute(
                "INSERT INTO letters (task_id, kind, msg, links, session_id, created_at)"
                " VALUES (?,?,?,?,?,?)",
                (task_id, kind, msg.strip(), links, session_id, _now()))
            return int(cur.lastrowid)
    finally:
        con.close()


def list_letters(path: Path | str, *, unread_only: bool = False,
                 task_id: Optional[str] = None, limit: int = 50) -> list[dict]:
    con = connect(path)
    con.row_factory = sqlite3.Row
    try:
        sql = "SELECT * FROM letters WHERE 1=1"
        params: list = []
        if unread_only:
            sql += " AND read_at IS NULL"
        if task_id:
            sql += " AND task_id=?"
            params.append(task_id)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        return [dict(r) for r in con.execute(sql, params)]
    finally:
        con.close()


def mark_letters_read(path: Path | str, ids: Sequence[int]) -> int:
    con = connect(path)
    try:
        with _txn(con):
            cur = con.execute(
                f"UPDATE letters SET read_at=? WHERE read_at IS NULL AND id IN"
                f" ({','.join('?' * len(ids))})", (_now(), *ids))
            return cur.rowcount
    finally:
        con.close()


def link_tasks(path: Path | str, src: str, dst: str, *, kind: str,
               note: Optional[str] = None, created_by: str) -> None:
    con = connect(path)
    try:
        for t in (src, dst):
            if con.execute("SELECT 1 FROM tasks WHERE id=?", (t,)).fetchone() is None:
                raise NawabanError(f"幻觉闸:卡不存在 → {t}(引用不存在的卡当场拒)")
        if src == dst:
            raise NawabanError("不许自环")
        if kind == "depends_on" and _reaches(con, start=dst, target=src):
            raise NawabanError(f"depends_on 环:{dst} 已(传递)依赖 {src}")
        if kind == "regresses":
            src_status, dst_status = (_task_row(con, t)["status"] for t in (src, dst))
            if dst_status != "done":
                raise NawabanError(f"regresses 只指向 done 的卡:{dst} 现在是 {dst_status}"
                                   "(还没交付的卡没有「被弄坏」一说，直接在原卡上修)")
            if src_status in TERMINAL:
                raise NawabanError(f"regresses 的起点必须是还没完成的修复卡:{src} 已是 {src_status}")
            if not (note or "").strip():
                raise NawabanError("regresses 必须带 --note:写清是哪次合并弄坏的，修复的人从这里开始查")
        with _txn(con):
            con.execute(
                "INSERT OR IGNORE INTO task_edges (src, dst, kind, note, created_at, created_by)"
                " VALUES (?,?,?,?,?,?)",
                (src, dst, kind, note, _now(), created_by),
            )
    finally:
        con.close()


def _reaches(con: sqlite3.Connection, *, start: str, target: str) -> bool:
    """depends_on 图上 start 能否走到 target(DFS,防环)。"""
    seen, stack = set(), [start]
    while stack:
        cur = stack.pop()
        if cur == target:
            return True
        if cur in seen:
            continue
        seen.add(cur)
        stack.extend(r[0] for r in con.execute(
            "SELECT dst FROM task_edges WHERE src=? AND kind='depends_on'", (cur,)))
    return False


def add_ref(path: Path | str, task_id: str, *, kind: str, value: str,
            note: Optional[str] = None) -> None:
    if kind == "artifact" and not Path(value).expanduser().is_file():
        raise NawabanError(f"保存闸:artifact 文件不存在 → {value}")
    con = connect(path)
    try:
        _task_row(con, task_id)
        with _txn(con):
            con.execute(
                "INSERT OR IGNORE INTO task_refs (task_id, kind, value, note, created_at)"
                " VALUES (?,?,?,?,?)",
                (task_id, kind, value, note, _now()),
            )
    finally:
        con.close()


# ── 人侧收件箱(NAWABAN-INBOX-SCHEMA-001)──────────────────────────────

# 判「有没有真材料」:零宽字符在 str.strip() 和 SQLite trim() 里都不算空白,但人眼看不见。
# 类别判定自动覆盖全部 Cf(格式控制,含 U+200B/U+2060/U+00AD/TAG 段)与各类空白;
# 剩下这撮是「渲染成空白但类别是字母/符号」的 —— 类别推不出字形,只能手工兜底。
_BLANK_CATEGORIES = frozenset(("Cf", "Cc", "Zs", "Zl", "Zp"))
_INVISIBLE_EXTRA = "\u3164\u2800\u115f\u1160\u3000"


def _visible(s: Optional[str]) -> bool:
    """整串里有没有任何一个字符是人眼看得见的。

    单遍扫描,不用链式 strip:strip 每次只剥两端「同一字符集连续同质」的一层,
    固定 N 次 pass 就隐含「最多 N-1 层」的假设 —— 空格与零宽交替 3 层以上直接漏,
    而那恰好是这条闸要挡的东西(判例 2026-08-15,codex 复审实测)。
    """
    if not s:
        return False
    return any(
        not (c.isspace() or c in _INVISIBLE_EXTRA
             or unicodedata.category(c) in _BLANK_CATEGORIES)
        for c in s
    )


def raise_ask(path: Path | str, *, kind: str, question: str, evidence: str,
              task_ids: Sequence[str], raised_by: str,
              options: Any = None, blast: Any = None,
              hands_on: bool = False, raised_at: Optional[int] = None,
              confidence: Optional[float] = None,
              confidence_reason: Optional[str] = None) -> int:
    """提一个 ask,返回 id。

    materials 闸在**写侧**:`evidence` 由 DDL 保证非空 —— 提不出没材料的问题。
    (读侧筛「没材料的卡」是事后惩罚人:卡已经堵在队列里了,筛掉只是让人看不见它。)
    三类各自的必填(decide 要 options / authorize 要 blast)是策略,由 cli 层闸管。

    `raised_at` 语义是**这个问题从什么时候开始等人**,不是"这行什么时候写进库"。
    迁移既有队列时必须传底卡的最后活动时刻 —— 否则全部 ask 停滞天数都是 0,
    「按停滞排序」当场失效,而那正是用来对抗「把最新的卡捧上首屏」的机制。
    """
    if kind not in ASK_KINDS:
        raise NawabanError(f"ask kind 只收 {ASK_KINDS},收到 {kind!r}")
    if not _visible(evidence):
        # DDL 的 trim 字符集只覆盖 ASCII 空白;零宽空格(U+200B)、不间断空格(U+00A0)
        # 能穿过去,落一条「材料非空但人眼看不见」的 ask —— 那正是材料闸要防的事。
        raise NawabanError("evidence 去掉不可见字符后是空的 —— 没有材料的问题提不出来")
    if not _visible(question):
        raise NawabanError("question 去掉不可见字符后是空的")
    if not task_ids:
        raise NawabanError("ask 必须至少挂一张卡 —— 不挂卡的问题没有上下文")
    if confidence is not None:
        if not 0 <= confidence <= 1:
            raise NawabanError(f"confidence 要在 0..1,收到 {confidence}")
        if not _visible(confidence_reason):
            # 光给分数不给理由 = 黑盒换黑盒(ADR-0209 原则 6)
            raise NawabanError("给了 confidence 就必须给 confidence_reason —— 分数不可审计,理由才可以")
    elif _visible(confidence_reason):
        # 反向也得挡:只有 reason 没有分数时读侧按「没有置信度」渲染,这条理由永远见不到人
        raise NawabanError("给了 confidence_reason 却没给 confidence —— 单独的理由读侧渲染不出来")
    con = connect(path)
    try:
        with _txn(con):
            for t in task_ids:
                _task_row(con, t)  # 幻觉闸:卡不存在当场炸
            cur = con.execute(
                "INSERT INTO asks(kind,question,evidence,options,blast,hands_on,"
                "raised_at,raised_by,confidence,confidence_reason)"
                " VALUES(?,?,?,?,?,?,?,?,?,?)",
                (kind, question, evidence, _jd(options), _jd(blast),
                 int(bool(hands_on)), int(raised_at or _now()), raised_by,
                 confidence, (confidence_reason or "").strip() or None),
            )
            ask_id = int(cur.lastrowid or 0)
            con.executemany(
                "INSERT INTO ask_tasks(ask_id,task_id) VALUES(?,?)",
                [(ask_id, t) for t in dict.fromkeys(task_ids)],
            )
        return ask_id
    finally:
        con.close()


def close_ask(path: Path | str, ask_id: int, *, closed_as: str,
              answer: Optional[str] = None,
              decision_id: Optional[int] = None) -> None:
    """关闭一个 ask。四种关闭态缺一不可 —— 少了哪种,那类 ask 就变成新的僵尸。"""
    if closed_as not in ASK_CLOSED:
        raise NawabanError(f"closed_as 只收 {ASK_CLOSED},收到 {closed_as!r}")
    con = connect(path)
    try:
        with _txn(con):
            # connect() 不设 row_factory,按位取
            row = con.execute("SELECT closed_at FROM asks WHERE id=?", (ask_id,)).fetchone()
            if row is None:
                raise NawabanError(f"ask #{ask_id} 不存在")
            if row[0] is not None:
                # 并发:两个窗口同时答同一个 ask,第二个拿明确报错而非静默覆盖
                raise NawabanError(f"ask #{ask_id} 已关闭,不可重复关")
            con.execute(
                "UPDATE asks SET closed_at=?,closed_as=?,answer=?,decision_id=? WHERE id=?",
                (_now(), closed_as, answer, decision_id, ask_id),
            )
    finally:
        con.close()


def _ro_con(path: Path | str) -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{Path(path)}?mode=ro", uri=True, timeout=10)
    con.row_factory = sqlite3.Row
    return con


def open_asks(path: Path | str) -> list[dict]:
    """人侧的**整个**界面就是这一个查询。没有列、没有状态机、没有过滤器要选。"""
    con = _ro_con(path)
    try:
        rows = con.execute(
            "SELECT * FROM asks WHERE closed_at IS NULL ORDER BY raised_at"
        ).fetchall()
        out = []
        now = _now()
        for r in rows:
            d = dict(r)
            d["options"] = _j(r["options"])
            d["blast"] = _j(r["blast"])
            d["hands_on"] = bool(r["hands_on"])
            d["stalled_days"] = round((now - r["raised_at"]) / 86400, 1)
            d["confidence"] = r["confidence"] if "confidence" in r.keys() else None
            d["confidence_reason"] = (r["confidence_reason"]
                                      if "confidence_reason" in r.keys() else None)
            d["task_ids"] = [x[0] for x in con.execute(
                "SELECT task_id FROM ask_tasks WHERE ask_id=? ORDER BY task_id", (r["id"],))]
            out.append(d)
        return out
    finally:
        con.close()


def ask_detail(path: Path | str, ask_id: int) -> dict:
    """一个 ask + 它挂的卡(带卡的实时 status —— 手写快照注解绝种)。"""
    con = _ro_con(path)
    try:
        r = con.execute("SELECT * FROM asks WHERE id=?", (ask_id,)).fetchone()
        if r is None:
            raise NawabanError(f"ask #{ask_id} 不存在")
        d = dict(r)
        d["options"] = _j(r["options"])
        d["blast"] = _j(r["blast"])
        d["hands_on"] = bool(r["hands_on"])
        d["tasks"] = [dict(x) for x in con.execute(
            "SELECT t.id, t.title, t.status, t.waiting_on FROM ask_tasks a"
            " JOIN tasks t ON t.id=a.task_id WHERE a.ask_id=? ORDER BY t.id", (ask_id,))]
        return d
    finally:
        con.close()


# ── 历史导入(NAWABAN-IMPORT-001 · 总监 scope+ 批准的第 10 个机制)────────────

def import_task(path: Path | str, *, task_id: str, title: str, status: str,
                created_at: int, owner: Optional[str] = None,
                waiting_on: Optional[str] = None, epic: Optional[str] = None,
                context: Optional[str] = None, now: Optional[str] = None,
                success: Optional[Sequence[str]] = None,
                constraints: Optional[Sequence[str]] = None,
                touches: Optional[Sequence[str]] = None,
                adr: Optional[str] = None, started_at: Optional[int] = None,
                completed_at: Optional[int] = None,
                events: Sequence[dict] = (), decisions: Sequence[dict] = (),
                sessions: Sequence[dict] = (), refs: Sequence[dict] = ()) -> bool:
    """一次性历史导入:一张卡的 5 张表一事务落库(边走 link_tasks,需两遍)。

    与 9 动词的关系:**动词一行不动**。动词是「前进的生命周期」,闸(acceptance_run 证据 /
    done 闸② user 拍板行)校验的是**此刻新产生的断言**;本函数回放的是**已经发生过的历史**,
    历史里没有的证据不许凭空补(no_fabrication)——所以它绕过闸,而不是放松闸。
    绕过的边界:仅此函数、仅导入期、状态/身份/时间戳全部由调用方从旧卡**如实**解析而来。

    DDL 层的 CHECK(title≤80 / now≤200 / event body≤2KB / 各枚举)仍然全部生效:
    违规不静默截断,整张卡事务回滚并抛错,由调用方计入对账报告的失败清单。

    幂等:卡已存在 → 整卡跳过返回 False(events/decisions 物理 append-only,
    行级去重事后无法修复,只能在卡级别拦)。

    decisions 每行**必须**带 provenance(2026-08-12 用户拍板):decided_by 是从旧卡文本
    推断出来的,推断就会错;{source:'import', file, line, raw} 让每一条 user/agent 归属
    都能回溯到源卡原文行、误标可纠。缺 provenance → KeyError,整卡回滚(fail-closed)。
    """
    con = connect(path)
    try:
        with _txn(con):
            if con.execute("SELECT 1 FROM tasks WHERE id=?", (task_id,)).fetchone():
                return False
            con.execute(
                "INSERT INTO tasks (id, title, status, waiting_on, owner, epic,"
                " context, now, success, constraints_, touches, adr,"
                " created_at, started_at, completed_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (task_id, title, status, waiting_on, owner, epic,
                 context, now, _jd(list(success) if success else None),
                 _jd(list(constraints) if constraints else None),
                 _jd(list(touches) if touches else None),
                 adr, created_at, started_at, completed_at),
            )
            for s in sessions:
                con.execute(
                    "INSERT OR IGNORE INTO task_sessions (task_id, owner, session_id,"
                    " started_at, ended_at, outcome, summary, note) VALUES (?,?,?,?,?,?,?,?)",
                    (task_id, s["owner"], s["session_id"], s["started_at"],
                     s.get("ended_at"), s.get("outcome"), s.get("summary"), s.get("note")),
                )
            for e in events:
                con.execute(
                    "INSERT INTO task_events (task_id, session_id, author, kind, body,"
                    " created_at) VALUES (?,?,?,?,?,?)",
                    (task_id, e.get("session_id"), e["author"], e["kind"], e["body"],
                     e["created_at"]),
                )
            for d in decisions:
                con.execute(
                    "INSERT INTO task_decisions (task_id, question, verdict, rejected,"
                    " decided_by, adr, supersedes, created_at, provenance)"
                    " VALUES (?,?,?,?,?,?,?,?,?)",
                    (task_id, d["question"], d["verdict"],
                     _jd(d.get("rejected")) if d.get("rejected") else None,
                     d["decided_by"], d.get("adr"), d.get("supersedes"), d["created_at"],
                     _jd(d["provenance"])),
                )
            for r in refs:
                con.execute(
                    "INSERT OR IGNORE INTO task_refs (task_id, kind, value, note, created_at)"
                    " VALUES (?,?,?,?,?)",
                    (task_id, r["kind"], r["value"], r.get("note"), r["created_at"]),
                )
        return True
    finally:
        con.close()


def update_touches(path: Path | str, task_id: str, *, add: Sequence[str],
                   reason: str, owner: str, session_id: Optional[str] = None) -> list[str]:
    """扩界的**唯一写入路径**:给 touches 追加路径,原子附一条 scope+ 留痕事件。

    为什么 append-only:touches 是 guard 的防撞面。悄悄扩 = 偷偷扩权(别人以为你只碰 A,
    你已经在碰 B);悄悄缩 = 把还在碰的文件从防撞面移走。两种静默都不许,所以
    ①只增不减 ②reason 必填 ③事件与字段同一事务落盘,没有「改了但没留痕」的中间态。
    收窄(把已声明的路径摘掉)本函数**不做** —— 那是另一种语义(需确认「真的不再碰了」),
    今天没有消费者,别提前造(NAWABAN-WRAPUP-SKILL-001 施工决策)。

    → 返回合并后的完整 touches。重复路径静默忽略(幂等),但若一条新的都没加则拒:
      空操作还留一条 scope+ 事件,会污染「扩过几次界」的审计。
    """
    if not reason.strip():
        raise NawabanError("scope+ 必须写理由(它就是留痕的正文,不许空手扩界)")
    con = connect(path)
    try:
        with _txn(con):
            row = _task_row(con, task_id)
            cur: list[str] = json.loads(row["touches"]) if row["touches"] else []
            fresh = [t for t in add if t not in cur]
            if not fresh:
                raise NawabanError(f"这些路径已在 touches 里,无需扩界:{list(add)}")
            merged = cur + fresh
            con.execute("UPDATE tasks SET touches=? WHERE id=?", (_jd(merged), task_id))
            _event(con, task_id, "coord",
                   f"scope+ touches 追加 {len(fresh)} 项:{' · '.join(fresh)} —— 理由:{reason}",
                   owner, session_id)
        return merged
    finally:
        con.close()


def release_touches(path: Path | str, task_id: str, *, drop: Sequence[str],
                    reason: str, owner: str, session_id: Optional[str] = None) -> list[str]:
    """收窄的**唯一写入路径**:把已声明但确认不再碰的路径从 touches 摘掉,原子附一条 scope- 留痕。

    `update_touches` 当年写「收窄今天没有消费者,别提前造」—— 2026-08-13 有了:**陈旧锁公开收窄协议**
    (agent-foreman)。占路者窗口已死、代码全部合并、工作区对 origin/main 无残留,而 touches 还占着
    别人要的文件时,协议授权任何窗口自行收窄。此前无动词可用,只能绕过工具直改库 = 改了没留痕。

    与 update_touches 对称的三条:①reason 必填 ②字段与事件同一事务 ③空操作拒(不留污染审计的空事件)。
    刻意**不**校验「你是不是 owner」—— 收窄本就是给别人用的动作(自己的卡收窄反倒罕见);
    留痕行里带 owner,谁收的窄一查便知。
    """
    if not reason.strip():
        raise NawabanError("scope- 必须写理由(收窄是动别人的防撞面,不许空手摘)")
    con = connect(path)
    try:
        with _txn(con):
            row = _task_row(con, task_id)
            cur: list[str] = json.loads(row["touches"]) if row["touches"] else []
            hit = [t for t in drop if t in cur]
            if not hit:
                raise NawabanError(f"这些路径本就不在 {task_id} 的 touches 里,无需收窄:{list(drop)}")
            rest = [t for t in cur if t not in hit]
            con.execute("UPDATE tasks SET touches=? WHERE id=?", (_jd(rest), task_id))
            _event(con, task_id, "coord",
                   f"scope- touches 收窄释放 {len(hit)} 项:{' · '.join(hit)} —— 理由:{reason}",
                   owner, session_id)
        return rest
    finally:
        con.close()


def open_claim_rows(path: Path | str, *, session_id: str) -> list[dict]:
    """本 session 未收尾的 claim,带**给人看**的字段(NAWABAN-WRAPUP-SKILL-001)。

    与 open_claims 的分工:那个是编译闸的热路径,每轮 Stop 都跑,只要数量所以越瘦越好;
    这个供收尾工具一次性展示,可以多查几列。同族两函数,别合并成一个带 flag 的。
    """
    con = connect(path)
    try:
        con.row_factory = sqlite3.Row
        return [dict(r) for r in con.execute(
            "SELECT t.id, t.title, t.status, t.now, s.started_at,"
            " (SELECT count(*) FROM task_events e WHERE e.task_id=t.id"
            "   AND e.session_id=s.session_id AND e.kind<>'status_change'"
            "   AND e.id>COALESCE((SELECT MAX(c.id) FROM task_events c"
            "     WHERE c.task_id=s.task_id AND c.session_id=s.session_id"
            "     AND c.kind='status_change' AND c.body='open→claimed'), 0)) AS events"
            " FROM task_sessions s JOIN tasks t ON t.id=s.task_id"
            " WHERE s.session_id=? AND s.ended_at IS NULL ORDER BY s.started_at",
            (session_id,),
        )]
    finally:
        con.close()


def open_claims(path: Path | str, *, session_id: str,
                busy_ms: int = 30000) -> list[tuple[str, int]]:
    """本 session 未收尾的 claim → [(task_id, 实质事件数)]。编译闸的唯一读侧。

    实质 = 排除 status_change:claim 自己就写一条,不排除的话「本 session 干过活」从第 1 轮起
    恒真,顶回预算头两轮就烧光、真到收尾时反而无闸。
    """
    con = connect(path, busy_ms=busy_ms)
    try:
        return [
            (r[0], r[1]) for r in con.execute(
                "SELECT s.task_id,"
                " (SELECT count(*) FROM task_events e WHERE e.task_id=s.task_id"
                "   AND e.session_id=s.session_id AND e.kind<>'status_change'"
                "   AND e.id>COALESCE((SELECT MAX(c.id) FROM task_events c"
                "     WHERE c.task_id=s.task_id AND c.session_id=s.session_id"
                "     AND c.kind='status_change' AND c.body='open→claimed'), 0))"
                " FROM task_sessions s WHERE s.session_id=? AND s.ended_at IS NULL",
                (session_id,),
            )
        ]
    finally:
        con.close()


def backup_db(path: Path | str, *, keep_days: int = 14) -> Path:
    """sqlite backup API 全量备份到 <db 目录>/backups/,清理超期。"""
    src_path = Path(path)
    bdir = src_path.parent / "backups"
    bdir.mkdir(parents=True, exist_ok=True)
    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    dest_path = bdir / f"nawaban-{stamp}.db"
    src = connect(src_path)
    dest = sqlite3.connect(str(dest_path))
    try:
        src.backup(dest)
    finally:
        dest.close()
        src.close()
    cutoff = time.time() - keep_days * 86400
    for old in (*bdir.glob("nawaban-*.db"), *bdir.glob("workos-*.db")):  # Legacy backups.
        if old.stat().st_mtime < cutoff:
            old.unlink()
    return dest_path
