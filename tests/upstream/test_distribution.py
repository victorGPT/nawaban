"""Exercise the installed command with a fresh task database."""
import os
import sys
import subprocess
import tempfile
import unittest
from pathlib import Path


class DistributionTest(unittest.TestCase):
    def test_installed_cli_lifecycle_and_identity(self):
        command = [sys.executable, str(Path(__file__).resolve().parents[2] / 'nawaban/cli.py')]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / '.nawaban/nawaban.db'
            env = dict(os.environ, NAWABAN_OWNER='ac:distribution',
                       CLAUDE_CODE_SESSION_ID='distribution-test')

            def run(*args, identity=True):
                current = dict(env)
                if not identity:
                    current.pop('NAWABAN_OWNER')
                    current.pop('CLAUDE_CODE_SESSION_ID')
                return subprocess.run([*command, '--db', str(path), *args],
                                      cwd=folder, env=current, capture_output=True, text=True, check=False)

            self.assertEqual(run('init').returncode, 0)
            self.assertEqual(run('create', 'SMOKE-001', '--title', 'A standalone task',
                                 '--body', '').returncode, 0)
            self.assertNotEqual(run('claim', 'SMOKE-001', identity=False).returncode, 0)
            self.assertEqual(run('claim', 'SMOKE-001').returncode, 0)
            shown = run('show', 'SMOKE-001').stdout
            self.assertIn('in_progress', shown)
            self.assertIn('窗口 distribution-test', shown)


if __name__ == '__main__':
    unittest.main()
