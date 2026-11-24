"""`nawaban okr`: Progress computed from each KR's measure, never narrated (spec NAWABAN-OKR, ticket 03)."""

import subprocess

import pytest

from nawaban import cli

OKR = """
[[objective]]
name = "听得懂需求"

[[objective.kr]]
name = "意图准确率"
target = ">= 95"
unit = "%"
measure = "echo '进度日志'; echo '100.0 2026-11-17'"

[[objective.kr]]
name = "L1 首位"
target = ">= 95"
unit = "%"
measure = "echo '89 2026-11-17'"

[[objective.kr]]
name = "边界难例"
target = ">= 80"

[[objective]]
name = "推荐能减少筛选"

[[objective.kr]]
name = "硬条件违反"
target = "<= 0"
measure = "echo 'missing data' >&2; exit 3"

[[objective.kr]]
name = "没写日期"
target = ">= 1"
measure = "echo 5"

[[objective.kr]]
name = "不是数"
target = ">= 1"
measure = "echo 'n/a 2026-11-17'"
"""


@pytest.fixture
def repo(tmp_path, monkeypatch):
    (tmp_path / "docs" / "agents").mkdir(parents=True)
    (tmp_path / "docs" / "agents" / "okr.toml").write_text(OKR)
    for args in (["init", "-q"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "okr"]):
        subprocess.run(["git", *args], cwd=tmp_path, check=True)
    monkeypatch.chdir(tmp_path)
    return tmp_path


def okr(capsys):
    code = cli.main(["okr"])
    out = capsys.readouterr()
    return code, out.out + out.err


def line(out, name):
    return next(l for l in out.splitlines() if name in l)


def test_a_kr_counts_as_met_only_when_its_measured_value_meets_the_target(repo, capsys):
    code, out = okr(capsys)
    assert code == 0, out
    assert "听得懂需求 · 1/3 达标" in out and "推荐能减少筛选 · 0/3 达标" in out
    assert line(out, "意图准确率") == "  意图准确率  100.0% / 目标 >= 95% · 偏差 +5.0 点 · 绿 · 截至 11-17"
    assert line(out, "L1 首位").startswith("  L1 首位  89.0% / 目标 >= 95% · 偏差 -6.0 点 · 红 · 截至 ")


def test_no_measure_is_untested_and_a_broken_measure_says_why(repo, capsys):
    _, out = okr(capsys)
    assert line(out, "边界难例") == "  边界难例  未测 / 目标 >= 80"
    assert "测量失败" in line(out, "硬条件违反") and "missing data" in line(out, "硬条件违反")
    assert "测量失败" in line(out, "没写日期") and "测量失败" in line(out, "不是数")


def test_a_crash_names_the_error_line_not_the_runtime_footer(repo, capsys):
    (repo / "docs" / "agents" / "okr.toml").write_text(
        '[[objective]]\nname = "O"\n[[objective.kr]]\nname = "崩"\ntarget = ">= 1"\n'
        'measure = "printf \'  at x\\\\nError [ERR_MODULE_NOT_FOUND]: no pkg\\\\n  at y\\\\n\\\\nNode.js v26\\\\n\' >&2; exit 1"\n')
    _, out = okr(capsys)
    assert "ERR_MODULE_NOT_FOUND" in line(out, "崩")


def test_a_python_crash_names_the_exception_not_a_traceback_path(repo, capsys):
    (repo / "docs" / "agents" / "okr.toml").write_text(
        '[[objective]]\nname = "O"\n[[objective.kr]]\nname = "崩"\ntarget = ">= 1"\n'
        'measure = "python3 -c \'exec(compile(\\"1/0\\", \\"errors.py\\", \\"exec\\"))\'"\n')
    _, out = okr(capsys)
    assert "ZeroDivisionError" in line(out, "崩")


def test_a_slow_measure_fails_instead_of_hanging(repo, capsys, monkeypatch):
    monkeypatch.setattr(cli, "MEASURE_TIMEOUT", 0.5)
    (repo / "docs" / "agents" / "okr.toml").write_text(
        '[[objective]]\nname = "O"\n[[objective.kr]]\nname = "慢"\ntarget = ">= 1"\nmeasure = "sleep 5"\n')
    _, out = okr(capsys)
    assert "测量失败" in line(out, "慢") and "超时" in line(out, "慢")


def test_the_header_names_the_definitions_commit_and_flags_uncommitted_edits(repo, capsys):
    head = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=repo, capture_output=True, text=True).stdout.strip()
    _, out = okr(capsys)
    assert head in out.splitlines()[0] and "未提交" not in out.splitlines()[0]
    (repo / "docs" / "agents" / "okr.toml").write_text(OKR.replace(">= 95", ">= 90", 1))
    _, out = okr(capsys)
    assert "未提交" in out.splitlines()[0]


@pytest.mark.parametrize("target", ["95", "=> 95", ">= abc", ""])
def test_a_malformed_target_refuses_the_whole_file(repo, capsys, target):
    (repo / "docs" / "agents" / "okr.toml").write_text(OKR.replace('target = ">= 80"', f'target = "{target}"'))
    code, out = okr(capsys)
    assert code == 1 and "边界难例" in out and "target" in out


def test_no_definitions_file_is_refused(tmp_path, monkeypatch, capsys):
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    monkeypatch.chdir(tmp_path)
    code, out = okr(capsys)
    assert code == 1 and "docs/agents/okr.toml" in out


def test_a_kr_without_a_name_or_with_a_numeric_target_refuses_the_file(repo, capsys):
    path = repo / "docs" / "agents" / "okr.toml"
    path.write_text('[[objective]]\nname = "O"\n[[objective.kr]]\ntarget = ">= 95"\n')
    assert okr(capsys)[0] == 1
    path.write_text('[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = 95\n')
    code, out = okr(capsys)
    assert code == 1 and "target" in out


def test_a_measure_printing_bad_bytes_fails_that_kr_only(repo, capsys):
    (repo / "docs" / "agents" / "okr.toml").write_text(
        '[[objective]]\nname = "O"\n[[objective.kr]]\nname = "坏字节"\ntarget = ">= 1"\nmeasure = "printf \'\\\\377\'"\n'
        '[[objective.kr]]\nname = "好的"\ntarget = ">= 1"\nmeasure = "echo \'2 today\'"\n')
    code, out = okr(capsys)
    assert code == 0 and "测量失败" in line(out, "坏字节") and line(out, "好的") == "  好的  2.0 / 目标 >= 1 · 偏差 +1.0 · 绿 · 截至 today"


@pytest.mark.parametrize("body", [b"\xff", b"objective = 5\n", b'[[objective]]\nname = "O"\nkr = [1]\n',
                                  b'[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = ">= 1"\nmeasure = true\n',
                                  b'[[objective]]\nname = "O"\n[[objective.kr]]\nname = 3\ntarget = ">= 1"\n',
                                  b'[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = ">= 1"\nmax_age_days = 1' + b'0' * 5000 + b'\n'])
def test_a_definitions_file_of_the_wrong_shape_is_refused(repo, capsys, body):
    (repo / "docs" / "agents" / "okr.toml").write_bytes(body)
    code, out = okr(capsys)
    assert code == 1 and "okr.toml" in out


def test_a_reading_just_below_the_target_is_missed_however_many_digits(repo, capsys):
    (repo / "docs" / "agents" / "okr.toml").write_text(
        '[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = ">= 9007199254740993"\nmeasure = "echo 9007199254740992 today"\n'
        '[[objective.kr]]\nname = "J"\ntarget = ">= 1.0000000000000001"\nmeasure = "echo 1 today"\n')
    _, out = okr(capsys)
    assert "0/2 达标" in out


def test_a_reading_older_than_max_age_days_is_stale_not_met(repo, capsys):
    import datetime
    d = lambda n: (datetime.date.today() - datetime.timedelta(days=n)).isoformat()
    (repo / "docs" / "agents" / "okr.toml").write_text(
        '[[objective]]\nname = "O"\n'
        f'[[objective.kr]]\nname = "新"\ntarget = ">= 1"\nmax_age_days = 7\nmeasure = "echo \'5 {d(2)} report.md\'"\n'
        f'[[objective.kr]]\nname = "旧"\ntarget = ">= 1"\nmax_age_days = 7\nmeasure = "echo \'5 {d(10)}\'"\n'
        '[[objective.kr]]\nname = "无日期"\ntarget = ">= 1"\nmax_age_days = 7\nmeasure = "echo \'5 latest\'"\n')
    _, out = okr(capsys)
    assert "1/3 达标" in out and " · 绿 · " in line(out, "新")
    assert " · 黄 · 截至 " in line(out, "旧") and "测量过期" in line(out, "旧")
    assert "测量失败" in line(out, "无日期")


@pytest.mark.parametrize("age", ["-1", "true", '"7"', "1.5"])
def test_a_bad_max_age_days_refuses_the_file(repo, capsys, age):
    (repo / "docs" / "agents" / "okr.toml").write_text(
        f'[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = ">= 1"\nmax_age_days = {age}\n')
    code, out = okr(capsys)
    assert code == 1 and "max_age_days" in out


def test_a_reading_with_bad_bytes_or_a_compact_date_never_counts(repo, capsys):
    (repo / "docs" / "agents" / "okr.toml").write_text(
        '[[objective]]\nname = "O"\n'
        '[[objective.kr]]\nname = "坏截至"\ntarget = ">= 1"\nmeasure = "printf \'2 \\\\377\'"\n'
        '[[objective.kr]]\nname = "紧凑日期"\ntarget = ">= 1"\nmax_age_days = 7\nmeasure = "echo 2 $(date +%Y%m%d)"\n')
    _, out = okr(capsys)
    assert "0/2 达标" in out and "测量失败" in line(out, "坏截至") and "测量失败" in line(out, "紧凑日期")


def test_a_nul_in_a_measure_refuses_the_file(repo, capsys):
    (repo / "docs" / "agents" / "okr.toml").write_text(
        '[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = ">= 1"\nmeasure = "echo \\u0000"\n')
    code, out = okr(capsys)
    assert code == 1 and "measure" in out


def test_a_reading_in_scientific_notation_is_read(repo, capsys):
    (repo / "docs" / "agents" / "okr.toml").write_text(
        '[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = "> 0"\nmeasure = "echo 1e-05 today"\n')
    _, out = okr(capsys)
    assert "1/1 达标" in out


# ── readings kept on the board, json okr, attention (spec NAWABAN-OKRP, ticket 01) ──

import json
import sqlite3
from contextlib import closing


@pytest.fixture
def board(tmp_path):
    db = tmp_path / "b" / ".nawaban" / "nawaban.db"
    assert cli.main(["--db", str(db), "init"]) == 0
    return db


def rows(db, table="kr_readings"):
    with closing(sqlite3.connect(db)) as con:
        return con.execute(f"SELECT * FROM {table}").fetchall()



def test_an_old_board_is_backed_up_and_migrated_on_open_keeping_its_tasks(board, capsys):
    assert cli.main(["--db", str(board), "create", "T", "--title", "留下", "--body", ""]) == 0
    with closing(sqlite3.connect(board)) as con:  # back to what a version-1 board looks like
        con.executescript("DROP TABLE kr_readings; DROP TABLE okr_accepts; PRAGMA user_version=1;")
    capsys.readouterr()
    assert cli.main(["--db", str(board), "list"]) == 0 and "留下" in capsys.readouterr().out
    with closing(sqlite3.connect(board)) as con:
        assert con.execute("PRAGMA user_version").fetchone()[0] == cli.VERSION
        assert con.execute("SELECT count(*) FROM kr_readings").fetchone()[0] == 0
    backups = list((board.parent / "backups").glob("nawaban-*.db"))
    assert backups
    with closing(sqlite3.connect(backups[0])) as con:
        assert con.execute("PRAGMA user_version").fetchone()[0] == 1
        assert con.execute("SELECT title FROM tasks").fetchall() == [("留下",)]


def test_init_on_an_old_board_migrates_it(board):
    with closing(sqlite3.connect(board)) as con:
        con.executescript("DROP TABLE kr_readings; DROP TABLE okr_accepts; PRAGMA user_version=1;")
    assert cli.main(["--db", str(board), "init"]) == 0
    assert rows(board) == []


def readings(db):
    return [r for r in rows(db) if r[2] != cli.FAILED]


def test_okr_keeps_each_reading_once_and_a_failed_measure_as_its_failure(repo, board, capsys):
    assert cli.main(["--db", str(board), "okr"]) == 0
    assert "读数新记 2 条" in capsys.readouterr().out
    got = {(r[0], r[1], r[2], r[3], r[4]) for r in readings(board)}
    assert got == {(str(repo.resolve()), "意图准确率", "100.0", "2026-11-17", ""),
                   (str(repo.resolve()), "L1 首位", "89", "2026-11-17", "")}
    assert {(r[1], r[4]) for r in rows(board) if r[2] == cli.FAILED} == {
        ("硬条件违反", "退出码 3：missing data"), ("没写日期", "最后一行不是「数值 截至」：'5'"),
        ("不是数", "最后一行不是「数值 截至」：'n/a 2026-11-17'")}
    assert cli.main(["--db", str(board), "okr"]) == 0
    assert "读数新记 0 条" in capsys.readouterr().out and len(rows(board)) == 5


def test_as_of_is_the_date_and_source_the_rest(repo, board):
    (repo / "docs" / "agents" / "okr.toml").write_text(
        '[[objective]]\nname = "O"\n[[objective.kr]]\nname = "K"\ntarget = ">= 1"\nmeasure = "echo 3 2026-11-18 a/b.md"\n')
    cli.main(["--db", str(board), "okr"])
    assert [r[3:5] for r in rows(board)] == [("2026-11-18", "a/b.md")]


def test_okr_in_a_worktree_records_under_the_main_checkout(repo, board, monkeypatch):
    wt = repo.parent / "wt"
    subprocess.run(["git", "worktree", "add", "-q", str(wt)], cwd=repo, check=True)
    monkeypatch.chdir(wt)
    assert cli.main(["--db", str(board), "okr"]) == 0
    assert {r[0] for r in rows(board)} == {str(repo.resolve())}


def test_okr_without_a_board_prints_and_records_nothing(repo, capsys):
    code, out = okr(capsys)
    assert code == 0 and "没有看板" in out


# KR names → readings (value, as_of), oldest first
def seed(db, repo, readings, at="2026-11-19T00:00:00"):
    with closing(sqlite3.connect(db)) as con, con:
        for kr, rs in readings.items():
            for i, (v, as_of) in enumerate(rs):
                con.execute("INSERT INTO kr_readings (repo, kr, value, as_of, source, measured_at) VALUES (?, ?, ?, ?, '', ?)",
                            (str(repo.resolve()), kr, str(v), as_of, f"{at[:-2]}{i:02d}"))


def jokr(db, capsys, *extra):
    capsys.readouterr()
    code = cli.main(["--db", str(db), "json", "okr", *extra])
    return code, json.loads(capsys.readouterr().out)


def define(repo, krs):
    body = '[[objective]]\nname = "O"\n' + "".join(f'[[objective.kr]]\nname = "{n}"\ntarget = "{t}"\n{x}\n'
                                               for n, t, x in krs)
    (repo / "docs" / "agents" / "okr.toml").write_text(body)


def kinds(data):
    return {(a["kind"], a["kr"]) for a in data["attention"]}


def test_json_okr_reads_the_board_and_never_runs_a_measure(repo, board, capsys, monkeypatch):
    monkeypatch.setattr(cli, "_measure", lambda *a: (_ for _ in ()).throw(AssertionError("ran a measure")))
    seed(board, repo, {"意图准确率": [(90, "2026-11-10"), (97.5, "2026-11-18")]})
    code, data = jokr(board, capsys)
    assert code == 0 and data["repo"] == str(repo.resolve()) and data["def_commit"]
    o = data["objectives"][0]
    k = o["krs"][0]
    assert (k["status"], k["value"], k["as_of"], k["trend"], k["missed_rounds"]) == ("met", 97.5, "2026-11-18", "closer", 0)
    assert k["history"] == [{"value": 90, "as_of": "2026-11-10"}, {"value": 97.5, "as_of": "2026-11-18"}]
    assert (k["target"], k["target_op"], k["target_value"]) == (">= 95", ">=", 95)
    assert {x["name"]: x["status"] for x in o["krs"]}["边界难例"] == "untested"
    assert (data["met"], data["total"], o["met"], o["total"]) == (1, 6, 1, 3)


def test_json_okr_with_repo_and_no_okr_file_is_a_json_error(board, tmp_path, capsys):
    subprocess.run(["git", "init", "-q", str(tmp_path / "bare")], check=True)
    code, data = jokr(board, capsys, "--repo", str(tmp_path / "bare"))
    assert code == 1 and "okr.toml" in data["error"]


@pytest.mark.parametrize("target,values,trend", [
    (">= 95", [80, 85], "closer"), (">= 95", [85, 80], "away"), (">= 95", [80, 80], "flat"),
    ("<= 5", [9, 7], "closer"), ("<= 5", [7, 9], "away"),
    ("== 0", [-3, 2], "closer"), ("== 0", [2, -3], "away"), ("== 0", [2, -2], "flat")])
def test_closer_is_toward_the_target(repo, board, capsys, target, values, trend):
    define(repo, [("K", target, "")])
    seed(board, repo, {"K": [(v, f"2026-11-1{i}") for i, v in enumerate(values)]})
    assert jokr(board, capsys)[1]["objectives"][0]["krs"][0]["trend"] == trend


def test_stuck_is_missed_with_two_rounds_not_closer(repo, board, capsys):
    define(repo, [("卡住", ">= 95", ""), ("在动", ">= 95", ""), ("两条", ">= 95", ""), ("达标", ">= 95", "")])
    seed(board, repo, {"卡住": [(80, "2026-11-10"), (80, "2026-11-11"), (79, "2026-11-12")],
                       "在动": [(80, "2026-11-10"), (80, "2026-11-11"), (81, "2026-11-12")],
                       "两条": [(80, "2026-11-10"), (80, "2026-11-11")],
                       "达标": [(96, "2026-11-10"), (96, "2026-11-11"), (96, "2026-11-12")]})
    data = jokr(board, capsys)[1]
    assert kinds(data) == {("stuck", "卡住")}
    assert "80、80、79" in data["attention"][0]["text"]


def test_five_is_five_missed_rounds_in_a_row(repo, board, capsys):
    define(repo, [("五轮", ">= 95", ""), ("四轮", ">= 95", "")])
    seed(board, repo, {"五轮": [(96, "2026-11-09")] + [(80 + i, f"2026-11-1{i}") for i in range(5)],
                       "四轮": [(96, "2026-11-09")] + [(80 + i, f"2026-11-1{i}") for i in range(4)]})
    data = jokr(board, capsys)[1]
    assert kinds(data) == {("five", "五轮")}
    assert {k["name"]: k["missed_rounds"] for k in data["objectives"][0]["krs"]} == {"五轮": 5, "四轮": 4}


def test_five_still_shows_once_the_latest_reading_has_gone_stale(repo, board, capsys):
    define(repo, [("K", ">= 95", "max_age_days = 7")])
    seed(board, repo, {"K": [(80 + i, f"2020-01-1{i}") for i in range(5)]})
    data = jokr(board, capsys)[1]
    assert data["objectives"][0]["krs"][0]["status"] == "stale" and kinds(data) == {("five", "K")}


def test_wait_is_a_kr_waiting_on_the_decision_maker_without_a_measure(repo, board, capsys):
    define(repo, [("要批", ">= 1", 'wait = "批读生产数据"'), ("有量", ">= 1", 'wait = "x"\nmeasure = "echo 1 2026-11-18"')])
    data = jokr(board, capsys)[1]
    assert data["attention"] == [{"kind": "wait", "objective": "O", "kr": "要批", "text": "批读生产数据"}]
    assert data["objectives"][0]["krs"][0]["wait"] == "批读生产数据"


def test_a_non_string_wait_refuses_the_file(repo, board, capsys):
    define(repo, [("K", ">= 1", "wait = 3")])
    code, data = jokr(board, capsys)
    assert code == 1 and "wait" in data["error"]


def accepted(db, repo, at):
    with closing(sqlite3.connect(db)) as con, con:
        con.execute("INSERT INTO okr_accepts VALUES (?, 'O', ?)", (str(repo.resolve()), at))


def test_accept_is_asked_when_all_met_and_never_accepted_or_missed_since(repo, board, capsys):
    define(repo, [("K", ">= 1", "")])
    seed(board, repo, {"K": [(2, "2026-11-10")]}, at="2026-11-10T00:00:00")
    assert kinds(jokr(board, capsys)[1]) == {("accept", None)}
    accepted(board, repo, "2026-11-11T00:00:00")
    data = jokr(board, capsys)[1]
    assert data["attention"] == [] and data["objectives"][0]["accept_pending"] is False
    seed(board, repo, {"K": [(0, "2026-11-12"), (3, "2026-11-13")]}, at="2026-11-12T00:00:00")
    data = jokr(board, capsys)[1]
    assert kinds(data) == {("accept", None)} and data["objectives"][0]["accept_pending"] is True


def test_accept_is_not_asked_while_a_kr_is_not_met(repo, board, capsys):
    define(repo, [("K", ">= 1", ""), ("J", ">= 1", "")])
    seed(board, repo, {"K": [(2, "2026-11-10")]})
    assert jokr(board, capsys)[1]["attention"] == []


def test_okr_accept_refuses_unless_the_objective_is_all_met_now(repo, board, capsys):
    assert cli.main(["--db", str(board), "okr", "--accept", "听得懂需求"]) == 1
    assert "还没全 ✓" in capsys.readouterr().err and rows(board, "okr_accepts") == []
    assert len(readings(board)) == 2  # a refused accept still keeps this run's readings
    assert cli.main(["--db", str(board), "okr", "--accept", "没这个"]) == 1
    define(repo, [("K", ">= 1", 'measure = "echo 2 2026-11-18"')])
    assert cli.main(["--db", str(board), "okr", "--accept", "O"]) == 0
    assert [r[:2] for r in rows(board, "okr_accepts")] == [(str(repo.resolve()), "O")]


def test_okr_and_json_okr_judge_the_same_kept_value(repo, board, capsys):
    define(repo, [("等于", "== 1", 'measure = "echo 1.0000000000000001 2026-11-18"'),
                  ("大数", ">= 9007199254740993", 'measure = "echo 9007199254740992 2026-11-18"')])
    assert cli.main(["--db", str(board), "okr"]) == 0
    assert "0/2 达标" in capsys.readouterr().out
    assert [k["status"] for k in jokr(board, capsys)[1]["objectives"][0]["krs"]] == ["missed", "missed"]


def test_a_miss_right_after_an_accept_asks_for_accept_again(repo, board, capsys):
    for value, day in ((2, 18), (0, 19), (3, 20)):  # all within the same second
        define(repo, [("K", ">= 1", f'measure = "echo {value} 2026-11-{day}"')])
        assert cli.main(["--db", str(board), "okr", *(["--accept", "O"] if day == 18 else [])]) == 0
    data = jokr(board, capsys)[1]
    assert kinds(data) == {("accept", None)}
    (accepted_at,), = [r[2:] for r in rows(board, "okr_accepts")]
    assert len(accepted_at) == 26 and all(r[5] != accepted_at for r in rows(board))


def test_a_raced_migration_backs_up_and_migrates_once(board, monkeypatch):
    with closing(sqlite3.connect(board)) as con:
        con.executescript("DROP TABLE kr_readings; DROP TABLE okr_accepts; PRAGMA user_version=1;")
    calls, real = [], cli.backup
    monkeypatch.setattr(cli, "backup", lambda p: calls.append(p) or real(p))
    cli._migrate(board)
    cli._migrate(board)  # the loser of a race finds version 2 under the write lock
    assert len(calls) == 1 and rows(board) == []


# ── declarations against readings (ticket NAWABAN-KRI-02) ──

def declare(db, repo, ticket, kr, d, at, o="O"):
    with closing(sqlite3.connect(db)) as con, con:
        con.execute("INSERT INTO kr_impacts VALUES (?,?,?,?,?,NULL,NULL,NULL,?)", (str(repo.resolve()), ticket, o, kr, d, at))


def reading(db, repo, kr, value, at, as_of=None):
    with closing(sqlite3.connect(db)) as con, con:
        con.execute("INSERT INTO kr_readings (repo, kr, value, as_of, source, measured_at) VALUES (?, ?, ?, ?, '', ?)", (str(repo.resolve()), kr, str(value), as_of or at[:10], at))


def kr_of(data, name):
    return next(k for o in data["objectives"] for k in o["krs"] if k["name"] == name)


def test_the_summary_counts_declarations_since_each_krs_last_round(repo, board, capsys):
    define(repo, [("K", ">= 95", ""), ("J", "<= 5", "")])
    reading(board, repo, "K", 80, "2026-11-10T00:00:00")
    declare(board, repo, "#1", "K", "↑", "2026-11-09T00:00:00")  # before the last round: no longer counted
    declare(board, repo, "#2", "K", "↑", "2026-11-11T00:00:00")
    declare(board, repo, "#3", "K", "=", "2026-11-11T00:00:01")
    declare(board, repo, "#4", "J", "↓", "2026-11-11T00:00:02")  # J has no reading yet: every declaration counts
    declare(board, repo, "#5", "J", "↑", "2026-11-01T00:00:00")
    declare(board, repo, "#6", "", "=", "2026-11-11T00:00:03")  # O only, no KR: not in the counts
    data = jokr(board, capsys)[1]
    assert data["objectives"][0]["impacts"] == {"↑": 2, "↓": 1, "=": 1}
    assert [i["ticket"] for i in kr_of(data, "K")["impacts"]] == ["#2", "#3"]
    assert kr_of(data, "K")["impacts"][0] == {"ticket": "#2", "dir": "↑", "before": None, "after": None,
                                              "basis": None, "at": "2026-11-11T00:00:00"}
    assert [i["ticket"] for i in kr_of(data, "J")["impacts"]] == ["#5", "#4"]
    assert kr_of(data, "K")["mismatch"] == []


@pytest.mark.parametrize("target,before,after,d,mismatch", [
    (">= 95", 80, 80, "↑", True), (">= 95", 80, 79, "↑", True), (">= 95", 80, 85, "↑", False),
    ("<= 5", 9, 7, "↑", False), ("<= 5", 7, 7, "↑", True),
    ("== 0", 2, -1, "↑", False), ("== 0", 2, -3, "↑", True),
    (">= 95", 80, 79, "=", True), (">= 95", 80, 80, "=", False), (">= 95", 80, 85, "=", False),
    ("<= 5", 7, 9, "↓", False), ("<= 5", 7, 6, "↓", False), ("<= 5", 7, 7, "↓", False)])
def test_the_first_round_after_a_declaration_judges_it_by_the_target(repo, board, capsys, target, before, after, d, mismatch):
    define(repo, [("K", target, "")])
    reading(board, repo, "K", before, "2026-11-10T00:00:00")
    declare(board, repo, "#7", "K", d, "2026-11-11T00:00:00")
    reading(board, repo, "K", after, "2026-11-12T00:00:00")
    k = kr_of(jokr(board, capsys)[1], "K")
    assert k["mismatch"] == ([{"ticket": "#7", "dir": d}] if mismatch else [])
    assert k["impacts"] == []  # a round has come since: no longer pending


def test_no_new_round_no_verdict(repo, board, capsys):
    define(repo, [("K", ">= 95", 'measure = "echo 80 2026-11-10"')])
    assert cli.main(["--db", str(board), "okr"]) == 0
    declare(board, repo, "#7", "K", "↑", "2099-01-01T00:00:00")
    assert cli.main(["--db", str(board), "okr"]) == 0  # the same as-of again: no row, no new round
    k = kr_of(jokr(board, capsys)[1], "K")
    assert k["mismatch"] == [] and [i["ticket"] for i in k["impacts"]] == ["#7"]


def test_a_declaration_before_any_reading_or_judged_by_an_older_round_is_not_judged(repo, board, capsys):
    define(repo, [("K", ">= 95", "")])
    declare(board, repo, "#1", "K", "↑", "2026-11-09T00:00:00")  # no baseline before it
    reading(board, repo, "K", 80, "2026-11-10T00:00:00")
    declare(board, repo, "#2", "K", "↑", "2026-11-11T00:00:00")
    reading(board, repo, "K", 70, "2026-11-12T00:00:00")  # judges #2 ...
    assert kr_of(jokr(board, capsys)[1], "K")["mismatch"] == [{"ticket": "#2", "dir": "↑"}]
    reading(board, repo, "K", 60, "2026-11-13T00:00:00")  # ... a later round does not judge it again
    assert kr_of(jokr(board, capsys)[1], "K")["mismatch"] == []


def test_one_round_with_several_readings_is_judged_on_its_latest_as_of(repo, board, capsys):
    define(repo, [("K", ">= 95", "")])
    reading(board, repo, "K", 80, "2026-11-10T00:00:00", "2026-11-10")
    declare(board, repo, "#7", "K", "↑", "2026-11-11T00:00:00")
    reading(board, repo, "K", 90, "2026-11-12T00:00:00", "2026-11-12")
    reading(board, repo, "K", 70, "2026-11-12T00:00:00", "2026-11-11")  # same round, older as-of
    assert kr_of(jokr(board, capsys)[1], "K")["mismatch"] == []


def test_okr_prints_the_counts_and_the_mismatches(repo, board, capsys):
    (repo / "k.txt").write_text("80 2026-11-10")
    define(repo, [("K", ">= 95", 'measure = "cat k.txt"'), ("J", ">= 1", "")])
    assert cli.main(["--db", str(board), "okr"]) == 0
    declare(board, repo, "#7", "K", "↑", "2000-01-01T00:00:00")  # before the run above: judged by the next
    with closing(sqlite3.connect(board)) as con, con:
        con.execute("UPDATE kr_readings SET measured_at='2000-01-01T00:00:00' WHERE kr='K'")
    declare(board, repo, "#8", "J", "↓", "2000-01-02T00:00:00")
    (repo / "k.txt").write_text("79 2026-11-11")
    capsys.readouterr()
    assert cli.main(["--db", str(board), "okr"]) == 0
    out = capsys.readouterr().out
    assert "O O · 声明 ↑0 ↓1 =0" in out and "预期不符 K：#7 声明 ↑" in out, out


def test_a_value_that_comes_back_on_the_same_as_of_is_kept_and_shown(repo, board, capsys):
    define(repo, [("K", "<= 3", 'measure = "cat k.txt"')])
    for value in ("2.1", "3.4", "2.1"):
        (repo / "k.txt").write_text(f"{value} 2026-11-17 e3")
        assert cli.main(["--db", str(board), "okr"]) == 0
    assert [r[2] for r in readings(board)] == ["2.1", "3.4", "2.1"]
    k = kr_of(jokr(board, capsys)[1], "K")
    assert (k["value"], k["status"], k["trend"]) == (2.1, "met", "closer")


def test_changing_the_measure_script_starts_a_new_series_from_zero(repo, board, capsys):
    (repo / "e3.ts").write_text("v1")
    define(repo, [("K", "<= 3", 'measure = "cat k.txt # e3.ts"')])
    for value in ("12.9", "11.6"):
        (repo / "k.txt").write_text(f"{value} 2026-11-17 e3")
        assert cli.main(["--db", str(board), "okr"]) == 0
    declare(board, repo, "#9", "K", "=", "2000-01-01T00:00:00")
    with closing(sqlite3.connect(board)) as con, con:
        con.execute("UPDATE kr_readings SET measured_at='2000-01-01T00:00:00' WHERE value='12.9'")
    old = kr_of(jokr(board, capsys)[1], "K")
    assert (old["series"]["version"], old["trend"], old["missed_rounds"]) == (1, "closer", 2)
    (repo / "e3.ts").write_text("v2")
    (repo / "k.txt").write_text("11.6 2026-11-17 e3")
    assert cli.main(["--db", str(board), "okr"]) == 0
    k = kr_of(jokr(board, capsys)[1], "K")
    assert (k["value"], k["trend"], k["missed_rounds"], k["mismatch"]) == (11.6, None, 1, [])
    assert k["history"] == [{"value": 11.6, "as_of": "2026-11-17"}]
    assert k["series"]["version"] == 2 and k["series"]["def_hash"] != old["series"]["def_hash"]
    assert len(readings(board)) == 3


def test_a_failed_measure_shows_unmeasurable_until_it_reads_again(repo, board, capsys):
    define(repo, [("K", "== 0", 'measure = "cat k.txt"')])
    (repo / "k.txt").write_text("0 2026-11-17 ci")
    assert cli.main(["--db", str(board), "okr"]) == 0
    (repo / "k.txt").unlink()
    capsys.readouterr()
    assert cli.main(["--db", str(board), "okr"]) == 0
    assert "K  量不了 / 目标 == 0 · 测量失败：退出码 1" in capsys.readouterr().out
    k = kr_of(jokr(board, capsys)[1], "K")
    assert (k["status"], k["value"], k["missed_rounds"]) == ("unmeasurable", 0, 0)
    assert k["failure"].startswith("退出码 1")
    (repo / "k.txt").write_text("0 2026-11-17 ci")
    assert cli.main(["--db", str(board), "okr"]) == 0
    k = kr_of(jokr(board, capsys)[1], "K")
    assert (k["status"], k["failure"], k["trend"], k["history"]) == ("met", None, None, [{"value": 0, "as_of": "2026-11-17"}])


def test_def_hash_is_the_one_the_board_cli_computes(tmp_path):
    (tmp_path / "scripts").mkdir()
    (tmp_path / "scripts" / "e3.ts").write_text("export const gold = 'v3'\n")
    (tmp_path / "evals.jsonl").write_text("{}\n")
    kr = {"name": "放错档（E3）", "target": "<= 3", "unit": "%", "max_age_days": 14,
          "measure": "node scripts/e3.ts evals.jsonl ../x.ts /etc/hosts"}
    assert cli.def_hash(tmp_path, kr) == DEF_HASH_BOTH_CLIS_AGREE_ON


DEF_HASH_BOTH_CLIS_AGREE_ON = "5383ad5b5354835d"


def test_a_quoted_measure_script_is_hashed(tmp_path):
    (tmp_path / "m.py").write_text("v1")
    kr = {"name": "K", "target": ">= 1", "measure": 'python "m.py"'}
    before = cli.def_hash(tmp_path, kr)
    (tmp_path / "m.py").write_text("v2")
    assert cli.def_hash(tmp_path, kr) != before


def test_a_new_measure_that_fails_first_leaves_the_old_series_behind(repo, board, capsys):
    (repo / "e3.ts").write_text("v1")
    define(repo, [("K", ">= 5", 'measure = "cat k.txt # e3.ts"')])
    for value in ("3", "2"):
        (repo / "k.txt").write_text(f"{value} 2026-11-17 e3")
        assert cli.main(["--db", str(board), "okr"]) == 0
    (repo / "e3.ts").write_text("v2")
    (repo / "k.txt").unlink()
    assert cli.main(["--db", str(board), "okr"]) == 0
    k = kr_of(jokr(board, capsys)[1], "K")
    assert (k["status"], k["series"], k["trend"], k["missed_rounds"], k["history"]) == ("unmeasurable", None, None, 0, [])


def test_a_script_right_before_a_shell_separator_is_hashed(tmp_path):
    (tmp_path / "m.py").write_text("v1")
    kr = {"name": "K", "target": ">= 1", "measure": "python3 m.py; echo"}
    before = cli.def_hash(tmp_path, kr)
    (tmp_path / "m.py").write_text("v2")
    assert cli.def_hash(tmp_path, kr) != before


def test_a_measure_that_fails_under_another_hash_and_comes_back_starts_over():
    kept = [dict(value=v, def_hash=h, as_of="2026-11-17", source="s", measured_at=str(i))
            for i, (v, h) in enumerate([("3", "A"), ("2", "A"), ("", "B"), ("1", "A")])]
    k, _ = cli._kr_view("O", {"name": "K", "target": ">= 5"}, kept, {}, [], [])
    assert (k["series"]["version"], k["trend"], k["missed_rounds"], k["history"]) == (3, None, 1, [{"value": 1, "as_of": "2026-11-17"}])


def inputs_fixture(root):
    for path, text in (("gold/a.jsonl", "a"), ("gold/sub/b.jsonl", "b"), ("gold/.h.jsonl", "h"), ("gold/.hidden/x.jsonl", "x"), ("cases.json", "c"),
                       ("gold/C.JSONL", "C"), ("outside/o.jsonl", "o")):
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_text(text)
    (root / "gold" / "out").symlink_to(root / "outside")
    (root / "gold" / "😀.jsonl").write_text("e")
    return {"name": "K", "target": "<= 3", "inputs": ["gold/**/*.jsonl", "cases.json", "missing/*.txt", "gold/**/**/*.jsonl", "gold/?.jsonl"]}


def test_inputs_hash_as_the_board_cli_does(tmp_path):
    assert cli.def_hash(tmp_path, inputs_fixture(tmp_path)) == INPUTS_HASH_BOTH_CLIS_AGREE_ON


INPUTS_HASH_BOTH_CLIS_AGREE_ON = "053c677dcdb3c251"


def test_a_changed_gold_file_starts_a_new_series_and_an_untouched_one_does_not(repo, board, capsys):
    (repo / "gold").mkdir()
    (repo / "gold" / "tier.jsonl").write_text("v1")
    (repo / "k.txt").write_text("2.1 2026-11-17 e3")
    define(repo, [("K", "<= 3", 'measure = "cat k.txt"\ninputs = ["gold/*.jsonl"]')])
    for _ in range(2):
        assert cli.main(["--db", str(board), "okr"]) == 0
    assert kr_of(jokr(board, capsys)[1], "K")["series"]["version"] == 1 and len(readings(board)) == 1
    (repo / "gold" / "tier.jsonl").write_text("v2")
    assert cli.main(["--db", str(board), "okr"]) == 0
    assert kr_of(jokr(board, capsys)[1], "K")["series"]["version"] == 2 and len(readings(board)) == 2


def test_inputs_under_home_are_read_from_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    (tmp_path / "home" / "proxy").mkdir(parents=True)
    (tmp_path / "home" / "proxy" / "gold.jsonl").write_text("v1")
    kr = {"name": "K", "target": "<= 3", "inputs": ["~/proxy/gold.jsonl"]}
    before = cli.def_hash(tmp_path, kr)
    (tmp_path / "home" / "proxy" / "gold.jsonl").write_text("v2")
    assert cli.def_hash(tmp_path, kr) != before


@pytest.mark.parametrize("inputs,why", [('"gold.jsonl"', "非空字符串的数组"), ('[""]', "非空字符串的数组"), ("[1]", "非空字符串的数组"),
                                        ("['gold/{a,b}.jsonl']", "只认 *、?、** 通配"), ("['gold/[ab].jsonl']", "只认 *、?、** 通配"),
                                        ("['gold/../x.jsonl']", "也不收 . 和 .. 段")])
def test_inputs_must_be_paths_with_the_wildcards_both_clis_read_alike(repo, capsys, inputs, why):
    define(repo, [("K", "<= 3", f"inputs = {inputs}")])
    assert cli.main(["okr"]) != 0
    assert why in capsys.readouterr().err
