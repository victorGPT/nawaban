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


# ── brief, and index's 待决 and 目标 sections (spec NAWABAN-PENDING) ──

from test_github import OBJ, _issue  # noqa: E402

BRIEF_ISSUES = [
    _issue(1, OBJ, title="留存", comments=[("2026-11-07T11:00:00Z", "进展：留存到 33%。\n细节")]),
    _issue(2, "属于 #1", title="上线方案", comments=[(
        "2026-11-07T03:00:00Z", "待决：上线 A 还是 B\n【推荐】A，先灰度。理由略\n【默认动作】11-07 08:00 按推荐执行")]),
    _issue(3, "需要你定：要不要拆\n【默认动作】可以搁置", title="拆分", created="2026-11-06T20:00:00Z", parent=1),
    _issue(4, "x", title="散活", comments=[("2026-11-07T05:00:00Z", "待决：选哪个")]),
    _issue(5, "y", title="另一件散活"),
    _issue(6, "意图：排期 1.1 第 5 条\n度量：首卡耗时，目标 2 秒，现值 3 秒（11-05）", title="提速"),
]

BRIEF_GOLDEN = """\
## 待决 3
- #3 拆分 · 意图：排期 1.1 第 3 条，留住新用户 · 推荐：没写 · 默认动作：可以搁置
- #2 上线方案 · 意图：排期 1.1 第 3 条，留住新用户 · 推荐：A，先灰度 · 默认动作：11-07 08:00 按推荐执行（已到期）
- #4 散活 · 意图：没写 · 推荐：没写 · 默认动作：没写

## 目标 #1 留存
意图：排期 1.1 第 3 条，留住新用户
度量：次日留存，目标 40%，现值 31%（11-06）
- 1 小时前 #1 留存到 33%。

## 目标 #6 提速
意图：排期 1.1 第 5 条
度量：首卡耗时，目标 2 秒，现值 3 秒（11-05）
近 24 小时没有进展。

挂不上目标的开着的 issue 2 个。
"""


@pytest.fixture
def briefed(github, monkeypatch, capsys):
    monkeypatch.setattr(cli, "_gh_issues", lambda root: BRIEF_ISSUES)
    monkeypatch.setattr(cli, "_gh_issue", lambda root, n: None)

    def run(verb):
        code = cli.main([verb])
        out = capsys.readouterr()
        assert code == 0, out.err
        return out.out
    return run


def test_brief_lists_pending_decisions_oldest_first_then_each_objective_then_the_unattached(briefed):
    assert briefed("brief") == BRIEF_GOLDEN


def test_a_brief_written_the_old_way_recommends_from_推荐_and_ties_go_by_issue_number(github, monkeypatch, capsys):
    # the same briefs as logic.test.js's, so brief and panel read them word for word alike
    monkeypatch.setattr(cli, "_gh_issues", lambda root: [
        _issue(10, "需要你定：要不要？推荐：拆。理由", title="乙"), _issue(9, "需要你定：x\n推荐：留着！好", title="甲")])
    monkeypatch.setattr(cli, "_gh_issue", lambda root, n: None)
    assert cli.main(["brief"]) == 0
    assert capsys.readouterr().out.splitlines()[1:3] == [
        "- #9 甲 · 意图：没写 · 推荐：留着 · 默认动作：没写", "- #10 乙 · 意图：没写 · 推荐：拆 · 默认动作：没写"]


def test_index_opens_with_the_briefs_待决_and_目标_sections_verbatim(briefed):
    top = BRIEF_GOLDEN.split("\n挂不上")[0]
    _, rest = briefed("index").split("\n\n", 1)  # after the title and counts lines
    assert rest.startswith(top)
    assert "\n## 没动 " in rest[len(top):]  # the old sections follow


def test_index_on_github_never_says_等你(github):
    assert "等你" not in github()  # the fixture's needs-info issues once made 等你


def test_brief_on_the_board_is_refused(run, capsys, tmp_path):
    assert cli.main(["--db", str(tmp_path / "proj" / ".nawaban" / "board.db"), "brief"]) == 1
    assert "GitHub" in capsys.readouterr().err


def test_a_snoozed_decision_is_out_of_待决_until_it_wakes(github, monkeypatch, capsys):
    monkeypatch.setattr(cli, "_gh_issues", lambda root: [
        _issue(1, "待决：x\n【默认动作】搁置到 2026-11-20 09:00", title="还睡着"),
        _issue(2, "待决：y\n【默认动作】搁置到 2026-11-01 09:00", title="醒了")])
    monkeypatch.setattr(cli, "_gh_issue", lambda root, n: None)
    monkeypatch.setattr(cli.time, "time", lambda: cli._dt.datetime(2026, 11, 7, 12, 0).timestamp())
    assert cli.main(["brief"]) == 0
    assert capsys.readouterr().out.split("\n\n")[0].splitlines() == [
        "## 待决 1", "- #2 醒了 · 意图：没写 · 推荐：没写 · 默认动作：搁置到 2026-11-01 09:00",
        "## 搁置 1", "- #1 还睡着 · 到 11-20 09:00"]
