"""Exercise build commands as real child processes, including Windows shims."""
from pathlib import Path
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from common import run


class BuildCommandTests(unittest.TestCase):
    def write_command(self, directory, name, *, exit_code=0):
        directory.mkdir(parents=True, exist_ok=True)
        command = directory / (name + '.cmd' if os.name == 'nt' else name)
        if os.name == 'nt':
            command.write_text(f'@echo off\necho %~1\nexit /b {exit_code}\n')
        else:
            command.write_text(f'#!/bin/sh\nprintf "%s\\n" "$1"\nexit {exit_code}\n')
            command.chmod(0o755)
        return command

    def test_command_uses_child_path_and_preserves_spaced_arguments(self):
        with tempfile.TemporaryDirectory(prefix='violoop build tools ') as temp:
            root = Path(temp)
            self.write_command(root / 'parent', 'violoop-build-probe', exit_code=23)
            self.write_command(root / 'child tools', 'violoop-build-probe')
            child_env = dict(os.environ, PATH=str(root / 'child tools'))
            with patch.dict(os.environ, PATH=str(root / 'parent')):
                result = run('violoop-build-probe', 'argument with spaces',
                             env=child_env, capture_output=True, text=True)
            self.assertEqual(result.stdout.strip(), 'argument with spaces')

    def test_explicit_executable_and_path_arguments(self):
        argument = Path('directory with spaces') / 'input.txt'
        result = run(Path(sys.executable), '-c', 'import sys; print(sys.argv[1])',
                     argument, env=None, capture_output=True, text=True)
        self.assertEqual(result.stdout.strip(), str(argument))

    def test_command_failure_preserves_exit_code(self):
        with tempfile.TemporaryDirectory(prefix='violoop build tools ') as temp:
            self.write_command(Path(temp), 'violoop-build-failure', exit_code=17)
            with self.assertRaises(subprocess.CalledProcessError) as error:
                run('violoop-build-failure', 'failed',
                    env=dict(os.environ, PATH=temp), capture_output=True, text=True)
            self.assertEqual(error.exception.returncode, 17)

    def test_missing_command_still_raises_file_not_found(self):
        with self.assertRaises(FileNotFoundError):
            run('violoop-no-such-build-command', capture_output=True, text=True)


if __name__ == '__main__':
    unittest.main()
