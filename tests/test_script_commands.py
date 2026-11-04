"""Build helpers resolve Windows executable shims without enabling a shell."""
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from scripts import common


class ScriptCommandTests(unittest.TestCase):
    def test_windows_resolves_npm_cmd_using_the_child_path(self):
        env = {'PATH': r'C:\Build Tools\node'}
        executable = r'C:\Build Tools\node\npm.cmd'
        with patch.object(common, 'os', SimpleNamespace(name='nt')), \
                patch.object(common, 'environment', return_value={}), \
                patch.object(common.shutil, 'which', return_value=executable) as which, \
                patch.object(common.subprocess, 'run') as run:
            common.run('npm', 'ci', '--prefix', Path('a folder'), env=env, capture_output=True)
        which.assert_called_once_with('npm', path=env['PATH'])
        run.assert_called_once_with([executable, 'ci', '--prefix', str(Path('a folder'))],
                                    cwd=common.ROOT, env=env, check=True, capture_output=True)

    def test_missing_windows_command_preserves_subprocess_error_behavior(self):
        with patch.object(common, 'os', SimpleNamespace(name='nt')), \
                patch.object(common, 'environment', return_value={'PATH': ''}), \
                patch.object(common.shutil, 'which', return_value=None), \
                patch.object(common.subprocess, 'run', side_effect=FileNotFoundError):
            with self.assertRaises(FileNotFoundError):
                common.run('missing-build-command')

    def test_posix_arguments_are_unchanged(self):
        with patch.object(common, 'os', SimpleNamespace(name='posix')), \
                patch.object(common, 'environment', return_value={}), \
                patch.object(common.shutil, 'which') as which, \
                patch.object(common.subprocess, 'run') as run:
            common.run('npm', 'ci')
        which.assert_not_called()
        self.assertEqual(run.call_args.args[0], ['npm', 'ci'])

    @unittest.skipUnless(os.name == 'nt', 'Windows PATHEXT integration')
    def test_windows_runs_a_cmd_shim_from_a_path_with_spaces(self):
        with tempfile.TemporaryDirectory(prefix='build tools ') as directory:
            Path(directory, 'build-shim.cmd').write_bytes(b'@echo off\r\necho %~1\r\n')
            env = dict(os.environ, PATH=directory + os.pathsep + os.environ.get('PATH', ''))
            result = common.run('build-shim', 'argument with spaces', env=env, capture_output=True, text=True)
            self.assertEqual(result.stdout.strip(), 'argument with spaces')

    @unittest.skipUnless(os.name == 'nt', 'Windows npm integration')
    def test_windows_runs_installed_npm(self):
        result = common.run('npm', '--version', capture_output=True, text=True)
        self.assertRegex(result.stdout.strip(), r'^\d+\.\d+\.\d+')
