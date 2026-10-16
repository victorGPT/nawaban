"""A PR behind main merges without update-branch only when main's new commits cannot change its CI."""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from nawaban import guard  # noqa: E402

PR_URL = "https://github.com/ac/repo/pull/1"


def files(*entries):
    return [{"filename": p, "status": s, "previous_filename": old} for p, s, old in entries]


def pr(*entries, changed=None):
    return {"url": PR_URL, "files": files(*entries), "changedFiles": len(entries) if changed is None else changed}


def main(messages, *entries, ahead=None):
    return {"ahead_by": len(messages) if ahead is None else ahead,
            "commits": [{"sha": "c" * 40, "commit": {"message": m}} for m in messages],
            "files": files(*entries)}


def judged(pr_data, compare) -> str:
    # The PR's file list is a third GitHub request; tests hand it over directly.
    return guard._behind_note(pr_data, compare, lambda: pr_data["files"])


def blocked(pr_data, compare) -> str:
    with pytest.raises(guard.Unverified) as exc:
        judged(pr_data, compare)
    return str(exc.value)


def test_up_to_date_passes_silently_without_fetching_pr_files():
    assert guard._behind_note(pr(), main([]), lambda: pytest.fail("fetched PR files")) == ""


def test_no_shared_file_passes_and_says_main_ci_backs_it():
    note = judged(pr(("src/app.py", "modified", None)),
                  main(["docs: archive card"], ("docs/tasks/a.md", "added", None)))
    assert "没有重叠" in note and "main CI 兜底" in note


@pytest.mark.parametrize("marker", ["[skip ci]", "[ci skip]", "[no ci]", "[skip actions]", "[actions skip]"])
def test_skip_ci_commits_pass_even_on_shared_file(marker):
    note = judged(pr(("docs/deployments/prod.json", "modified", None)),
                  main([f"chore(deploy): prod 指针\n\n{marker}"],
                       ("docs/deployments/prod.json", "modified", None)))
    assert "跳过 CI" in note


@pytest.mark.parametrize("messages", [["fix: app"], ["chore: x [skip ci]", "docs: README"]])
def test_shared_file_blocks_with_update_branch(messages):
    msg = blocked(pr(("src/app.py", "modified", None)), main(messages, ("src/app.py", "modified", None)))
    assert "src/app.py" in msg and f"gh pr update-branch {PR_URL}" in msg


def test_file_main_renamed_away_counts_as_shared():
    msg = blocked(pr(("src/app.py", "modified", None)), main(["refactor: move"], ("src/new.py", "renamed", "src/app.py")))
    assert "src/app.py" in msg


@pytest.mark.parametrize("messages", [["feat: add table"], ["chore: x [skip ci]"]])
def test_both_sides_adding_migrations_blocks(messages):
    msg = blocked(pr(("migrations/versions/0042_b.py", "added", None)),
                  main(messages, ("migrations/versions/0042_a.py", "added", None)))
    assert "migrations" in msg and "gh pr update-branch" in msg


@pytest.mark.parametrize("entry", [("migrations/versions/0042_a.py", "copied", "migrations/versions/0041.py"),
                                   ("migrations/versions/0042_a.py", "renamed", "drafts/0042_a.py")])
def test_migration_copied_or_renamed_in_counts_as_added(entry):
    msg = blocked(pr(("migrations/versions/0042_b.py", "added", None)), main(["feat: x"], entry))
    assert "migrations" in msg and "gh pr update-branch" in msg


def test_migration_added_on_one_side_only_passes():
    assert "没有重叠" in judged(pr(("migrations/versions/0042_b.py", "added", None)),
                               main(["fix: app"], ("src/app.py", "modified", None)))


@pytest.mark.parametrize("pr_data, compare", [
    (pr(("src/app.py", "modified", None)), main(["fix: a"], ahead=2)),                       # commits cut at 250
    (pr(("src/app.py", "modified", None)), main(["fix: a"], *[(f"f{i}", "added", None) for i in range(300)])),
    (pr(("src/app.py", "modified", None), changed=101), main(["fix: a"], ("docs/a.md", "added", None))),
    (pr(("src/app.py", "modified", None)), {**main(["fix: a"]), "commits": None}),
])
def test_incomplete_lists_block(pr_data, compare):
    msg = blocked(pr_data, compare)
    assert "完整清单" in msg and "gh pr update-branch" in msg


@pytest.mark.parametrize("view, compare", [
    (pr(), {"ahead_by": 1, "commits": [{"sha": "c", "commit": {"message": "fix: a"}}]}),  # no file lists
    (pr(("src/app.py", "modified", None)), {"ahead_by": 1, "commits": [{"sha": "c"}], "files": []}),
])
def test_malformed_response_blocks_in_judge_merge(monkeypatch, tmp_path, view, compare):
    def github(args, *_):
        if args[-1].endswith("/files?per_page=100"):
            return {"files": view["files"]}
        if args[:2] == ["run", "list"]:
            return {"runs": []}
        if args[:2] == ["pr", "view"]:
            return {**view, "statusCheckRollup": [{"name": "t", "status": "COMPLETED", "conclusion": "SUCCESS"}],
                    "headRefOid": "a" * 40, "url": PR_URL}
        return compare
    monkeypatch.setattr(guard, "_github", github)
    code, msg = guard.judge_merge("gh pr merge 1 -R ac/repo --squash", str(tmp_path))
    assert code == 2 and "merge gate" in msg


def test_file_the_pr_renamed_away_counts_as_shared():
    msg = blocked(pr(("docs/tasks-done/a.md", "renamed", "docs/tasks/a.md")),
                  main(["docs: fix card"], ("docs/tasks/a.md", "modified", None)))
    assert "docs/tasks/a.md" in msg


# The third request starts only while the shared deadline has time left; naming the active
# account after a failed query is bounded by the same deadline.
@pytest.mark.parametrize("elapsed", [9.0, 8.0])
def test_pr_files_fetched_after_budget_is_spent_blocks(monkeypatch, tmp_path, elapsed):
    clock = iter([0.0, elapsed])
    monkeypatch.setattr(guard.time, "monotonic", lambda: next(clock))

    def github(args, *_):
        if args[:2] == ["pr", "view"]:
            return {"statusCheckRollup": [{"name": "t", "status": "COMPLETED", "conclusion": "SUCCESS"}],
                    "headRefOid": "a" * 40, "url": PR_URL, "changedFiles": 1}
        if args[-1].endswith("/files?per_page=100"):
            pytest.fail("third request started after the budget was spent")
        if args[:2] == ["run", "list"]:
            return {"runs": []}
        return main(["fix: a"], ("docs/a.md", "added", None))
    monkeypatch.setattr(guard, "_github", github)
    code, msg = guard.judge_merge("gh pr merge 1 -R ac/repo --squash", str(tmp_path))
    assert code == 2 and "hook 时限" in msg
