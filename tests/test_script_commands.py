"""Cross-platform command resolution and native build configuration."""
import ast
import os
from pathlib import Path
import sysconfig
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from scripts import common


class ScriptCommandTests(unittest.TestCase):
    def test_macos_environment_sets_the_app_minimum_and_preserves_overrides(self):
        with patch.object(common.sys, 'platform', 'darwin'), patch.dict(os.environ, {}, clear=True):
            self.assertEqual(common.environment()['MACOSX_DEPLOYMENT_TARGET'], '14.4')
            os.environ['MACOSX_DEPLOYMENT_TARGET'] = '15.0'
            self.assertEqual(common.environment()['MACOSX_DEPLOYMENT_TARGET'], '15.0')

    def test_non_macos_environment_does_not_add_an_apple_target(self):
        with patch.object(common.sys, 'platform', 'linux'), patch.dict(os.environ, {}, clear=True):
            self.assertNotIn('MACOSX_DEPLOYMENT_TARGET', common.environment())

    def test_macos_cmake_uses_the_same_deployment_target_as_packaging(self):
        # Execute the actual CMake command builder without importing setup.py,
        # which would invoke setuptools and compile the whole engine.
        tree = ast.parse((common.ENGINE / 'setup.py').read_text())
        build_ext = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                         and node.name == 'OpenVikingBuildExt')
        method = next(node for node in build_ext.body if isinstance(node, ast.FunctionDef)
                      and node.name == '_build_extension_impl')
        namespace = {'Path': Path, 'os': os, 'sysconfig': sysconfig,
                     'sys': SimpleNamespace(platform='darwin', executable='python'),
                     'ENGINE_SOURCE_DIR': str(common.ENGINE / 'src'),
                     'ENGINE_BUILD_CONFIG': SimpleNamespace(cmake_variants=()),
                     'C_COMPILER_PATH': 'clang', 'CXX_COMPILER_PATH': 'clang++'}
        exec(compile(ast.Module(body=[method], type_ignores=[]), 'setup.py', 'exec'), namespace)
        builder = SimpleNamespace(extensions=[SimpleNamespace(name='engine')],
                                  get_ext_filename=lambda _: 'engine.so',
                                  cmake_executable='cmake', spawn=Mock())
        for override, expected in [(None, '14.4'), ('15.0', '15.0')]:
            with self.subTest(override=override), patch.dict(os.environ, {}, clear=True):
                if override:
                    os.environ['MACOSX_DEPLOYMENT_TARGET'] = override
                namespace['_build_extension_impl'](builder, Path('engine.so'), Path('out'), Path('build'))
                configure = builder.spawn.call_args_list[-2].args[0]
                self.assertIn(f'-DCMAKE_OSX_DEPLOYMENT_TARGET={expected}', configure)

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
