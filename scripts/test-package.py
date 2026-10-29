#!/usr/bin/env python3
"""Run the native integration contract against the actual flattened package layout."""
from pathlib import Path
import json
import shlex
import shutil
import tempfile
from common import ROOT, PYTHON, run, test_environment
import argparse
parser = argparse.ArgumentParser()
parser.add_argument("--app-root", type=Path, help="Actual extracted /opt/violoop-mem directory")
parser.add_argument("--python", type=Path, default=PYTHON)
args = parser.parse_args()
config = {'contents': []}
if not args.app_root:
    import yaml
    config = yaml.safe_load((ROOT / 'scripts/nfpm.yaml').read_text())
if not args.app_root and not (ROOT / 'build/openviking-python/openviking/server/bootstrap.py').exists():
    raise SystemExit('Build and assemble the runtime before testing the package.')
with tempfile.TemporaryDirectory(prefix='mem-package-') as directory:
    stage = args.app_root.resolve() if args.app_root else Path(directory) / "app"
    if not args.app_root: stage.mkdir()
    assert stage.is_dir(), 'extracted app directory is missing'
    for item in config['contents']:
        if args.app_root: break
        destination = item['dst']
        prefix = '/opt/violoop-mem/'
        if not destination.startswith(prefix): continue
        source = ROOT / item['src']
        target = stage / destination[len(prefix):]
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir(): target.symlink_to(source)
        else: shutil.copy2(source, target)
    assert (stage / 'openviking-python/openviking/server/bootstrap.py').is_file(), 'packaged Python engine missing'
    package = json.loads((stage / 'package.json').read_text())
    assert (stage / package['main']).is_file()
    assert all((stage / entry).is_file() for entry in package['bin'].values())
    # -S prevents editable installs or venv dependencies from masking an
    # incomplete wheel/runtime. Only the assembled PYTHONPATH is available.
    python = Path(directory) / 'python-isolated'
    python.write_text('#!/bin/sh\nexec ' + shlex.quote(str(args.python.resolve())) + ' -S "$@"\n')
    python.chmod(0o755)
    env = test_environment()
    env.update(VIOLOOP_TEST_SERVICE_ROOT=str(stage), VIOLOOP_TEST_PYTHON=str(python),
               VIOLOOP_TEST_PYTHONPATH=str(stage / 'openviking-python'))
    run('node', ROOT / 'scripts/smoke-installed.cjs', stage, env=env)
    run('node', '--test', '--test-timeout=240000', ROOT / 'service/test/native_integration.js', env=env)
