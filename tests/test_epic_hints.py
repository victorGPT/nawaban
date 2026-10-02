"""Module recommendations are optional observations after a committed create."""

import io
import json
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nawaban import cli, db  # noqa: E402


@pytest.fixture
def board(tmp_path, monkeypatch):
    path = tmp_path / "board.db"
    db.init_db(path)
    db.create_task(path, task_id="OLD", title="登录页面能打开", epic="LOGIN")
    monkeypatch.setenv("NAWABAN_OWNER", "test")
    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    monkeypatch.setattr(cli, "_hints", lambda *a, **k: [])
    monkeypatch.setattr(cli, "_dependency_hint", lambda *a, **k: None)
    return path


def reply(probs):
    return io.BytesIO(json.dumps({"answers": {"module": {"probabilities": probs}}}).encode())


def create(path, *extra):
    return cli.main(["--db", str(path), "create", "NEW", "--title", "用户能重新登录", *extra])


def test_create_commits_before_request_and_only_hints(board, monkeypatch, capsys):
    def post(req):
        with sqlite3.connect(board) as con:
            assert con.execute("SELECT epic FROM tasks WHERE id='NEW'").fetchone() == (None,)
        sent = json.loads(req.data)
        assert sent["questions"]["module"]["criteria"]["module_0"]["module"] == "LOGIN"
        assert "用户能重新登录" not in str(sent["questions"])
        assert sent["state"]["task"]["title"] == "用户能重新登录"
        return reply({"module_0": 0.99, "none": 0.01})
    monkeypatch.setattr(cli, "_post", post)
    assert create(board) == 0
    out = capsys.readouterr()
    assert "✓ create NEW" in out.out
    assert len(out.err.splitlines()) == 1
    assert '模块建议' in out.err and 'LOGIN' in out.err
    with sqlite3.connect(board) as con:
        assert con.execute("SELECT epic FROM tasks WHERE id='NEW'").fetchone() == (None,)


@pytest.mark.parametrize("extra,expected", [(["--epic", "LOGIN"], "LOGIN"),
                                           (["--split-from", "OLD"], "LOGIN"),
                                           (["--epic", ""], "")])
def test_explicit_or_inherited_module_skips_api(board, monkeypatch, capsys, extra, expected):
    monkeypatch.setattr(cli, "_post", pytest.fail)
    assert create(board, *extra) == 0
    assert capsys.readouterr().err == ""
    with sqlite3.connect(board) as con:
        assert con.execute("SELECT epic FROM tasks WHERE id='NEW'").fetchone() == (expected,)


@pytest.mark.parametrize("mode", ["no_key", "timeout", "network", "malformed", "read_error"])
def test_unavailable_hint_never_fails_create(board, monkeypatch, capsys, mode):
    if mode == "no_key":
        monkeypatch.delenv("TYPESAFE_API_KEY")
        monkeypatch.setattr(cli, "_post", pytest.fail)
    else:
        def post(req):
            if mode == "timeout":
                raise TimeoutError()
            if mode == "network":
                raise OSError("unavailable")
            return io.BytesIO(b"bad json")
        monkeypatch.setattr(cli, "_post", post)
    if mode == "read_error":
        connect = sqlite3.connect
        def fail_read(*args, **kwargs):
            if kwargs.get("uri"):
                raise sqlite3.OperationalError("locked")
            return connect(*args, **kwargs)
        monkeypatch.setattr(cli.sqlite3, "connect", fail_read)
    assert create(board) == 0
    assert capsys.readouterr().err == ""
    with sqlite3.connect(board) as con:
        assert con.execute("SELECT count(*) FROM tasks WHERE id='NEW'").fetchone() == (1,)


@pytest.mark.parametrize("probs", [None, [], {}, {"module_0": 1},
    {"module_0": True, "none": 0}, {"module_0": float("nan"), "none": 0},
    {"module_0": 0.9, "none": 0.9}, {"module_0": 0.5, "none": 0.5},
    {"module_0": 0.01, "none": 0.99}, {"module_0": 0.4, "none": 0.6},
    {"module_0": 0.99, "none": 0, "unknown": 0.01}])
def test_invalid_uncertain_or_none_answers_stay_silent(board, monkeypatch, capsys, probs):
    monkeypatch.setattr(cli, "_post", lambda req: reply(probs))
    assert create(board) == 0
    assert capsys.readouterr().err == ""


def test_module_catalog_has_bounded_examples_and_no_placeholder():
    rows = [("LOGIN", str(i)) for i in range(20)] + [(None, "x"), ("", "x"), ("n/a", "x")]
    question, names = cli._epic_question(rows)
    assert names == {"module_0": "LOGIN"}
    assert question["criteria"]["module_0"]["example_titles"] == ["0", "1", "2"]
    assert cli._epic_question([(str(i), "x") for i in range(255)]) == ({}, {})
    assert len(cli._epic_question([(str(i), "x") for i in range(254)])[0]["criteria"]) == 255


def test_empty_board_skips_api(tmp_path, monkeypatch, capsys):
    path = tmp_path / "empty.db"
    db.init_db(path)
    monkeypatch.setenv("NAWABAN_OWNER", "test")
    monkeypatch.setenv("TYPESAFE_API_KEY", "test")
    monkeypatch.setattr(cli, "_hints", lambda *a, **k: [])
    monkeypatch.setattr(cli, "_post", pytest.fail)
    assert create(path) == 0
    assert capsys.readouterr().err == ""


def test_state_excludes_labels_and_bounds_long_context():
    state = cli._epic_state("title", "x" * 10000, ["y" * 1000] * 20)["task"]
    assert set(state) == {"title", "context", "success"}
    assert len(state["context"]) == 4000
    assert len(state["success"]) == 10
    assert len(state["success"][0]) == 500


def test_live_rounded_distribution_is_accepted():
    question, _ = cli._epic_question([("LOGIN", "Login")])
    assert cli._epic_choice({"probabilities": {"module_0": .9, "none": .09}}, question) == ("module_0", .9)


@pytest.mark.parametrize("score,shown", [(0.89, False), (0.9, True)])
def test_threshold_boundary(board, monkeypatch, capsys, score, shown):
    monkeypatch.setattr(cli, "_post", lambda req: reply({"module_0": score, "none": 1 - score}))
    assert create(board) == 0
    assert ("模块建议" in capsys.readouterr().err) == shown


def test_failed_create_does_not_request_hint(board, monkeypatch, capsys):
    db.create_task(board, task_id="NEW", title="Already exists")
    monkeypatch.setattr(cli, "_post", pytest.fail)
    with pytest.raises(sqlite3.IntegrityError):
        create(board)
    assert "模块建议" not in capsys.readouterr().err


def test_too_many_modules_skips_api(board, monkeypatch, capsys):
    with sqlite3.connect(board) as con:
        con.executemany("INSERT INTO tasks(id,title,epic,created_at) VALUES(?,?,?,0)",
                        [(f"T-{i}", "Title", f"Module-{i}") for i in range(254)])
    monkeypatch.setattr(cli, "_post", pytest.fail)
    assert create(board) == 0
    assert capsys.readouterr().err == ""
