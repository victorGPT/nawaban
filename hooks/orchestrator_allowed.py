import json
import os
import sys

from repo_write import SEPARATORS, closing_paren, free_dirs, shell_tokens, without_heredoc_bodies, without_prefixes

ORCHESTRATION_PROGRAMS = {"nawaban", "hc", "cd", "echo", "printf", "true", "sleep"}
STDIN_FILTER_FLAGS_AND_VALUED_FLAGS = {
    "cat": ("", ""),
    "head": ("0123456789", "nc"),
    "tail": ("0123456789", "nc"),
    "wc": ("lcwm", ""),
    "sort": ("nru", "kt"),
    "uniq": ("cdu", ""),
    "grep": ("ivEFcnowxqh", "eABCm"),
    "jq": ("rcejSsn", ""),
}
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


def substitutions(command):
    s, i, in_double = without_heredoc_bodies(command, quoted_only=True), 0, False
    while i < len(s):
        if s[i] == "'" and not in_double:
            j = s.find("'", i + 1)
            i = len(s) if j < 0 else j + 1
        elif s[i] == "\\":
            i += 2
        elif s[i] == '"':
            in_double, i = not in_double, i + 1
        elif s.startswith("$(", i):
            end = closing_paren(s, i + 2)
            yield s[i + 2:end - 1]
            i = end
        elif s[i] == "`":
            j = s.find("`", i + 1)
            j = len(s) if j < 0 else j
            yield s[i + 1:j]
            i = j + 1
        else:
            i += 1


def reads_only_stdin(name, args):
    flags, valued = STDIN_FILTER_FLAGS_AND_VALUED_FLAGS[name]
    operands, value_next = [], False
    for a in args:
        if value_next:
            value_next = False
        elif a.startswith("--"):
            return False
        elif a.startswith("-") and len(a) > 1:
            for k, ch in enumerate(a[1:]):
                if ch in valued:
                    value_next = k == len(a) - 2
                    break
                if ch not in flags:
                    return False
        else:
            operands.append(a)
    return len(operands) <= (name in STDIN_FILTERS_WITH_AN_EXPRESSION)


def git_subcommand(args):
    while args and args[0].startswith("-"):
        args = args[2:] if args[0] in GIT_OPTIONS_WITH_A_VALUE else args[1:]
    return args[0] if args else None


def program_allowed(words):
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
    if name in STDIN_FILTER_FLAGS_AND_VALUED_FLAGS:
        return reads_only_stdin(name, args)
    return False


def shell_refusal(command):
    for inner in substitutions(command):
        refused = shell_refusal(inner)
        if refused:
            return refused
    words, heredoc_delimiter_next = [], False
    for is_operator, token in list(shell_tokens(command)) + [(True, ";")]:
        if not is_operator:
            if not heredoc_delimiter_next:
                words.append(token)
            heredoc_delimiter_next = False
            continue
        heredoc_delimiter_next = token == "<<"
        if token not in SEPARATORS:
            continue
        if not program_allowed(words):
            return " ".join(words)
        words = []
    return None


def refusal(d):
    if d.get("agent_id"):
        return None
    tool, tool_input = d.get("tool_name", ""), d.get("tool_input") or {}
    cwd = d.get("cwd") or os.getcwd()
    if tool == "Bash":
        return shell_refusal(tool_input.get("command", ""))
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
