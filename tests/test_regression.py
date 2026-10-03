"""A later change breaking a Done task: the regresses link, the derived red mark, blame, and stop-the-line."""
import json
import sqlite3
import subprocess
import time
from datetime import datetime, timezone

import pytest

from nawaban import board_view as bv, cli, db, main_ci, paths


@pytest.fixture
def board(tmp_path):
    path = tmp_path / "board.db"
    db.init_db(path)
    for tid, status in (("SHIPPED", "done"), ("FIX", "open"), ("NEXT", "open"), ("OTHER", "open")):
        db.create_task(path, task_id=tid, title="Example task", project="other" if tid == "OTHER" else "app")
        with sqlite3.connect(path) as con:
            con.execute("UPDATE tasks SET status=? WHERE id=?", (status, tid))
    return path


def _link(path, src="FIX", dst="SHIPPED", note="broken by abc1234"):
    db.link_tasks(path, src, dst, kind="regresses", note=note, created_by="test")


def _finish(path, tid):
    with sqlite3.connect(path) as con:
        con.execute("UPDATE tasks SET status='done' WHERE id=?", (tid,))


@pytest.mark.parametrize("src,dst,note,message", [
    ("FIX", "NEXT", "x", "只指向 done"),
    ("SHIPPED", "FIX", "x", "只指向 done"),
    ("FIX", "SHIPPED", " ", "必须带 --note"),
])
def test_regresses_link_needs_done_target_unfinished_fix_and_note(board, src, dst, note, message):
    with pytest.raises(db.NawabanError, match=message):
        _link(board, src, dst, note)


def test_fix_task_must_be_unfinished(board):
    _finish(board, "FIX")
    with pytest.raises(db.NawabanError, match="还没完成的修复卡"):
        _link(board)


def test_regressed_mark_is_derived_everywhere_and_clears_when_fixed(board):
    _link(board)
    assert db.kin(board, "SHIPPED")["regressed_by"] == ["FIX"]
    done = next(c for c in bv.board_data(board)["columns"] if c["key"] == "done")
    assert next(t for t in done["tasks"] if t["id"] == "SHIPPED")["regressed_by"] == ["FIX"]
    assert {t["i"]: t.get("rb") for t in bv.modules_data(board)["tasks"]}["SHIPPED"] == ["FIX"]
    node = next(n for n in bv.graph_data(board)["nodes"] if n["id"] == "SHIPPED")
    assert node["flags"]["regressed"] and node["role"] == "regressed"
    with sqlite3.connect(board) as con:
        assert con.execute("SELECT status FROM tasks WHERE id='SHIPPED'").fetchone() == ("done",)

    _finish(board, "FIX")
    assert db.kin(board, "SHIPPED")["regressed_by"] == []
    assert "rb" not in {t["i"]: t for t in bv.modules_data(board)["tasks"]}["SHIPPED"]
    assert not next(n for n in bv.graph_data(board)["nodes"] if n["id"] == "SHIPPED")["flags"]["regressed"]


RED = {"since": 1_000, "url": "https://ci.example/run/1"}


def _claim(path, tid="NEXT", **kw):
    return db.claim_task(path, tid, owner="ac:test", session_id="s", **kw)


def test_stop_the_line_blocks_claim_until_a_fix_is_linked(board, monkeypatch):
    with pytest.raises(db.NawabanError, match="停线闸"):
        _claim(board, main_red=RED)
    monkeypatch.setattr(db, "_now", lambda: RED["since"] - 1)
    _link(board)
    with pytest.raises(db.NawabanError, match="停线闸"):  # a fix from before the red streak
        _claim(board, main_red=RED)
    with sqlite3.connect(board) as con:
        con.execute("UPDATE task_edges SET created_at=? WHERE kind='regresses'", (RED["since"],))
    assert _claim(board, main_red=RED)


def test_another_projects_fix_does_not_lift_the_stop(board):
    with sqlite3.connect(board) as con:
        con.execute("UPDATE tasks SET project='other' WHERE id='FIX'")
    _link(board)
    with pytest.raises(db.NawabanError, match="停线闸"):
        _claim(board, main_red={**RED, "since": 0})


def test_override_passes_the_stop_and_leaves_a_trace(board):
    assert _claim(board, main_red=RED, override="CI runner outage")
    with sqlite3.connect(board) as con:
        body = con.execute("SELECT body FROM task_events WHERE task_id='NEXT' AND kind='coord'").fetchone()[0]
    assert "停线闸" in body and "CI runner outage" in body and RED["url"] in body


def test_green_or_unknown_ci_does_not_stop(board):
    assert _claim(board, main_red=None)


def _run(name, conclusion, created, status="completed"):
    return {"workflowName": name, "status": status, "conclusion": conclusion,
            "headSha": f"sha-{created}", "url": f"u-{name}-{created}", "createdAt": created}


def test_red_runs_report_each_red_workflow_from_the_start_of_its_streak():
    runs = [  # newest first, as gh lists them
        _run("test", "", "2026-10-03T05:00:00Z", status="in_progress"),
        _run("test", "failure", "2026-10-03T04:00:00Z"),
        _run("lint", "success", "2026-10-03T03:30:00Z"),
        _run("test", "cancelled", "2026-10-03T03:00:00Z"),
        _run("test", "failure", "2026-10-03T02:00:00Z"),
        _run("lint", "failure", "2026-10-03T01:30:00Z"),
        _run("test", "success", "2026-10-03T01:00:00Z"),
        _run("test", "failure", "2026-10-02T00:00:00Z"),
    ]
    (red,) = main_ci.red_runs(runs)
    assert red["workflow"] == "test" and red["url"] == "u-test-2026-10-03T04:00:00Z"
    assert red["since"] == int(datetime(2026, 10, 3, 2, tzinfo=timezone.utc).timestamp())
    assert main_ci.red_runs([_run("test", "success", "2026-10-03T04:00:00Z")]) == []


def test_state_file_feeds_claim_and_goes_stale(tmp_path, monkeypatch):
    state = paths.state_dir()
    target = main_ci.state_file(state, "app")
    target.parent.mkdir(parents=True)
    target.write_text(json.dumps({"checked_at": int(time.time()),
                                  "red": [{"workflow": "t", "url": "u2", "since": 20},
                                          {"workflow": "s", "url": "u1", "since": 10}]}))
    assert main_ci.red_since(state, "app") == {"since": 10, "url": "u1"}
    assert main_ci.red_since(state, "missing") is None
    target.write_text(json.dumps({"checked_at": int(time.time()) - main_ci.MAX_AGE_S - 1, "red": [{}]}))
    assert main_ci.red_since(state, "app") is None


def test_missing_gh_is_recorded_as_an_error(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", str(tmp_path))
    assert "FileNotFoundError" in main_ci.check(tmp_path)["error"]


def test_cli_claim_reads_the_state_file(board, capsys):
    target = main_ci.state_file(paths.state_dir(), "app")
    target.parent.mkdir(parents=True)
    target.write_text(json.dumps({"checked_at": int(time.time()),
                                  "red": [{"workflow": "t", "url": "https://ci/1", "since": 0}]}))
    assert cli.main(["--db", str(board), "claim", "NEXT"]) == 1
    assert "停线闸" in capsys.readouterr().err
    assert cli.main(["--db", str(board), "claim", "OTHER"]) == 0


def _git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


def test_blame_maps_changed_files_to_merged_tasks(board, tmp_path, monkeypatch, capsys):
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    shas = {}
    for name in ("a.py", "b.py"):
        (repo / name).write_text(name)
        _git(repo, "add", name)
        _git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", name)
        shas[name] = _git(repo, "rev-parse", "HEAD")
    db.add_ref(board, "SHIPPED", kind="merge_sha", value=shas["a.py"])
    monkeypatch.chdir(repo)
    assert cli.main(["--db", str(board), "blame", "a.py"]) == 0
    out = capsys.readouterr().out
    assert "1 张卡" in out and "SHIPPED [done]" in out and shas["a.py"][:8] in out
    assert cli.main(["--db", str(board), "blame", "b.py"]) == 0
    assert "没有对应的卡" in capsys.readouterr().out


def test_blame_outside_git_fails_loudly(board, capsys):
    assert cli.main(["--db", str(board), "blame", "a.py"]) == 1
    assert "git 仓库" in capsys.readouterr().err


OLD_EDGES = """CREATE TABLE task_edges (
    src        TEXT NOT NULL REFERENCES tasks(id),
    dst        TEXT NOT NULL REFERENCES tasks(id),
    kind       TEXT NOT NULL CHECK (kind IN ('depends_on','split_from','supersedes','relates')),
    note       TEXT,
    created_at INTEGER NOT NULL,
    created_by TEXT,
    PRIMARY KEY (src, dst, kind)
)"""


def _old_edges_board(path, kind="depends_on"):
    """The live board's pre-regresses DDL, including the retired 'relates' kind."""
    db.init_db(path)
    for tid in ("A", "B"):
        db.create_task(path, task_id=tid, title="Example task")
    with sqlite3.connect(path) as con:
        con.execute("DROP TABLE task_edges")
        con.execute(OLD_EDGES)
        con.execute("INSERT INTO task_edges VALUES ('A','B',?,'n',1,'t')", (kind,))


def test_migration_widens_the_edge_check_and_keeps_rows(tmp_path):
    path = tmp_path / "old.db"
    _old_edges_board(path)
    assert "task_edges.kind:+regresses" in db.migrate_db(path)
    assert db.migrate_db(path) == []
    with sqlite3.connect(path) as con:
        assert con.execute("SELECT src,dst,kind,note FROM task_edges").fetchall() == [("A", "B", "depends_on", "n")]
        ddl = con.execute("SELECT sql FROM sqlite_master WHERE name='task_edges'").fetchone()[0]
        assert "'regresses'" in ddl and "'relates'" not in ddl
        assert con.execute("SELECT name FROM sqlite_master WHERE name='idx_edges_dst'").fetchone()
        assert con.execute("PRAGMA integrity_check").fetchone() == ("ok",)


def test_migration_rolls_back_when_a_row_uses_a_retired_kind(tmp_path):
    path = tmp_path / "old.db"
    _old_edges_board(path, kind="relates")
    with pytest.raises(sqlite3.IntegrityError):
        db.migrate_db(path)
    with sqlite3.connect(path) as con:
        assert con.execute("SELECT kind FROM task_edges").fetchall() == [("relates",)]
        assert "'relates'" in con.execute("SELECT sql FROM sqlite_master WHERE name='task_edges'").fetchone()[0]


def test_a_red_streak_older_than_the_listed_runs_has_an_unknown_start():
    runs = [_run("test", "failure", f"2026-10-03T0{h}:00:00Z") for h in (5, 4, 3)]
    assert main_ci.red_runs(runs)[0]["since"] == 0


def test_an_open_fix_lifts_the_stop_when_the_streak_start_is_unknown(board, monkeypatch):
    monkeypatch.setattr(db, "_now", lambda: 1)
    _link(board)
    assert _claim(board, main_red={**RED, "since": 0})


def _state(checked_at, red, repo="/repo"):
    target = main_ci.state_file(paths.state_dir(), "app")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({"checked_at": checked_at, "repo": repo,
                                  "red": [{"workflow": "t", "url": "u", "since": 5}] if red else []}))
    return target


def test_stale_red_is_rechecked_before_stopping_the_line(monkeypatch):
    calls = []
    monkeypatch.setattr(main_ci, "check", lambda repo: calls.append(repo) or {"checked_at": int(time.time()), "red": []})
    target = _state(int(time.time()) - main_ci.RECHECK_RED_S - 1, red=True)
    assert main_ci.red_since(paths.state_dir(), "app") is None
    assert [str(c) for c in calls] == ["/repo"] and json.loads(target.read_text())["red"] == []
    _state(int(time.time()), red=True)
    assert main_ci.red_since(paths.state_dir(), "app") == {"since": 5, "url": "u"}
    assert len(calls) == 1  # a fresh red result is trusted without the network


def test_rebuild_accepts_a_name_quoted_by_an_earlier_rename(tmp_path):
    path = tmp_path / "old.db"
    _old_edges_board(path)
    with sqlite3.connect(path) as con:
        con.execute("ALTER TABLE task_edges RENAME TO t")
        con.execute("ALTER TABLE t RENAME TO task_edges")
        assert con.execute("SELECT sql FROM sqlite_master WHERE name='task_edges'").fetchone()[0].startswith(
            'CREATE TABLE "task_edges"')
    assert "task_edges.kind:+regresses" in db.migrate_db(path)
