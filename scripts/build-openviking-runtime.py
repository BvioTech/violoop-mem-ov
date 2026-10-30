#!/usr/bin/env python3
"""Assemble a device runtime from this checkout's built wheel and frozen dependencies."""
import argparse
import shutil
import subprocess
import json
import uuid
import tempfile
from common import ROOT, ENGINE, PYTHON, VERSION, run
p = argparse.ArgumentParser()
p.add_argument('--output', type=__import__('pathlib').Path, default=ROOT / 'build/openviking-python')
p.add_argument('--replace', action='store_true', help='Replace only this checkout build artifact after validation')
a = p.parse_args()
target = a.output.resolve()
if not target.is_relative_to(ROOT / 'build') or target == ROOT / 'build':
    raise SystemExit('Runtime staging must be a child of this repository build/ directory.')
if target.exists() and not a.replace: raise SystemExit('Output exists; use --replace to rebuild this checkout artifact.')
wheels = list((ROOT / 'dist').glob(f'openviking-{VERSION}-*.whl'))
if len(wheels) != 1: raise SystemExit('Run npm run build on the target platform first (exactly one matching wheel required).')
lock = ROOT / 'build/requirements.lock.txt'
if not lock.exists(): raise SystemExit('Run npm run setup first to export the frozen engine requirements.')
target.parent.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='runtime-stage-', dir=target.parent) as temp:
    stage = __import__('pathlib').Path(temp) / 'python'
    run('uv', 'pip', 'install', '--python', PYTHON, '--target', stage, '-r', lock)
    run('uv', 'pip', 'install', '--python', PYTHON, '--target', stage, '--no-deps', wheels[0])
    shutil.copyfile(ROOT / 'SOURCE_MANIFEST.json', stage / 'violoop-source-manifest.json')
    shutil.copyfile(ENGINE / 'LICENSE', stage / 'OPENVIKING-LICENSE')
    shutil.copyfile(lock, stage / 'requirements-locked.txt')
    service_version = json.loads((ROOT / 'package.json').read_text())['version']
    archive = ROOT / 'dist' / f'violoop-mem-ov-{service_version}-source.tar.gz'
    if not archive.is_file(): raise RuntimeError('Matching service source archive is missing; run npm run build.')
    shutil.copyfile(archive, stage / 'violoop-mem-ov-source.tar.gz')
    from common import environment
    env = environment(); env['PYTHONPATH'] = str(stage)
    subprocess.run([str(PYTHON), '-S', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import openviking.server.bootstrap; import openviking; print(openviking.__version__)', str(stage)], cwd=temp, env=env, check=True)
    previous = target.with_name(target.name + '.previous-' + uuid.uuid4().hex)
    if target.exists(): target.rename(previous)
    try:
        stage.rename(target)
    except BaseException:
        if previous.exists(): previous.rename(target)
        raise
    if previous.exists(): shutil.rmtree(previous)
print(f'Runtime staged: {target}')
