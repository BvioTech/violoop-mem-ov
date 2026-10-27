# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: AGPL-3.0

from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace

import pytest

import openviking.server.app as app_module
import openviking.server.bootstrap as bootstrap
from openviking.server.config import ServerConfig
from openviking.utils.agfs_utils import resolve_queuefs_mount_point
from openviking_cli.utils.config.open_viking_config import OpenVikingConfigSingleton
from openviking_cli.utils.config.storage_config import StorageConfig


def test_main_keeps_config_host_when_cli_host_is_omitted(monkeypatch):
    config = ServerConfig(host="127.0.0.1", port=1933)
    captured: dict[str, object] = {}

    monkeypatch.setattr(
        bootstrap,
        "load_server_config",
        lambda config_path: config,
    )
    monkeypatch.setattr(
        bootstrap,
        "create_app",
        lambda config, **kwargs: "app",
    )
    monkeypatch.setattr(
        bootstrap,
        "configure_uvicorn_logging",
        lambda: None,
    )
    monkeypatch.setattr(
        OpenVikingConfigSingleton,
        "initialize",
        classmethod(lambda cls, config_path: None),
    )
    monkeypatch.setattr(
        bootstrap.argparse.ArgumentParser,
        "parse_args",
        lambda self: SimpleNamespace(
            host=None,
            port=None,
            config=None,
            workers=None,
        ),
    )
    monkeypatch.setattr(
        bootstrap.uvicorn,
        "run",
        lambda app, host, port, log_config=None, **kwargs: captured.update(
            {"app": app, "host": host, "port": port, "log_config": log_config, **kwargs}
        ),
    )

    bootstrap.main()

    assert captured["host"] == "127.0.0.1"
    assert captured["port"] == 1933


def test_main_coerces_cli_host_all_to_none(monkeypatch):
    config = ServerConfig(host="127.0.0.1", port=1933)
    captured: dict[str, object] = {}

    monkeypatch.setattr(
        bootstrap,
        "load_server_config",
        lambda config_path: config,
    )
    monkeypatch.setattr(
        bootstrap,
        "create_app",
        lambda config, **kwargs: "app",
    )
    monkeypatch.setattr(
        bootstrap,
        "configure_uvicorn_logging",
        lambda: None,
    )
    monkeypatch.setattr(
        OpenVikingConfigSingleton,
        "initialize",
        classmethod(lambda cls, config_path: None),
    )
    monkeypatch.setattr(
        bootstrap.argparse.ArgumentParser,
        "parse_args",
        lambda self: SimpleNamespace(
            host="all",
            port=None,
            config=None,
            workers=None,
        ),
    )
    monkeypatch.setattr(
        bootstrap.uvicorn,
        "run",
        lambda app, host, port, log_config=None, **kwargs: captured.update(
            {"app": app, "host": host, "port": port, "log_config": log_config, **kwargs}
        ),
    )

    bootstrap.main()

    assert captured["host"] is None
    assert captured["port"] == 1933


def test_main_prints_config_diagnostics_on_validation_error(monkeypatch, capsys):
    """An unknown top-level config field must exit 1 with actionable diagnostics."""
    config = ServerConfig(host="127.0.0.1", port=1933)

    monkeypatch.setattr(bootstrap, "resolve_config_path", lambda *a, **k: Path("/tmp/ov.conf"))
    monkeypatch.setattr(bootstrap, "load_server_config", lambda *a, **k: config)

    def failing_initialize(cls, config_path):
        raise ValueError("Unknown config field 'claude_code' in OpenVikingConfig")

    monkeypatch.setattr(
        OpenVikingConfigSingleton,
        "initialize",
        classmethod(failing_initialize),
    )
    monkeypatch.setattr(
        bootstrap.argparse.ArgumentParser,
        "parse_args",
        lambda self: SimpleNamespace(
            host=None,
            port=None,
            config="/tmp/ov.conf",
            workers=None,
        ),
    )

    previous_config = os.environ.get(bootstrap.OPENVIKING_CONFIG_ENV)
    with monkeypatch.context() as environment:
        # main() exports --config for worker processes before validation.
        environment.setenv(bootstrap.OPENVIKING_CONFIG_ENV, "bootstrap-test-original")
        with pytest.raises(SystemExit) as exc:
            bootstrap.main()

    assert os.environ.get(bootstrap.OPENVIKING_CONFIG_ENV) == previous_config
    assert exc.value.code == 1
    err = capsys.readouterr().err
    assert "/tmp/ov.conf" in err
    assert "Unknown config field 'claude_code'" in err
    assert "openviking-server doctor" in err
    assert "openviking/ov.conf.example" in err


def test_resolve_queuefs_mount_point_defaults_to_shared():
    config = StorageConfig()

    assert resolve_queuefs_mount_point(config) == "/queue"


def test_resolve_queuefs_mount_point_worker_mode_uses_process_index(monkeypatch):
    monkeypatch.setattr(
        "openviking.utils.agfs_utils.multiprocessing.current_process",
        lambda: SimpleNamespace(_identity=(3,)),
    )
    config = StorageConfig(agfs={"queuefs": {"mode": "worker"}})

    assert resolve_queuefs_mount_point(config) == "/queue/worker-2"


def test_resolve_queuefs_mount_point_worker_mode_falls_back_to_pid(monkeypatch):
    monkeypatch.setattr(
        "openviking.utils.agfs_utils.multiprocessing.current_process",
        lambda: SimpleNamespace(_identity=()),
    )
    monkeypatch.setattr(os, "getpid", lambda: 43210)
    config = StorageConfig(agfs={"queuefs": {"mode": "worker"}})

    assert resolve_queuefs_mount_point(config) == "/queue/worker-43210"


def test_configure_default_executor_uses_configured_size(monkeypatch):
    created: dict[str, object] = {}

    class _Executor:
        def __init__(self, *, max_workers, thread_name_prefix):
            created["max_workers"] = max_workers
            created["thread_name_prefix"] = thread_name_prefix

    class _Loop:
        def set_default_executor(self, executor):
            created["executor"] = executor

    monkeypatch.setattr(app_module, "ThreadPoolExecutor", _Executor)
    monkeypatch.setattr(app_module.asyncio, "get_running_loop", lambda: _Loop())

    app_module._configure_default_executor(ServerConfig(executor_threads=48))

    assert created["max_workers"] == 48
    assert created["thread_name_prefix"] == "openviking-asyncio"
    assert created["executor"].__class__ is _Executor


def test_configure_default_executor_keeps_python_default_when_zero(monkeypatch):
    monkeypatch.setattr(
        app_module.asyncio,
        "get_running_loop",
        lambda: pytest.fail("event loop should not be touched when the setting is zero"),
    )

    app_module._configure_default_executor(ServerConfig())
