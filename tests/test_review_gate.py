"""Review verdicts are judged by fixed rules and merges are locked to the reviewed commit."""

import json
import sqlite3
import subprocess
import threading
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


def merge(monkeypatch, tmp_path, command, head=REVIEWED, url=PR, local_project=None):
    """local_project:合并命令所在的本地项目(该目录下有 .nawaban/)。"""
    def github(args, cwd):
        if args[:2] == ["pr", "view"]:
            return {"statusCheckRollup": [{"name": "t", "status": "COMPLETED",
                                           "conclusion": "SUCCESS"}],
                    "headRefOid": head, "url": url}
        return {"base_commit": {"sha": "b" * 40}, "merge_base_commit": {"sha": "b" * 40}}
    monkeypatch.setattr(guard, "_github", github)
    cwd = tmp_path
    if local_project:
        cwd = tmp_path / local_project
        (cwd / ".nawaban").mkdir(parents=True, exist_ok=True)
    return guard.judge_merge(command, str(cwd))


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
    f"gh pr merge 1 -R ac/repo --squash --body '--match-head-commit={REVIEWED}'",
    f"gh pr merge 1 -R ac/repo --squash --body=x -t --match-head-commit {REVIEWED}",
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


def one_task_board(tmp_path, monkeypatch, values, project, status="in_progress"):
    path = tmp_path / "board.db"
    db.init_db(path)
    db.create_task(path, task_id="P-2", title="裸号 ref", project=project)
    for value in values:
        db.add_ref(path, "P-2", kind="pr", value=value)
    if status != "open":
        with sqlite3.connect(path) as con:  # 夹具:直接摆状态,不走状态机
            con.execute("UPDATE tasks SET status=?, owner='ac:x' WHERE id='P-2'", (status,))
    monkeypatch.setenv("NAWABAN_DB", str(path))
    return path


# 合并时所在的本地项目是 checkout-alias(本地目录名 ≠ GitHub 仓库名 repo)
@pytest.mark.parametrize("values, project, expected", [
    (["1"], "repo", "没有 review 结论"),
    (["#1"], "Repo", "没有 review 结论"),
    (["https://github.com/AC/Repo/pull/1/files"], None, "没有 review 结论"),
    (["1", "https://github.com/ac/repo/pull/1"], "checkout-alias", "没有 review 结论"),
    (["1"], "checkout-alias", "认不出"),  # 本项目的卡认不出仓库:拦,要求登记完整 URL
    (["#1"], None, None),  # 不知道属于哪个项目的卡:不拦
    (["1"], "other", None),  # 其他项目的卡:不拦
    (["1", "https://github.com/ac/other/pull/1"], "checkout-alias", None),  # 裸号由同卡 URL 定
    (["#12"], "repo", None),
    (["https://github.com/ac/repo/pull/12"], None, None),
    (["https://github.com/ac/other/pull/1"], None, None),
])
def test_pr_ref_forms(tmp_path, monkeypatch, values, project, expected):
    one_task_board(tmp_path, monkeypatch, values, project)
    code, msg = merge(monkeypatch, tmp_path, "gh pr merge 1 --squash",
                      local_project="checkout-alias")
    assert (code == 2 and "P-2" in msg and expected in msg) if expected else code == 0


def test_other_projects_bare_ref_does_not_block(tmp_path, monkeypatch):
    one_task_board(tmp_path, monkeypatch, ["39"], "nawaban")
    code, msg = merge(monkeypatch, tmp_path, "gh pr merge 39 -R victorGPT/bzkanbanv2 --squash",
                      url="https://github.com/victorGPT/bzkanbanv2/pull/39",
                      local_project="bzkanbanv2")
    assert (code, msg) == (0, "")


@pytest.mark.parametrize("status", ["done", "cancelled"])
@pytest.mark.parametrize("values, project", [
    (["1"], "repo"), (["1"], "checkout-alias"), ([PR], None)])
def test_finished_task_does_not_block(tmp_path, monkeypatch, status, values, project):
    one_task_board(tmp_path, monkeypatch, values, project, status=status)
    code, msg = merge(monkeypatch, tmp_path, "gh pr merge 1 --squash",
                      local_project="checkout-alias")
    assert (code, msg) == (0, "")


@pytest.mark.parametrize("in_git", [False, True])
def test_external_board_still_blocks_own_projects_bare_ref(tmp_path, monkeypatch, in_git):
    # NAWABAN_DB 指外部共享看板,仓库里没有 .nawaban/:本项目卡的裸号认不出仓库照样拦
    one_task_board(tmp_path, monkeypatch, ["39"], "checkout-alias")
    checkout = tmp_path / "checkout-alias"
    cwd = checkout / "src" if in_git else checkout
    cwd.mkdir(parents=True)
    if in_git:
        subprocess.run(["git", "init", "-q", str(checkout)], check=True)
    monkeypatch.setattr(guard, "_github", lambda args, _: (
        {"statusCheckRollup": [{"name": "t", "status": "COMPLETED", "conclusion": "SUCCESS"}],
         "headRefOid": REVIEWED, "url": "https://github.com/ac/repo/pull/39"}
        if args[:2] == ["pr", "view"] else
        {"base_commit": {"sha": "b" * 40}, "merge_base_commit": {"sha": "b" * 40}}))
    code, msg = guard.judge_merge("gh pr merge 39 -R ac/repo --squash", str(cwd))
    assert code == 2 and "P-2" in msg and "完整 URL" in msg


def test_unidentifiable_ref_blocks_even_after_passing_review(tmp_path, monkeypatch):
    path = one_task_board(tmp_path, monkeypatch, ["1"], "checkout-alias")
    db.add_review(path, "P-2", commit_sha=REVIEWED, findings=[], author="ac:x")
    code, msg = merge(monkeypatch, tmp_path, LOCKED, local_project="checkout-alias")
    assert code == 2 and "完整 URL" in msg


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

def asks(board) -> int:
    with sqlite3.connect(board) as con:
        return con.execute("SELECT COUNT(*) FROM asks").fetchone()[0]


def test_one_ask_per_failing_streak(board, tmp_path):
    for _ in range(6):
        review(tmp_path, [finding("major")])
    assert asks(board) == 1
    review(tmp_path, [])
    for _ in range(3):
        review(tmp_path, [finding("major")])
    assert asks(board) == 2  # 通过一次后的新一段连败,再问一次


def test_concurrent_reviews_raise_one_ask(board):
    for _ in range(2):
        db.add_review(board, "P-1", commit_sha=REVIEWED, findings=[finding("major")], author="ac:x")
    start = threading.Barrier(6)

    def record():
        start.wait()
        db.add_review(board, "P-1", commit_sha=REVIEWED, findings=[finding("major")], author="ac:x")
    workers = [threading.Thread(target=record) for _ in range(6)]
    for w in workers:
        w.start()
    for w in workers:
        w.join()
    with sqlite3.connect(board) as con:
        assert con.execute("SELECT COUNT(*) FROM reviews").fetchone()[0] == 8
    assert asks(board) == 1


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
