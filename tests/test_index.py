"""`nawaban index`: the board as an md index on stdout (spec NAWABAN-INDEX, format E)."""

import json
import os
import subprocess
import time
from pathlib import Path

import pytest

from nawaban import cli

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "gh_issues.json").read_text())
HOUR = 3600


@pytest.fixture(autouse=True)
def utc():
    old = os.environ.get("TZ")
    os.environ["TZ"] = "UTC"
    time.tzset()
    yield
    if old is None:
        os.environ.pop("TZ")
    else:
        os.environ["TZ"] = old
    time.tzset()


def _at(monkeypatch, ts):
    monkeypatch.setattr(cli.time, "time", lambda: ts)


def ts(iso):
    from datetime import datetime
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())


@pytest.fixture
def github(tmp_path, monkeypatch, capsys):
    repo = tmp_path / "roubao"
    (repo / "docs" / "agents").mkdir(parents=True)
    (repo / "docs" / "agents" / "issue-tracker.md").write_text("# Issue tracker: GitHub\n")
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    monkeypatch.chdir(repo)
    monkeypatch.setattr(cli, "_gh_issues", lambda root: FIXTURE)
    _at(monkeypatch, ts("2026-11-07T12:00:00Z"))

    def index():
        code = cli.main(["index"])
        out = capsys.readouterr()
        assert code == 0, out.err
        return out.out
    return index


GITHUB_GOLDEN = """\
roubao 进行中的事 · 11-07 12:00 生成
停了 2 · 在推 3 · 没动 2

## 待决 0

## 停了
- #264 web：推荐卡片标题显示 content_id（示例）（28 小时没动静 · 停在：@someone）
  进展 28 小时前：后端在 #266。@someone 请看新字段 (链接) 。
- #301 首卡提速（示例）（26 小时没动静 · 停在：没写）
  进展 27 小时前：首卡压到目标内。
  最近决定 26 小时前：(roubao-e8)合并标准见正文。

## 在推
- #275 角色方向分不清（示例）
  进展 17 小时前：人标写回。 核查略。
  最近决定 18 小时前：改动不合 → 停在这里，理由：打平。
- #307 关系摸底（示例）
  进展 10 小时前：摸底做完。
  下一步：等 owner 对设计 B 拍板；另开小卡
- #292 身材放宽（示例）
  进展 3 小时前：等合并。
  最近决定 4 小时前：（owner 2026-11-07，经 roubao-e8 转达）审过，可以合。

## 48 小时内你拍的板 2（agent 自己定的另有 4 条，在各任务里）
- 2 小时前 #306 ADR 0033 是否采纳 → 采纳，负责人 11-07 拍板。
- 4 小时前 #292 （owner 2026-11-07，经 roubao-e8 转达）审过，可以合。

## 没动 2（开着，从没认领也没写进展）
- #239 evals: 两臂正面比（#236-C） · 属于 #236
- #294 增量抽取（示例） · 属于 #289

48 小时内关了 3 个。
"""


def test_github_golden(github, monkeypatch):
    monkeypatch.setenv("NAWABAN_OWNER_NAMES", "owner,负责人")
    assert github() == GITHUB_GOLDEN


def test_without_owner_names_only_a_decision_that_says_拍板_is_the_owner_s(github):
    assert "## 48 小时内你拍的板 1（agent 自己定的另有 5 条，在各任务里）\n- 2 小时前 #306 ADR 0033" in github()


@pytest.fixture
def run(tmp_path, capsys):
    board = tmp_path / "proj" / ".nawaban" / "board.db"

    def run(*args):
        code = cli.main(["--db", str(board), *args])
        out = capsys.readouterr()
        assert code == 0, out.err
        return out.out

    run("init")
    return run


BOARD_GOLDEN = """\
p 进行中的事 · 04-26 17:46 生成
等你 1 · 停了 1 · 在推 1 · 没动 2

## 等你
- W 等用户
  下一步：选 A 还是 B？

## 停了
- S 卡住的（26 小时没动静 · 停在：@alice）
  进展 26 小时前：跑到一半 @alice 在看

## 在推
- C1 子任务 · 属于 SPEC 总规格
  进展 1 小时前：写完测试
  最近决定 30 分钟前：先不接 CLI

## 48 小时内你拍的板 1（agent 自己定的另有 1 条，在各任务里）
- 3 小时前 D 发布

## 没动 2（开着，从没认领也没写进展）
- TRI 分诊过的
- IDLE 没人碰

48 小时内关了 1 个。
"""


def test_board_golden_and_no_file_is_written(run, monkeypatch, tmp_path):
    now = 10_000_000
    _at(monkeypatch, now - 40 * HOUR)
    for i, (t, title, extra) in enumerate([("SPEC", "总规格", []), ("C1", "子任务", ["--parent", "SPEC"]), ("W", "等用户", []),
                            ("S", "卡住的", []), ("IDLE", "没人碰", []), ("TRI", "分诊过的", []), ("D", "发布", [])]):
        _at(monkeypatch, now - 40 * HOUR + i)  # created_at orders 没动, newest first
        run("create", t, "--title", title, "--body", "", "--project", "p", *extra)
    run("event", "TRI", "--kind", "note", "--body", "triage: ready-for-agent")  # bookkeeping, not progress
    _at(monkeypatch, now - 30 * HOUR)
    run("claim", "S")
    _at(monkeypatch, now - 26 * HOUR)
    run("event", "S", "--kind", "note", "--body", "跑到一半 @alice 在看")
    _at(monkeypatch, now - 5 * HOUR)
    run("claim", "W")
    run("event", "W", "--kind", "note", "--body", "triage: needs-info — 等你：选 A 还是 B？")
    _at(monkeypatch, now - 3 * HOUR)
    run("event", "D", "--kind", "decision", "--body", "Verdict: 发布", "--by", "user")
    run("close", "D", "--done")
    _at(monkeypatch, now - 2 * HOUR)
    run("claim", "C1")
    _at(monkeypatch, now - HOUR)
    run("event", "C1", "--kind", "note", "--body", "写完测试，下一步：接 CLI。")
    _at(monkeypatch, now - HOUR // 2)
    run("event", "C1", "--kind", "decision", "--body", "Question: 现在接吗\nVerdict: 先不接 CLI")  # overtakes 下一步
    _at(monkeypatch, now)
    def files():  # SQLite's own -wal/-shm beside a WAL board appear on any read, json board's too
        return sorted(f for f in tmp_path.rglob("*") if not f.name.endswith(("-wal", "-shm")))
    before = files()
    assert run("index", "--project", "p") == BOARD_GOLDEN
    assert files() == before


def test_a_done_task_without_a_done_event_counts_as_not_recently_closed(run, tmp_path):
    run("create", "OLD", "--title", "老任务", "--body", "", "--project", "p")
    import sqlite3
    with sqlite3.connect(tmp_path / "proj" / ".nawaban" / "board.db") as con:  # an old task: done, no →done event
        con.execute("UPDATE tasks SET status='done' WHERE id='OLD'")
    assert run("index", "--project", "p").endswith("48 小时内关了 0 个。\n")


def test_a_link_stops_before_the_cjk_text_after_it(run):
    run("create", "L", "--title", "带链接", "--body", "", "--project", "p")
    run("claim", "L")
    run("event", "L", "--kind", "note", "--body", "详见 https://github.com/o/r/pull/300（PR #300 的评论）")
    assert "进展 0 分钟前：详见 (链接)（PR #300 的评论）" in run("index", "--project", "p")


# ── brief, and index's 待决 section (spec NAWABAN-PENDING) ──

from test_github import _issue  # noqa: E402

BRIEF_ISSUES = [
    _issue(2, "x", title="上线方案", comments=[
        ("2026-11-07T01:00:00Z", "进展：第 1 步"), ("2026-11-07T02:00:00Z", "进展：第 2 步"),
        ("2026-11-07T03:00:00Z", "待决：上线 A 还是 B\n【推荐】A，先灰度。理由略"),
        ("2026-11-07T04:00:00Z", "进展：第 3 步"), ("2026-11-07T05:00:00Z", "## 进展：第 4 步\n  细节   在这\n\n还有"),
        ("2026-11-07T06:00:00Z", "决定：先不拆"), ("2026-11-07T07:00:00Z", "进展：第 5 步")]),
    _issue(10, "需要你定：要不要拆？推荐：拆", title="乙", created="2026-11-06T20:00:00Z"),
    _issue(9, "背景。\n\n待决：留着还是删\n", title="甲", created="2026-11-06T20:00:00Z"),
    _issue(5, "y", title="没待决"),
    _issue(4, "待决：关了的", title="已关", state="CLOSED"),
]

BRIEF_GOLDEN = """\
## 待决 3

### #9 甲 · 11-06 20:00 提出
https://github.com/example/roubao/issues/9
原文：
待决：留着还是删
近期进展：没有

### #10 乙 · 11-06 20:00 提出
https://github.com/example/roubao/issues/10
原文：
需要你定：要不要拆？推荐：拆
近期进展：没有

### #2 上线方案 · 11-07 03:00 提出
https://github.com/example/roubao/issues/2
原文：
待决：上线 A 还是 B
【推荐】A，先灰度。理由略
近期进展：
- 11-07 04:00 第 3 步
- 11-07 05:00 第 4 步 细节 在这 还有
- 11-07 07:00 第 5 步
"""


@pytest.fixture
def briefed(github, monkeypatch, capsys):
    monkeypatch.setattr(cli, "_gh_issues", lambda root: BRIEF_ISSUES)

    def run(verb):
        code = cli.main([verb])
        out = capsys.readouterr()
        assert code == 0, out.err
        return out.out
    return run


def test_brief_gives_each_pending_decision_oldest_first_its_text_its_issue_and_its_last_进展(briefed):
    assert briefed("brief") == BRIEF_GOLDEN


def test_index_opens_with_the_pending_decisions_by_issue_number(briefed):
    _, rest = briefed("index").split("\n\n", 1)  # after the title and counts lines
    assert rest.startswith("## 待决 3\n- #9 甲\n- #10 乙\n- #2 上线方案\n\n## ")


def test_index_on_github_never_says_等你(github):
    assert "等你" not in github()  # the fixture's needs-info issues once made 等你


def test_brief_on_the_board_is_refused(run, capsys, tmp_path):
    assert cli.main(["--db", str(tmp_path / "proj" / ".nawaban" / "board.db"), "brief"]) == 1
    assert "GitHub" in capsys.readouterr().err
