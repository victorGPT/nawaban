"""Readability policy shared by task creation, retitling, decisions, and claims.

The two diagnostic functions are the public interface. They hide matching rules
and remediation text, leaving enforcement to the caller: new content is rejected,
while claiming legacy content only warns. Storage constraints remain in db.
Domain terms are defined in CONTEXT.md.
"""

from __future__ import annotations

import re

_TITLE_CODE_SMELL: tuple[tuple[str, str], ...] = (
    (r"`", "反引号"),
    (r"\b[a-z][a-z0-9]*_[a-z0-9_]+\b", "snake_case 标识符"),
    (r"\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b", "全大写 flag / env 名"),
    (r"\b\w+\.(py|md|yml|yaml|ts|tsx|sh|json)\b", "文件名"),
    (r"/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", "路径"),  # ASCII paths exclude domain labels such as 姓名/部门/岗位.
)
_TITLE_EXAMPLES = (
    "  ✗ reading_queue 接口返回错误 · 路由未连接 · 阅读页打不开\n"
    "  ✓ 阅读清单页面可以打开并保存书目")


def _smell(text: str, rules=_TITLE_CODE_SMELL) -> list[str]:
    return [why for pat, why in rules if re.search(pat, text)]


def title_problem(title: str) -> str | None:
    """Return an actionable title diagnostic, or None when its form is allowed.

    A title must stand alone because the board omits the task ID prefix.
    This checks readability heuristics, not meaning, length, or persistence.
    Callers may reject a new title without applying the policy to imported tasks.
    """
    hits = _smell(title)
    seps = len(re.findall(r" · |——| / ", title))
    if seps >= 2:
        hits.append(f"{seps} 处分句(· / —— / /)= 症状+原因+交付塞一句")
    if not hits:
        return None
    return ("title 要让非技术人一眼知道这张卡做完后能看见什么变化。查到:"
            + " · ".join(hits) + "\n  原因 / 调用点 / flag 名 / 路径 → 写进 --context;"
            "交付细节 → --success。示范:\n" + _TITLE_EXAMPLES)


# An acceptance criterion may identify a deliverable by path; code identifiers
# still obscure the observable outcome. Titles have the stricter policy.
_SUCCESS_CODE_SMELL = _TITLE_CODE_SMELL[:3]


def success_problem(items: list[str] | None) -> str | None:
    """Return a bounded acceptance-criteria diagnostic, or None if allowed.

    None and an empty list mean no criteria to check. Paths are legitimate
    deliverable locations here. Callers decide whether a finding blocks a write
    or only warns about existing content; this function never mutates criteria.
    """
    bad = [(s, _smell(s, _SUCCESS_CODE_SMELL)) for s in (items or []) if _smell(s, _SUCCESS_CODE_SMELL)]
    if not bad:
        return None
    # Keep legacy-card warnings usable even when many criteria need revision.
    more = f"\n  …还有 {len(bad) - 3} 条" if len(bad) > 3 else ""
    return ("success 每条要让 PM 能读、能抽查(「面板切开关后真机能打开填表页」),不是实现 todo。查到:\n"
            + "\n".join(f"  ✗ {s[:60]} ← {' · '.join(w)}" for s, w in bad[:3]) + more
            + "\n  标识符 / flag 名 → 换成它对应的用户面现象;实现细节 → context 或 event")


_ORIGIN_ITEM = re.compile(r"^\s*[-*]\s+\S")
_ORIGIN_EXAMPLE = ("  - **用户 2026-09-17**:用户原话或需求\n"
                   "  - **背景**:为什么做、原始依据\n"
                   "  - **范围**:做什么、不做什么")


def context_problem(context: str | None) -> str | None:
    """Return a diagnostic unless every nonblank context line is a bullet item.

    An absent or blank context is allowed. Indented bullets count as sub-items;
    a numbered list or a wrapped prose line does not.
    """
    if not context or not context.strip():
        return None
    bad = [ln.strip() for ln in context.splitlines()
           if ln.strip() and not _ORIGIN_ITEM.match(ln)]
    if not bad:
        return None
    return ("context 要写成无序列表,每行一个「- 」开头的要点。查到非列表行:"
            + f"「{bad[0][:40]}」" + (f" 等 {len(bad)} 行" if len(bad) > 1 else "")
            + "\n  示范:\n" + _ORIGIN_EXAMPLE)
