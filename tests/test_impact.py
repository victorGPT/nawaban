"""KR 影响声明 (ticket NAWABAN-KRI-01): event --kind impact, the close --done lock, the merge hook."""

import json
import os
import sqlite3
import subprocess
from contextlib import closing
from pathlib import Path

import pytest

from nawaban import cli

OKR = """
[[objective]]
name = "听得懂需求"

[[objective.kr]]
name = "意图准确率"
target = ">= 95"

[[objective.kr]]
name = "L1 首位"
target = ">= 95"
"""
HOOK = Path(__file__).resolve().parent.parent / "hooks" / "impact-guard.sh"


def _git_repo(path, okr=True, github=False):
    (path / "docs" / "agents").mkdir(parents=True)
    if okr:
        (path / "docs" / "agents" / "okr.toml").write_text(OKR)
    if github:
        (path / "docs" / "agents" / "issue-tracker.md").write_text("# Issue tracker: GitHub\n")
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    return path


@pytest.fixture
def board(tmp_path):
    db = tmp_path / "b" / ".nawaban" / "nawaban.db"
    assert cli.main(["--db", str(db), "init"]) == 0
    return db


@pytest.fixture
def repo(tmp_path, monkeypatch):
    monkeypatch.chdir(_git_repo(tmp_path / "r"))
    return tmp_path / "r"


def run(capsys, board, *argv):
    code = cli.main(["--db", str(board), *argv])
    out = capsys.readouterr()
    return code, out.out + out.err


def impacts(db):
    with closing(sqlite3.connect(db)) as con:
        return con.execute("SELECT repo, ticket, objective, kr, dir, before, after, basis FROM kr_impacts").fetchall()


def events(db, task):
    with closing(sqlite3.connect(db)) as con:
        return [r[0] for r in con.execute("SELECT body FROM events WHERE task=? AND kind='note'", (task,))]


def test_a_valid_declaration_is_stored_and_logged(repo, board, capsys):
    run(capsys, board, "create", "T-01", "--title", "t", "--body", "")
    code, out = run(capsys, board, "event", "T-01", "--kind", "impact", "--o", "听得懂需求",
                    "--kr", "意图准确率=↑ 90→95 预计", "--kr", "L1 首位==")
    assert code == 0 and "✓" in out
    key = str(repo.resolve())
    assert impacts(board) == [(key, "T-01", "听得懂需求", "意图准确率", "↑", "90", "95", "预计"),
                              (key, "T-01", "听得懂需求", "L1 首位", "=", None, None, None)]
    assert events(board, "T-01") == ["impact: O 听得懂需求 · 意图准确率=↑ 90→95 预计 · L1 首位=="]


def test_pure_infrastructure_declares_no_objective(repo, board, capsys):
    run(capsys, board, "create", "T-01", "--title", "t", "--body", "")
    assert run(capsys, board, "event", "T-01", "--kind", "impact", "--o", "无")[0] == 0
    assert impacts(board)[0][2:5] == ("无", "", "=")


@pytest.mark.parametrize("o, kr, why", [
    ("没这个O", "意图准确率=↑ 1→2 实测", "没有这个 O"),
    ("听得懂需求", "没这个KR=↑ 1→2 实测", "没有这个 KR"),
    ("听得懂需求", "意图准确率=↑", "↑↓"),
    ("听得懂需求", "意图准确率=↑ 1→2", "格式"),
    ("听得懂需求", "意图准确率=↑ 多→少 实测", "格式"),
    ("听得懂需求", "意图准确率=+ 1→2 实测", "格式"),
    ("听得懂需求", "意图准确率", "格式"),
])
def test_a_bad_declaration_is_refused_and_writes_nothing(repo, board, capsys, o, kr, why):
    run(capsys, board, "create", "T-01", "--title", "t", "--body", "")
    code, out = run(capsys, board, "event", "T-01", "--kind", "impact", "--o", o, "--kr", kr)
    assert code == 1 and "✗" in out and why in out, out
    assert impacts(board) == [] and events(board, "T-01") == []


def test_impact_outside_an_okr_repository_needs_o_none(tmp_path, board, capsys, monkeypatch):
    monkeypatch.chdir(_git_repo(tmp_path / "plain", okr=False))
    run(capsys, board, "create", "T-01", "--title", "t", "--body", "")
    code, out = run(capsys, board, "event", "T-01", "--kind", "impact", "--o", "听得懂需求", "--kr", "意图准确率==")
    assert code == 1 and "okr.toml" in out
    assert run(capsys, board, "event", "T-01", "--kind", "impact", "--o", "无")[0] == 0


def test_ask_and_decision_keep_a_single_kr(repo, board, capsys):
    run(capsys, board, "create", "T-01", "--title", "t", "--body", "")
    assert run(capsys, board, "event", "T-01", "--kind", "decision", "--body", "定了", "--kr", "意图准确率")[0] == 0
    code, out = run(capsys, board, "event", "T-01", "--kind", "decision", "--body", "x", "--kr", "a", "--kr", "b")
    assert code == 1
    code, out = run(capsys, board, "event", "T-01", "--kind", "note")
    assert code == 1 and "--body" in out
    with closing(sqlite3.connect(board)) as con:
        assert con.execute("SELECT body FROM events WHERE kind='decision'").fetchone()[0] == "[意图准确率] 定了"


def test_close_done_needs_a_declaration_in_an_okr_repository(repo, board, capsys):
    run(capsys, board, "create", "T-01", "--title", "t", "--body", "")
    code, out = run(capsys, board, "close", "T-01", "--done")
    assert code == 1 and "✗" in out and "--kind impact" in out
    run(capsys, board, "event", "T-01", "--kind", "impact", "--o", "无")
    assert run(capsys, board, "close", "T-01", "--done")[0] == 0


def test_close_cancelled_is_never_locked(repo, board, capsys):
    run(capsys, board, "create", "T-01", "--title", "t", "--body", "")
    assert run(capsys, board, "close", "T-01", "--cancelled")[0] == 0


def test_close_done_without_okr_toml_is_not_locked(tmp_path, board, capsys, monkeypatch):
    monkeypatch.chdir(_git_repo(tmp_path / "plain", okr=False))
    run(capsys, board, "create", "T-01", "--title", "t", "--body", "")
    assert run(capsys, board, "close", "T-01", "--done")[0] == 0


def test_a_github_issue_declares_on_the_issue_and_the_local_board(tmp_path, board, capsys, monkeypatch):
    repo = _git_repo(tmp_path / "gh", github=True)
    monkeypatch.chdir(repo)
    calls = []
    monkeypatch.setattr(cli, "_gh", lambda root, *a: calls.append(a) or "")
    code, out = run(capsys, board, "close", "#5", "--done")
    assert code == 1 and "--kind impact" in out and calls == []  # refused before GitHub is touched
    assert run(capsys, board, "event", "#5", "--kind", "impact", "--o", "听得懂需求", "--kr", "意图准确率=↓ 3→1 实测")[0] == 0
    (comment,) = [a for a in calls if a[:2] == ("issue", "comment")]
    body = comment[comment.index("--body") + 1]
    assert body.startswith("影响：O 听得懂需求") and cli.read_marker(body)["kind"] == "impact"
    assert impacts(board)[0][1:5] == ("#5", "听得懂需求", "意图准确率", "↓")
    assert run(capsys, board, "close", "#5", "--done")[0] == 0
    assert ("issue", "close", "5", "--reason", "completed") in calls


def test_a_synced_github_repo_hands_the_board_only_a_declaration_github_took_and_a_board_refusal_keeps_none(tmp_path, board, capsys, monkeypatch):
    repo = _git_repo(tmp_path / "roubao", github=True)
    monkeypatch.chdir(repo)
    board_dir = tmp_path / "board-dir"
    board_dir.mkdir()
    (board_dir / "github-sync.json").write_text(json.dumps({"repos": {"acme/roubao": "roubao"}, "reader": "x"}))
    monkeypatch.setenv("NAWABAN_BOARD_DIR", str(board_dir))
    calls, handed, refusal = [], [], []
    monkeypatch.setattr(cli, "_gh", lambda root, *a: calls.append(a) or "")
    real_run = subprocess.run

    def run_board_hooks_faked(args, **kw):
        if args[0] == "node" and args[2:4] == ["hook", "github-impact"]:
            handed.append(json.loads(kw["input"]))
            return subprocess.CompletedProcess(args, 1 if refusal else 0, "", "✗ 板挂了" if refusal else "")
        return real_run(args, **kw)
    monkeypatch.setattr(subprocess, "run", run_board_hooks_faked)
    assert run(capsys, board, "event", "#5", "--kind", "impact", "--o", "听得懂需求", "--kr", "意图准确率=↓ 3→1 实测")[0] == 0
    with closing(sqlite3.connect(board)) as con:
        (repo_key, declared_at), = con.execute("SELECT repo, declared_at FROM kr_impacts").fetchall()
    assert handed == [[{"repo": repo_key, "ticket": "#5", "objective": "听得懂需求", "kr": "意图准确率", "dir": "↓",
                        "before": "3", "after": "1", "basis": "实测", "declared_at": declared_at}]]
    monkeypatch.setattr(cli, "_gh", lambda root, *a: (_ for _ in ()).throw(cli.Refused("HTTP 503")))
    assert run(capsys, board, "event", "#6", "--kind", "impact", "--o", "无")[0] == 1
    assert len(handed) == 1 and len(impacts(board)) == 1
    monkeypatch.setattr(cli, "_gh", lambda root, *a: calls.append(a) or "")
    refusal.append("down")
    code, out = run(capsys, board, "event", "#7", "--kind", "impact", "--o", "无")
    assert code == 1 and "板写不进" in out
    assert len(impacts(board)) == 1


def test_a_failed_github_post_keeps_no_declaration(tmp_path, board, capsys, monkeypatch):
    monkeypatch.chdir(_git_repo(tmp_path / "gh", github=True))
    monkeypatch.setattr(cli, "_gh", lambda root, *a: (_ for _ in ()).throw(cli.Refused("HTTP 503")))
    assert run(capsys, board, "event", "#5", "--kind", "impact", "--o", "无")[0] == 1
    assert impacts(board) == []


READINGS_AS_VERSION_3_KEPT_THEM = """DROP TABLE kr_readings;
CREATE TABLE kr_readings (repo TEXT NOT NULL, kr TEXT NOT NULL, value TEXT NOT NULL, as_of TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '', measured_at TEXT NOT NULL, UNIQUE (repo, kr, as_of, source));
INSERT INTO kr_readings VALUES ('r','k','1','2026-11-17','','x');"""


@pytest.mark.parametrize("old", [2, 3])
def test_an_old_board_migrates_keeping_its_readings_and_takes_a_new_value_on_the_same_as_of(board, old):
    with closing(sqlite3.connect(board)) as con:
        con.executescript(READINGS_AS_VERSION_3_KEPT_THEM + ("DROP TABLE kr_impacts;" if old == 2 else "")
                          + f"PRAGMA user_version={old};")
    calls, real = [], cli.backup
    cli.backup = lambda p: calls.append(p) or real(p)
    try:
        cli._migrate(board)
        cli._migrate(board)  # the loser of a race finds the current version under the write lock
    finally:
        cli.backup = real
    with closing(sqlite3.connect(board)) as con:
        assert con.execute("PRAGMA user_version").fetchone()[0] == cli.VERSION
        con.execute("INSERT INTO kr_readings (repo, kr, value, as_of, source, measured_at, def_hash)"
                    " VALUES ('r','k','2','2026-11-17','','y','h')")
        assert con.execute("SELECT value, def_hash FROM kr_readings ORDER BY rowid").fetchall() == [("1", ""), ("2", "h")]
        assert con.execute("SELECT count(*) FROM kr_impacts").fetchone()[0] == 0
    assert len(calls) == 1


# ── the merge hook ──

def _hook(tmp_path, repo, board, command, pr=None, gh_exit=0):
    bin_ = tmp_path / "bin"
    bin_.mkdir(exist_ok=True)
    (tmp_path / "pr.json").write_text(json.dumps(pr or {}))
    (bin_ / "gh").write_text(f'#!/bin/sh\necho "$@" >> {tmp_path}/gh.log\ncat {tmp_path}/pr.json\nexit {gh_exit}\n')
    (bin_ / "gh").chmod(0o755)
    env = {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}", "NAWABAN_DB": str(board)}
    return subprocess.run(["sh", str(HOOK)], input=json.dumps({"tool_input": {"command": command}, "cwd": str(repo)}),
                          env=env, capture_output=True, text=True)


def _declare(repo, board, ticket):
    with closing(sqlite3.connect(board)) as con, con:
        con.execute("INSERT INTO kr_impacts VALUES (?,?,'无','','=',NULL,NULL,NULL,'x')", (str(repo.resolve()), ticket))


PR = {"number": 12, "url": "u", "title": "t", "body": "", "headRefName": "b", "closingIssuesReferences": [{"number": 5}]}


@pytest.mark.parametrize("cmd", ["scripts/merge.sh 12", "./scripts/merge.sh 12 --squash", "bash scripts/merge.sh 12",
                                 "GH_TOKEN=$(gh auth token --user victorGPT) gh pr merge 12 --squash",
                                 "cd x && gh pr merge 12", "gh pr merge --squash -R o/r 12"])
def test_a_merge_without_a_declaration_is_denied(tmp_path, repo, board, cmd):
    r = _hook(tmp_path, repo, board, cmd, PR)
    assert r.returncode == 2 and "#5" in r.stderr and "--kind impact" in r.stderr, (cmd, r.stderr)


def test_a_merge_with_a_declaration_passes(tmp_path, repo, board):
    _declare(repo, board, "#5")
    assert _hook(tmp_path, repo, board, "scripts/merge.sh 12", PR).returncode == 0
    assert _hook(tmp_path, repo, board, "gh pr merge 12 --squash", PR).returncode == 0


def test_refs_in_the_body_and_a_local_ticket_id_count_as_linked(tmp_path, repo, board, capsys):
    run(capsys, board, "create", "KRI-07", "--title", "t", "--body", "", "--project", repo.name)
    pr = {**PR, "closingIssuesReferences": [], "body": "Refs #8", "headRefName": "wt/kri-07"}
    r = _hook(tmp_path, repo, board, "scripts/merge.sh 12", pr)
    assert r.returncode == 2 and "#8" in r.stderr and "KRI-07" in r.stderr
    _declare(repo, board, "#8")
    _declare(repo, board, "KRI-07")
    assert _hook(tmp_path, repo, board, "scripts/merge.sh 12", pr).returncode == 0


def test_every_merge_in_a_compound_command_and_a_quoted_pr_number_are_checked(tmp_path, repo, board):
    _declare(repo, board, "#5")
    bin_ = tmp_path / "bin"
    r = _hook(tmp_path, repo, board, "true", PR)  # writes the fake gh
    # the fake gh answers PR 12 (declared #5) for "12", PR 13 (undeclared #6) for anything else
    (bin_ / "gh").write_text(f'#!/bin/sh\necho "$@" >> {tmp_path}/gh.log\n'
                             'case "$3" in 12) echo \'{"number":12,"closingIssuesReferences":[{"number":5}]}\';;'
                             ' *) echo \'{"number":13,"closingIssuesReferences":[{"number":6}]}\';; esac\n')
    env = {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}", "NAWABAN_DB": str(board)}
    for cmd in ("gh pr merge 12 --squash && gh pr merge 13 --squash", 'gh pr merge "13" --squash'):
        r = subprocess.run(["sh", str(HOOK)], input=json.dumps({"tool_input": {"command": cmd}, "cwd": str(repo)}),
                           env=env, capture_output=True, text=True)
        assert r.returncode == 2 and "#6" in r.stderr, (cmd, r.stderr)
    assert "13 --json" in (tmp_path / "gh.log").read_text()


def test_a_pr_with_no_linked_ticket_is_denied_saying_why(tmp_path, repo, board):
    r = _hook(tmp_path, repo, board, "gh pr merge 12", {**PR, "closingIssuesReferences": []})
    assert r.returncode == 2 and "查不到关联票" in r.stderr


def test_a_failing_gh_is_denied_saying_why(tmp_path, repo, board):
    r = _hook(tmp_path, repo, board, "gh pr merge 12", PR, gh_exit=1)
    assert r.returncode == 2 and "gh" in r.stderr


@pytest.mark.parametrize("cmd", ["gh pr view 12", "gh pr create --body x", 'echo "gh pr merge 12"',
                                 'git commit -m "调 scripts/merge.sh 12; gh pr merge 12"', "ls scripts", "cat scripts/merge.sh.bak"])
def test_other_commands_pass_without_asking_gh(tmp_path, repo, board, cmd):
    assert _hook(tmp_path, repo, board, cmd, PR).returncode == 0, cmd
    assert not (tmp_path / "gh.log").exists()


def test_a_repository_without_okr_toml_is_never_gated(tmp_path, board):
    plain = _git_repo(tmp_path / "plain", okr=False)
    assert _hook(tmp_path, plain, board, "gh pr merge 12", PR).returncode == 0
