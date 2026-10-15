"""Review verdicts are judged by fixed rules and merges are locked to the reviewed commit."""

import json
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from nawaban import cli, db, guard  # noqa: E402

PR = "https://github.com/ac/repo/pull/1"
REVIEWED, NEWER = "a" * 40, "d" * 40


def finding(severity, *, evidence="nawaban/x.py:1 · pytest -k x fails", preexisting=False):
    return {"summary": f"{severity} problem", "severity": severity,
            "evidence": evidence, "preexisting": preexisting}


@pytest.fixture
def board(tmp_path, monkeypatch):
    path = tmp_path / "board.db"
    db.init_db(path)
    db.create_task(path, task_id="P-1", title="合并前审过")
    db.add_ref(path, "P-1", kind="pr", value=PR)
    monkeypatch.setenv("NAWABAN_DB", str(path))
    return path


def review(tmp_path, findings, commit=REVIEWED) -> int:
    f = tmp_path / "findings.json"
    f.write_text(json.dumps(findings))
    return cli.main(["--db", str(tmp_path / "board.db"), "review", "P-1",
                     "--commit", commit, "--findings", str(f)])


def merge(monkeypatch, tmp_path, command, head=REVIEWED):
    def github(args, cwd):
        if args[:2] == ["pr", "view"]:
            return {"statusCheckRollup": [{"name": "t", "status": "COMPLETED",
                                           "conclusion": "SUCCESS"}],
                    "headRefOid": head, "url": PR}
        return {"base_commit": {"sha": "b" * 40}, "merge_base_commit": {"sha": "b" * 40}}
    monkeypatch.setattr(guard, "_github", github)
    return guard.judge_merge(command, str(tmp_path))


LOCKED = f"gh pr merge 1 -R ac/repo --squash --match-head-commit {REVIEWED}"


def test_verdict_records_commit_and_each_finding(board, tmp_path, capsys):
    assert review(tmp_path, [finding("minor"), finding("nit", evidence="")]) == 0
    with sqlite3.connect(board) as con:
        commit, passed, raw = con.execute(
            "SELECT commit_sha, passed, findings FROM reviews WHERE task_id='P-1'").fetchone()
        event = con.execute("SELECT body FROM task_events WHERE kind='verify'").fetchone()[0]
    assert (commit, passed) == (REVIEWED, 1)
    assert [(f["severity"], f["evidence"], f["preexisting"]) for f in json.loads(raw)] == [
        ("minor", "nawaban/x.py:1 · pytest -k x fails", False), ("nit", "", False)]
    assert REVIEWED[:12] in event and "通过" in event
    assert "review 通过" in capsys.readouterr().out


@pytest.mark.parametrize("bad, needle", [
    ({"summary": "x", "severity": "blocker", "evidence": "e", "preexisting": False}, "severity"),
    ({"summary": "x", "severity": "major", "evidence": "e"}, "preexisting"),
    ({"summary": " ", "severity": "major", "evidence": "e", "preexisting": False}, "summary"),
])
def test_malformed_finding_is_refused(board, tmp_path, capsys, bad, needle):
    assert review(tmp_path, [bad]) == 1
    assert needle in capsys.readouterr().err
    with sqlite3.connect(board) as con:
        assert con.execute("SELECT COUNT(*) FROM reviews").fetchone()[0] == 0


def test_short_commit_is_refused(board, tmp_path, capsys):
    assert review(tmp_path, [], commit="abc1234") == 1
    assert "40" in capsys.readouterr().err


@pytest.mark.parametrize("findings, passed", [
    ([], True),
    ([finding("minor"), finding("nit")], True),
    ([finding("major")], False),
    ([finding("critical")], False),
    ([finding("critical", preexisting=True), finding("major", preexisting=True)], True),
])
def test_fixed_rule_blocks_from_major(findings, passed):
    assert db.judge_findings(findings)[0] is passed


def test_critical_without_evidence_counts_as_major():
    _, judged = db.judge_findings([finding("critical", evidence=" "),
                                   finding("critical", evidence=None)])
    assert [f["effective"] for f in judged] == ["major", "major"]
    assert db.judge_findings([finding("critical")])[1][0]["effective"] == "critical"


def test_merge_passes_when_locked_to_reviewed_head(board, tmp_path, monkeypatch):
    review(tmp_path, [finding("minor")])
    assert merge(monkeypatch, tmp_path, LOCKED) == (0, "")


def test_new_commit_after_review_blocks_merge(board, tmp_path, monkeypatch):
    review(tmp_path, [])
    code, msg = merge(monkeypatch, tmp_path,
                      f"gh pr merge 1 -R ac/repo --match-head-commit={NEWER}", head=NEWER)
    assert code == 2 and "重新 review" in msg and REVIEWED[:12] in msg


@pytest.mark.parametrize("command", [
    "gh pr merge 1 -R ac/repo --squash",
    f"gh pr merge 1 -R ac/repo --match-head-commit {NEWER}",
])
def test_merge_not_locked_to_reviewed_commit_blocks(board, tmp_path, monkeypatch, command):
    review(tmp_path, [])
    code, msg = merge(monkeypatch, tmp_path, command)
    assert code == 2 and f"--match-head-commit {REVIEWED}" in msg


def test_failed_or_missing_review_blocks_merge(board, tmp_path, monkeypatch):
    code, msg = merge(monkeypatch, tmp_path, LOCKED)
    assert code == 2 and "没有 review 结论" in msg
    review(tmp_path, [finding("major")])
    code, msg = merge(monkeypatch, tmp_path, LOCKED)
    assert code == 2 and "不过" in msg


def test_pr_not_on_any_task_keeps_ci_only_gate(tmp_path, monkeypatch):
    path = tmp_path / "board.db"
    db.init_db(path)
    monkeypatch.setenv("NAWABAN_DB", str(path))
    assert merge(monkeypatch, tmp_path, "gh pr merge 1 --squash") == (0, "")


def test_board_without_reviews_table_blocks_registered_pr(board, tmp_path, monkeypatch):
    with sqlite3.connect(board) as con:
        con.executescript("DROP TRIGGER reviews_no_update; DROP TRIGGER reviews_no_delete;"
                          " DROP TABLE reviews;")
    code, msg = merge(monkeypatch, tmp_path, LOCKED)
    assert code == 2 and "没有 review 结论" in msg


def test_three_failed_reviews_in_a_row_raise_an_ask(board, tmp_path):
    review(tmp_path, [finding("major")])
    review(tmp_path, [])
    for _ in range(2):
        review(tmp_path, [finding("major")])
    with sqlite3.connect(board) as con:
        assert con.execute("SELECT COUNT(*) FROM asks").fetchone()[0] == 0
    review(tmp_path, [finding("critical")])
    with sqlite3.connect(board) as con:
        kind, question = con.execute("SELECT kind, question FROM asks").fetchone()
        linked = con.execute("SELECT task_id FROM ask_tasks").fetchall()
    assert kind == "decide" and "连续 3 次" in question and linked == [("P-1",)]
    review(tmp_path, [finding("major")])
    with sqlite3.connect(board) as con:
        assert con.execute("SELECT COUNT(*) FROM asks").fetchone()[0] == 1


def test_reviews_are_append_only(board, tmp_path):
    review(tmp_path, [])
    with sqlite3.connect(board) as con, pytest.raises(sqlite3.IntegrityError):
        con.execute("DELETE FROM reviews")


def test_migration_adds_reviews_table(tmp_path):
    path = tmp_path / "old.db"
    db.init_db(path)
    with sqlite3.connect(path) as con:
        con.executescript("DROP TRIGGER reviews_no_update; DROP TRIGGER reviews_no_delete;"
                          " DROP TABLE reviews;")
    assert "reviews" in db.migrate_db(path)
    assert db.migrate_db(path) == []
