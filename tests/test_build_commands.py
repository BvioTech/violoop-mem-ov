"""Exercise build commands as real child processes, including Windows shims."""
from pathlib import Path
import ast
import os
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from common import ROOT, environment, run


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

    def test_python_build_logs_support_unicode_with_legacy_parent_encoding(self):
        with patch.dict(os.environ, PYTHONIOENCODING='cp1252', PYTHONUTF8='0'):
            result = run(Path(sys.executable), '-c', 'print(chr(0x1f517))',
                         capture_output=True, encoding='utf-8')
        self.assertEqual(result.stdout.strip(), chr(0x1f517))


class MacBuildTargetTests(unittest.TestCase):
    def test_child_environment_defaults_to_desktop_macos_requirement(self):
        with patch('common.sys.platform', 'darwin'), patch.dict(os.environ):
            os.environ.pop('MACOSX_DEPLOYMENT_TARGET', None)
            self.assertEqual(environment()['MACOSX_DEPLOYMENT_TARGET'], '14.4')

    def test_child_environment_preserves_explicit_macos_target(self):
        with patch('common.sys.platform', 'darwin'), patch.dict(
                os.environ, MACOSX_DEPLOYMENT_TARGET='15.0'):
            self.assertEqual(environment()['MACOSX_DEPLOYMENT_TARGET'], '15.0')

    def cmake_command(self):
        # Exercise the real CMake invocation without running setup() or compiling.
        tree = ast.parse((ROOT / 'engine/setup.py').read_text(encoding='utf-8'))
        method = next(node for node in ast.walk(tree)
                      if isinstance(node, ast.FunctionDef)
                      and node.name == '_build_extension_impl')
        namespace = dict(Path=Path, os=os, sysconfig=__import__('sysconfig'),
                         sys=SimpleNamespace(platform='darwin', executable=sys.executable),
                         ENGINE_SOURCE_DIR=str(ROOT / 'engine/src'),
                         ENGINE_BUILD_CONFIG=SimpleNamespace(cmake_variants=()),
                         C_COMPILER_PATH='cc', CXX_COMPILER_PATH='c++')
        exec(compile(ast.Module(body=[method], type_ignores=[]),
                     'engine/setup.py', 'exec'), namespace)
        calls = []
        builder = SimpleNamespace(cmake_executable='cmake', spawn=calls.append,
                                  extensions=[SimpleNamespace(name='_native')],
                                  get_ext_filename=lambda name: '_native.abi3.so')
        with tempfile.TemporaryDirectory(prefix='violoop cmake ') as temp:
            output = Path(temp) / '_native.abi3.so'
            namespace['_build_extension_impl'](builder, output, output.parent,
                                               output.parent / 'build')
        return calls[0]

    def test_cmake_defaults_to_supported_macos_target(self):
        with patch.dict(os.environ):
            os.environ.pop('MACOSX_DEPLOYMENT_TARGET', None)
            self.assertIn('-DCMAKE_OSX_DEPLOYMENT_TARGET=14.4', self.cmake_command())

    def test_cmake_honors_explicit_target_used_by_rust(self):
        with patch.dict(os.environ, MACOSX_DEPLOYMENT_TARGET='15.0'):
            self.assertIn('-DCMAKE_OSX_DEPLOYMENT_TARGET=15.0', self.cmake_command())


if __name__ == '__main__':
    unittest.main()
