# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: AGPL-3.0
"""Bootstrap script for OpenViking HTTP Server."""

import argparse
import asyncio
import os
import sys
from typing import Optional

import uvicorn

from openviking.server.app import create_app
from openviking.server.config import load_server_config
from openviking_cli.utils.config import OPENVIKING_CONFIG_ENV
from openviking_cli.utils.config.config_loader import resolve_config_path
from openviking_cli.utils.config.consts import DEFAULT_OV_CONF
from openviking_cli.utils.logger import configure_uvicorn_logging


def _get_version() -> str:
    try:
        from openviking import __version__

        return __version__
    except ImportError:
        return "unknown"


def _normalize_host_arg(host: Optional[str]) -> Optional[str]:
    """Normalize special CLI host values."""
    if host is None:
        return None
    if host.strip().lower() == "all":
        return None
    return host


def main():
    """Main entry point for openviking-server command."""
    parser = argparse.ArgumentParser(
        description="OpenViking HTTP Server",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"openviking-server {_get_version()}",
    )
    parser.add_argument(
        "--host",
        type=str,
        default=None,
        help="Host to bind to",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help="Port to bind to",
    )
    parser.add_argument(
        "--config",
        type=str,
        default=None,
        help="Path to ov.conf config file",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=None,
        help="Number of uvicorn worker processes (default: 1, or server.workers in ov.conf)",
    )
    args = parser.parse_args()

    # Set OPENVIKING_CONFIG_FILE environment variable if --config is provided
    # This allows OpenVikingConfigSingleton to load from the specified config file
    if args.config is not None:
        os.environ[OPENVIKING_CONFIG_ENV] = args.config

    from openviking_cli.utils.config.open_viking_config import OpenVikingConfigSingleton

    # Load server config from ov.conf
    try:
        resolved_config_path = resolve_config_path(
            args.config,
            OPENVIKING_CONFIG_ENV,
            DEFAULT_OV_CONF,
        )
        config = load_server_config(args.config)
        OpenVikingConfigSingleton.initialize(config_path=args.config)
    except (FileNotFoundError, ValueError) as e:
        if isinstance(e, ValueError):
            print(
                f"Failed to load OpenViking server configuration from {resolved_config_path}:\n{e}",
                file=sys.stderr,
            )
            print(
                "\nValidate the configuration with:\n"
                "  openviking-server doctor\n\n"
                "See openviking/ov.conf.example for supported fields.",
                file=sys.stderr,
            )
        else:
            print(e, file=sys.stderr)
        sys.exit(1)

    # Configure logging early so that all subsequent steps have proper logging
    configure_uvicorn_logging()

    # 🔍 Authentication health check - CRITICAL: will exit if check fails
    try:
        from openviking.server.auth.health_check import run_startup_health_check_or_exit

        asyncio.run(run_startup_health_check_or_exit(config))
    except Exception as e:
        # Don't fail startup if health check itself has issues
        print(f"Warning: Authentication health check failed to run: {e}", file=sys.stderr)
        print("Continuing startup anyway...", file=sys.stderr)

    # Override with command line arguments
    if args.host is not None:
        config.host = _normalize_host_arg(args.host)
    if args.port is not None:
        config.port = args.port
    if args.workers is not None:
        config.workers = args.workers
    # Create and run server app
    app = create_app(
        config,
        config_path=(
            str(resolved_config_path) if resolved_config_path is not None else args.config
        ),
    )
    workers_info = f" (workers: {config.workers})" if config.workers > 1 else ""
    print(f"OpenViking HTTP Server is running on {config.host}:{config.port}{workers_info}")

    workers = config.workers
    if workers > 1:
        # Multi-worker mode requires an import string so each worker
        # can independently import the application.  We stash the
        # resolved config path in an env-var so that the factory can
        # pick it up (ServerConfig already reads OPENVIKING_CONFIG_FILE).
        uvicorn.run(
            "openviking.server.app:create_worker_app",
            factory=True,
            host=config.host,
            port=config.port,
            workers=workers,
            timeout_keep_alive=config.timeout_keep_alive,
            log_config=None,
        )
    else:
        uvicorn.run(
            app,
            host=config.host,
            port=config.port,
            timeout_keep_alive=config.timeout_keep_alive,
            log_config=None,
        )


if __name__ == "__main__":
    main()
