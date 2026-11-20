"""Projects moved to the Vercel Board are read-only here (spec board-migration, 阶段 1; NAWABAN-MIGRATE-06)."""

import sqlite3

import pytest

from nawaban import cli


@pytest.fixture
def run(tmp_path, capsys):
    board = tmp_path / "proj" / ".nawaban" / "board.db"

    def run(*args):
        code = cli.main(["--db", str(board), *args])
        out = capsys.readouterr()
        return code, out.out, out.err

    assert run("init")[0] == 0
    # A task of a moved project, as it was before the move.
    with sqlite3.connect(board) as con:
        con.execute("INSERT INTO tasks (id, project, title, body, created_at) VALUES ('N-1', 'nawaban', 'moved', '', 0)")
    return run


def test_the_moved_list_is_the_panels(run):
    assert {"nawaban", "bzkanbanv2"} <= cli.moved_projects()
    assert not {"roubao", "agent-center", "personal-assistant-zinsey"} & cli.moved_projects()


@pytest.mark.parametrize("args", [
    ("create", "N-2", "--title", "t", "--body", "b", "--project", "nawaban"),
    ("create", "N-3", "--title", "t", "--body", "b", "--parent", "N-1"),
    ("block", "N-1", "N-1"),
    ("claim", "N-1"),
    ("close", "N-1", "--cancelled"),
    ("event", "N-1", "--kind", "note", "--body", "progress"),
])
def test_a_write_to_a_moved_project_is_refused_with_the_board_command(run, args):
    code, _, err = run(*args)
    assert code == 1
    assert f"已迁到 Board:nawaban {args[0]} " in err and "--db" not in err
    assert run("show", "N-1")[1].count("progress") == 0


def test_reads_of_a_moved_project_still_work(run):
    assert run("show", "N-1")[0] == 0
    assert "N-1" in run("list", "--project", "nawaban")[1]


def test_a_project_not_moved_is_written_as_before(run):
    assert run("create", "R-1", "--title", "t", "--body", "b", "--project", "roubao")[0] == 0
    assert run("event", "R-1", "--kind", "note", "--body", "progress")[0] == 0
    assert "progress" in run("show", "R-1")[1]


def test_okr_in_a_moved_repository_records_nothing_here(run, tmp_path, monkeypatch):
    import subprocess
    repo = tmp_path / "nawaban"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    monkeypatch.chdir(repo)
    code, _, err = run("okr")
    assert code == 1 and "已迁到 Board:nawaban okr" in err


def test_no_readable_list_refuses_every_write(run, monkeypatch, tmp_path):
    monkeypatch.setattr(cli, "_MOVED_FILE", tmp_path / "missing.js")
    code, _, err = run("create", "R-2", "--title", "t", "--body", "b", "--project", "roubao")
    assert code == 1 and "BOARD_PROJECTS" in err
