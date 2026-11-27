import json
import os
import re
import subprocess
import sys
import tempfile

SEPARATORS = {";", "&&", "||", "|", "&", "(", ")", "\n", ";;", "|&"}
REDIRECTS = {">", ">>", ">|", "&>", "&>>", ">&"}
QUOTES = ("'", '"')
HEREDOC_START = re.compile(r"<<-?\s*(['\"]?)(\w+)\1")
OPERATORS = sorted({"<<<", "&>>", ">>", "&>", ">&", ">|", "&&", "||", ";;", "|&", "<<", "<", ">", "&", "|", ";", "(", ")", "\n"}, key=len, reverse=True)
GIT_WRITES = {"commit", "push", "apply", "am", "cherry-pick", "rebase", "revert"}
GIT_OPTIONS_WITH_A_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace"}
PATCHED_FILE = re.compile(r"^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$", re.M)
FILE_TOOLS = {"Edit": "file_path", "Write": "file_path", "MultiEdit": "file_path", "NotebookEdit": "notebook_path"}


def free_dirs():
    board = os.environ.get("NAWABAN_BOARD_DIR") or os.path.expanduser("~/.nawaban/board")
    return [os.path.realpath(d) for d in (board, tempfile.gettempdir(), "/tmp")]


def nearest_existing(path):
    while not os.path.exists(path) and os.path.dirname(path) != path:
        path = os.path.dirname(path)
    return path


def is_repository_file(path, cwd):
    real = os.path.realpath(os.path.join(cwd, os.path.expanduser(path)))
    if any(real == d or real.startswith(d + os.sep) for d in free_dirs()):
        return False
    anchor = nearest_existing(real)
    anchor = anchor if os.path.isdir(anchor) else os.path.dirname(anchor)
    top = subprocess.run(["git", "-C", anchor, "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    if top.returncode != 0:
        return False
    ignored = subprocess.run(["git", "-C", top.stdout.strip(), "check-ignore", "-q", real], capture_output=True)
    return ignored.returncode != 0


def closing_quote(s, i):
    if s[i] == "'":
        j = s.find("'", i + 1)
        return len(s) if j < 0 else j
    j = i + 1
    while j < len(s) and s[j] != '"':
        if s[j] == "\\":
            j += 2
        elif s.startswith("$(", j):
            j = closing_paren(s, j + 2)
        elif s[j] == "`":
            k = s.find("`", j + 1)
            j = len(s) if k < 0 else k + 1
        else:
            j += 1
    return min(j, len(s))


def closing_paren(s, j):
    depth = 1
    while j < len(s):
        if s[j] in QUOTES:
            j = closing_quote(s, j) + 1
            continue
        if s[j] == "\\":
            j += 2
            continue
        depth += {"(": 1, ")": -1}.get(s[j], 0)
        j += 1
        if depth == 0:
            return j
    return len(s)


def without_heredoc_bodies(command, quoted_only=False):
    lines, kept, i = command.split("\n"), [], 0
    while i < len(lines):
        kept.append(lines[i])
        for m in HEREDOC_START.finditer(lines[i]):
            if quoted_only and not m.group(1):
                continue
            end = next((j for j in range(i + 1, len(lines)) if lines[j].strip() == m.group(2)), None)
            if end is not None:
                i = end
        i += 1
    return "\n".join(kept)


def shell_tokens(command):
    s, i, word = without_heredoc_bodies(command).replace("\\\n", " "), 0, None
    while i < len(s):
        operator = next((op for op in OPERATORS if s.startswith(op, i)), None)
        if s[i] in QUOTES:
            j = closing_quote(s, i)
            word, i = (word or "") + s[i + 1:j], j + 1
        elif s[i] == "\\":
            word, i = (word or "") + s[i + 1:i + 2], i + 2
        elif s[i] == "#" and word is None:
            end = s.find("\n", i)
            i = len(s) if end < 0 else end
        elif s[i] in " \t\r" or operator:
            if word is not None:
                yield False, word
            word = None
            if operator:
                yield True, operator
            i += len(operator or " ")
        else:
            word, i = (word or "") + s[i], i + 1
    if word is not None:
        yield False, word


def simple_commands(command, cwd):
    words, targets, outer = [], [], []
    tokens = shell_tokens(command)
    for is_operator, token in tokens:
        if not is_operator:
            words.append(token)
            continue
        if token in REDIRECTS:
            target = next(tokens, (True, ""))[1]
            if target and not target.isdigit() and target != "-":
                targets.append(target)
            continue
        if token not in SEPARATORS:
            continue
        yield words, targets
        words, targets = [], []
        if token == "(":
            outer.append(cwd[0])
        elif token == ")" and outer:
            cwd[0] = outer.pop()
    yield words, targets


def without_prefixes(words):
    while words and (re.match(r"^\w+=", words[0]) or words[0] in ("env", "command", "sudo", "exec", "time")):
        words = words[1:]
    return words


def git_write(args, cwd):
    while args and args[0].startswith("-"):
        if args[0] == "-C" and len(args) > 1:
            cwd = os.path.join(cwd, args[1])
        args = args[2:] if args[0] in GIT_OPTIONS_WITH_A_VALUE else args[1:]
    return f"git {args[0]}" if args and args[0] in GIT_WRITES else None


def shell_write(command, start):
    cwd = [start]
    for words, targets in simple_commands(command, cwd):
        for target in targets:
            if target != "/dev/null" and is_repository_file(target, cwd[0]):
                return f"重定向写进 {target}"
        words = without_prefixes(words)
        if not words:
            continue
        name, args = os.path.basename(words[0]), words[1:]
        if name == "cd":
            cwd[0] = os.path.join(cwd[0], os.path.expanduser(args[0] if args else "~"))
            continue
        if name == "git" and git_write(args, cwd[0]):
            return git_write(args, cwd[0])
        if name == "apply_patch":
            patched = [p.strip() for p in PATCHED_FILE.findall(command)] or ["."]
            if any(is_repository_file(p, cwd[0]) for p in patched):
                return "apply_patch"
        in_place = name == "sed" and any(a == "--in-place" or re.match(r"^-[a-zA-Z]*i", a) for a in args)
        if in_place or name == "tee":
            for a in args:
                if not a.startswith("-") and (name == "tee" or os.path.isfile(os.path.join(cwd[0], a))) and is_repository_file(a, cwd[0]):
                    return f"{name} 写 {a}"
    return None


def repository_write(d):
    if d.get("agent_id"):
        return None
    tool, tool_input = d.get("tool_name", ""), d.get("tool_input") or {}
    cwd = d.get("cwd") or os.getcwd()
    if tool in FILE_TOOLS:
        path = tool_input.get(FILE_TOOLS[tool]) or ""
        return f"{tool} {path}" if path and is_repository_file(path, cwd) else None
    if tool == "apply_patch":
        command = tool_input.get("command", "")
        return next((f"apply_patch {p}" for p in PATCHED_FILE.findall(command) if is_repository_file(p.strip(), cwd)), None)
    if tool == "Bash":
        return shell_write(tool_input.get("command", ""), cwd)
    return None


if __name__ == "__main__":
    try:
        what = repository_write(json.load(sys.stdin))
    except Exception:
        what = None
    if what:
        print(what)
