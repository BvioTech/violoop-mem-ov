"""Exercise build-tool launchers without installing the engine or dependencies."""
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import environment, run


class BuildCommands(unittest.TestCase):
    def test_command_on_supplied_path_preserves_arguments_with_spaces(self):
        with tempfile.TemporaryDirectory(prefix='memory commands ') as directory:
            tool = Path(directory) / ('build probe.cmd' if os.name == 'nt' else 'build probe')
            if os.name == 'nt':
                tool.write_text('@echo off\necho first=%~1\necho second=%~2\n')
            else:
                tool.write_text('#!/bin/sh\nprintf "first=%s\\nsecond=%s\\n" "$1" "$2"\n')
                tool.chmod(0o755)
            env = environment()
            env['PATH'] = directory + os.pathsep + env['PATH']
            result = run('build probe', 'hello world', 'next', cwd=directory,
                         env=env, capture_output=True, text=True)
            self.assertEqual(result.stdout.splitlines(), ['first=hello world', 'second=next'])

    def test_npm_launcher_runs_without_a_shell(self):
        result = run('npm', '--version', capture_output=True, text=True)
        self.assertIsNotNone(re.fullmatch(r'\d+\.\d+\.\d+', result.stdout.strip()))


if __name__ == '__main__':
    unittest.main()
