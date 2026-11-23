"""NAWABAN-INBOX-01: the Stop hook's 收件箱 line in the orchestrator's terminal."""

import json, os, subprocess, time
from pathlib import Path

from nawaban import cli

HOOK = Path(__file__).resolve().parent.parent / "hooks" / "inbox.sh"


def _github_repo(tmp_path):
    repo = tmp_path / "repo"; (repo / "docs/agents").mkdir(parents=True)
    (repo / "docs/agents/issue-tracker.md").write_text("# Issue tracker: GitHub\n")
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    return repo.resolve()


def _cache(repo, items, age=0):
    p = cli._inbox_cache(repo); p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"at": int(time.time() - age), "items": items}, ensure_ascii=False))


def _hook(tmp_path, cwd, role="orchestrator", session="s1", gh_exit=1):
    bin_ = tmp_path / "bin"; bin_.mkdir(exist_ok=True)
    (bin_ / "hc").write_text(f"#!/bin/sh\necho '{json.dumps({'labels': {'role': role}})}'\n"); (bin_ / "hc").chmod(0o755)
    (bin_ / "gh").write_text(f"#!/bin/sh\necho gh down >&2\nexit {gh_exit}\n"); (bin_ / "gh").chmod(0o755)
    env = {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}", "HC_TERMINAL_ID": "t1"}
    r = subprocess.run(["sh", str(HOOK)], input=json.dumps({"session_id": session, "cwd": str(cwd), "stop_hook_active": False}),
                       env=env, capture_output=True, text=True, timeout=10)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)["systemMessage"] if r.stdout.strip() else None


ITEMS = [{"id": "#1213", "title": "停用/重置密码"}, {"id": "#1214", "title": "反馈状态"}]


def test_orchestrator_sees_the_count_and_titles_then_only_the_count_when_nothing_changed(tmp_path):
    repo = _github_repo(tmp_path); _cache(repo, ITEMS)
    first = _hook(tmp_path, repo)
    assert first.startswith("待你决定 2 件：") and "#1213 停用/重置密码 · #1214 反馈状态" in first and "同步" in first
    assert _hook(tmp_path, repo) == "待你决定 2 件（无变化）"


def test_a_new_pending_decision_is_listed_alone(tmp_path):
    repo = _github_repo(tmp_path); _cache(repo, ITEMS[:1]); _hook(tmp_path, repo)
    _cache(repo, ITEMS)
    line = _hook(tmp_path, repo)
    assert line.startswith("待你决定 2 件：#1214 反馈状态") and "#1213" not in line


def test_none_pending_shows_nothing(tmp_path):
    repo = _github_repo(tmp_path); _cache(repo, [])
    assert _hook(tmp_path, repo) is None


def test_a_worker_terminal_or_a_directory_without_a_tracker_gets_nothing(tmp_path):
    repo = _github_repo(tmp_path); _cache(repo, ITEMS)
    assert _hook(tmp_path, repo, role="worker") is None
    plain = tmp_path / "plain"; plain.mkdir()
    assert _hook(tmp_path, plain) is None


def test_a_stale_cache_is_shown_with_its_age_and_refreshed_in_the_background(tmp_path, monkeypatch):
    repo = _github_repo(tmp_path); _cache(repo, ITEMS, age=12 * 60)
    monkeypatch.chdir(repo)
    started = []
    monkeypatch.setattr(cli, "inbox_refresh_later", started.append)
    line = cli.inbox_line(cli.resolve_db(None), "s")
    assert "待你决定 2 件" in line and "12 分钟前" in line and started == [repo]
    _cache(repo, ITEMS)
    cli.inbox_line(cli.resolve_db(None), "s")
    assert started == [repo]  # fresh: no refresh


def test_github_down_and_no_cache_is_silent(tmp_path):
    repo = _github_repo(tmp_path)
    assert _hook(tmp_path, repo) is None
    time.sleep(1)  # the background refresh fails against the fake gh, and writes no cache
    assert not cli._inbox_cache(repo).exists()


def test_index_writes_the_cache(tmp_path, monkeypatch):
    repo = _github_repo(tmp_path); monkeypatch.chdir(repo)
    data = {"tracker": "github", "columns": [{"key": "open", "tasks": [
        {"id": "#7", "title": "要你定", "pending": {"at": 1}}, {"id": "#8", "title": "在推", "pending": None}]}]}
    monkeypatch.setattr(cli, "github_board_data", lambda root: data)
    cli.any_board(cli.resolve_db(None), None)
    assert json.loads(cli._inbox_cache(repo).read_text())["items"] == [{"id": "#7", "title": "要你定"}]


def test_an_ask_rewrites_the_cache_before_the_turn_ends(tmp_path, monkeypatch):
    repo = _github_repo(tmp_path); monkeypatch.chdir(repo); _cache(repo, [])
    data = {"tracker": "github", "columns": [{"key": "open", "tasks": [{"id": "#7", "title": "要你定", "pending": {"at": 1}}]}]}
    monkeypatch.setattr(cli, "gh_write", lambda root, a: "✓ event")
    monkeypatch.setattr(cli, "github_board_data", lambda root: data)
    assert cli.main(["event", "#7", "--kind", "ask", "--body", "定 A", "--kr", "K", "--context", "c",
                     "--option", "A｜快", "--option", "B｜稳", "--rec", "A"]) == 0
    assert cli.inbox_line(cli.resolve_db(None), "s").startswith("待你决定 1 件：#7 要你定")


def test_a_slower_older_read_does_not_overwrite_a_newer_cache(tmp_path):
    repo = _github_repo(tmp_path)
    data = lambda ids: {"columns": [{"tasks": [{"id": i, "title": "t", "pending": {"at": 1}} for i in ids]}]}
    cli.inbox_save(repo, data([]), 200.0)
    cli.inbox_save(repo, data(["#7"]), 100.0)  # started earlier, finished later
    assert json.loads(cli._inbox_cache(repo).read_text())["items"] == []


def test_refreshes_start_at_most_once_a_minute(tmp_path, monkeypatch):
    repo = _github_repo(tmp_path); started = []
    monkeypatch.setattr(cli.subprocess, "Popen", lambda *a, **k: started.append(a))
    for _ in range(5):
        cli.inbox_refresh_later(repo)
    assert len(started) == 1


def test_on_the_board_the_waiting_tasks_are_the_inbox(tmp_path, monkeypatch):
    db = tmp_path / "b.db"
    assert cli.main(["--db", str(db), "init"]) == 0
    assert cli.main(["--db", str(db), "create", "T-1", "--title", "要密钥", "--body", "x", "--project", "p"]) == 0
    assert cli.main(["--db", str(db), "create", "T-2", "--title", "在干", "--body", "x", "--project", "p"]) == 0
    assert cli.main(["--db", str(db), "event", "T-1", "--kind", "note", "--body", "triage: needs-info — 等你：给密钥"]) == 0
    line = cli.inbox_line(db, "s")
    assert line.startswith("待你决定 1 件：T-1 要密钥")
