import json
import os
import re
import shlex
import subprocess
import sys
import tempfile

SHELL_OPERATORS = "();<>|&\n"
SEPARATORS = {";", "&&", "||", "|", "&", "(", ")", "\n", ";;", "|&"}
REDIRECTS = {">", ">>", ">|", "&>", "&>>"}
GIT_WRITES = {"commit", "push", "apply", "am", "cherry-pick", "rebase", "revert"}
GIT_OPTIONS_WITH_A_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace"}
HEREDOC_START = re.compile(r"<<-?\s*(['\"]?)(\w+)\1")
PATCHED_FILE = re.compile(r"^\*\*\* (?:Add|Update|Delete) File: (.+)$", re.M)
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


def without_heredoc_bodies(command):
    lines, kept, ends = command.split("\n"), [], []
    for line in lines:
        if ends:
            if line.strip() == ends[0]:
                ends.pop(0)
            continue
        kept.append(line)
        ends += [m.group(2) for m in HEREDOC_START.finditer(line)]
    return "\n".join(kept)


def simple_commands(command):
    lexer = shlex.shlex(without_heredoc_bodies(command).replace("\\\n", " "), posix=True, punctuation_chars=SHELL_OPERATORS)
    lexer.whitespace = " \t\r"
    lexer.commenters = ""
    words, targets = [], []
    tokens = iter(lexer)
    for token in tokens:
        if token in SEPARATORS:
            yield words, targets
            words, targets = [], []
        elif token in REDIRECTS:
            target = next(tokens, "")
            if not target.startswith("&"):
                targets.append(target)
        elif not token.startswith("<") and not token.startswith(">"):
            words.append(token)
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


def shell_write(command, cwd):
    for words, targets in simple_commands(command):
        for target in targets:
            if target != "/dev/null" and is_repository_file(target, cwd):
                return f"重定向写进 {target}"
        words = without_prefixes(words)
        if not words:
            continue
        name, args = os.path.basename(words[0]), words[1:]
        if name == "git" and git_write(args, cwd):
            return git_write(args, cwd)
        if name == "apply_patch" and is_repository_file(".", cwd):
            return "apply_patch"
        in_place = name == "sed" and any(a == "--in-place" or re.match(r"^-[a-zA-Z]*i", a) for a in args)
        if in_place or name == "tee":
            for a in args:
                if not a.startswith("-") and (name == "tee" or os.path.isfile(os.path.join(cwd, a))) and is_repository_file(a, cwd):
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
