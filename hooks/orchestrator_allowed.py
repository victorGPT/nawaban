import json
import os
import sys

import re

from repo_write import REDIRECTS, SEPARATORS, closing_paren, free_dirs, heredoc_openers, shell_tokens, without_heredoc_bodies, without_prefixes

ORCHESTRATION_PROGRAMS = {"nawaban", "hc", "cd", "echo", "printf", "true", "sleep"}
STDIN_FILTER_FLAGS_AND_VALUED_FLAGS = {
    "cat": ("", ""),
    "head": ("0123456789", "nc"),
    "tail": ("0123456789", "nc"),
    "wc": ("lcwm", ""),
    "sort": ("nru", "kt"),
    "uniq": ("cdu", ""),
    "grep": ("ivEFcnowxqh", "ABCm"),
    "jq": ("rcejSsn", ""),
}
STDIN_FILTERS_WITH_AN_EXPRESSION = {"jq", "grep"}
GH_ORCHESTRATION = {("issue", "view"), ("issue", "list"), ("pr", "view"), ("pr", "list"), ("pr", "checks"), ("pr", "merge"),
                     ("issue", "comment"), ("auth", "token")}
GIT_ORCHESTRATION = {("pull", "--ff-only"), ("worktree", "list"), ("worktree", "remove"), ("worktree", "prune"), ("fetch",)}
ORCHESTRATION_SCRIPTS = {"node": ("hooks/route.mjs", "board/src/cli.ts"), "python3": ("nawaban/cli.py",), "sh": ("herdr/install-mod.sh",)}
MERGE_SCRIPT = "scripts/merge.sh"
GIT_READS = {"log", "status"}
GIT_STATUS_OPTIONS = re.compile(r"^(-s|-b|-sb|-bs|--short|--branch|--porcelain(=v\d)?|--long|-u(no|normal|all)?|--untracked-files(=.*)?|--ahead-behind|--no-ahead-behind)$")
GIT_LOG_METADATA_OPTIONS = re.compile(r"^(-\d+|-n|--oneline|--stat|--shortstat|--name-only|--name-status|--graph|--all|--no-merges|--merges|--first-parent|--reverse|--decorate(=.*)?|--no-decorate|--abbrev-commit|--no-color|--(format|pretty|max-count|since|until|after|before|author|committer|grep|date|branches|tags|remotes)=.*)$")
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


def unquoted_heredoc_bodies(command):
    lines, i = command.split("\n"), 0
    while i < len(lines):
        for quoted, delimiter in heredoc_openers(lines[i]):
            end = next((j for j in range(i + 1, len(lines)) if lines[j].strip() == delimiter), len(lines))
            if not quoted:
                yield "\n".join(lines[i + 1:end])
            i = end
        i += 1


def substitutions(command):
    yield from substitutions_in(without_heredoc_bodies(command), shell_quoting=True)
    for body in unquoted_heredoc_bodies(command):
        yield from substitutions_in(body, shell_quoting=False)


def substitutions_in(s, shell_quoting):
    i, in_double = 0, False
    while i < len(s):
        if shell_quoting and s[i] == "#" and not in_double and (i == 0 or s[i - 1] in " \t\n;&|("):
            j = s.find("\n", i)
            i = len(s) if j < 0 else j
        elif shell_quoting and s[i] == "'" and not in_double:
            j = s.find("'", i + 1)
            i = len(s) if j < 0 else j + 1
        elif s[i] == "\\":
            i += 2
        elif shell_quoting and s[i] == '"':
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


def git_reads_metadata(args):
    while args and args[0].startswith("-"):
        args = args[2:] if args[0] in GIT_OPTIONS_WITH_A_VALUE else args[1:]
    if any(tuple(args[:len(rule)]) == rule for rule in GIT_ORCHESTRATION):
        return True
    if not args or args[0] not in GIT_READS:
        return False
    if args[0] == "status":
        return all(GIT_STATUS_OPTIONS.match(a) for a in args[1:] if a.startswith("-"))
    log_args = args[1:]
    for k, a in enumerate(log_args):
        if a == "--":
            return True
        if a.startswith("-") and not GIT_LOG_METADATA_OPTIONS.match(a) and not (k and log_args[k - 1] == "-n"):
            return False
    return True


def program_allowed(words):
    words = without_prefixes(words)
    if not words:
        return True
    name, args = os.path.basename(words[0]), words[1:]
    if name in ORCHESTRATION_PROGRAMS:
        return True
    if name == "gh":
        while args[:1] and args[0] in ("-R", "--repo"):
            args = args[2:]
        args = args[1:] if args[:1] and args[0].startswith("--repo=") else args
        return tuple(args[:2]) in GH_ORCHESTRATION
    if name in ORCHESTRATION_SCRIPTS:
        return bool(args) and args[0].endswith(ORCHESTRATION_SCRIPTS[name])
    if words[0].endswith(MERGE_SCRIPT):
        return True
    if name == "git":
        return git_reads_metadata(args)
    if name in STDIN_FILTER_FLAGS_AND_VALUED_FLAGS:
        return reads_only_stdin(name, args)
    return False


def shell_refusal(command):
    for inner in substitutions(command):
        refused = shell_refusal(inner)
        if refused:
            return refused
    words, redirect = [], None
    for is_operator, token in list(shell_tokens(command)) + [(True, ";")]:
        if not is_operator:
            if redirect == "<" and token != "/dev/null":
                return f"< {token}"
            if redirect is None:
                words.append(token)
            redirect = None
            continue
        if token in REDIRECTS | {"<", "<<", "<<-", "<<<"}:
            if words and words[-1].isdigit() and words[-1].glued_to_an_operator:
                words.pop()
            redirect = token
            continue
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
