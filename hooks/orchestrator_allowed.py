import json
import os
import sys

from repo_write import SEPARATORS, closing_paren, free_dirs, shell_tokens, without_prefixes

ORCHESTRATION_PROGRAMS = {"nawaban", "hc", "cd", "echo", "printf", "true", "sleep"}
STDIN_FILTERS = {"cat", "head", "tail", "wc", "sort", "uniq"}
STDIN_FILTERS_WITH_AN_EXPRESSION = {"jq", "grep"}
GH_READS = {("issue", "view"), ("issue", "list"), ("pr", "view"), ("pr", "list")}
GIT_READS = {"log", "status"}
GIT_OPTIONS_WITH_A_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace"}
INSTRUCTION_FILES = {"AGENTS.md", "CLAUDE.md"}
INSTRUCTION_DIR = os.sep + os.path.join("docs", "agents") + os.sep


def instruction_dirs():
    plugin_skills = os.path.join(os.path.dirname(os.path.dirname(os.path.realpath(__file__))), "skills")
    return free_dirs() + [os.path.realpath(os.path.expanduser("~/.claude")), plugin_skills]


def readable(path, cwd):
    real = os.path.realpath(os.path.join(cwd, os.path.expanduser(path)))
    if os.path.basename(real) in INSTRUCTION_FILES or INSTRUCTION_DIR in real + os.sep:
        return True
    return any(real == d or real.startswith(d + os.sep) for d in instruction_dirs())


def substitutions(word):
    i = word.find("$(")
    while i >= 0:
        end = closing_paren(word, i + 2)
        yield word[i + 2:end - 1]
        i = word.find("$(", end)
    parts = word.split("`")
    yield from parts[1:-1:2]


def git_subcommand(args):
    while args and args[0].startswith("-"):
        args = args[2:] if args[0] in GIT_OPTIONS_WITH_A_VALUE else args[1:]
    return args[0] if args else None


def program_allowed(words, cwd):
    words = without_prefixes(words)
    if not words:
        return True
    name, args = os.path.basename(words[0]), words[1:]
    if name in ORCHESTRATION_PROGRAMS:
        return True
    if name == "gh":
        return tuple(args[:2]) in GH_READS
    if name == "git":
        return git_subcommand(args) in GIT_READS
    if name in STDIN_FILTERS | STDIN_FILTERS_WITH_AN_EXPRESSION:
        operands = [a for a in args if not a.startswith("-")][name in STDIN_FILTERS_WITH_AN_EXPRESSION:]
        return not any(os.path.exists(os.path.join(cwd, os.path.expanduser(a))) for a in operands)
    return False


def shell_refusal(command, cwd):
    words = []
    for is_operator, token in list(shell_tokens(command)) + [(True, ";")]:
        if not is_operator:
            words.append(token)
            for inner in substitutions(token):
                refused = shell_refusal(inner, cwd)
                if refused:
                    return refused
            continue
        if token not in SEPARATORS:
            continue
        if not program_allowed(words, cwd):
            return " ".join(words)
        words = []
    return None


def refusal(d):
    if d.get("agent_id"):
        return None
    tool, tool_input = d.get("tool_name", ""), d.get("tool_input") or {}
    cwd = d.get("cwd") or os.getcwd()
    if tool == "Bash":
        return shell_refusal(tool_input.get("command", ""), cwd)
    if tool == "Read":
        path = tool_input.get("file_path") or ""
        return None if readable(path, cwd) else f"Read {path}"
    if tool in ("Grep", "Glob"):
        path = os.path.join(tool_input.get("path") or cwd, tool_input.get("pattern", "") if tool == "Glob" else "")
        return None if readable(path, cwd) else f"{tool} {tool_input.get('pattern', '')} {tool_input.get('path') or ''}".strip()
    return None


if __name__ == "__main__":
    try:
        what = refusal(json.load(sys.stdin))
    except Exception:
        what = None
    if what:
        print(what)
