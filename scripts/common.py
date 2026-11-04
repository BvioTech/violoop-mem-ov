"""Repository-owned paths shared by setup, build and validation."""
from pathlib import Path
import os
import shutil
import subprocess
import sys
ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / 'engine'
VENV = ROOT / '.venv'
PYTHON = VENV / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
VERSION = (ENGINE / 'VIOLOOP_ENGINE_VERSION').read_text().strip()
def environment():
    env = dict(os.environ)
    if sys.platform == 'darwin':
        # Match the desktop app's minimum OS for native code and wheel tags.
        env.setdefault('MACOSX_DEPLOYMENT_TARGET', '14.4')
    bins = [str(VENV / ('Scripts' if os.name == 'nt' else 'bin')), str(ROOT / '.build-tools/cargo/bin')]
    env['PATH'] = os.pathsep.join(bins + [env.get('PATH', '')])
    if (ROOT / '.build-tools/rustup').exists():
        env['RUSTUP_HOME'] = str(ROOT / '.build-tools/rustup')
        env['CARGO_HOME'] = str(ROOT / '.build-tools/cargo')
    env.update(OPENVIKING_VERSION=VERSION, SETUPTOOLS_SCM_PRETEND_VERSION_FOR_OPENVIKING=VERSION,
               OV_SKIP_STUDIO_BUILD='1', PYTHONPATH=str(ENGINE), PYTHONDONTWRITEBYTECODE='1')
    return env
def run(*args, cwd=ROOT, **kwargs):
    print('+', ' '.join(str(a) for a in args), flush=True)
    command = [str(a) for a in args]
    env = kwargs.pop("env", environment())
    if os.name == 'nt':
        # CreateProcess does not search PATHEXT like a shell does. Resolve npm's
        # .cmd shim (and checkout-local tools) against the child's PATH first.
        command[0] = shutil.which(command[0], path=env.get('PATH') if env is not None else None) or command[0]
    return subprocess.run(command, cwd=cwd, env=env, check=True, **kwargs)
def require_node():
    result = run('node', '-p', 'process.versions.node.split(".")[0]', capture_output=True, text=True)
    if result.stdout.strip() != '24': raise SystemExit('Use Node.js 24 (native SQLite ABI).')

def test_environment():
    env = environment()
    for key in list(env):
        if key.lower() in {'http_proxy', 'https_proxy', 'all_proxy'}:
            del env[key]
    env['NO_PROXY'] = env['no_proxy'] = '*'
    env['LITELLM_LOCAL_MODEL_COST_MAP'] = 'True'
    return env
