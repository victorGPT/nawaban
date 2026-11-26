"""A repository the board syncs from GitHub is read and written on the board once it switched (NAWABAN-SYNC-PARITY)."""

import json
import subprocess

import pytest

from nawaban import cli


@pytest.fixture
def run(tmp_path, monkeypatch, capsys):
    repo = tmp_path / "roubao"
    (repo / "docs" / "agents").mkdir(parents=True)
    (repo / "docs" / "agents" / "issue-tracker.md").write_text("# Issue tracker: GitHub\n")
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    board = tmp_path / "board"
    (board / "github-sync").mkdir(parents=True)
    (board / "github-sync.json").write_text(json.dumps({"repos": {"acme/roubao": "roubao"}, "reader": "x"}))
    monkeypatch.setenv("NAWABAN_BOARD_DIR", str(board))
    monkeypatch.chdir(repo)

    def run(*args):
        code = cli.main(["--db", str(tmp_path / "old.db"), *args])
        out = capsys.readouterr()
        return code, out.out, out.err

    def switch():
        (board / "github-sync" / "acme%2Froubao.switched.json").write_text("{}")

    run.switch = switch
    return run


@pytest.mark.parametrize("args, board_command", [
    (("show", "#1318"), "nawaban show ROUBAO-1318"),
    (("claim", "#1318"), "nawaban claim ROUBAO-1318"),
    (("event", "#1318", "--kind", "note", "--body", "进展 #1318"), "nawaban event ROUBAO-1318 note '进展 #1318'"),
    (("close", "#1318", "--done"), "nawaban close ROUBAO-1318 --done"),
    (("list",), "nawaban list"),
    (("index",), "nawaban index"),
])
def test_once_switched_the_old_cli_refuses_and_names_the_board_command(run, args, board_command):
    run.switch()
    code, out, err = run(*args)
    assert (code, out) == (1, "")
    assert f"acme/roubao 已切到板上，旧 CLI 不再读写它:{board_command}(" in err


def test_before_the_switch_the_old_cli_still_answers(run):
    assert "已切到板上" not in run("list")[2]
