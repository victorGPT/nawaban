#!/usr/bin/env python3
"""NAWABAN 政策层 CLI:10 动词 + backup。

身份铁律:owner/session 只从环境解析(FOREMAN_OWNER / CLAUDE_CODE_SESSION_ID),
任何子命令不设 --owner/--session 旗标——身份不可伪造(Hermes author-from-runtime 平移)。

字段合同(2026-09-07 用户拍板 · 唯一定义处 · 每种内容只有一个家):
  title        做完后人能看见什么变化。板 UI 不渲染 ID 前缀,title 必须自立。
               技术名词只有当它就是用户面对的东西时才许出现(写侧闸 _title_gate)。
  origin       为什么做 + 做什么(触发事件 · 证据 · 拍板来源 · 票正文,长 spec 也行)。
               write-once:来由变了就是另一张卡。进度别塞这里。
  now          此刻到哪了 / 下一步(≤200)。唯一随时间变的字段:start 必填,event --now 随时刷。
  success      凭什么说做完了。每条一个 PM 能读、能抽查的观察(写侧闸 _success_gate);
               只能经 decide --set-success 改(改验收口径是决策不是清理)。
  constraints  不许做什么 / 范围边界。不是排期,不是施工步骤。
  touches / epic / adr  机器与归组用。
  排期 · 协调 · 占用状态 → event,不属于任何字段。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from nawaban import board_view, db  # noqa: E402

# ── 提问的写侧闸(NAWABAN-INBOX-RAISE-001)──────────────────────────────
# 材料闸必须在**写侧**:在读侧筛掉「没材料的卡」是事后惩罚人 —— 卡已经堵在队列里了,
# 筛掉只是让人看不见它。这里让 agent 一开始就提不出没材料的问题。
#
# accept 的判据直接引仓库 verification-close 规则:要**读侧正向证据**。
# 「PR 已合并」「CI 绿」是写侧信号 —— 写侧 2xx 与实际效果之间那条缝里住着一整族 bug。
_WRITE_SIDE = ("已合并", "已合入", "已 merge", "merged", "ci 绿", "ci 全绿", "全绿",
               "测试通过", "单测通过", "pytest", "已部署", "已上线")
_READ_SIDE = ("真机", "实测", "逐条对照", "日志", "loki", "grafana", "run ", "http",
              "查出", "正向证据", "复现", "观测", "抽样", "截图", "真人", "端到端")


def _ask_gate(a) -> str | None:
    """三类各自的必填。返回错误消息(说清怎么改才能过)或 None。"""
    ev = (a.evidence or "").strip()
    if a.kind == "accept":
        low = ev.lower()
        if any(w in low for w in _WRITE_SIDE) and not any(r in low for r in _READ_SIDE):
            return ("accept 的 evidence 只有写侧信号(PR 已合并 / CI 绿 / 测试通过)。\n"
                    "  写侧 2xx 不等于实际效果 —— 要读侧正向证据:真机操作记录、日志查询、\n"
                    "  run URL、逐条对照 success 的账本。补一条再提。")
    if a.kind == "authorize":
        if not a.blast:
            return ('authorize 必须带 --blast "谁受影响|改什么|怎么回滚" —— '
                    "放行一个动作而说不清影响面,人没法判断。")
        if len(a.blast.split("|")) != 3:
            return f'--blast 要三段(谁受影响|改什么|怎么回滚),收到 {len(a.blast.split("|"))} 段'
    if a.kind == "decide":
        if len(a.option) < 2:
            return ('decide 必须带 ≥2 个 --option "选项|后果" —— '
                    "只有一个选项那不是分叉;一个都没有那是在让人替你想方案。")
        for o in a.option:
            if "|" not in o or not o.split("|", 1)[1].strip():
                return f'--option "{o}" 缺后果。格式:"选项|这么选会怎样"'
    return None


# ── 标题的写侧闸(2026-09-07 · PM 看板看不懂卡是干嘛的)──────────────────
# 模块 docstring 的「做完后人能看见什么变化」写了几个月没人执行:150 张活跃卡全是
# 工程师给自己看的诊断 —— 症状 + 原因 + 交付塞进 80 字。语义判不了,判代码味:
# 代码味的东西(标识符 / 路径 / flag 名 / 多段分句)都该去 origin / success。
_TITLE_CODE_SMELL: tuple[tuple[str, str], ...] = (
    (r"`", "反引号"),
    (r"\b[a-z][a-z0-9]*_[a-z0-9_]+\b", "snake_case 标识符"),
    (r"\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b", "全大写 flag / env 名"),
    (r"\b\w+\.(py|md|yml|yaml|ts|tsx|sh|json)\b", "文件名"),
    (r"/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", "路径"),  # ASCII 限定:「姓名/部门/岗位」不是路径
)
_TITLE_EXAMPLES = (
    "  ✗ keyword-lists 七个端点零判权 · 靠 nginx 不路由挡着 · 前端功能因此在线上 404\n"
    "  ✓ 关键词表页面在线上能打开,且只有有权限的人能改\n"
    "  ✗ platform_owner 权限包从「算出来」改成「写下来」· 焊死静默提权通道\n"
    "  ✓ 平台管理员的权限改成明文清单,不会被悄悄扩权\n"
    "  ✗ 删掉 m2 判权缓存 —— 六个模块十一个调用点,清的是一个没人往里写的空 dict\n"
    "  ✓ 清掉一段没用的权限缓存代码(用户无感)")


def _smell(text: str, rules=_TITLE_CODE_SMELL) -> list[str]:
    return [why for pat, why in rules if re.search(pat, text)]


def _title_gate(title: str) -> str | None:
    """返回错误消息(说清怎么改才能过)或 None。只判形式,不判语义。"""
    hits = _smell(title)
    seps = len(re.findall(r" · |——| / ", title))
    if seps >= 2:
        hits.append(f"{seps} 处分句(· / —— / /)= 症状+原因+交付塞一句")
    if not hits:
        return None
    return ("title 要让非技术人一眼知道这张卡做完后能看见什么变化。查到:"
            + " · ".join(hits) + "\n  原因 / 调用点 / flag 名 / 路径 → 写进 --origin;"
            "交付细节 → --success。示范:\n" + _TITLE_EXAMPLES)


# 正则只判形式;语义交给 TypeSafe Noul,**只提醒不拦**(2026-09-17 eval:65 对 retitle 前后标题,
# 正则 → Noul<0.2 准确率 0.82 vs 纯正则 0.70,但误拦 14/65 好标题 —— 硬拦会逼人反复改标题)。
# 无 key / 网络失败 = 不提示;形式闸仍是硬闸,语义这层可有可无。
_TITLE_HINT_THRESHOLD = 0.2
_TITLE_HINT_Q = {
    "type": "noul",
    "instructions": "读到这个任务标题 `title` 的非技术产品经理,能否一眼看懂:这个任务做完后,用户或团队能看见什么变化?",
    "criteria": {
        "true": "标题用普通人的话描述做完后的可见结果,不需要懂代码、文件名、开关名或内部编号。",
        "false": "标题是工程师写给自己的诊断或实现步骤:含标识符、路径、内部编号,或把症状、原因、做法塞进一句。",
    },
}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # 3xx 直接失败:默认跟跳会把 Authorization 带到别的域


def _post(req: urllib.request.Request):
    # opener 在调用时建:模块级建会让 TLS 初始化失败搞挂整个 CLI import
    return urllib.request.build_opener(_NoRedirect).open(req, timeout=3)


_HINT_DEADLINE_S = 5


def _answers(state: dict, questions: dict) -> dict:
    """一次请求判多题,回原始 answers;无 key / 失败 / 超时 / 畸形 = {}。"""
    key = os.environ.get("TYPESAFE_API_KEY")
    if not key:
        return {}
    body = json.dumps({"state": state, "model": "jev-latest", "questions": questions}).encode()
    req = urllib.request.Request(
        "https://api.typesafe.ai/v1/systemone", data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        # socket timeout 只管单次读;滴灌响应靠总截止时间兜住(单次读 3s 内返回,总等待 ≤ 截止 + 3s)
        deadline, buf = time.monotonic() + _HINT_DEADLINE_S, b""
        with _post(req) as r:
            while chunk := r.read1(65536):
                buf += chunk
                if time.monotonic() > deadline or len(buf) > 1 << 20:
                    return {}
        answers = json.loads(buf)["answers"]
        return answers if isinstance(answers, dict) else {}
    except Exception:  # 外部 API 边界:提示可有可无,响应再怪也不能让已写库的命令报错
        return {}


def _prob(raw) -> float | None:
    if type(raw) not in (int, float):  # bool / 字符串 = 畸形响应(float(False) 会冒充 0 分)
        return None
    try:
        p = float(raw)
    except OverflowError:
        return None
    return p if 0 <= p <= 1 else None  # NaN / 越界 = 畸形响应


def _nouls(state: dict, questions: dict) -> dict[str, float]:
    """只回合法的分;缺席 = 不提示。"""
    out = {}
    for name, ans in _answers(state, questions).items():
        if name in questions and isinstance(ans, dict) and (p := _prob(ans.get("noul"))) is not None:
            out[name] = p
    return out


def _hints(title: str | None = None, success: list[str] | None = None) -> list[str]:
    success = [s for s in success or [] if isinstance(s, str)]
    state, qs = {}, {}
    if title is not None:
        state["title"], qs["pm_readable"] = title, _TITLE_HINT_Q
    if success:
        state["success"] = success
        qs.update({f"success_{i}": _success_q(i) for i in range(len(success))})
    if not qs:
        return []
    p = _nouls(state, qs)
    out = []
    if (t := p.get("pm_readable")) is not None and t < _TITLE_HINT_THRESHOLD:
        out.append(f"标题可能不是人话(语义判分 {t:.2f} < {_TITLE_HINT_THRESHOLD}):非技术人看不出做完后有什么变化。"
                   "\n  不拦;觉得不对就 nawaban retitle。示范:\n" + _TITLE_EXAMPLES)
    low = [(s, p[f"success_{i}"]) for i, s in enumerate(success)
           if p.get(f"success_{i}", 1) < _SUCCESS_HINT_THRESHOLD]
    if low:
        out.append(f"成功判据可能验收人读不懂或没法抽查(语义判分 < {_SUCCESS_HINT_THRESHOLD}):\n"
                   + "\n".join(f"  ✗ {s[:60]} ({v:.2f})" for s, v in low)
                   + "\n  不拦;觉得不对就 nawaban decide --set-success 改写成能看见、能核对的结果")
    return out


# success 用 title 的前三条:文件名 / 路径不拦 —— 「docs/integration/… 存在」是交付位置判据,
# 正当(2026-09-07 实测 573 条里 27 条只因此命中)。2a 拍板:success 给 PM 读,标识符去括号外的家。
_SUCCESS_CODE_SMELL = _TITLE_CODE_SMELL[:3]


def _success_gate(items: list[str] | None) -> str | None:
    bad = [(s, _smell(s, _SUCCESS_CODE_SMELL)) for s in (items or []) if _smell(s, _SUCCESS_CODE_SMELL)]
    if not bad:
        return None
    # 存量 105/144 张会命中(2026-09-07 实测),claim 时全列会训练人忽略 ⚠ → 只列前 3 条
    more = f"\n  …还有 {len(bad) - 3} 条" if len(bad) > 3 else ""
    return ("success 每条要让 PM 能读、能抽查(「面板切开关后真机能打开填表页」),不是实现 todo。查到:\n"
            + "\n".join(f"  ✗ {s[:60]} ← {' · '.join(w)}" for s, w in bad[:3]) + more
            + "\n  标识符 / flag 名 → 换成它对应的用户面现象;实现细节 → origin 或 event")


# 语义层同标题:只提醒不拦。2026-09-17 eval:40 条 success(30 差 10 好;33 号 PM 标,其余 39 条 Claude 代标,
# 衡量的是与同一判据下强模型读者的一致度,不是 PM 真值):正则 → Noul<0.2 准确率 0.95 vs 纯正则 0.75,
# 好判据误报 0/10(只有 10 个正例,区间很宽);0.25 起开始误报好判据。
_SUCCESS_HINT_THRESHOLD = 0.2


def _success_q(i: int) -> dict:
    return {
        "type": "noul",
        "instructions": f"验收人(非技术产品经理)读到成功判据 `success[{i}]`,能否看懂它要求的可观察结果,并自己去抽查是否达成?",
        "criteria": {
            "true": "用普通人的话描述做完后能看见、能核对的结果,不需要懂代码、表名、开关名或内部编号。",
            "false": "是工程师的实现步骤或内部检查:含标识符、表名、函数名、开关名,或只说改了什么、没说能观察到什么。",
        },
    }


# accept 证据的语义层:正则闸只认关键词(「uv run pytest」里的 run 就能骗过它),Choice 判证据属于哪类,只提醒不拦。
# 2026-09-17 eval:全部 52 条 accept ask(Claude 代标 35 有观测 / 14 仅写侧 / 3 基本没有,非 PM 判断):
# 存量全都过了正则闸(正则抓到 0/17);Choice 取最高概率抓到 12/17,有观测的误报 0/35;加概率差门槛不改善,故用 argmax。
_EVIDENCE_Q = {
    "type": "choice",
    "instructions": "这份验收证据 `evidence` 属于哪一类?",
    "criteria": {
        "observed": "含实际观测到的结果:真机操作、日志或数据查询、截图、逐条对照",
        "write_only": "只有写侧信号:PR 已合并、CI 绿、测试通过、或只贴链接/编号",
        "none": "基本没有证据:空泛描述或与交付无关",
    },
}
_EVIDENCE_HINT = {
    "write_only": "验收证据可能只有写侧信号(PR 已合并 / CI 绿 / 测试通过 / 只贴链接):验收人看不到实际效果。",
    "none": "验收证据可能基本是空的:验收人没法据此判断做没做到。",
}


def _evidence_hint(evidence: str) -> str | None:
    ans = _answers({"evidence": evidence}, {"evidence_kind": _EVIDENCE_Q}).get("evidence_kind")
    probs = ans.get("probabilities") if isinstance(ans, dict) else None
    if not isinstance(probs, dict) or set(probs) != set(_EVIDENCE_Q["criteria"]):
        return None
    ps = {k: _prob(v) for k, v in probs.items()}
    if None in ps.values():
        return None
    top = max(ps, key=ps.get)
    if top not in _EVIDENCE_HINT or list(ps.values()).count(ps[top]) > 1:  # 并列最高 = 没判出来,不提示
        return None
    return (_EVIDENCE_HINT[top] + f"(判分 {ps[top]:.2f})"
            "\n  不拦;补真机操作记录、日志查询、截图或逐条对照 success 的账本更稳。")


def _identity(*, need_session: bool) -> tuple[str, str | None]:
    sid = os.environ.get("CLAUDE_CODE_SESSION_ID")
    owner = os.environ.get("FOREMAN_OWNER") or (f"ac:{sid[:8]}" if sid else None)
    if owner is None or (need_session and not sid):
        raise db.NawabanError(
            "身份缺失:需 CLAUDE_CODE_SESSION_ID(或 FOREMAN_OWNER)env——身份只从环境来,不收参数")
    return owner, sid


def _j(s: str | None):
    return json.loads(s) if s else None


def _ago(ts: int | None) -> str:
    """相对年龄(Hermes 反陈旧呈现平移):绝对时间戳不会让人/模型去想「这还新鲜吗」。"""
    if not ts:
        return "?"
    d = max(0, int(time.time()) - ts)
    for unit, n in (("d", 86400), ("h", 3600), ("m", 60)):
        if d >= n:
            return f"{d // n}{unit} ago"
    return "刚刚"


def _print_kin(data: dict) -> None:
    blocks = []
    if data["blocked_by"]:
        lines = ["被挡", f"  真正卡在 {data['stuck_at']}"]
        for task in data["blocked_by"]:
            lines.append(f"  {'  ' * (task['depth'] - 1)}↳ {task['id']}"
                         f" [{task['status']}] {task['title']}")
        blocks.append("\n".join(lines))
    if data["unblocks"]:
        lines = ["放开"]
        for task in data["unblocks"]:
            waiting = (f" · 另有 {task['others_waiting']} 张还在等别人"
                       if task["others_waiting"] else "")
            lines.append(f"  {task['id']} [{task['status']}] {task['title']}{waiting}")
        blocks.append("\n".join(lines))
    lineage = data["lineage"]
    family = []
    if lineage["split_from"]:
        family.append(f"  拆自 {lineage['split_from']}")
    if lineage["split_out"]:
        family.append(f"  拆出 {', '.join(lineage['split_out'])}")
    if lineage["supersedes"]:
        family.append(f"  替代 {', '.join(lineage['supersedes'])}")
    if lineage["superseded_by"]:
        family.append(f"  被 {', '.join(lineage['superseded_by'])} 替代")
    if lineage["latest_decision"]:
        family.append(f"  最新决定 {lineage['latest_decision']}")
    if family:
        blocks.append("\n".join(["家谱", *family]))
    if data["epic"]:
        blocks.append(f"epic\n  {data['epic']}")
    if blocks:
        print("\n\n".join(blocks))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="nawaban", allow_abbrev=False,
                                 description="NAWABAN 本地 Agent Work OS · 写入工具环")
    ap.add_argument("--db", help="库路径(默认 NAWABAN_DB env → 就近 .nawaban/nawaban.db)")
    sub = ap.add_subparsers(dest="verb", required=True)

    p = sub.add_parser("create", help="建卡(title=人话:做完后人能看见什么变化)")
    p.add_argument("task_id")
    p.add_argument("--title", required=True)
    p.add_argument("--origin", help="票正文:What to build + 背景,用户视角(write-once;长文用 --origin-file)")
    p.add_argument("--origin-file", help="从文件读票正文(与 --origin 二选一)")
    p.add_argument("--success", help="JSON array")
    p.add_argument("--constraints", help="JSON array")
    p.add_argument("--touch", action="append", default=[])
    p.add_argument("--split-from", help="父卡号(自动挂 split_from 边并继承 epic)")
    for f in ("epic", "adr"):
        p.add_argument(f"--{f}")

    p = sub.add_parser("claim", help="CAS 认领(身份从环境;上游未 done 会被闸)")
    p.add_argument("task_id")
    p.add_argument("--override", help="强闯上游闸的理由(落 coord 事件可审计)")

    p = sub.add_parser("start", help="claimed→in_progress(--now 必填:开工即有板面进展)")
    p.add_argument("task_id")
    p.add_argument("--now", required=True, help="板上当前态一句 ≤200:到哪了 / 下一步")

    p = sub.add_parser("kin", help="看一张卡的阻塞、下游与家谱")
    p.add_argument("task_id")

    p = sub.add_parser("advance", help="状态转移(闸在库层)")
    p.add_argument("task_id")
    p.add_argument("--to", required=True,
                   choices=["staging-verified", "done", "in_progress"])
    p.add_argument("--waiting-on", choices=list(db.WAITING))

    p = sub.add_parser("reopen", help="打回终态的卡(done→in_progress · cancelled→open · 理由必填)")
    p.add_argument("task_id")
    p.add_argument("--reason", required=True, help="为什么打回:接手的人据此知道要改什么")

    p = sub.add_parser("cancel", help="作废前提已消失的卡(open→cancelled · 理由必填)")
    p.add_argument("task_id")
    p.add_argument("--reason", required=True,
                   help="为什么这活不做了:被谁取代 / 载体没了 / 用户否掉了")
    p.add_argument("--supersedes", help="真正接手这件事的卡号(可选 · 挂一条 supersedes 边)")

    p = sub.add_parser("event", help="记事件(note/coord/acceptance/verify)")
    p.add_argument("task_id")
    p.add_argument("--kind", default="note",
                   choices=["note", "coord", "acceptance", "verify"])
    p.add_argument("--body", required=True)
    p.add_argument("--now", help="顺手刷新板面当前态(≤200)· 不要求活 session")

    p = sub.add_parser("handoff", help="收尾三件套原子(sessions+事件+now)· 含保存闸")
    p.add_argument("task_id")
    p.add_argument("--outcome", required=True, choices=list(db.SESSION_OUTCOMES))
    p.add_argument("--summary", required=True, help="本次尝试一句收尾")
    p.add_argument("--now", required=True, help="板上当前态一句(≤200)· 三件套之一,必填")
    p.add_argument("--body", help="handoff 事件正文:done X · 剩 Y · 下一步 file:line(缺省=summary)")
    p.add_argument("--artifact", action="append", default=[],
                   help="声明产出文件(不存在→拒收尾;自动登记 refs)")
    p.add_argument("--release", action="store_true", help="收尾并释放 owner(供接力)")

    p = sub.add_parser("decide", help="决策落痕;success 只能经此改(--set-success)")
    p.add_argument("task_id")
    p.add_argument("--question", required=True)
    p.add_argument("--verdict", required=True)
    p.add_argument("--rejected", help='JSON [{"option":..,"reason":..}]')
    p.add_argument("--by", help="缺省 agent:<owner>;advisor;user 仅拍板通道可用")
    p.add_argument("--adr")
    p.add_argument("--supersedes", type=int, help="修订:新行指旧 decision id(append-only)")
    p.add_argument("--set-success", help="JSON array:原子替换 success(规则①)")

    p = sub.add_parser("retitle", help="改标题(过人话闸 · 旧标题留痕进 note)")
    p.add_argument("task_id")
    p.add_argument("--title", required=True)

    p = sub.add_parser("meta", help="补填 epic(只补空 · 带留痕)")
    p.add_argument("task_id")
    for f in db.META_FIELDS:
        p.add_argument(f"--set-{f}", dest=f"set_{f}")

    p = sub.add_parser("letter", help="写信(worker→总监汇报,NAWABAN-LETTERS-DB-001)")
    p.add_argument("task_id")
    p.add_argument("--kind", required=True, choices=list(db.LETTER_KINDS))
    p.add_argument("--msg", required=True)
    p.add_argument("--links")

    p = sub.add_parser("letters", help="列信(📩=未读)")
    p.add_argument("--unread", action="store_true")
    p.add_argument("--task")
    p.add_argument("--limit", type=int, default=50)

    p = sub.add_parser("letter-read", help="标已读")
    p.add_argument("ids", nargs="+", type=int)

    p = sub.add_parser("link", help="建边(幻觉闸+depends_on 环检测)")
    p.add_argument("src")
    p.add_argument("dst")
    p.add_argument("--kind", required=True, choices=list(db.EDGE_KINDS))
    p.add_argument("--note")

    p = sub.add_parser("ref", help="外部指针(pr/merge_sha/issue/commit/acceptance_run/artifact)")
    p.add_argument("task_id")
    p.add_argument("--kind", required=True, choices=list(db.REF_KINDS))
    p.add_argument("--value", required=True)
    p.add_argument("--note")

    p = sub.add_parser("scope", help="扩界:给卡追加 touches(append · 自动落 scope+ 留痕)")
    p.add_argument("task_id")
    p.add_argument("--add", action="append", required=True, help="要纳入的路径(可多次)")
    p.add_argument("--reason", required=True, help="为什么要扩(进留痕事件正文)")

    p = sub.add_parser("release",
                       help="收窄:从卡的 touches 摘掉路径(陈旧锁公开收窄协议 · 自动落 scope- 留痕)")
    p.add_argument("task_id")
    p.add_argument("--drop", action="append", required=True, help="要释放的路径(可多次)")
    p.add_argument("--reason", required=True, help="为什么能收窄(三条判据 · 进留痕事件正文)")

    p = sub.add_parser("ask", help="向人提一个待办动作(收件箱条目)· 没有材料提不出问题")
    p.add_argument("--kind", required=True, choices=list(db.ASK_KINDS))
    p.add_argument("--question", required=True, help="一句人话疑问句(≤120)· 不是任务标题")
    p.add_argument("--evidence", required=True,
                   help="材料。accept 要读侧正向证据(真机/日志/run URL);「PR 已合并」「CI 绿」是写侧信号,不算")
    p.add_argument("--task", action="append", required=True, dest="tasks",
                   help="挂哪张卡(可多次)· 一次人的决策覆盖多张卡就挂多张")
    p.add_argument("--option", action="append", default=[],
                   help='decide 必填 ≥2 项,格式 "选项|后果"')
    p.add_argument("--blast", help='authorize 必填,格式 "谁受影响|改什么|怎么回滚"')
    p.add_argument("--hands-on", action="store_true", help="accept:需要人亲自去操作验证")

    p = sub.add_parser("inbox", help="看收件箱(人侧唯一队列)")
    p.add_argument("--json", action="store_true")

    p = sub.add_parser("answer", help="回答一个 ask:写决策 + 关条目 + accept 类扇出")
    p.add_argument("ask_id", type=int)
    p.add_argument("--verdict", required=True, help="人的回答(会原样进 task_decisions)")
    p.add_argument("--reject", action="store_true", help="打回:卡退回 in_progress 返工")
    p.add_argument("--rejected", help='JSON [{"option":..,"reason":..}] · decide 的被否项')

    p = sub.add_parser(
        "fanout",
        help="授权类 ask 的扇出:动作**执行成功后**才调 —— 授权≠已生效")
    p.add_argument("ask_id", type=int)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--ok", action="store_true", help="动作成功:按 flag 分流关卡")
    g.add_argument("--failed", action="store_true", help="动作失败:一张都不关")

    sub.add_parser("wrapup", help="收尾清单:列出本 session 未收尾的卡 + 逐张给出补齐命令")
    sub.add_parser("backup", help="全量备份到 <db 目录>/backups/ · 保留 14 天")
    sub.add_parser("init", help="显式建库(唯一允许创建 DB 文件的动词)")

    a = ap.parse_args(argv)
    path = Path(a.db).expanduser() if a.db else db.resolve_db(for_init=a.verb == "init")
    if a.verb == "init":
        db.init_db(path)
        print(f"✓ init → {path}")
        return 0
    if not path.exists():
        # 不静默建库:路径错误时空库会让一切「看似成功」(空库备份永绿=错误的成功)
        print(f"✗ 库不存在:{path}(建新板用 nawaban init;路径错就修路径)", file=sys.stderr)
        return 1
    db.migrate_db(path)  # 幂等:退役列 DROP / 新表补建(FOREMAN-SIMPLIFY-003)

    try:
        if a.verb == "create":
            owner, sid = _identity(need_session=False)
            if a.origin and a.origin_file:
                raise db.NawabanError("--origin 与 --origin-file 二选一")
            origin = Path(a.origin_file).read_text(encoding="utf-8") if a.origin_file else a.origin
            if err := _title_gate(a.title) or _success_gate(_j(a.success)):
                raise db.NawabanError(err)
            db.create_task(path, task_id=a.task_id, title=a.title, origin=origin,
                           success=_j(a.success), constraints=_j(a.constraints),
                           touches=a.touch or None, epic=a.epic, adr=a.adr,
                           split_from=a.split_from)
            print(f"✓ create {a.task_id}")
            for hint in _hints(a.title, _j(a.success)):
                print("⚠ " + hint, file=sys.stderr)
        elif a.verb == "claim":
            owner, sid = _identity(need_session=True)
            if db.claim_task(path, a.task_id, owner=owner, session_id=sid,
                             override=a.override):
                print(f"✓ claim {a.task_id} → {owner}")
                # 占用只在这里看一次(FOREMAN-SIMPLIFY-004):WARN 不拒,guard 不再逐次 Edit 查
                touches = _j(db.task_touches(path, a.task_id)) or []
                if touches:
                    subprocess.run([sys.executable, str(Path(__file__).parent / "claim_check.py"),
                                    *touches, "--owner", owner, "--repo", str(path.parent.parent)])
                # 存量 success 错位(实现 todo 写成验收)只提醒不拦:谁 claim 谁顺手改(decide --set-success)
                if warn := _success_gate(_j(db.task_success(path, a.task_id))):
                    print("⚠ 本卡 " + warn.replace("\n", "\n  "), file=sys.stderr)
                _print_kin(db.kin(path, a.task_id))
            else:
                print(f"✗ claim 失败:{a.task_id} 已被占或不在 open 态", file=sys.stderr)
                return 1
        elif a.verb == "start":
            owner, sid = _identity(need_session=True)
            db.start_task(path, a.task_id, owner=owner, session_id=sid, now=a.now)
            print(f"✓ start {a.task_id}")
            _print_kin(db.kin(path, a.task_id))
        elif a.verb == "kin":
            _print_kin(db.kin(path, a.task_id))
        elif a.verb == "advance":
            owner, sid = _identity(need_session=True)
            db.advance_task(path, a.task_id, to=a.to, waiting_on=a.waiting_on,
                            owner=owner, session_id=sid)
            print(f"✓ advance {a.task_id} → {a.to}")
        elif a.verb == "reopen":
            owner, sid = _identity(need_session=True)
            db.reopen_task(path, a.task_id, reason=a.reason, owner=owner, session_id=sid)
            print(f"✓ reopen {a.task_id}")
        elif a.verb == "cancel":
            owner, sid = _identity(need_session=True)
            db.cancel_task(path, a.task_id, reason=a.reason, owner=owner, session_id=sid,
                           supersedes=a.supersedes)
            print(f"✓ cancel {a.task_id} → cancelled"
                  + (f"(由 {a.supersedes} 接手)" if a.supersedes else ""))
        elif a.verb == "event":
            owner, sid = _identity(need_session=False)
            db.add_event(path, a.task_id, kind=a.kind, body=a.body,
                         author=owner, session_id=sid, now=a.now)
            print(f"✓ event({a.kind}) {a.task_id}" + (" · now 已刷新" if a.now else ""))
        elif a.verb == "retitle":
            owner, sid = _identity(need_session=False)
            if err := _title_gate(a.title):
                raise db.NawabanError(err)
            old = db.retitle(path, a.task_id, title=a.title, author=owner, session_id=sid)
            print(f"✓ retitle {a.task_id}\n  旧:{old}\n  新:{a.title}")
            for hint in _hints(title=a.title):
                print("⚠ " + hint, file=sys.stderr)
        elif a.verb == "meta":
            owner, sid = _identity(need_session=False)
            db.set_meta(path, a.task_id,
                        fields={f: getattr(a, f"set_{f}") for f in db.META_FIELDS
                                if getattr(a, f"set_{f}", None)},
                        author=owner, session_id=sid)
            print(f"✓ meta {a.task_id}")
        elif a.verb == "letter":
            owner, sid = _identity(need_session=False)
            lid = db.add_letter(path, a.task_id, kind=a.kind, msg=a.msg,
                                links=a.links, session_id=sid)
            print(f"✓ letter #{lid} → {a.task_id} [{a.kind}]")
        elif a.verb == "letters":
            rows = db.list_letters(path, unread_only=a.unread, task_id=a.task,
                                   limit=a.limit)
            if not rows:
                print("(无信)")
            for r in rows:
                mark = "📩" if r["read_at"] is None else "  "
                ts = time.strftime("%m-%d %H:%M", time.localtime(r["created_at"]))
                print(f"{mark} #{r['id']} {ts} [{r['kind']}] {r['task_id']} · {r['msg'][:80]}")
        elif a.verb == "letter-read":
            n = db.mark_letters_read(path, a.ids)
            print(f"✓ 已读 {n} 封")
        elif a.verb == "handoff":
            owner, sid = _identity(need_session=True)
            db.handoff(path, a.task_id, owner=owner, session_id=sid,
                       outcome=a.outcome, summary=a.summary, now=a.now,
                       body=a.body, artifacts=a.artifact, release=a.release)
            print(f"✓ handoff {a.task_id}({a.outcome})" + (" · released" if a.release else ""))
        elif a.verb == "decide":
            owner, sid = _identity(need_session=False)
            if err := _success_gate(_j(a.set_success)):
                raise db.NawabanError(err)
            db.decide(path, a.task_id, question=a.question, verdict=a.verdict,
                      rejected=_j(a.rejected), decided_by=a.by or f"agent:{owner}",
                      adr=a.adr, supersedes=a.supersedes, set_success=_j(a.set_success))
            print(f"✓ decide {a.task_id}")
            for hint in _hints(success=_j(a.set_success)):
                print("⚠ " + hint, file=sys.stderr)
        elif a.verb == "link":
            owner, sid = _identity(need_session=False)
            db.link_tasks(path, a.src, a.dst, kind=a.kind, note=a.note, created_by=owner)
            print(f"✓ link {a.src} -{a.kind}→ {a.dst}")
        elif a.verb == "ref":
            db.add_ref(path, a.task_id, kind=a.kind, value=a.value, note=a.note)
            print(f"✓ ref({a.kind}) {a.task_id} → {a.value}")
        elif a.verb == "scope":
            owner, sid = _identity(need_session=False)
            merged = db.update_touches(path, a.task_id, add=a.add, reason=a.reason,
                                       owner=owner, session_id=sid)
            print(f"✓ scope+ {a.task_id}:touches 现 {len(merged)} 项(已落 coord 留痕)")
            for t in merged:
                print(f"    · {t}")
        elif a.verb == "release":
            owner, sid = _identity(need_session=False)
            rest = db.release_touches(path, a.task_id, drop=a.drop, reason=a.reason,
                                      owner=owner, session_id=sid)
            print(f"✓ scope- {a.task_id}:touches 现 {len(rest)} 项(已落 coord 留痕)")
            for t in rest:
                print(f"    · {t}")
        elif a.verb == "ask":
            owner, _ = _identity(need_session=False)
            bad = _ask_gate(a)
            if bad:
                print(f"✗ {bad}", file=sys.stderr)
                return 1
            opts = [{"option": o.split("|", 1)[0].strip(),
                     "consequence": o.split("|", 1)[1].strip()} for o in a.option] or None
            blast = None
            if a.blast:
                parts = [x.strip() for x in a.blast.split("|")]
                blast = {"who": parts[0], "what": parts[1], "rollback": parts[2]}
            aid = db.raise_ask(path, kind=a.kind, question=a.question, evidence=a.evidence,
                               task_ids=a.tasks, raised_by=owner, options=opts,
                               blast=blast, hands_on=a.hands_on)
            print(f"✓ ask #{aid} [{a.kind}] → 收件箱({len(a.tasks)} 张卡)")
            if a.kind == "accept" and (hint := _evidence_hint(a.evidence)):
                print("⚠ " + hint, file=sys.stderr)
        elif a.verb == "inbox":
            d = board_view.inbox_data(path)
            if a.json:
                print(json.dumps(d, ensure_ascii=False, indent=2))
                return 0
            flow = f"本周进 {d['flow']['raised_7d']} · 已清 {d['flow']['closed_7d']}"
            if not d["total"]:
                print(f"没有需要你决定的事({flow})")
                return 0
            print(f"{d['total']} 件事等你 · 最久 {d['oldest_days']} 天({flow})\n")
            for g in d["groups"]:
                if not g["items"]:
                    continue
                print(f"━━ {g['title']} · {len(g['items'])}")
                for x in g["items"]:
                    hands = "  [要你亲自点]" if x["hands_on"] else ""
                    c = x.get("confidence")
                    conf = f"  ~{int(c * 100)}%" if c is not None else ""
                    print(f"  #{x['id']}  {x['stalled_days']:>5.1f}d{conf}  {x['question']}{hands}")
                    if x.get("confidence_reason"):
                        print(f"        依据: {x['confidence_reason'][:70]}")
                    print(f"        挂 {len(x['task_ids'])} 张: {', '.join(x['task_ids'][:3])}"
                          f"{' …' if len(x['task_ids']) > 3 else ''}")
                print()
        elif a.verb == "answer":
            owner, sid = _identity(need_session=True)
            d = db.ask_detail(path, a.ask_id)
            if d["closed_at"]:
                # 并发:两个窗口同时答同一条,第二个拿明确报错而不是静默覆盖
                print(f"✗ ask #{a.ask_id} 已于早前关闭({d['closed_as']}),不可重复回答",
                      file=sys.stderr)
                return 1
            # 收件箱本身就是拍板通道 —— 人在这里点的,不是 agent 代填
            os.environ["NAWABAN_DECISION_CHANNEL"] = "inbox"
            for t in d["tasks"]:
                db.decide(path, t["id"], question=d["question"], verdict=a.verdict,
                          rejected=_j(a.rejected), decided_by="user")
            # 顺序要紧:先扇出再关 ask。反过来的话,advance 被库层闸拦住时
            # (如 done 闸② 的同秒自批检测)ask 已经关了、决策已经写了、卡却没关 ——
            # 一个不可重试的不一致状态。放这里,闸一拦就抛,ask 仍开着,人可以再答。
            moved = []
            if d["kind"] == "accept":
                # accept 的回答本身就是终态:验收通过 = 卡可以关
                for t in d["tasks"]:
                    to = "in_progress" if a.reject else "done"
                    db.advance_task(path, t["id"], to=to, owner=owner, session_id=sid)
                    moved.append(f"   {'↩ 打回' if a.reject else '✓ 归档'} {t['id']}")
            db.close_ask(path, a.ask_id, closed_as="answered", answer=a.verdict)
            print(f"✓ answer #{a.ask_id} · {len(d['tasks'])} 张卡各落一条决策")
            for line in moved:
                print(line)
            if d["kind"] != "accept":
                # authorize/decide:回答只是**授权**,动作还没发生。
                # 扇出必须钩在动作成功信号上,不是钩在这次点击上 —— 否则失败的部署
                # 会静默关掉一批卡(写侧信号当成实际效果,verification-close 第 ③ 类形状)。
                print(f"   {len(d['tasks'])} 张卡**未动**:授权≠已生效。")
                print(f"   动作成功后跑:nawaban fanout {a.ask_id} --ok"
                      f"   失败则:nawaban fanout {a.ask_id} --failed")
        elif a.verb == "fanout":
            owner, sid = _identity(need_session=True)
            d = db.ask_detail(path, a.ask_id)
            if not d["closed_at"]:
                print(f"✗ ask #{a.ask_id} 还没被回答,先 answer", file=sys.stderr)
                return 1
            if a.failed:
                print(f"✓ 记下动作失败 · {len(d['tasks'])} 张卡一张都不关")
                db.add_event(path, d["tasks"][0]["id"], kind="note", author=owner,
                             session_id=sid,
                             body=f"ask #{a.ask_id} 授权的动作执行失败 —— 扇出未发生,卡保持原状")
                return 0
            os.environ["NAWABAN_DECISION_CHANNEL"] = "inbox"
            closed = []
            for t in d["tasks"]:
                db.decide(path, t["id"], question=d["question"],
                          verdict=f"{d['answer']} · 动作已成功执行(fanout --ok)",
                          decided_by="user")
                db.advance_task(path, t["id"], to="done", owner=owner, session_id=sid)
                closed.append(t["id"])
            print(f"✓ fanout #{a.ask_id}:关 {len(closed)} 张")
        elif a.verb == "wrapup":
            owner, sid = _identity(need_session=True)
            rows = db.open_claim_rows(path, session_id=sid)
            if not rows:
                print(f"✓ 本 session({owner})无未收尾的卡")
                return 0
            print(f"本 session({owner})有 {len(rows)} 张卡未收尾:\n")
            for i, r in enumerate(rows, 1):
                print(f"[{i}] {r['id']} · {r['status']} · 认领 {_ago(r['started_at'])}"
                      f" · 本 session {r['events']} 条实质事件")
                print(f"    {r['title']}")
                print(f"    now 现值:{r['now'] or '(空)'}")
                print(f"    补齐:python3 {Path(__file__)} handoff {r['id']} \\\n"
                      f"            --outcome completed|handed_off|blocked \\\n"
                      f"            --summary \"本次一句收尾\" --now \"板上当前态一句(≤200)\"")
                print("            # 交接给别人再加 --release;有产出文件加 --artifact <路径>\n")
            print("三件套(sessions.outcome + handoff 事件 + now)缺一整笔拒;"
                  "--artifact 声明的文件不存在也拒(保存闸)。")
            return 0
        elif a.verb == "backup":
            dest = db.backup_db(path)
            print(f"✓ backup → {dest}")
    except db.NawabanError as e:
        print(f"✗ {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
