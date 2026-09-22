"""Run inherited script assertions and pytest suites in isolated environments."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[1]
scripts = sorted((root / "tests/upstream").glob("test_*.py"))
commands = [(p.name, [sys.executable, str(p)]) for p in scripts]
commands.append(("pytest", [sys.executable, "-m", "pytest", "-q", "tests",
                            "--ignore=tests/upstream", "--ignore=tests/test_upstream_scripts.py"]))
failed = []
skipped = []
for name, command in commands:
    if name == "test_workos_import.py" and importlib.util.find_spec("yaml") is None:
        skipped.append(name)
        print(f"SKIP {name}: historical Markdown import requires optional PyYAML", flush=True)
        continue
    with tempfile.TemporaryDirectory(prefix="nawaban-test-") as home:
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("NAWABAN_", "WORKOS_", "TYPESAFE_", "FOREMAN_"))
               and not k.endswith(("_API_KEY", "_API_TOKEN"))
               and k not in {"GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN",
                             "GITHUB_ENTERPRISE_TOKEN", "TMUX", "TMUX_PANE",
                             "NAWABAN_OWNER"}}
        env.update(HOME=home, NAWABAN_STATE_DIR=str(Path(home) / "state"),
                   XDG_CONFIG_HOME=str(Path(home) / "config"),
                   XDG_CACHE_HOME=str(Path(home) / "cache"),
                   FOREMAN_OWNER="ac:selftest", CLAUDE_CODE_SESSION_ID="selftest-session",
                   PYTHONPATH=str(root), GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                   PATH=str(Path(sys.executable).parent) + os.pathsep + os.environ["PATH"])
        working_directory = root if name == "pytest" else Path(home)
        result = subprocess.run(command, cwd=working_directory, env=env, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                timeout=180, check=False)
        print(f'{"FAIL" if result.returncode else "PASS"} {name}', flush=True)
        if result.returncode:
            failed.append(name)
            print(result.stdout, flush=True)
        elif name == "pytest" or "SKIP:" in result.stdout:
            print(result.stdout, flush=True)
print(f"{len(commands) - len(failed) - len(skipped)} passed, {len(failed)} failed, {len(skipped)} skipped")
raise SystemExit(bool(failed))
