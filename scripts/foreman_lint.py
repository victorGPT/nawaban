#!/usr/bin/env python3
"""foreman 卡片 lint · 多人写卡的格式守门(FOREMAN-MULTIUSER-PARSE-001)。

guard 的 fail-closed 只在 Edit 热路径拦「安全最小」问题;本脚本做完整卫生检查,
写卡后/被 guard 拦到时手跑,未来 tasks/ 进共享仓后挂 CI。

用法: python3 scripts/foreman_lint.py [--repo .]
- active 卡:可解析 + 安全最小校验 + per-status 卫生 → 违规=错误(exit 1)
- done 卡:仅要求可解析(历史不溯及卫生检查)→ 违规=警告
- 值含「空格+#数字」未加引号(YAML 当注释,PR/issue 引用被截断)= 错误
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nawaban.foreman_card import (  # noqa: E402
    WAITING_ENUM,
    CardError,
    guard_problems,
    load_card,
    split_document,
)

# 「空格 + #数字」在未引号的 YAML plain 标量里会被当注释截断(PR #1909 → "PR")。
# 模板对齐注释是「# 中文说明」,不撞此模式。已引号值与块标量(| / >)内部是字面量,安全。
_HASH_REF = re.compile(r"\s#\d")
_KEY_LINE = re.compile(r"^([A-Za-z_]\w*):\s*(.*)$")
_ITEM_LINE = re.compile(r"^(\s+-)\s+(.+)$")


def _truncation_risks(path: Path) -> list[str]:
    try:
        raw, _ = split_document(path.read_text(encoding="utf-8"), path.suffix)
    except (OSError, CardError):
        return []  # 解析层问题另报
    out = []
    block_indent: int | None = None  # 块标量所属 key 的缩进;更深缩进行 = 块内容,跳过
    for line in raw.splitlines():
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip())
        if block_indent is not None:
            if indent > block_indent:
                continue
            block_indent = None
        s = line.strip()
        if s.startswith("#"):
            continue  # 整行注释
        if m := _KEY_LINE.match(line):
            val = m.group(2).strip()
            if val.startswith(("|", ">")):
                block_indent = indent
                continue
        elif m := _ITEM_LINE.match(line):
            val = m.group(2).strip()
            if val.startswith(("|", ">")):  # 列表项块标量 `- |-`
                block_indent = indent
                continue
        else:
            val = s  # plain 多行标量的续行
        if val.startswith(('"', "'")):
            continue  # 已引号
        if _HASH_REF.search(val):
            out.append(f"『{s[:60]}』含「空格+#数字」——YAML 当注释截断,给值加引号/改块标量 |/用 pr: 字段")
    return out


def lint_card(path: Path, state: str) -> tuple[list[str], list[str], str]:
    """返回 (errors, warnings, task_id)。state ∈ active|done。"""
    errors: list[str] = []
    warnings: list[str] = []
    try:
        fm, _ = load_card(path)
    except CardError as e:
        if state == "active":
            errors.append(str(e))
        else:
            warnings.append(str(e))
        return errors, warnings, path.stem

    task_id = str(fm.get("task_id") or "") or path.stem
    if state == "done":
        return errors, warnings, task_id  # 归档卡不溯及卫生检查

    errors += guard_problems(fm)
    status = str(fm.get("status") or "").strip()
    if status == "done":
        errors.append("status=done 但卡在 active/(该 mv 进 done/)")
    if status == "staging-verified":
        if not str(fm.get("acceptance") or "").strip():
            errors.append("staging-verified 但 acceptance 空(验收闸契约)")
        if str(fm.get("waiting_on") or "").strip() not in WAITING_ENUM:
            errors.append(f"staging-verified 但 waiting_on 非法(须 ∈ {'/'.join(sorted(WAITING_ENUM))})")
    if status in ("claimed", "in_progress") and not fm.get("touches"):
        warnings.append("touches 空(无代码卡合法;有代码就是裸奔)")
    if task_id != path.stem:
        warnings.append(f"task_id『{task_id}』≠ 文件名『{path.stem}』")
    errors += _truncation_risks(path)
    return errors, warnings, task_id


# ── 注意力预算(WORKOS-INBOX-BUDGET-001)──────────────────────────────
# EEMUA 191 给操作员定的是硬数(平均<6 条/小时 · 峰值<10 条/10 分钟 · 期望响应<10 分钟)。
# 该抄的不是数值,是**「预算可以被违反、被检测、被修」**这个态度 —— 定性说「太多了」
# 永远修不掉,定量说「超了 3 条」才修得掉。
INBOX_WARN = 12   # 黄:开始拥堵
INBOX_FAIL = 20   # 红:失效

# 逃生口(不变量 IV):纯硬顶会饥饿 —— 队列满时被挡在门外的是新来的紧急问题,
# 堵住门的是没人理的旧问题,惩罚了提问的 agent,而该罚的是不回答的人。
# 故 authorize(放行类通常真的急)不计入硬顶,超限只对人报警,永不挡 agent 提问。
BUDGET_EXEMPT = ("authorize",)


def lint_inbox(repo: Path) -> tuple[list[str], list[str]]:
    """收件箱预算 + 归属不变量。返回 (errors, warnings)。库不在/表没建 → 静默跳过。"""
    from nawaban.db import board_db
    dbp = board_db(repo)
    if not dbp.exists():
        return [], []
    import sqlite3
    con = sqlite3.connect(f"file:{dbp}?mode=ro", uri=True)
    try:
        have = con.execute(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='asks'").fetchone()[0]
        if not have:
            return [], []
        rows = con.execute(
            "SELECT kind, raised_at FROM asks WHERE closed_at IS NULL").fetchall()
        # 干完了却没说在等谁的卡 = 永久静音的盲区。此刻实测为 0 张,但那是运气不是保证。
        orphan = con.execute(
            "SELECT count(*) FROM tasks WHERE status='staging-verified'"
            " AND waiting_on IS NULL").fetchone()[0]
    finally:
        con.close()

    errors: list[str] = []
    warnings: list[str] = []
    if orphan:
        errors.append(
            f"{orphan} 张卡 status=staging-verified 但 waiting_on 为空 —— "
            "干完了却没说在等谁,这类卡会掉进 agent 侧永久静音")

    counted = [r for r in rows if r[0] not in BUDGET_EXEMPT]
    if rows:
        import time
        oldest = max((time.time() - r[1]) / 86400 for r in rows)
        tail = (f";最旧一条停了 {oldest:.1f} 天 —— 该催的是回答的人,不是提问的 agent")
    else:
        tail = ""
    n, tot = len(counted), len(rows)
    if n > INBOX_FAIL:
        errors.append(f"收件箱 {tot} 条(计入预算 {n} 条)超硬顶 {INBOX_FAIL}{tail}")
    elif n > INBOX_WARN:
        warnings.append(f"收件箱 {tot} 条(计入预算 {n} 条)超警戒 {INBOX_WARN}{tail}")
    return errors, warnings


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    repo = Path(ap.parse_args().repo).resolve()
    tasks = repo / ".foreman" / "tasks"

    n_err = n_warn = n_cards = 0
    # 收件箱预算先查:它读 DB,与 md 卡目录在不在无关
    inbox_err, inbox_warn = lint_inbox(repo)
    for msg in inbox_err:
        print(f"❌ inbox: {msg}")
    for msg in inbox_warn:
        print(f"⚠️  inbox: {msg}")
    n_err += len(inbox_err)
    n_warn += len(inbox_warn)

    if not tasks.is_dir():
        print(f"(无 .foreman/tasks) {tasks.parent.parent}")
        return 1 if n_err else 0

    seen_ids: dict[str, str] = {}
    for state in ("active", "done"):
        for p in sorted(tasks.glob(f"*/{state}/*")):
            if p.suffix not in (".md", ".yaml", ".yml"):
                continue
            n_cards += 1
            errors, warnings, task_id = lint_card(p, state)
            rel = f"{p.parent.parent.name}/{state}/{p.name}"
            if task_id in seen_ids:
                errors.append(f"task_id 与 {seen_ids[task_id]} 重复(sync 会拒同步该 ID)")
            else:
                seen_ids[task_id] = rel
            for msg in errors:
                print(f"❌ {rel}: {msg}")
            for msg in warnings:
                print(f"⚠️  {rel}: {msg}")
            n_err += len(errors)
            n_warn += len(warnings)

    print(f"—— {n_cards} 张卡 · {n_err} 错误 · {n_warn} 警告")
    return 1 if n_err else 0


if __name__ == "__main__":
    sys.exit(main())
