"""Inbox questions, shared read projection, and trusted CLI write workflows.

Call read from terminal or Web clients; call the write operations only after CLI
identity resolution. This module owns projection, material policy, and write
ordering; db owns persistence and transition gates.
It neither renders output nor executes an authorized external action.

answer_ask and successful fanout establish NAWABAN_DECISION_CHANNEL=inbox in the
process environment, preserving the CLI decision channel. This is not an
in-process Web handler or an authentication layer: callers must supply an actual
human answer or a confirmed execution result. Multi-task writes commit separately;
a failure or unknown outcome requires readback before deciding whether to retry.
"""

from __future__ import annotations

import os
import sqlite3
import time
from collections.abc import Sequence
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path

from nawaban import db

_WRITE_SIDE = ("已合并", "已合入", "已 merge", "merged", "ci 绿", "ci 全绿", "全绿",
               "测试通过", "单测通过", "pytest", "已部署", "已上线")
_READ_SIDE = ("真机", "实测", "逐条对照", "日志", "loki", "grafana", "run ", "http",
              "查出", "正向证据", "复现", "观测", "抽样", "截图", "真人", "端到端")


def _materials_problem(kind: str, evidence: str, options: Sequence[str],
                       blast: str | None) -> str | None:
    # Reject missing material before it can become an unactionable inbox item.
    ev = (evidence or "").strip()
    if kind == "accept":
        low = ev.lower()
        if any(w in low for w in _WRITE_SIDE) and not any(r in low for r in _READ_SIDE):
            return ("accept 的 evidence 只有写侧信号(PR 已合并 / CI 绿 / 测试通过)。\n"
                    "  写侧 2xx 不等于实际效果 —— 要读侧正向证据:真机操作记录、日志查询、\n"
                    "  run URL、逐条对照 success 的账本。补一条再提。")
    if kind == "authorize":
        if not blast:
            return ('authorize 必须带 --blast "谁受影响|改什么|怎么回滚" —— '
                    "放行一个动作而说不清影响面,人没法判断。")
        if len(blast.split("|")) != 3:
            return f'--blast 要三段(谁受影响|改什么|怎么回滚),收到 {len(blast.split("|"))} 段'
    if kind == "decide":
        if len(options) < 2:
            return ('decide 必须带 ≥2 个 --option "选项|后果" —— '
                    "只有一个选项那不是分叉;一个都没有那是在让人替你想方案。")
        for o in options:
            if "|" not in o or not o.split("|", 1)[1].strip():
                return f'--option "{o}" 缺后果。格式:"选项|这么选会怎样"'
    return None


@dataclass(frozen=True)
class AnswerResult:
    """Completed answer receipt; task IDs are ordered as in the linked-task query.

    For accept, all listed tasks moved to the requested state before return.
    Other kinds only recorded decisions and closed the ask; no action ran.
    """

    kind: str
    task_ids: tuple[str, ...]


def raise_ask(path: Path | str, *, kind: str, question: str, evidence: str,
              task_ids: Sequence[str], raised_by: str,
              options: Sequence[str] = (), blast: str | None = None,
              hands_on: bool = False) -> int:
    """Validate human-facing materials and persist an ask, returning its ID.

    kind is accept, authorize, or decide. Options use 'choice|consequence'; blast
    uses 'who|what|rollback'. Required material depends on kind, while any supplied
    encoded values must use those formats. Policy rejection raises NawabanError
    before writing. The ask and task links are committed atomically by db.
    raised_by is the identity already resolved by the CLI, not user input.
    """
    if problem := _materials_problem(kind, evidence, options, blast):
        raise db.NawabanError(problem)
    parsed_options = [{"option": o.split("|", 1)[0].strip(),
                       "consequence": o.split("|", 1)[1].strip()} for o in options] or None
    parsed_blast = None
    if blast:
        parts = [x.strip() for x in blast.split("|")]
        parsed_blast = {"who": parts[0], "what": parts[1], "rollback": parts[2]}
    return db.raise_ask(path, kind=kind, question=question, evidence=evidence,
                        task_ids=task_ids, raised_by=raised_by, options=parsed_options,
                        blast=parsed_blast, hands_on=hands_on)


def answer_ask(path: Path | str, ask_id: int, *, verdict: str, owner: str,
               session_id: str, reject: bool = False,
               rejected: Sequence[dict] | None = None) -> AnswerResult:
    """Record a human answer, apply acceptance, and close the ask last.

    owner/session_id identify the runtime actor, not a required task owner;
    answering does not reassign tasks. accept moves tasks to done,
    or in_progress when reject is true; authorize/decide leave task states alone.
    A closed ask raises NawabanError. Database gate failures propagate and may
    leave decisions and earlier task transitions committed, with the ask open.
    There is no whole-answer transaction or automatic/idempotent retry.
    """
    detail = db.ask_detail(path, ask_id)
    if detail["closed_at"]:
        raise db.NawabanError(
            f"ask #{ask_id} 已于早前关闭({detail['closed_as']}),不可重复回答")
    os.environ["NAWABAN_DECISION_CHANNEL"] = "inbox"
    task_ids = tuple(task["id"] for task in detail["tasks"])
    for task_id in task_ids:
        db.decide(path, task_id, question=detail["question"], verdict=verdict,
                  rejected=rejected, decided_by="user")
    # Closing first would hide an unanswered acceptance when a transition gate
    # rejects the move. Earlier per-task commits still survive such a failure.
    if detail["kind"] == "accept":
        for task_id in task_ids:
            db.advance_task(path, task_id, to="in_progress" if reject else "done",
                            owner=owner, session_id=session_id)
    db.close_ask(path, ask_id, closed_as="answered", answer=verdict)
    return AnswerResult(kind=detail["kind"], task_ids=task_ids)


def fanout(path: Path | str, ask_id: int, *, succeeded: bool, owner: str,
           session_id: str) -> tuple[str, ...]:
    """Record the execution result for a closed ask; return its linked task IDs.

    succeeded is an observed result, not permission to execute. False records a
    note on the first linked task without moving any task. True records fresh
    user decisions and advances each task to done through the existing gates.
    An open ask raises NawabanError. Each write commits separately, so inspect
    persisted decisions and task states after failure rather than blindly retry.
    This preserves the existing closed-ask check; kind and closed_as are not
    additional eligibility gates. State transitions still go through db.
    """
    detail = db.ask_detail(path, ask_id)
    if not detail["closed_at"]:
        raise db.NawabanError(f"ask #{ask_id} 还没被回答,先 answer")
    task_ids = tuple(task["id"] for task in detail["tasks"])
    if not succeeded:
        db.add_event(path, task_ids[0], kind="note", author=owner,
                     session_id=session_id,
                     body=f"ask #{ask_id} 授权的动作执行失败 —— 扇出未发生,卡保持原状")
        return task_ids
    os.environ["NAWABAN_DECISION_CHANNEL"] = "inbox"
    for task_id in task_ids:
        db.decide(path, task_id, question=detail["question"],
                  verdict=f"{detail['answer']} · 动作已成功执行(fanout --ok)", decided_by="user")
        db.advance_task(path, task_id, to="done", owner=owner, session_id=session_id)
    return task_ids


def read(path: Path | str) -> dict:
    """Return the shared inbox projection for terminal and Web clients, read-only.

    The result has authorize/accept/decide groups, total and oldest_days, rolling
    seven-day raised/closed counts, and agent_side (nonterminal tasks without an
    open ask). Each item has db.open_asks fields. Within a group, scores below
    0.5 sort last, then older questions first; missing scores are neutral.

    oldest_days and stalled_days are days rounded to one decimal. Flow windows
    exclude the exact seven-day boundary. A database without asks returns empty
    groups with unavailable=True; missing/unreadable files raise sqlite3 errors.
    No schema migration or write occurs. Separate committed reads do not promise
    a single transaction snapshot while another process changes the inbox.
    """
    with closing(sqlite3.connect(f"file:{Path(path)}?mode=ro", uri=True, timeout=10)) as con0:
        has_asks = con0.execute(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='asks'"
        ).fetchone()[0]
    if not has_asks:
        # Old boards may predate asks. A read must not migrate them just to render
        # an inbox; preserve an explicit unavailable result for both callers.
        return {"total": 0, "oldest_days": 0.0, "unavailable": True,
                "groups": [{"kind": k, "title": t, "items": []} for k, t in
                           (("authorize", "放行"), ("accept", "验收"), ("decide", "拍板"))],
                "flow": {"raised_7d": 0, "closed_7d": 0}, "agent_side": 0}

    asks = db.open_asks(path)
    order = {"authorize": 0, "accept": 1, "decide": 2}
    # Uncertain questions stay visible. Lower confidence changes ordering only.
    def _conf(a: dict) -> float:
        # An unscored question is neutral; zero is an explicit low-confidence score.
        c = a.get("confidence")
        return 0.5 if c is None else float(c)

    asks.sort(key=lambda a: (order.get(a["kind"], 9), _conf(a) < 0.5, -a["stalled_days"]))

    with closing(sqlite3.connect(f"file:{Path(path)}?mode=ro", uri=True, timeout=10)) as con:
        week = int(time.time()) - 7 * 86400
        raised = con.execute("SELECT count(*) FROM asks WHERE raised_at>?", (week,)).fetchone()[0]
        closed = con.execute("SELECT count(*) FROM asks WHERE closed_at>?", (week,)).fetchone()[0]
        agent_side = con.execute(
            "SELECT count(*) FROM tasks WHERE status NOT IN ('done','cancelled') AND id NOT IN"
            " (SELECT task_id FROM ask_tasks WHERE ask_id IN"
            "  (SELECT id FROM asks WHERE closed_at IS NULL))").fetchone()[0]

    groups = [
        {"kind": "authorize", "title": "放行", "items": [a for a in asks if a["kind"] == "authorize"]},
        {"kind": "accept", "title": "验收", "items": [a for a in asks if a["kind"] == "accept"]},
        {"kind": "decide", "title": "拍板", "items": [a for a in asks if a["kind"] == "decide"]},
    ]
    return {
        "total": len(asks),
        "oldest_days": max((a["stalled_days"] for a in asks), default=0.0),
        "groups": groups,
        "flow": {"raised_7d": raised, "closed_7d": closed},
        "agent_side": agent_side,
    }
