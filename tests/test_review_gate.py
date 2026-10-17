"""Review verdicts are judged by fixed rules and merges are locked to the reviewed commit."""

import json
import os
import sqlite3
import subprocess
import threading
import sys
import time
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
    def github(args, cwd, *_):
        if args[:2] == ["pr", "view"]:
            return {"statusCheckRollup": [{"name": "t", "status": "COMPLETED",
                                           "conclusion": "SUCCESS"}],
                    "headRefOid": head, "url": PR}
        return {"ahead_by": 0, "commits": [], "runs": []}
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


REPO39 = "https://github.com/ac/repo/pull/39"


# 合并闸只按完整 PR 链接认卡(用户 2026-10-16 定,ask #194);合并的是 ac/repo#39。
# 列:卡 project, 卡的 pr ref, 卡状态, 拦?
@pytest.mark.parametrize("project, refs, status, blocked", [
    pytest.param("repo", [REPO39], "in_progress", True, id="完整链接"),
    pytest.param(None, ["https://GitHub.com/AC/Repo/pull/39/files"], "open", True,
                 id="链接带后缀与大小写"),
    pytest.param("nawaban", [REPO39], "in_progress", True, id="链接与卡属于哪个项目无关"),
    pytest.param("repo", ["https://github.com/ac/repo/pull/039"], "in_progress", True,
                 id="号按数值比"),
    pytest.param("repo", ["https://www.github.com/ac/repo/pull/39"], "in_progress", True,
                 id="www主机"),
    pytest.param("repo", ["39"], "in_progress", False, id="裸号不算登记"),
    pytest.param("repo", ["#39"], "in_progress", False, id="#号不算登记"),
    pytest.param("other", ["39"], "in_progress", False, id="其他项目的裸号"),
    pytest.param("repo", ["https://github.com/someone/repo/pull/39"], "in_progress", False,
                 id="同名仓库不同owner"),
    pytest.param("repo", ["https://gitlab.com/ac/repo/pull/39"], "in_progress", False,
                 id="同名路径不同主机"),
    pytest.param("repo", ["https://github.com/ac/repo/pull/390"], "in_progress", False,
                 id="号不同"),
    pytest.param("repo", [REPO39], "done", False, id="done卡"),
    pytest.param("repo", [REPO39], "cancelled", False, id="cancelled卡"),
])
def test_which_tasks_refer_to_the_pr(tmp_path, monkeypatch, project, refs, status, blocked):
    one_task_board(tmp_path, monkeypatch, refs, project, status=status)
    monkeypatch.setattr(guard, "_github", lambda args, *_: (
        {"statusCheckRollup": [{"name": "t", "status": "COMPLETED", "conclusion": "SUCCESS"}],
         "headRefOid": REVIEWED, "url": REPO39}
        if args[:2] == ["pr", "view"] else
        {"ahead_by": 0, "commits": [], "runs": []}))
    code, msg = guard.judge_merge("gh pr merge 39 -R ac/repo --squash", str(tmp_path))
    assert (code == 2 and "P-2" in msg and "没有 review 结论" in msg) if blocked else \
        (code, msg) == (0, "")


def test_review_gate_starts_no_subprocess(board, tmp_path, monkeypatch):
    # hook 预算 10 秒:两次 gh 之外,review 闸只读看板,不起 git 等子进程
    def no_subprocess(*args, **kwargs):
        raise AssertionError(f"subprocess started: {args}")
    monkeypatch.setattr(guard.subprocess, "run", no_subprocess)
    with pytest.raises(guard.Unverified, match="没有 review 结论"):
        guard._review_gate(str(tmp_path), PR, REVIEWED, REVIEWED)


def git_checkout(tmp_path, monkeypatch, *remotes):
    root = tmp_path / "checkout"
    root.mkdir()
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    for i, url in enumerate(remotes):
        subprocess.run(["git", "-C", str(root), "remote", "add", f"r{i}", url], check=True)
    monkeypatch.chdir(root)


@pytest.mark.parametrize("remotes, value, stored", [
    (["https://github.com/ac/repo.git"], "39", REPO39),
    (["git@github.com:ac/repo.git", "https://github.com/ac/repo"], "#39", REPO39),
    (["ssh://git@github.com/ac/repo.git"], " 39 ", REPO39),
    (["https://www.github.com/ac/repo"], "#039", REPO39),
    ([], "https://github.com/other/x/pull/7", "https://github.com/other/x/pull/7"),
])
def test_bare_pr_ref_is_written_as_full_url(tmp_path, monkeypatch, capsys, remotes, value, stored):
    path = tmp_path / "board.db"
    db.init_db(path)
    db.create_task(path, task_id="P-3", title="登记 PR")
    git_checkout(tmp_path, monkeypatch, *remotes)
    assert cli.main(["--db", str(path), "ref", "P-3", "--kind", "pr", "--value", value]) == 0
    with sqlite3.connect(path) as con:
        assert con.execute("SELECT value FROM task_refs WHERE kind='pr'").fetchall() == [(stored,)]


@pytest.mark.parametrize("remotes", [
    None,  # 不在 git 里
    [],  # 没有远端
    ["https://gitlab.com/ac/repo.git"],  # 没有 GitHub 远端
    ["https://github.com/me/repo.git", "https://github.com/ac/repo.git"],  # 指向不同仓库
])
def test_bare_pr_ref_that_cannot_be_completed_is_refused(tmp_path, monkeypatch, capsys, remotes):
    path = tmp_path / "board.db"
    db.init_db(path)
    db.create_task(path, task_id="P-3", title="登记 PR")
    if remotes is not None:
        git_checkout(tmp_path, monkeypatch, *remotes)
    assert cli.main(["--db", str(path), "ref", "P-3", "--kind", "pr", "--value", "39"]) == 1
    assert "https://github.com/<OWNER>/<REPO>/pull/<N>" in capsys.readouterr().err
    with sqlite3.connect(path) as con:
        assert con.execute("SELECT COUNT(*) FROM task_refs").fetchone()[0] == 0


def inject_remote(tmp_path, monkeypatch, how, url):
    if how == "env":
        monkeypatch.setenv("GIT_CONFIG_COUNT", "1")
        monkeypatch.setenv("GIT_CONFIG_KEY_0", "remote.origin.url")
        monkeypatch.setenv("GIT_CONFIG_VALUE_0", url)
    else:
        cfg = tmp_path / "global.gitconfig"
        cfg.write_text(f'[remote "origin"]\n\turl = {url}\n')
        monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(cfg))


@pytest.mark.parametrize("how", ["env", "global"])
@pytest.mark.parametrize("cwd", ["/", "tmp"])
def test_remote_outside_a_repository_is_not_used(tmp_path, monkeypatch, capsys, how, cwd):
    path = tmp_path / "board.db"
    db.init_db(path)
    db.create_task(path, task_id="P-3", title="登记 PR")
    inject_remote(tmp_path, monkeypatch, how, "https://github.com/ac/repo.git")
    monkeypatch.chdir("/" if cwd == "/" else tmp_path)
    assert cli.main(["--db", str(path), "ref", "P-3", "--kind", "pr", "--value", "39"]) == 1
    assert "补不出完整链接" in capsys.readouterr().err


@pytest.mark.parametrize("how", ["env", "global"])
def test_injected_remote_does_not_mix_into_the_repository(tmp_path, monkeypatch, how):
    path = tmp_path / "board.db"
    db.init_db(path)
    db.create_task(path, task_id="P-3", title="登记 PR")
    git_checkout(tmp_path, monkeypatch, "https://github.com/ac/repo.git")
    inject_remote(tmp_path, monkeypatch, how, "https://github.com/me/other.git")
    assert cli.main(["--db", str(path), "ref", "P-3", "--kind", "pr", "--value", "39"]) == 0
    with sqlite3.connect(path) as con:
        assert con.execute("SELECT value FROM task_refs").fetchall() == [(REPO39,)]


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


# NAWABAN-NOCI-GATE-001:checks 为空时,仓库没有在 PR 上跑的 workflow 才看 review 放行
DEPLOY_ONLY = {"deploy-staging.yml": "name: s\non:\n  push:\n    branches: [main]\njobs: {}\n",
               "deploy-production.yml": "# 手动\non:\n  workflow_dispatch:\njobs: {}\n"}
PR_CI = {"test.yml": "on:\n  pull_request:\njobs: {}\n"}


def merge_without_checks(monkeypatch, tmp_path, command, *, main=None, head=None, checks=(),
                         base="main", others=None):
    refs = {"main": main, REVIEWED: head, **(others or {})}

    def tree(field, args):
        ref = next(a for a in args if a.startswith(field + "=")).partition("=")[2]
        files = refs.get(ref.removesuffix(":.github/workflows"))
        return files and {"entries": [{"name": n, "object": {"text": t}} for n, t in files.items()]}

    def github(args, cwd, *_):
        if args[:2] == ["pr", "view"]:
            return {"statusCheckRollup": list(checks), "headRefOid": REVIEWED,
                    "headRefName": "feature", "baseRefName": base, "url": PR}
        if args[:2] == ["api", "graphql"]:
            assert args[2:4] == ["--hostname", "github.com"]
            return {"data": {"repository": {"main": tree("main", args),
                                            "head": tree("head", args)}}}
        return {"ahead_by": 0, "commits": [], "runs": []}
    monkeypatch.setattr(guard, "_github", github)
    return guard.judge_merge(command, str(tmp_path))


@pytest.mark.parametrize("main, head", [
    pytest.param(DEPLOY_ONLY, DEPLOY_ONLY, id="只有push-main和手动部署"),
    pytest.param(None, None, id="没有workflows目录"),
])
def test_repo_without_pr_ci_merges_after_locked_review(board, tmp_path, monkeypatch, main, head):
    review(tmp_path, [])
    assert merge_without_checks(monkeypatch, tmp_path, LOCKED, main=main, head=head) == (0, "")


@pytest.mark.parametrize("main, head", [
    pytest.param(PR_CI, PR_CI, id="main和head都有PR-CI"),
    pytest.param(PR_CI, DEPLOY_ONLY, id="PR删掉了main上的CI"),
    pytest.param(DEPLOY_ONLY, {**DEPLOY_ONLY, **PR_CI}, id="PR新加CI"),
])
def test_repo_with_pr_ci_still_blocks_empty_checks(board, tmp_path, monkeypatch, main, head):
    review(tmp_path, [])
    code, msg = merge_without_checks(monkeypatch, tmp_path, LOCKED, main=main, head=head)
    assert code == 2 and "PR checks 为空" in msg and "等它们跑完" in msg


def test_workflows_are_read_from_the_pr_base_branch(board, tmp_path, monkeypatch):
    review(tmp_path, [])
    code, msg = merge_without_checks(monkeypatch, tmp_path, LOCKED, main=DEPLOY_ONLY,
                                     head=DEPLOY_ONLY, base="develop", others={"develop": PR_CI})
    assert code == 2 and "等它们跑完" in msg


def test_slow_github_blocks_within_the_hook_timeout(board, tmp_path, monkeypatch):
    # 总预算调成 4 秒;假 gh 每步 1 秒(离单步上限至少 1 秒),graphql 一直挂 —— 拦下它的只能是总时限
    monkeypatch.setattr(guard, "_BUDGET", 4.0)
    review(tmp_path, [])
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    view = json.dumps({"statusCheckRollup": [], "headRefOid": REVIEWED, "headRefName": "feature",
                       "baseRefName": "main", "url": PR})
    compare = json.dumps({"ahead_by": 0, "commits": []})
    (bin_dir / "gh").write_text(
        "#!/bin/sh\n"
        'case "$1 $2" in\n'
        "  'auth token') sleep 1; echo tok ;;\n"
        f"  'pr view') sleep 1; echo '{view}' ;;\n"
        "  'api graphql') exec sleep 30 ;;\n"
        "  'run list') echo '{\"runs\": []}' ;;\n"
        f"  *) sleep 1; echo '{compare}' ;;\n"
        "esac\n")
    (bin_dir / "gh").chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}:{os.environ['PATH']}")
    started = time.monotonic()
    code, msg = guard.judge_merge(f"GH_TOKEN=$(gh auth token --user ac) {LOCKED}", str(tmp_path))
    elapsed = time.monotonic() - started
    assert code == 2 and ("TimeoutExpired" in msg or "hook 时限" in msg), (msg, elapsed)
    assert 3.5 < elapsed < 5, elapsed


def test_hook_deadline_reaches_the_merge_gate(monkeypatch):
    # main() 从进程入口起算的时限经 judge() 传到合并闸;已经用完就不再发查询,直接拦
    def no_subprocess(*args, **kwargs):
        raise AssertionError(f"subprocess started: {args}")
    monkeypatch.setattr(guard.subprocess, "run", no_subprocess)
    payload = {"tool_name": "Bash", "cwd": str(ROOT), "tool_input": {"command": LOCKED}}
    code, msg = guard.judge(payload, deadline=time.monotonic())
    assert code == 2 and "hook 时限" in msg


@pytest.mark.parametrize("check", [
    {"name": "t", "status": "IN_PROGRESS", "conclusion": ""},
    {"name": "t", "status": "COMPLETED", "conclusion": "FAILURE"},
])
def test_unfinished_or_failed_checks_still_block(board, tmp_path, monkeypatch, check):
    review(tmp_path, [])
    code, msg = merge_without_checks(monkeypatch, tmp_path, LOCKED, main=PR_CI, head=PR_CI,
                                     checks=[check])
    assert code == 2 and "checks 未全部 success" in msg


def test_repo_without_pr_ci_blocks_failed_or_missing_review(board, tmp_path, monkeypatch):
    code, msg = merge_without_checks(monkeypatch, tmp_path, LOCKED, main=DEPLOY_ONLY)
    assert code == 2 and "没有 review 结论" in msg
    review(tmp_path, [finding("major")])
    code, msg = merge_without_checks(monkeypatch, tmp_path, LOCKED, main=DEPLOY_ONLY)
    assert code == 2 and "不过" in msg


def test_repo_without_pr_ci_blocks_unlocked_merge(board, tmp_path, monkeypatch):
    review(tmp_path, [])
    code, msg = merge_without_checks(monkeypatch, tmp_path, "gh pr merge 1 -R ac/repo --squash",
                                     main=DEPLOY_ONLY)
    assert code == 2 and f"--match-head-commit {REVIEWED}" in msg


def test_repo_without_pr_ci_blocks_pr_on_no_task(tmp_path, monkeypatch):
    path = tmp_path / "board.db"
    db.init_db(path)
    monkeypatch.setenv("NAWABAN_DB", str(path))
    code, msg = merge_without_checks(monkeypatch, tmp_path, LOCKED, main=DEPLOY_ONLY)
    assert code == 2 and "PR checks 为空" in msg and "登记到卡上" in msg


def test_workflow_query_failure_blocks_empty_checks(board, tmp_path, monkeypatch):
    review(tmp_path, [])

    def github(args, cwd, *_):
        if args[:2] == ["api", "graphql"]:
            raise guard.Unverified("GitHub query failed (exit 1)")
        return {"statusCheckRollup": [], "headRefOid": REVIEWED, "headRefName": "feature",
                "baseRefName": "main",
                "url": PR, "ahead_by": 0, "commits": [], "runs": []}
    monkeypatch.setattr(guard, "_github", github)
    code, msg = guard.judge_merge(LOCKED, str(tmp_path))
    assert code == 2 and "GitHub query failed" in msg


@pytest.mark.parametrize("text, runs", [
    pytest.param("on:\n  push:\n    branches: [main]\n", False, id="push-main"),
    pytest.param("'on':\n  push:\n    branches:\n      - main\n      - release\n    paths: [x]\n",
                 False, id="push分支列表"),
    pytest.param("on:\n  workflow_dispatch:\n  schedule:\n    - cron: '0 0 * * *'\n", False,
                 id="手动和定时"),
    pytest.param("on: [workflow_dispatch]\n", False, id="内联手动"),
    pytest.param("on: push\n", True, id="内联push"),
    pytest.param("on:\n  push:\n", True, id="push不限分支"),
    pytest.param("on:\n  - push\n", True, id="列表push"),
    pytest.param("on:\n  push:\n    branches: ['**']\n", True, id="push通配"),
    pytest.param("on:\n  push:\n    branches: [feature]\n", True, id="push到PR分支"),
    pytest.param("on:\n  push:\n    branches-ignore: [main]\n", True, id="branches-ignore"),
    pytest.param("on:\n  pull_request_target:\n", True, id="pull_request_target"),
    pytest.param("on:\n  merge_group:\n", True, id="merge_group"),
    pytest.param("on: {push: {branches: [main]}}\n", True, id="流式映射读不懂"),
    pytest.param("on: [workflow_dispatch,\n  pull_request]\n", True, id="跨行流式列表"),
    pytest.param('on:\n  push:\n    branches: ["\\u0066eature"]\n', True, id="分支名带转义"),
    pytest.param('on:\n  push:\n    branches:\n      - "\\x66eature"\n', True, id="列表分支名带转义"),
    pytest.param("on:\n  push:\n    branches: [main,\n      feature]\n", True, id="跨行分支列表"),
    pytest.param("on:\n  push:\n    branches:\n      - \"feature'\"\n", True, id="分支名带引号字符"),
    pytest.param("on:\n  push:\n    branches: [\"feature'\"]\n", True, id="流式分支名带引号字符"),
    pytest.param("on:\n  push:\n    branches:\n      - main\n      -\tfeature\n", True,
                 id="列表项用tab分隔"),
    pytest.param("jobs: {}\n", True, id="没有on"),
    pytest.param("on:\n  push:\n    paths-ignore:\n      - |\n        branches: [main]\n", True,
                 id="块标量里的branches不算"),
    pytest.param('x: "a\non: workflow_dispatch\n"\non: pull_request\n', True, id="顶格引号串跨行"),
    pytest.param('jobs:\n  a:\n    run: "x\non: workflow_dispatch\n  y"\non: pull_request\n',
                 True, id="嵌套引号串顶格续行"),
    pytest.param("on: workflow_dispatch\nenv: {a: 1,\n  b: 2}\n", True, id="流式映射跨行"),
    pytest.param("on:\n  workflow_dispatch:\njobs:\n  a:\n    steps:\n      - run: echo \"it's\" "
                 "${{ x }} [ok]\n", False, id="同行闭合的引号和括号"),
    pytest.param("---\non:\n  workflow_dispatch:\n", False, id="开头的文档标记"),
    pytest.param("on: workflow_dispatch\n---\non: pull_request\n", True, id="多文档"),
    pytest.param(None, True, id="不是文本"),
])
def test_which_workflows_run_on_the_pr(text, runs):
    assert guard._runs_on_pr(text, "feature") is runs


def test_session_that_worked_the_task_cannot_review_it(board):
    db.claim_task(board, "P-1", owner="ac:worker", session_id="worker")
    with pytest.raises(db.NawabanError, match="自审闸"):
        db.add_review(board, "P-1", commit_sha=REVIEWED, findings=[],
                      author="ac:worker", session_id="worker")


def test_session_that_registered_the_pr_cannot_review_it(tmp_path, monkeypatch, capsys):
    path = tmp_path / "board.db"
    db.init_db(path)
    db.create_task(path, task_id="P-1", title="合并前审过")
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "opener")
    monkeypatch.delenv("NAWABAN_OWNER", raising=False)
    assert cli.main(["--db", str(path), "ref", "P-1", "--kind", "pr", "--value", PR]) == 0
    assert review(tmp_path, []) != 0
    assert "自审闸" in capsys.readouterr().err
    with sqlite3.connect(path) as con:
        assert con.execute("SELECT COUNT(*) FROM reviews").fetchone()[0] == 0


def test_another_session_reviews_as_usual(board):
    db.claim_task(board, "P-1", owner="ac:worker", session_id="worker")
    r = db.add_review(board, "P-1", commit_sha=REVIEWED, findings=[finding("major")],
                      author="ac:reviewer", session_id="reviewer")
    assert r["passed"] is False


def test_old_board_gains_pr_registrant_columns(tmp_path):
    path = tmp_path / "old.db"
    db.init_db(path)
    with sqlite3.connect(path) as con:
        con.executescript("ALTER TABLE task_refs DROP COLUMN author;"
                          " ALTER TABLE task_refs DROP COLUMN session_id;")
    assert db.migrate_db(path) == ["task_refs.author", "task_refs.session_id"]
    assert db.migrate_db(path) == []
