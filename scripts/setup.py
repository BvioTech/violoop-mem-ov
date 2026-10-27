#!/usr/bin/env python3
"""Install into this repository only; no system packages or user configuration."""
import argparse
import os
import platform
import shutil
import subprocess
import urllib.request
from common import ROOT, ENGINE, VENV, PYTHON, run, environment, require_node
p = argparse.ArgumentParser()
p.add_argument('--bootstrap-rust', action='store_true', help='Install Rust 1.99.1 into ignored .build-tools')
p.add_argument('--python', default='3.12', help='Python version or executable (3.11 on Debian 12)')
a = p.parse_args()
require_node()
if not shutil.which('uv'): raise SystemExit('Install uv first, then rerun npm run setup.')
run('npm', 'ci', '--include=optional', '--no-audit', '--no-fund')
if not PYTHON.exists():
    run('uv', 'venv', '--python', a.python, VENV)
(ROOT / 'build').mkdir(exist_ok=True)
requirements = ROOT / 'build/requirements.lock.txt'
run('uv', 'export', '--frozen', '--no-dev', '--no-emit-project', '--format', 'requirements-txt', '--output-file', requirements, cwd=ENGINE, stdout=subprocess.DEVNULL)
run('uv', 'pip', 'install', '--python', PYTHON, '-r', requirements)
run('uv', 'pip', 'install', '--python', PYTHON, 'setuptools==84.2.1', 'setuptools-scm==10.3.4', 'wheel==0.48.0', 'cmake==4.4.4', 'maturin==1.15.0', 'build==1.5.0', 'pytest==9.0.2', 'pytest-asyncio==1.3.0')
if a.bootstrap_rust and not shutil.which('cargo', path=environment()['PATH']):
    targets = {('Darwin', 'arm64'): 'aarch64-apple-darwin', ('Darwin', 'x86_64'): 'x86_64-apple-darwin', ('Linux', 'aarch64'): 'aarch64-unknown-linux-gnu', ('Linux', 'x86_64'): 'x86_64-unknown-linux-gnu'}
    target = targets.get((platform.system(), platform.machine()))
    if not target: raise SystemExit('Install Rust >= 1.91.1 for this platform first.')
    dest = ROOT / '.build-tools'; dest.mkdir(exist_ok=True)
    installer = dest / 'rustup-init'
    urllib.request.urlretrieve(f'https://static.rust-lang.org/rustup/dist/{target}/rustup-init', installer)
    installer.chmod(0o755)
    # These directories only belong to the current checkout.
    (dest / 'rustup').mkdir(exist_ok=True)
    (dest / 'cargo').mkdir(exist_ok=True)
    run(installer, '-y', '--no-modify-path', '--profile', 'minimal', '--default-toolchain', '1.99.1')
if not shutil.which('cargo', path=environment()['PATH']):
    raise SystemExit('Rust >=1.91.1 required. Rerun npm run setup -- --bootstrap-rust.')
run('uv', 'pip', 'install', '--python', PYTHON, '--no-build-isolation', '--no-deps', '--editable', ENGINE)
run(PYTHON, '-c', 'import openviking.server.bootstrap; import openviking; print("Engine ready:", openviking.__version__, openviking.__file__)')
