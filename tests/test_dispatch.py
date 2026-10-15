"""One command starts one worker session per card; a second one tears it down."""

import json
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nawaban import cli, db, dispatch  # noqa: E402

SID = "11111111-2222-3333-4444-555555555555"
LAUNCH = (["claude", "--bg"], ["herdr", "agent", "start"])


class Backend:
    """Stands in for git, claude and herdr; records every command it is asked to run."""

    def __init__(self, root: Path, *, fail=(), stderr="boom", dirty="", unpushed=""):
        self.root, self.fail, self.stderr, self.registers = root, fail, stderr, True
        self.dirty, self.unpushed = dirty, unpushed
        self.agents_out = None  # 设了就让 `claude agents --json` 原样输出它
        self.calls: list[list[str]] = []
        self.sessions: list[dict] = []

    def __call__(self, cmd, **_):
        self.calls.append(cmd)
        out = ""
        if any(cmd[:len(prefix)] == list(prefix) for prefix in self.fail):
            return subprocess.CompletedProcess(cmd, 1, "", self.stderr)
        if any(cmd[:len(prefix)] == prefix for prefix in LAUNCH):
            name = cmd[cmd.index("--name") + 1]
            self.registers and self.sessions.append({"name": name, "sessionId": SID,
                                  "cwd": str(self.root / ".claude/worktrees" / name)})
        elif cmd[:2] == ["claude", "agents"]:
            out = json.dumps(self.sessions) if self.agents_out is None else self.agents_out
        elif cmd[:3] == ["herdr", "tab", "create"]:
            out = json.dumps({"result": {"root_pane": {"pane_id": "w1:p9"},
                                         "tab": {"tab_id": "w1:t9"}}})
        elif "--git-common-dir" in cmd:
            out = str(self.root / ".git")
        elif "status" in cmd:
            out = self.dirty
        elif "log" in cmd:
            out = self.unpushed
        return subprocess.CompletedProcess(cmd, 0, out, "")

    def ran(self, *prefix) -> list[list[str]]:
        return [c for c in self.calls if c[:len(prefix)] == list(prefix)]

    @property
    def launched(self) -> bool:
        return any(self.ran(*prefix) for prefix in LAUNCH)


@pytest.fixture
def board(tmp_path):
    path = tmp_path / "board.db"
    db.init_db(path)
    db.create_task(path, task_id="P", title="父卡")
    db.create_task(path, task_id="P-1", title="用户能派出第一张子卡", split_from="P")
    return path


@pytest.fixture
def backend(tmp_path, monkeypatch):
    fake = Backend(tmp_path)
    monkeypatch.setattr(dispatch, "RUN", fake)
    monkeypatch.setattr(dispatch, "SPAWN", lambda cmd, **_: fake.calls.append(cmd))
    monkeypatch.delenv("HERDR_ENV", raising=False)
    return fake


def run(board, *argv) -> int:
    return cli.main(["--db", str(board), *argv])


def task(board, task_id) -> dict:
    with sqlite3.connect(board) as con:
        con.row_factory = sqlite3.Row
        return dict(con.execute("SELECT status,owner,now FROM tasks WHERE id=?",
                                (task_id,)).fetchone())


def dump(board) -> list[str]:
    with sqlite3.connect(board) as con:
        return list(con.iterdump())


def test_dispatch_starts_a_background_session_named_after_the_card(board, backend):
    assert run(board, "dispatch", "P-1") == 0
    [launch] = backend.ran("claude", "--bg")
    assert launch[2:8] == ["-w", "p-1", "--name", "p-1", "--permission-mode", "auto"]
    assert "只做一张卡:P-1" in launch[-1] and "用户能派出第一张子卡" in launch[-1]
    assert str(board) in launch[-1]
    assert not backend.ran("herdr")
    assert SID in task(board, "P-1")["now"]
    assert task(board, "P-1")["owner"] is None


def test_dispatch_records_who_dispatched_and_tells_the_worker_how_to_report(
        board, backend, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "director-session")
    assert run(board, "dispatch", "P-1") == 0
    with sqlite3.connect(board) as con:
        [(body,)] = con.execute("SELECT body FROM task_events WHERE body LIKE 'dispatch {%'")
    assert json.loads(body[len("dispatch "):])["director"] == "director-session"
    [launch] = backend.ran("claude", "--bg")
    assert "最后一段话会自动送回派你的主控" in launch[-1] and "不要在这里等人回话" in launch[-1]
    assert "必须先用" in launch[-1] and "--kind blocked" in launch[-1]
    assert "没报阻塞就停下,一律当你交付了" in launch[-1]


def test_dispatch_inside_herdr_opens_a_new_tab(board, backend, monkeypatch):
    monkeypatch.setenv("HERDR_ENV", "1")
    monkeypatch.setattr(dispatch, "_trusted", lambda root: True)
    assert run(board, "dispatch", "P-1") == 0
    assert backend.ran("herdr", "tab", "create") and backend.ran("herdr", "agent", "prompt")
    [start] = backend.ran("herdr", "agent", "start")
    assert start[3:8] == ["p-1", "--kind", "claude", "--pane", "w1:p9"]
    assert not backend.ran("claude", "--bg")
    assert SID in task(board, "P-1")["now"]


def test_herdr_failure_falls_back_to_a_background_session(board, backend, monkeypatch):
    monkeypatch.setenv("HERDR_ENV", "1")
    monkeypatch.setattr(dispatch, "_trusted", lambda root: True)
    backend.fail = (("herdr", "agent", "start"),)
    assert run(board, "dispatch", "P-1") == 0
    assert backend.ran("herdr", "tab", "close", "w1:t9")
    assert backend.ran("claude", "--bg")
    assert SID in task(board, "P-1")["now"]


def test_half_started_herdr_session_blocks_the_fallback(board, backend, monkeypatch, capsys):
    monkeypatch.setenv("HERDR_ENV", "1")
    monkeypatch.setattr(dispatch, "_trusted", lambda root: True)
    backend.fail = (("herdr", "agent", "prompt"), ("herdr", "tab", "close"))
    assert run(board, "dispatch", "P-1") == 1
    assert "没能关掉" in capsys.readouterr().err
    assert not backend.ran("claude", "--bg")


def test_a_session_that_cannot_be_recorded_is_stopped(board, backend, monkeypatch, capsys):
    def locked(*args, **kwargs):
        raise sqlite3.OperationalError("database is locked")
    monkeypatch.setattr(db, "add_event", locked)
    assert run(board, "dispatch", "P-1") == 1
    assert "记不进卡" in capsys.readouterr().err
    assert backend.ran("claude", "stop", SID[:8])


def test_a_session_without_an_id_is_not_reported_as_dispatched(board, backend, monkeypatch, capsys):
    monkeypatch.setattr(dispatch.time, "sleep", lambda seconds: None)
    backend.registers = False
    assert run(board, "dispatch", "P-1") == 1
    assert "没查到它的编号" in capsys.readouterr().err


@pytest.fixture
def family(board):
    db.create_task(board, task_id="UP", title="还没做完的前置卡")
    db.create_task(board, task_id="P-2", title="前置没完成的子卡", split_from="P")
    db.link_tasks(board, "P-2", "UP", kind="depends_on", created_by="test")
    db.create_task(board, task_id="P-3", title="已经有人认领的子卡", split_from="P")
    db.claim_task(board, "P-3", owner="ac:other", session_id="other")
    db.create_task(board, task_id="P-9", title="卡号开头相同但不是拆出来的卡")
    return board


def test_batch_dispatches_only_ready_children_and_explains_the_rest(family, backend, capsys):
    assert run(family, "dispatch", "--parent", "P") == 0
    assert [c[3] for c in backend.ran("claude", "--bg")] == ["p-1"]
    out = capsys.readouterr().out
    assert "P-2 [open] 不派:前置卡未完成:UP(open)" in out
    assert "P-3 [claimed] 不派:已被 ac:other 认领" in out
    assert "P-9" not in out


def test_dry_run_lists_children_without_starting_or_changing_anything(family, backend, capsys):
    before = dump(family)
    assert run(family, "dispatch", "--parent", "P", "--dry-run") == 0
    out = capsys.readouterr().out
    assert "P-1 [open] 会派出" in out and "P-2 [open] 不派" in out and "P-3 [claimed] 不派" in out
    assert "P-9" not in out
    assert not backend.launched
    assert dump(family) == before


@pytest.fixture
def six(board):
    for n in range(2, 7):
        db.create_task(board, task_id=f"P-{n}", title=f"第 {n} 张子卡", split_from="P")
    return board


def test_only_four_workers_run_at_once_and_the_rest_say_why(six, backend, capsys):
    assert run(six, "dispatch", "--parent", "P") == 0
    assert [c[3] for c in backend.ran("claude", "--bg")] == ["p-1", "p-2", "p-3", "p-4"]
    out = capsys.readouterr().out
    for n in (5, 6):
        assert f"P-{n} [open] 排队 P-{n}:同时运行的 worker 已到上限 4 个(在跑:P-1、P-2、P-3、P-4)" in out
        assert task(six, f"P-{n}")["now"].startswith("排队等派发:同时运行的 worker 已到上限 4 个")


def test_dry_run_shows_which_cards_would_queue(six, backend, capsys):
    before = dump(six)
    assert run(six, "dispatch", "--parent", "P", "--dry-run") == 0
    out = capsys.readouterr().out
    assert out.count("会派出") == 4 and "P-5 [open] 会排队:" in out and "本批先派的 4 张" in out
    assert dump(six) == before


def test_the_limit_counts_only_live_undismissed_workers(six, backend, monkeypatch):
    monkeypatch.setenv("NAWABAN_MAX_WORKERS", "2")
    for card in ("P-2", "P-3"):  # 派过、没收工,但会话早没了:不占名额
        db.add_event(six, card, kind="coord", author="t", body='dispatch {"session": null}')
    assert run(six, "dispatch", "P-1") == 0
    assert run(six, "dispatch", "P-4") == 0
    assert run(six, "dispatch", "P-5") == 1  # P-1、P-4 活着,到上限 2
    db.add_event(six, "P-1", kind="coord", author="t", body="dismiss · 已停")
    assert run(six, "dispatch", "P-5") == 0  # 收工一张就腾出名额


@pytest.mark.parametrize("broken", ["exit 1", "empty", "bad json", "not a list"])
def test_when_live_workers_cannot_be_listed_the_limit_stays_full(six, backend, capsys, broken):
    if broken == "exit 1":
        backend.fail = (("claude", "agents"),)
    else:
        backend.agents_out = {"empty": "", "bad json": "[{", "not a list": '{"a": 1}'}[broken]
    assert run(six, "dispatch", "P-1") == 1
    assert "查不到哪些 worker 还活着" in capsys.readouterr().err
    assert not backend.launched
    assert task(six, "P-1")["now"].startswith("排队等派发:查不到哪些 worker 还活着")
    assert run(six, "dispatch", "--parent", "P", "--dry-run") == 0
    assert "会派出" not in capsys.readouterr().out


def test_the_dispatch_record_notes_the_latest_ask(board, backend):
    db.raise_ask(board, kind="decide", question="旧问题", evidence="材料", task_ids=["P-1"],
                 raised_by="ac:x", options=["A", "B"])
    assert run(board, "dispatch", "P-1") == 0
    with sqlite3.connect(board) as con:
        [(body,)] = con.execute("SELECT body FROM task_events WHERE body LIKE 'dispatch {%'")
    assert json.loads(body[len("dispatch "):])["asks"] == 1


def test_a_successor_brief_carries_its_prerequisite_s_output(board, backend):
    db.create_task(board, task_id="UP", title="前置卡")
    db.link_tasks(board, "P-1", "UP", kind="depends_on", created_by="test")
    db.add_letter(board, "UP", kind="done", msg="第一版", session_id="w")
    db.add_letter(board, "UP", kind="done", msg="PR #15 已修,测试 493 passed", session_id="w")
    db.add_ref(board, "UP", kind="pr", value="https://github.com/o/r/pull/15")
    db.add_ref(board, "UP", kind="merge_sha", value="e2349f13")
    with sqlite3.connect(board) as con:
        con.execute("UPDATE tasks SET status='done' WHERE id='UP'")
    assert run(board, "dispatch", "P-1") == 0
    brief = backend.ran("claude", "--bg")[0][-1]
    assert "前置卡的产出" in brief and "[UP] 前置卡 «done»" in brief
    assert "完成报告:PR #15 已修,测试 493 passed" in brief and "第一版" not in brief
    assert "PR:https://github.com/o/r/pull/15 · 合并提交:e2349f13" in brief


def test_a_card_without_prerequisites_gets_no_handoff_section(board, backend):
    assert run(board, "dispatch", "P-1") == 0
    assert "前置卡的产出" not in backend.ran("claude", "--bg")[0][-1]


@pytest.mark.parametrize("case,reason", [
    ("claimed", "已被 ac:other 认领"),
    ("done", "不是待办状态"),
    ("untrusted", "Workspace not trusted"),
])
def test_dispatch_refuses_with_a_reason_and_starts_nothing(board, backend, capsys, case, reason):
    if case == "claimed":
        db.claim_task(board, "P-1", owner="ac:other", session_id="other")
    elif case == "done":
        with sqlite3.connect(board) as con:
            con.execute("UPDATE tasks SET status='done' WHERE id='P-1'")
    else:
        backend.fail, backend.stderr = (("claude", "--bg"),), "Workspace not trusted. Run `claude` once."
    before = task(board, "P-1")
    assert run(board, "dispatch", "P-1") == 1
    assert reason in capsys.readouterr().err
    assert not backend.sessions
    assert backend.launched == (case == "untrusted")
    assert task(board, "P-1") == before


@pytest.fixture
def finished(board, backend, tmp_path):
    assert run(board, "dispatch", "P-1") == 0
    (tmp_path / ".claude/worktrees/p-1").mkdir(parents=True)
    with sqlite3.connect(board) as con:
        con.execute("UPDATE tasks SET status='done' WHERE id='P-1'")
    return board


def test_dismiss_stops_the_session_and_removes_a_clean_worktree(finished, backend, tmp_path):
    assert run(finished, "dismiss", "P-1") == 0
    assert backend.ran("claude", "stop", SID[:8])
    steps = [c[3:] for c in backend.ran("git", "-C", str(tmp_path))]
    worktree = str(tmp_path / ".claude/worktrees/p-1")
    assert steps == [["worktree", "unlock", worktree], ["worktree", "remove", worktree],
                     ["branch", "-d", "worktree-p-1"]]


def test_dismiss_closes_the_tab_of_a_herdr_worker(board, backend, monkeypatch):
    monkeypatch.setenv("HERDR_ENV", "1")
    monkeypatch.setattr(dispatch, "_trusted", lambda root: True)
    assert run(board, "dispatch", "P-1") == 0
    db.claim_task(board, "P-1", owner="ac:w", session_id=SID)
    db.start_task(board, "P-1", owner="ac:w", session_id=SID, now="做完了")
    db.handoff(board, "P-1", owner="ac:w", session_id=SID, outcome="handed_off",
               summary="交接", now="等评审")
    assert run(board, "dismiss", "P-1") == 0
    assert backend.ran("herdr", "tab", "close", "w1:t9")
    assert not backend.ran("claude", "stop")


def test_dismiss_still_cleans_up_when_the_session_is_already_gone(finished, backend, capsys):
    backend.fail, backend.sessions = (("claude", "stop"),), []
    assert run(finished, "dismiss", "P-1") == 0
    assert "已经不在" in capsys.readouterr().out
    assert [c for c in backend.ran("git") if "remove" in c]


@pytest.mark.parametrize("state,reason", [
    ({"dirty": " M a.py"}, "没提交"),
    ({"unpushed": "abc123 wip"}, "没推送"),
])
def test_dismiss_keeps_a_worktree_with_unsaved_work(finished, backend, capsys, state, reason):
    vars(backend).update(state)
    assert run(finished, "dismiss", "P-1") == 0
    assert reason in capsys.readouterr().out
    assert backend.ran("claude", "stop")
    assert not [c for c in backend.ran("git") if "remove" in c or "unlock" in c]


def test_dismiss_refuses_a_card_still_in_progress(board, backend, capsys):
    assert run(board, "dispatch", "P-1") == 0
    assert run(board, "dismiss", "P-1") == 1
    assert "还没完成也没交接" in capsys.readouterr().err
    assert not backend.ran("claude", "stop")


def test_context_verb_prints_the_card_briefing(board, capsys):
    assert run(board, "context", "P-1") == 0
    assert "用户能派出第一张子卡" in capsys.readouterr().out


def test_worker_protocol_names_the_dispatch_command():
    text = (Path(__file__).resolve().parents[1]
            / "skills/nawaban/references/director-worker.md").read_text(encoding="utf-8")
    assert "nawaban dispatch" in text and "nawaban dismiss" in text and "named sub-agent" in text
