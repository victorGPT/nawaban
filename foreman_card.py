#!/usr/bin/env python3
"""foreman 卡片解析 · 单一事实源(guard/sync/claim_check/session_start/stale_check/lint 共用)。

FOREMAN-MULTIUSER-PARSE-001(2026-07-27):此前 5 个脚本各带一份手撸正则解析器,语义各异
(guard 剥「≥2空格+#」注释 · sync 直接 split("#") · claim_check 不剥),且全部 fail-open——
解析不出 = 卡静默失去保护(真机实锤:PRESENCE-SHIFT-BREAK-RULE-001 声明了 3 条 touches,
正则读成空列表,看板显示"未声明"、guard 不设防)。安全前提「写入方=解析方=同一套工具」
在多人写卡后不成立 → 收敛到 yaml.safe_load + fail-closed(解析失败=显式报错,绝不静默跳过)。

原 guard「零依赖」决策(Edit 热路径不引 PyYAML)以实测退役:import yaml 5.8ms(2026-07-27
homebrew python3 + PyYAML 6.0.3)。

YAML 语义提醒:值里的「空格+#」是注释起点——`notes: PR #1909` 会截断成 "PR"。
issue/PR 引用要么写进 `pr:` 字段,要么给值加引号(foreman_lint 会拦)。
"""

from __future__ import annotations

import fnmatch
from pathlib import Path

import yaml

STATUS_ENUM = {"open", "claimed", "in_progress", "staging-verified", "done"}
LOCKED = {"claimed", "in_progress"}  # guard 防撞状态
CLAIM_BLOCKING = LOCKED | {"staging-verified"}  # claim_check 视为占用的状态
WAITING_ENUM = {"decision", "prod", "observe", "external"}


class CardError(Exception):
    """卡片不可机读(frontmatter 缺失/YAML 炸/结构非 mapping)· fail-closed 信号。"""


def split_document(text: str, suffix: str = ".md") -> tuple[str, str]:
    """返回 (frontmatter_raw, body)。.yaml/.yml 全文即 frontmatter、body 恒空。"""
    if suffix in (".yaml", ".yml"):
        return text, ""
    if not text.startswith("---"):
        raise CardError("无 frontmatter(文件需以 --- 开头)")
    end = text.find("\n---", 3)
    if end == -1:
        raise CardError("frontmatter 未闭合(缺结尾 ---)")
    return text[3:end], text[end + 4 :].lstrip("\n")


def parse_card_text(text: str, suffix: str = ".md") -> tuple[dict, str]:
    """解析卡片全文 → (frontmatter dict, body)。touches 归一为 list[str]。失败抛 CardError。"""
    raw, body = split_document(text, suffix)
    try:
        fm = yaml.safe_load(raw)
    except yaml.YAMLError as e:
        first = " ".join(str(e).split())[:140]
        raise CardError(f"YAML 解析失败:{first}") from e
    if not isinstance(fm, dict):
        raise CardError("frontmatter 不是键值 mapping")
    touches = fm.get("touches")
    if touches is None or touches == "":
        fm["touches"] = []
    elif isinstance(touches, list):
        fm["touches"] = [str(t).strip() for t in touches if str(t or "").strip()]
    else:
        raise CardError(f"touches 需为列表,得到 {type(touches).__name__}")
    return fm, body


def load_card(path: Path) -> tuple[dict, str]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        raise CardError(f"读文件失败:{e}") from e
    return parse_card_text(text, path.suffix)


def guard_problems(fm: dict) -> list[str]:
    """guard/claim_check 的安全最小校验——过不了 = 锁表不可信(fail-closed 拦)。
    完整卫生检查(验收字段/touches 空/重复 ID)在 foreman_lint,不在热路径。"""
    problems: list[str] = []
    if not str(fm.get("task_id") or "").strip():
        problems.append("task_id 缺失")
    status = str(fm.get("status") or "").strip()
    if status not in STATUS_ENUM:
        problems.append(f"status 非法『{status}』(须 ∈ {'/'.join(sorted(STATUS_ENUM))})")
    if status in CLAIM_BLOCKING and not str(fm.get("owner") or "").strip():
        problems.append(f"owner 缺失({status} 卡不许匿名)")
    return problems


def touches_match(target_rel: str, touch: str) -> bool:
    """touches 语义:目录尾 / = 前缀匹配 · 含 *? = fnmatch · 其余精确(或其子路径)。"""
    touch = touch.strip().lstrip("./")
    target_rel = target_rel.lstrip("./")
    if not touch:
        return False
    if "*" in touch or "?" in touch:
        return fnmatch.fnmatch(target_rel, touch)
    if touch.endswith("/"):
        return target_rel.startswith(touch)
    return target_rel == touch or target_rel.startswith(touch.rstrip("/") + "/")
