"""`migrate` from an old-schema board, driven through the tracker CLI (spec NAWABAN-LEAN, seam 1)."""

import json
import sqlite3

import pytest

from nawaban import cli

# The old schema as the real board holds it (db.py SCHEMA_SQL after migrate_db), trimmed of indexes.
OLD_SCHEMA = """
CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','in_progress','staging-verified','done','cancelled')),
    waiting_on TEXT, owner TEXT, epic TEXT, context TEXT, now TEXT, success TEXT, constraints_ TEXT,
    touches TEXT, adr TEXT, created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER, project TEXT);
CREATE TABLE task_edges (
    src TEXT NOT NULL REFERENCES tasks(id), dst TEXT NOT NULL REFERENCES tasks(id),
    kind TEXT NOT NULL CHECK (kind IN ('depends_on','split_from','supersedes','regresses')),
    note TEXT, created_at INTEGER NOT NULL, created_by TEXT, PRIMARY KEY (src, dst, kind));
CREATE TABLE task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), session_id TEXT,
    author TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE task_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), question TEXT NOT NULL,
    verdict TEXT NOT NULL, rejected TEXT, decided_by TEXT NOT NULL, adr TEXT,
    supersedes INTEGER REFERENCES task_decisions(id), created_at INTEGER NOT NULL, provenance TEXT);
CREATE TABLE task_sessions (
    task_id TEXT NOT NULL REFERENCES tasks(id), owner TEXT NOT NULL, session_id TEXT NOT NULL,
    started_at INTEGER NOT NULL, ended_at INTEGER, outcome TEXT, summary TEXT, note TEXT,
    PRIMARY KEY (task_id, session_id));
CREATE TABLE task_refs (
    task_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, value TEXT NOT NULL, note TEXT,
    created_at INTEGER NOT NULL, author TEXT, session_id TEXT, PRIMARY KEY (task_id, kind, value));
CREATE TABLE asks (id INTEGER PRIMARY KEY, question TEXT);
"""

T0 = 1_760_000_000


class OldBoard:
    def __init__(self, path):
        self.path = path
        self.con = sqlite3.connect(path)
        self.con.execute("PRAGMA journal_mode=WAL")
        self.con.executescript(OLD_SCHEMA)

    def task(self, id, title="旧任务", status="open", **cols):
        cols = {"id": id, "title": title, "status": status, "created_at": T0, **cols}
        for k in ("success", "constraints_"):
            if isinstance(cols.get(k), list):
                cols[k] = json.dumps(cols[k], ensure_ascii=False)
        self._insert("tasks", cols)

    def edge(self, src, dst, kind):
        self._insert("task_edges", {"src": src, "dst": dst, "kind": kind, "created_at": T0})

    def event(self, task, kind, body, at, author="ac:old"):
        self._insert("task_events", {"task_id": task, "kind": kind, "body": body, "created_at": at,
                                     "author": author})

    def decision(self, task, question, verdict, at, decided_by="user", rejected=None):
        self._insert("task_decisions", {"task_id": task, "question": question, "verdict": verdict,
                                        "rejected": json.dumps(rejected or [], ensure_ascii=False),
                                        "decided_by": decided_by, "created_at": at})

    def ref(self, task, kind, value, at, note=None):
        self._insert("task_refs", {"task_id": task, "kind": kind, "value": value, "note": note,
                                   "created_at": at})

    def session(self, task, session_id, started_at, ended_at=None):
        self._insert("task_sessions", {"task_id": task, "owner": f"ac:{session_id}",
                                       "session_id": session_id, "started_at": started_at,
                                       "ended_at": ended_at})

    def _insert(self, table, cols):
        self.con.execute(f"INSERT INTO {table} ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                         tuple(cols.values()))

    def close(self):
        self.con.commit()
        self.con.close()


@pytest.fixture
def old(tmp_path):
    board = OldBoard(tmp_path / "old.db")
    yield board
    board.con.close()


@pytest.fixture
def run(tmp_path, capsys):
    new = tmp_path / "proj" / ".nawaban" / "nawaban.db"

    def run(*args, db=new):
        code = cli.main(["--db", str(db), *args])
        out = capsys.readouterr()
        return code, out.out, out.err

    run.new = new
    return run


def migrate(run, old):
    old.close()
    return run("migrate", str(old.path), str(run.new))


def test_migrated_task_keeps_title_project_and_builds_its_body(run, old):
    old.task("T-1", title="能看到旧任务", project="alpha", context="原来的缘由",
             success=["第一条", "第二条"], constraints_=["别碰生产"])
    code, out, err = migrate(run, old)
    assert code == 0, err
    show = run("show", "T-1")[1]
    assert "能看到旧任务" in show and "项目 alpha" in show and "状态 open" in show
    assert "原来的缘由\n\n## Acceptance criteria\n\n- 第一条\n- 第二条\n\n## Constraints\n\n- 别碰生产" in show


def test_split_from_becomes_parent_and_depends_on_becomes_blocked_by(run, old):
    old.task("SPEC", project="alpha")
    old.task("A", status="done")
    old.task("B")
    old.task("C")
    for child in ("A", "B", "C"):
        old.edge(child, "SPEC", "split_from")
    old.edge("B", "A", "depends_on")
    old.edge("C", "B", "depends_on")
    old.edge("C", "A", "supersedes")
    assert migrate(run, old)[0] == 0
    c = run("show", "C")[1]
    assert "父任务 SPEC" in c and "被挡:B open" in c
    assert "下游任务:B open\n" in run("show", "A")[1]
    assert len(run("list", "--parent", "SPEC")[1].splitlines()) == 3
    assert {line.split()[0] for line in run("list", "--frontier")[1].splitlines()} == {"SPEC", "B"}


def test_edges_to_missing_tasks_are_skipped_and_counted(run, old):
    old.task("A")
    old.task("B")
    old.edge("A", "GONE", "split_from")
    old.edge("GHOST", "A", "split_from")
    old.edge("B", "GONE", "depends_on")
    old.edge("B", "A", "depends_on")
    code, out, err = migrate(run, old)
    assert code == 0 and "Traceback" not in err, err
    assert "任务 2" in out and "跳过悬空关系 3" in out
    shown = run("show", "B")[1]
    assert "被挡:A open" in shown and "GONE" not in shown
    assert "父任务" not in run("show", "A")[1]


def test_an_unreadable_old_board_is_refused_without_a_traceback(run, old):
    old.task("T")
    old.con.execute("ALTER TABLE tasks DROP COLUMN context")
    code, _, err = migrate(run, old)
    assert code == 1 and err.startswith("✗") and "Traceback" not in err


def _statuses(run):
    return {line.split()[0]: line.split()[1] for line in run("list")[1].splitlines()}


def test_statuses_collapse_and_held_tasks_keep_their_latest_open_session(run, old):
    old.task("CLAIMED", status="claimed", owner="ac:s2")
    old.session("CLAIMED", "s1", T0 + 1)
    old.session("CLAIMED", "s2", T0 + 2)
    old.session("CLAIMED", "s3", T0 + 3, ended_at=T0 + 4)
    old.task("WORKING", status="in_progress", owner="ac:w1")
    old.session("WORKING", "w1", T0 + 1)
    old.task("RECLAIMED", owner=None)  # reclaim leaves the session row open on an open task
    old.session("RECLAIMED", "r1", T0 + 1)
    old.task("STAGED", status="staging-verified")
    old.task("DONE", status="done")
    old.session("DONE", "d1", T0 + 1)
    old.task("GONE", status="cancelled")
    assert migrate(run, old)[0] == 0
    assert _statuses(run) == {"CLAIMED": "in_progress", "WORKING": "in_progress", "RECLAIMED": "open",
                              "STAGED": "open", "DONE": "done", "GONE": "cancelled"}
    assert "窗口 s2" in run("show", "CLAIMED")[1]
    assert "窗口 w1" in run("show", "WORKING")[1]
    assert "窗口" not in run("show", "RECLAIMED")[1] and "窗口" not in run("show", "DONE")[1]
    assert "staging-verified" in run("show", "STAGED")[1]
    assert {line.split()[0] for line in run("list", "--frontier")[1].splitlines()} == {"RECLAIMED", "STAGED"}


def test_held_task_without_an_open_session_row_falls_back_to_its_owner(run, old):
    old.task("ORPHAN", status="in_progress", owner="ac:abc-123")
    old.session("ORPHAN", "abc-123", T0 + 1, ended_at=T0 + 2)
    assert migrate(run, old)[0] == 0
    assert "窗口 abc-123" in run("show", "ORPHAN")[1]


def test_old_events_decisions_refs_and_pointers_arrive_as_events_of_their_kind(run, old):
    old.task("T", epic="EPIC-X", adr="ADR-0007", now="正在写迁移")
    old.event("T", "status_change", "open→claimed", T0 + 1, author="ac:s1")
    old.event("T", "verify", "测试全绿", T0 + 2)
    old.decision("T", "A 还是 B", "A", T0 + 3, decided_by="user",
                 rejected=[{"option": "B", "reason": "太重"}])
    old.decision("T", "要不要缓存", "不要", T0 + 4, decided_by="agent:ac:s1")
    old.ref("T", "pr", "https://example.com/pull/9", T0 + 5, note="主 PR")
    old.event("T", "note", "最后一条旧笔记", T0 + 6)
    assert migrate(run, old)[0] == 0
    out = run("show", "T")[1]
    assert "status · ac:s1] open→claimed" in out
    assert "note · ac:old] verify: 测试全绿" in out
    assert "decision · user] 问题:A 还是 B\n结论:A\n否决:B(太重)" in out
    assert "decision · agent:ac:s1] 问题:要不要缓存" in out
    assert "link · migrate] pr:https://example.com/pull/9 · 主 PR" in out
    assert "note · migrate] epic: EPIC-X" in out and "link · migrate] adr:ADR-0007" in out
    assert "当前进展:正在写迁移" in out
    events = out[out.index("最近事件"):]
    assert "共 9 条" in events
    order = ["正在写迁移", "最后一条旧笔记", "pr:", "要不要缓存", "A 还是 B", "测试全绿", "open→claimed", "adr:"]
    assert [events.index(s) for s in order] == sorted(events.index(s) for s in order)


def test_migration_leaves_the_old_file_byte_for_byte_unchanged(run, old):
    old.task("T", status="in_progress", owner="ac:s1", context="c", success=["s"])
    old.session("T", "s1", T0)
    old.event("T", "note", "n", T0 + 1)
    old.close()
    before = old.path.read_bytes()
    assert run("migrate", str(old.path), str(run.new))[0] == 0
    assert old.path.read_bytes() == before


def test_second_migration_into_the_same_board_is_refused(run, old):
    old.task("T")
    old.event("T", "note", "n", T0 + 1)
    assert migrate(run, old)[0] == 0
    code, _, err = run("migrate", str(old.path), str(run.new))
    assert code == 1 and "已有任务" in err
    assert "共 1 条" in run("show", "T")[1]


def test_migration_into_a_board_with_tasks_is_refused(run, old):
    old.task("OLD")
    run("init")
    run("create", "MINE", "--title", "t", "--body", "b")
    code, _, err = migrate(run, old)
    assert code == 1 and "已有任务" in err
    assert [line.split()[0] for line in run("list")[1].splitlines()] == ["MINE"]


def test_migration_refuses_a_source_that_is_missing_or_not_an_old_board(run, old, tmp_path):
    code, _, err = run("migrate", str(tmp_path / "nope.db"), str(run.new))
    assert code == 1 and "nope.db" in err
    old.task("T")
    old.close()
    code, _, err = run("migrate", str(old.path), str(old.path))
    assert code == 1 and "不是新版看板" in err
    run("init")
    code, _, err = run("migrate", str(run.new), str(tmp_path / "other.db"))
    assert code == 1 and "不是旧版看板" in err
