"""Generated reconciliation commands must keep the explicitly selected database."""
import shlex
import tempfile
import unittest
from pathlib import Path

from nawaban.recon_md_db import emit_approval


class ReconciliationTargetTest(unittest.TestCase):
    def test_emit_pins_database_with_spaces(self):
        with tempfile.TemporaryDirectory() as folder:
            selected = Path(folder) / 'a project/task data.db'
            output = Path(folder) / 'approval.sh'
            emit_approval([('T-001', 'in_progress', '')], output, selected)
            commands = [shlex.split(line.removesuffix(' \\')) for line in output.read_text().splitlines()
                        if ' --db ' in line]
            self.assertEqual(len(commands), 2)
            for command in commands:
                self.assertEqual(command[command.index('--db') + 1], str(selected.resolve()))
            self.assertNotIn('sample-project', output.read_text())


if __name__ == '__main__':
    unittest.main()
