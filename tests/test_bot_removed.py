"""The memory service must remain usable without the retired Bot package."""
from pathlib import Path
import subprocess
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[1]


def test_no_bot_package_entrypoint_or_dependency_group():
    project = tomllib.loads((ROOT / "engine/pyproject.toml").read_text())
    assert not (ROOT / "engine/bot").exists()
    assert "vikingbot" not in project["project"]["scripts"]
    assert "bot" not in project["project"]["optional-dependencies"]
    assert project["tool"]["setuptools"]["packages"]["find"]["where"] == ["."]


def test_server_import_routes_metrics_and_cli_work_when_bot_imports_are_forbidden():
    code = r"""
import importlib.abc
import sys
class NoBot(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == 'vikingbot' or fullname.startswith('vikingbot.'):
            raise AssertionError('Unexpected Bot import: ' + fullname)
sys.meta_path.insert(0, NoBot())
from openviking.server.app import create_app
from openviking.server.config import ServerConfig
from openviking.server import bootstrap
from openviking.metrics.bootstrap import create_default_collector_manager
from openviking_cli.doctor import _CHECKS
app = create_app(ServerConfig(), service=object())
routes = {route.path for route in app.routes}
assert '/api/v1/search/find' in routes
assert '/api/v1/compile' in routes
assert not any(path.startswith('/bot/') for path in routes)
assert not any('Feedback' in type(c).__name__ for c in create_default_collector_manager()._collectors)
assert not any('Bot' in name for name, _ in _CHECKS)
"""
    subprocess.run([sys.executable, '-c', code], cwd=ROOT / 'engine', check=True)


def test_server_help_has_no_bot_options():
    result = subprocess.run([sys.executable, '-m', 'openviking.server.bootstrap', '--help'],
                            cwd=ROOT / 'engine', check=True, capture_output=True, text=True)
    assert '--with-bot' not in result.stdout
    assert '--bot' not in result.stdout
    assert '--config' in result.stdout
    assert '--workers' in result.stdout
