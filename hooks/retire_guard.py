import datetime as dt
import json
import os
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path

BOARD_CLI = Path(__file__).resolve().parent.parent / "board" / "src" / "cli.ts"
HC_TIMEOUT_SECONDS = 5
BOARD_TIMEOUT_SECONDS = 10
CHECKS_START_WITHIN_SECONDS = 15
COMMAND_SEPARATORS = ";&|()<>\n"
ASSIGNMENT = re.compile(r"\w+=")
WORDS_BEFORE_A_COMMAND = {"then", "do", "else", "elif", "if", "while", "until", "!", "time", "exec", "command", "{"}


def retiring_terminals(command: str) -> list[str]:
    lex = shlex.shlex(command.replace("\\\n", " "), posix=True, punctuation_chars=COMMAND_SEPARATORS)
    lex.whitespace, lex.whitespace_split = " \t\r", True
    try:
        tokens = list(lex)
    except ValueError:
        return []
    named, start = [], 0
    for i, tok in enumerate(tokens + [";"]):
        if set(tok) <= set(COMMAND_SEPARATORS):
            words = tokens[start:i]
            while words and (ASSIGNMENT.match(words[0]) or words[0] in WORDS_BEFORE_A_COMMAND):
                words.pop(0)
            if words[:1] == ["hc"] and words[1:2] in (["kill"], ["rm"]):
                named += [w for w in words[2:] if not w.startswith("-") and not re.search(r"[$`*]", w)]
            start = i + 1
    return named


def address_of(terminal: str) -> str | None:
    try:
        r = subprocess.run(["hc", "get", terminal, "--json"], capture_output=True, text=True, timeout=HC_TIMEOUT_SECONDS)
        term = json.loads(r.stdout) if r.returncode == 0 else None
    except (ValueError, OSError, subprocess.SubprocessError):
        return None
    return term.get("address") if isinstance(term, dict) else None


def claims_held_on_the_board() -> list[dict]:
    r = subprocess.run(["node", str(BOARD_CLI), "list", "--json"], capture_output=True, text=True, timeout=BOARD_TIMEOUT_SECONDS)
    if r.returncode != 0:
        raise RuntimeError(f"板读不到:{r.stderr.strip()}")
    now = dt.datetime.now(dt.timezone.utc)
    return [t for t in json.loads(r.stdout)["tasks"]
            if t["task"].get("state") == "claimed"
            and dt.datetime.fromisoformat(t["task"]["claim"]["until"].replace("Z", "+00:00")) > now]


def refusal_text(held: list[tuple[str, str]]) -> str:
    return "\n".join([f"终端 {addr} 还拿着 {key}(开着、在它名下)" for addr, key in held] + [
        "收 worker 前,票要么关、要么交还,由 worker 自己做(hc send <终端> 让它做):",
        "  做完:nawaban event <ID> link \"pr:<url>\" 后 nawaban close <ID> --done",
        "  没做完:nawaban event <ID> note \"已完成：… / 下一步：… / 卡点：…\" 后 nawaban claim <ID> --release",
        "worker 已不动了:等它的认领租约过期(最多 1h)再收。",
    ])


def main() -> int:
    command = (json.load(sys.stdin).get("tool_input") or {}).get("command", "")
    started = time.monotonic()
    addresses, unread = [], []
    for t in retiring_terminals(command):
        if time.monotonic() - started > CHECKS_START_WITHIN_SECONDS:
            unread.append(f"{t}:来不及查")
        elif addr := address_of(t):
            addresses.append(addr)
    held = []
    if addresses:
        try:
            claims = claims_held_on_the_board()
            held = [(a, t["labels"].get("key") or f"#{t['id']}") for a in addresses for t in claims if t["labels"].get("terminal") == a]
        except (RuntimeError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as e:
            unread += [f"{a}:{e}" for a in addresses]
    if held:
        print(refusal_text(held), file=sys.stderr)
        return 2
    if unread:
        print(json.dumps({"systemMessage": f"没查清终端名下的票,放行(只凭确证才拦):{'; '.join(unread)}"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
