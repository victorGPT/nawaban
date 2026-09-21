#!/usr/bin/env python3
"""Foreman 存活探测 · 问 herdr「这个 owner 的窗口还在吗」。

为什么(2026-08-06):foreman 的锁表里,**绝大多数持有者的窗口早就关了**——
实测一次:15 个 owner 持 60+ 张 active 卡,而 herdr 看到的活窗口里只有 1 个对得上。
撞锁时判断「对方是不是真在干活」过去只能靠启发式(翻卡 status、查 PR 合没合、
看工作区有没有未提交改动),每次都要人肉走一遍「陈旧锁公开收窄协议」。

herdr 原生捕获每个 pane 的 claude session id,而 foreman 的 owner 恰好就是
`ac:<full session-id>` (legacy eight-character aliases remain readable) —— 两边天然可对账。于是「对方还在不在」从**猜**变成**事实**。

⚠️ 这是一个**新增信号,不是自动决策**。窗口不在 ≠ 活已干完:人可能只是关了窗口,
而 WIP 还半路躺着。所以本模块只回答「窗口在不在」,收窄与否仍由既有协议判定
(卡 status + PR 状态 + 工作区改动),存活只是多给一条硬证据。

⚠️ **fail-soft 是硬要求**:herdr 没装 / 没跑 / 超时 / 输出变形 → 一律返回「未知」,
**绝不退化成「已死」**。误判「对方死了」会让人放心收窄一把真在用的锁,那是真撞车。
未知就是未知(接 no-fabrication)。
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from nawaban.owner_identity import owner_from_session, session_owners  # noqa: E402

_TIMEOUT_S = 3.0
_OWNER_PREFIX = "ac:"


@dataclass(frozen=True)
class LiveAgent:
    owner: str  # ac:<full session-id>
    session_id: str
    status: str  # herdr 的 agent_status:idle / busy / blocked …
    pane: str
    cwd: str


def _run_herdr() -> str | None:
    """跑 `herdr agent list` 拿原始 JSON · 任何不顺一律 None(调用方降级为未知)。"""
    if shutil.which("herdr") is None:
        return None
    try:
        p = subprocess.run(
            ["herdr", "agent", "list"],
            capture_output=True,
            text=True,
            timeout=_TIMEOUT_S,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    if p.returncode != 0 or not p.stdout.strip():
        return None
    return p.stdout


def live_agents() -> list[LiveAgent] | None:
    """herdr 当前看到的 claude 窗口 · None = 探测不可用(**不是**「没有窗口」)。"""
    raw = _run_herdr()
    if raw is None:
        return None
    try:
        payload = json.loads(raw)
        agents = payload["result"]["agents"]
    except (json.JSONDecodeError, KeyError, TypeError):
        return None  # 输出形状变了(herdr 是移动靶)→ 当探测不可用,别硬解

    out: list[LiveAgent] = []
    for a in agents:
        if not isinstance(a, dict):
            continue
        sid = str((a.get("agent_session") or {}).get("value") or "")
        if not sid:
            continue  # 没捕到 session id 的 pane 无法对账 · 跳过而不是瞎猜
        out.append(
            LiveAgent(
                owner=owner_from_session(sid),
                session_id=sid,
                status=str(a.get("agent_status") or "?"),
                pane=str(a.get("pane_id") or "?"),
                cwd=str(a.get("cwd") or "?"),
            )
        )
    return out


def owner_liveness() -> dict[str, LiveAgent] | None:
    """owner 标签 → 活着的窗口 · None = 探测不可用。"""
    agents = live_agents()
    if agents is None:
        return None
    return {owner: a for a in agents for owner in session_owners(a.session_id)}


def describe(owner: str, table: dict[str, LiveAgent] | None) -> str:
    """给撞锁提示用的一行存活说明 · 措辞刻意保守,不替人下收窄结论。"""
    if table is None:
        return "❔ 存活未知(herdr 不可用)"
    if not owner.startswith(_OWNER_PREFIX):
        # window-1 / grok / unassigned 这类不是 session 派生的 owner,对不上账
        return "❔ 存活未知(owner 非 session 派生)"
    hit = table.get(owner)
    if hit is not None:
        return f"🟢 窗口在({hit.pane} · {hit.status})—— 可能真在干活,别动"
    return "⚰️ 当前无活动窗口(herdr 未见)—— 疑似陈旧锁,仍需按协议核对卡状态与工作区"


def main() -> int:
    """独立跑:打印当前活着的窗口与 owner 对账表。"""
    agents = live_agents()
    if agents is None:
        print("❔ herdr 探测不可用(没装 / 没跑 / 超时 / 输出变形)· 存活一律记为未知")
        return 0
    if not agents:
        print("herdr 在跑,但没看到任何 claude 窗口")
        return 0
    print(f"herdr 看到 {len(agents)} 个 claude 窗口:")
    for a in sorted(agents, key=lambda x: x.pane):
        print(f"  {a.owner}  {a.status:<8} {a.pane:<8} {a.cwd}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
